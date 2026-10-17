// 页面级验证：起静态服务器（带 hf 权重代理）+ Chrome for Testing，
// 跑内容脚本包（工具栏/拖拽/算子链/取帧）、AI 宿主（vendor + slimSAM/YuNet/swin2SR 真实推理）、
// 以及设置页（普通网页 + chrome 桩，逐个点按钮）。
// 用法：node test/run_browser.mjs [--ai] [--options] [--only=sr|sam|face|vlm|script|options|warm|faceid|ms]
//      环境变量 AI_WAIT / OPT_WAIT = 轮询次数；MS_TASKS=sam,sr,tags,depth,face 指定 --only=ms 要验的源
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Cdp, findChromeForTesting } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const DO_AI = argv.includes('--ai');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
const BROWSER = findChromeForTesting(path.join(ROOT, 'test', '.browsers'));
if (!BROWSER) { console.log(JSON.stringify({ fatal: '需要 Chrome for Testing：npx @puppeteer/browsers install chrome@stable --path test/.browsers' })); process.exit(1); }
const BASE = process.env.PORT_BASE ? parseInt(process.env.PORT_BASE, 10) : 9500 + Math.floor(Math.random() * 60);
const PORT = BASE;
const CDP = BASE + 200;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PLOG = path.join(ROOT, 'test/out_proxy.log');

function crc32(buf) {
    let t = crc32.table;
    if (!t) { t = crc32.table = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } }
    let c = 0xffffffff;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function pngFromRgba(w, h, data) {
    const rows = [];
    for (let y = 0; y < h; y++) {
        const row = Buffer.alloc(1 + w * 4);
        row.set(data.subarray(y * w * 4, (y + 1) * w * 4), 1);
        rows.push(row);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const chunk = (type, d) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(d.length, 0);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), d]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
        return Buffer.concat([len, body, crc]);
    };
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
function edgePng(w = 600, h = 400) {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, v = x < w / 2 ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    return pngFromRgba(w, h, d);
}
const EDGE = edgePng();
const MP4 = path.join(ROOT, 'test', 'media', 'sample.mp4');
// 真人脸照片要有可核实的公开源；探测不到就跳过该子断言（不算失败）
let FACE = null;
for (const u of [
    'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',  // 占位，不用
]) { void u; }
for (const u of [
    'https://hf-mirror.com/datasets/DeepSourceCorp/face_alignment_data_raw/resolve/main/face_images/0.jpg',
    'https://github.com/opencv/opencv/raw/3.4/resources/lena.jpg',
]) {
    try {
        const r = await fetch(u, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
        const buf = Buffer.from(await r.arrayBuffer());
        if (r.ok && buf.length > 3000 && (buf[0] === 0xff || buf[1] === 0x50)) { FACE = buf; console.log('用人脸照片: ' + u + ' (' + buf.length + 'B)'); break; }
    } catch (e) { /* 换下一个 */ }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const routes = {
    '/test/make/edge.png': () => ({ body: EDGE, type: 'image/png' }),
    '/test/make/face.png': () => (FACE ? { body: FACE, type: 'image/jpeg' } : { code: 404, body: Buffer.from('no face image') }),
    '/test/make/sample.mp4': () => (fs.existsSync(MP4) ? { body: fs.readFileSync(MP4), type: 'video/mp4' } : { code: 404, body: Buffer.from('no mp4') }),
};
function plog(msg) { try { fs.appendFileSync(PLOG, msg + String.fromCharCode(10)); } catch (e) { /* ignore */ } }

// web 页面直连会被 CORS 挡，测试服务器代取权重，并且镜像挂了时退回 huggingface.co
async function proxyHf(rel, res) {
    const targets = ['https://hf-mirror.com/' + rel, 'https://huggingface.co/' + rel];
    for (let i = 0; i < targets.length * 2; i++) {
        const target = targets[i % targets.length];
        try {
            const r = await fetch(target, { headers: { 'user-agent': 'mtb-test' }, redirect: 'follow' });
            const buf = Buffer.from(await r.arrayBuffer());
            plog(target + ' -> ' + r.status + ' ' + buf.length + 'B');
            if (r.ok) {
                res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'content-length': buf.length });
                return res.end(buf);
            }
        } catch (e) { plog(target + ' -> THROW ' + e.name + ': ' + e.message); }
        await wait(400);
    }
    plog('ALL FAILED ' + rel);
    res.writeHead(502); res.end('proxy fail ' + rel);
}

async function proxyUrl(target, res) {
    try {
        const r = await fetch(target, { headers: { 'user-agent': 'mtb-test' }, redirect: 'follow' });
        const buf = Buffer.from(await r.arrayBuffer());
        plog(target + ' -> ' + r.status + ' ' + buf.length + 'B');
        if (r.ok) {
            res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'content-length': buf.length });
            return res.end(buf);
        }
        res.writeHead(502); res.end('bad upstream ' + r.status);
    } catch (e) {
        plog(target + ' -> THROW ' + e.name + ': ' + e.message);
        res.writeHead(502); res.end('proxy fail ' + e.message);
    }
}

function serveStatic(req, res) {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u.startsWith('/proxy/hf/')) return proxyHf(u.slice('/proxy/hf/'.length), res);
    // 通用只读代理：/proxy/get/<完整 URL>，用于验证被 CORS 挡在 web 页外的模型源
    if (u.startsWith('/proxy/get/')) return proxyUrl(u.slice('/proxy/get/'.length), res);
    if (routes[u]) {
        const r = routes[u]();
        if (r.code) { res.writeHead(r.code); return res.end(r.body); }
        res.writeHead(200, { 'content-type': r.type, 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
        return res.end(r.body);
    }
    const file = path.join(ROOT, u === '/' ? 'index.html' : u.replace(/^\/+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('404 ' + u); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'accept-ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
}
const server = http.createServer(serveStatic);
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mtb-browser-'));
const proc = spawn(BROWSER, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--no-first-run', '--autoplay-policy=no-user-gesture-required', '--window-size=1920,1080', 'about:blank'], { stdio: 'ignore' });
let cdp = null;
for (let i = 0; i < 90; i++) { await wait(300); try { cdp = await Cdp.connect(CDP); break; } catch (e) { /* 等启动 */ } }
if (!cdp) { console.log(JSON.stringify({ fatal: 'CDP 不可达' })); process.exit(1); }

const steps = [];
function step(name, ok, data = {}) {
    steps.push({ name, ok: !!ok, ...data });
    console.log(`${ok ? 'OK   ' : 'FAIL '} ${name}  ${JSON.stringify(data).slice(0, 300)}`);
}

// ============================================ 1) 内容脚本 / 工具栏
const page = await cdp.open(`http://127.0.0.1:${PORT}/test/harness_page.html`);
for (let i = 0; i < 40 && !(await cdp.ev(page, `!!window.__mtbReady && typeof window.__mtb === 'object'`)); i++) await wait(300);
const loaded = await cdp.ev(page, `({ready: !!window.__mtbReady, mtb: typeof window.__mtb, host: !!window.__mtbHostStub})`);
step('内容脚本包在页面里可加载（打包与语法正确）', !!(loaded && loaded.ready && loaded.mtb === 'object'), { loaded });

const enabled = await cdp.ev(page, `(()=>{
  const s = __mtb.state.settings;
  for (const id of ['invert','copy-link','download','upscale-lanczos','autotrim','edges','v-frame','ai-describe','palette','measure','clean-url','open-src']) if (s.tools[id]) s.tools[id].enabled = true;
  __mtb.refresh(true);
  return Object.keys(s.tools).filter(k=>s.tools[k].enabled).length;
})()`);
step('按设置显隐按钮（enabled 计数）', enabled > 0, { enabled });

const hover = await cdp.ev(page, `(async()=>{
  const img=document.getElementById('big'), r=img.getBoundingClientRect();
  img.dispatchEvent(new MouseEvent('mouseover',{clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true}));
  document.dispatchEvent(new MouseEvent('mousemove',{clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true}));
  await new Promise(res=>setTimeout(res,900));
  const wrap=document.getElementById('mtb-root').shadowRoot.querySelector('.wrap');
  return {shown:wrap.classList.contains('show'), buttons:[...wrap.querySelectorAll('button.btn')].map(b=>b.textContent.trim()), handle:!!wrap.querySelector('.draghandle')};
})()`);
step('悬停图片出工具栏（按钮清单来自设置）', !!(hover && hover.shown && hover.buttons.length >= 3 && hover.handle), { hover });

const op = await cdp.ev(page, `(async()=>{
  const shadow=document.getElementById('mtb-root').shadowRoot;
  const b=[...shadow.querySelectorAll('button.btn')].find(x=>x.textContent.includes('反色'));
  if(!b) return {error:'没有反色按钮'};
  b.click();
  for(let i=0;i<40;i++){ await new Promise(r=>setTimeout(r,200));
    const img=shadow.querySelector('.panel.show img.result');
    if(img){ try{await img.decode()}catch(e){}
      const c=document.createElement('canvas'); c.width=4; c.height=1;
      const g=c.getContext('2d',{willReadFrequently:true}); g.drawImage(img,0,0,4,1);
      const d=g.getImageData(0,0,4,1).data;
      return {size:img.naturalWidth+'x'+img.naturalHeight,left:[d[0],d[1],d[2]],right:[d[12],d[13],d[14]]}; }
    const t=shadow.querySelector('.toast.show'); if(t) return {error:t.textContent};
  }
  return {error:'等不到结果面板'};
})()`);
step('反色按钮 → host 通道 → 算子链 → 结果面板（左白右黑变左黑右白）', !!(op.left && op.right && op.left[0] === 0 && op.right[0] === 255), { op });

// 面板必须真的有尺寸、真的能点：宿主是 pointer-events:none + 0×0 的话，absolute 子元素会塌成一列窄条
// 而且完全点不动——这类问题读 naturalWidth 是看不出来的，只能量渲染几何 + 做真实命中测试。
const geo = await cdp.ev(page, `(()=>{
  const host=document.getElementById('mtb-root'), shadow=host.shadowRoot;
  const p=shadow.querySelector('.panel.show');
  if(!p) return {error:'面板没开着'};
  const r=p.getBoundingClientRect();
  const hit=(x,y)=>{ const e=document.elementFromPoint(x,y); return e ? (e.id || e.tagName) : 'null'; };
  const btn=p.querySelector('button.act') || p.querySelector('header .close');
  const br=btn ? btn.getBoundingClientRect() : {left:0,top:0,width:0,height:0};
  return {w:Math.round(r.width),h:Math.round(r.height),pe:getComputedStyle(p).pointerEvents,
    hostW:Math.round(host.getBoundingClientRect().width),
    hitPanel:hit(r.left+Math.min(60,r.width/2), r.top+8), hitBtn:btn?hit(br.left+br.width/2, br.top+br.height/2):'无按钮',
    btns:p.querySelectorAll('button').length};
})()`);
step('结果面板有实际宽度且可命中（不是 0 宽塌陷、pointer-events 已开）',
    !!(geo.w > 240 && geo.h > 80 && geo.pe === 'auto' && geo.hitPanel === 'mtb-root'), { geo });

// 折叠到 ▾ 下拉：常驻数变少、菜单能开、菜单项能真的执行、执行后自动收起
const fold = await cdp.ev(page, `(async()=>{
  const M=window.__mtb, shadow=document.getElementById('mtb-root').shadowRoot;
  const before=[...shadow.querySelectorAll('.wrap button.btn')].length;
  // 走真路径：写 storage → onChanged → applySettings 重建清单（直接改内存对象会绕过这条链）
  const s=JSON.parse(JSON.stringify(M.state.settings));
  s.tools.invert.collapsed = true;
  await new Promise(r=>chrome.storage.local.set({mtbSettings:s}, r));
  await new Promise(x=>setTimeout(x,600));
  const img=document.getElementById('big'), r=img.getBoundingClientRect();
  document.dispatchEvent(new MouseEvent('mousemove',{clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true,composed:true}));
  await new Promise(x=>setTimeout(x,800));
  const wrap=shadow.querySelector('.wrap');
  const after=[...wrap.querySelectorAll('button.btn')].length;
  const pinned=[...wrap.querySelectorAll('button.btn')].map(b=>b.textContent.trim());
  const more=[...wrap.querySelectorAll('button.btn')].find(b=>b.classList.contains('more'));
  const out={before, after, pinned, hasMore:!!more, menuShown:false, items:[], panelOk:false, closedAfter:false, menuHit:false, menuUnderMore:false, stayOnChrome:false};
  if(more){
    more.click(); await new Promise(x=>setTimeout(x,250));
    const menu=wrap.querySelector('.menu');
    out.menuShown=!!(menu&&menu.classList.contains('show'));
    if(menu&&menu.classList.contains('show')){
      const mb=more.getBoundingClientRect(), mt=menu.getBoundingClientRect();
      // 菜单要贴着「⋯ 更多」正下方，不是整条工具栏的左端
      out.menuUnderMore = mt.top >= mb.bottom - 2 && (Math.abs(mt.left-mb.left) < 8 || Math.abs(mt.right-mb.right) < 8);
      out.menuGeo={dxLeft:Math.round(mt.left-mb.left), dxRight:Math.round(mt.right-mb.right), gapTop:Math.round(mt.top-mb.bottom)};
    }
    out.items=[...(menu?menu.querySelectorAll('.mi'):[])].map(x=>x.textContent.trim());
    const mr=menu&&menu.querySelector('.mi');
    if(mr){ const q=mr.getBoundingClientRect(); out.menuHit=document.elementFromPoint(q.left+q.width/2,q.top+q.height/2) ? (document.getElementById('mtb-root').contains(document.elementFromPoint(q.left+q.width/2,q.top+q.height/2))) : false;
      mr.click();
      for(let i=0;i<40;i++){ await new Promise(x=>setTimeout(x,200));
        const im=shadow.querySelector('.panel.show img.result');
        if(im){ try{await im.decode()}catch(e){}
          const c=document.createElement('canvas'); c.width=4; c.height=1;
          const g=c.getContext('2d',{willReadFrequently:true}); g.drawImage(im,0,0,4,1);
          const d=g.getImageData(0,0,4,1).data; out.panelOk = d[0]===0 && d[12]===255; break; } }
      out.closedAfter = !(menu.classList.contains('show')); }
  }
  // 指针移到工具栏上、但已经离开图片：栏子不能消失（否则右边的按钮根本点不到）
  {
    const img2=document.getElementById('big'), r2=img2.getBoundingClientRect();
    document.dispatchEvent(new MouseEvent('mouseover',{clientX:r2.left+r2.width/2,clientY:r2.top+r2.height/2,bubbles:true,composed:true}));
    await new Promise(x=>setTimeout(x,700));
    const btns=[...wrap.querySelectorAll('button.btn')];
    const outside=btns.find(b=>{const q=b.getBoundingClientRect(); return q.right>r2.right+4 || q.left<r2.left-4 || q.bottom>r2.bottom+4;});
    if(outside){
      const q=outside.getBoundingClientRect();
      document.dispatchEvent(new MouseEvent('mousemove',{clientX:q.left+q.width/2,clientY:q.top+q.height/2,bubbles:true,composed:true}));
      await new Promise(x=>setTimeout(x,1200));   // 跨过两次 300ms 轮询
      out.stayOnChrome = wrap.classList.contains('show');
      out.stayBtn = outside.textContent.trim();
    }
  }
  const s2=JSON.parse(JSON.stringify(M.state.settings));
  s2.tools.invert.collapsed = false;
  await new Promise(r=>chrome.storage.local.set({mtbSettings:s2}, r));
  return out;
})()`);
step('折叠 ▾ 下拉：常驻变少、菜单能开且能命中、菜单项真执行并自动收起',
    !!(fold.hasMore && fold.menuShown && !fold.pinned.some((t) => /反色/.test(t)) && fold.items.some((t) => /反色/.test(t)) && fold.menuHit && fold.panelOk && fold.closedAfter), { fold });
step('菜单开在「⋯ 更多」正下方（不是整条工具栏左端）', !!fold.menuUnderMore, { geo: fold.menuGeo });
step('指针移到超出图片的工具栏按钮上，栏子不消失', !!fold.stayOnChrome, { btn: fold.stayBtn });

const chain = await cdp.ev(page, `(async()=>{
  const shadow=document.getElementById('mtb-root').shadowRoot;
  const b=[...shadow.querySelectorAll('button.btn')].find(x=>x.textContent.includes('Lanczos'));
  if(!b) return {error:'没有 Lanczos 按钮'};
  b.click();
  for(let i=0;i<60;i++){ await new Promise(r=>setTimeout(r,250));
    const img=shadow.querySelector('.panel.show img.result');
    if(img){ try{await img.decode()}catch(e){} return {size:img.naturalWidth+'x'+img.naturalHeight, title:shadow.querySelector('.panel .tt').textContent}; } }
  return {error:'等不到放大结果'};
})()`);
step('Lanczos 2x 放大（1200x800）', chain.size === '1200x800', { chain });

const drag = await cdp.ev(page, `(async()=>{
  const shadow=document.getElementById('mtb-root').shadowRoot, wrap=shadow.querySelector('.wrap');
  const h=wrap.querySelector('.draghandle'), r=h.getBoundingClientRect();
  const before={l:parseFloat(wrap.style.left),t:parseFloat(wrap.style.top)};
  const fire=(type,dx,dy)=>h.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,composed:true,clientX:r.left+r.width/2+dx,clientY:r.top+r.height/2+dy,pointerId:5,isPrimary:true,button:0,buttons:type==='pointerup'?0:1}));
  fire('pointerdown',0,0); await new Promise(r=>setTimeout(r,80));
  fire('pointermove',48,-26); await new Promise(r=>setTimeout(r,80));
  fire('pointerup',48,-26); await new Promise(r=>setTimeout(r,900));
  const after={l:parseFloat(wrap.style.left),t:parseFloat(wrap.style.top)};
  const st=window.__mtbStubGetStorage().mtbSettings;
  const calls=(window.__mtbStubCalls||[]).filter(c=>c.action==='patchSettings').length;
  return {moved:Math.abs(after.l-before.l)>10, patched:calls, savedOffset: st&&st.toolbar?{x:st.toolbar.offsetX,y:st.toolbar.offsetY}:null, flag: st&&st.toolbar?st.toolbar.dragMoved:null};
})()`);
step('拖拽 ⠿ 改位置并写回设置（偏移量持久化）', !!(drag.patched && drag.flag && drag.savedOffset && Math.abs(drag.savedOffset.x - 48) <= 26 && Math.abs(drag.savedOffset.y + 26) <= 26), { drag });

const bg = await cdp.ev(page, `(async()=>{
  const box=document.getElementById('bgbox'), r=box.getBoundingClientRect();
  document.dispatchEvent(new MouseEvent('mouseover',{clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true}));
  await new Promise(res=>setTimeout(res,800));
  const wrap=document.getElementById('mtb-root').shadowRoot.querySelector('.wrap');
  return {shown:wrap.classList.contains('show'), buttons:[...wrap.querySelectorAll('button.btn')].map(b=>b.textContent.trim())};
})()`);
step('background-image 容器命中（bg 态只留可取链按钮）', !!(bg.shown && bg.buttons.length >= 2 && !bg.buttons.some((x) => x.includes('Lanczos'))), { bg });

if (fs.existsSync(MP4)) {
    const vid = await cdp.ev(page, `(async()=>{
  const v=document.getElementById('vid'); v.muted=true;
  try{ await v.play(); }catch(e){}
  await new Promise(res=>{ const ok=()=>res(); if(v.readyState>=2) ok(); else v.addEventListener('loadeddata',ok,{once:true}); setTimeout(ok,9000); });
  try{ v.currentTime=Math.min(1,(v.duration||2)/2); }catch(e){}
  await new Promise(res=>{ v.addEventListener('seeked',res,{once:true}); setTimeout(res,6000); });
  v.scrollIntoView({block:'center'}); await new Promise(r=>setTimeout(r,400));
  const r=v.getBoundingClientRect();
  document.dispatchEvent(new MouseEvent('mouseover',{clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true}));
  await new Promise(res=>setTimeout(res,800));
  const shadow=document.getElementById('mtb-root').shadowRoot, wrap=shadow.querySelector('.wrap');
  const videoButtons=[...wrap.querySelectorAll('button.btn')].map(b=>b.textContent.trim());
  const b=[...wrap.querySelectorAll('button.btn')].find(x=>x.textContent.includes('当前帧'));
  if(!b) return {error:'视频态没有当前帧按钮', videoButtons};
  b.click();
  for(let i=0;i<50;i++){ await new Promise(r2=>setTimeout(r2,300));
    const img=shadow.querySelector('.panel.show img.result');
    if(img){ try{await img.decode()}catch(e){} return {size:img.naturalWidth+'x'+img.naturalHeight, videoButtons, title:shadow.querySelector('.panel .tt').textContent}; } }
  const t=shadow.querySelector('.toast.show'); return {error:t?t.textContent:'等不到帧'};
})()`);
    step('视频态：工具栏切到视频按钮组 + 取当前帧', !!(vid.size && /x/.test(vid.size) && vid.videoButtons.some((x) => x.includes('帧'))), { vid });

// 视频控制类按钮：必须真的改到元素上，并且站点偷偷复位时能被重新按回去
const vidCtl = await cdp.ev(page, `(async()=>{
  const shadow=document.getElementById('mtb-root').shadowRoot, wrap=shadow.querySelector('.wrap'), v=document.getElementById('vid');
  const press=async(id)=>{
    let b=wrap.querySelector('button.btn[data-tool="'+id+'"]');
    if(!b){ const more=wrap.querySelector('button.btn.more'); if(more){ more.click(); await new Promise(x=>setTimeout(x,250)); }
      b=shadow.querySelector('.menu .mi[data-tool="'+id+'"]'); }
    if(!b) return { id, missing:true };
    b.click(); await new Promise(x=>setTimeout(x,500));
    const t=shadow.querySelector('.toast.show');
    return { id, toast: t?t.textContent:null };
  };
  const out={ diag: { same: !!(window.__mtb.state.media && window.__mtb.state.media.el === v), readyState: v.readyState,
      duration: v.duration, seekable: v.seekable ? v.seekable.length : -1, src: String(v.currentSrc || v.src).slice(-24), paused: v.paused } };
  try { v.pause(); } catch(e){}
  v.playbackRate=1; v.loop=false; v.muted=false;
  out.speed = await press('v-speed'); out.rateAfter = v.playbackRate;
  // 逐帧：本地合成的 sample.mp4 只有一个关键帧，浏览器会把 seek 吸回 0，
  // 所以这里能验的是「按钮→seekStep→seekTo→反馈」这条链与目标时间，吸帧误差留给真站点手测。
  try { v.pause(); } catch(e){}
  await new Promise(x=>setTimeout(x,250));
  const t0 = v.currentTime; out.seek = await press('v-seek-out');
  out.moved = +(v.currentTime - t0).toFixed(4); out.pausedDuringSeek = v.paused; out.t0 = +t0.toFixed(4); out.tAfter = +v.currentTime.toFixed(4);
  out.seekToast = (out.seek && out.seek.toast) || '';
  out.mute = await press('v-mute'); out.mutedAfter = v.muted;
  out.loop = await press('v-loop'); out.loopAfter = v.loop;
  out.play = await press('v-play'); out.pausedAfter = v.paused;
  v.playbackRate = 1; v.dispatchEvent(new Event('play'));
  await new Promise(x=>setTimeout(x,300));
  out.rateSticky = v.playbackRate;
  out.rateToast = (shadow.querySelector('.toast.show')||{}).textContent || null;
  return out;
})()`);
step('视频控制：倍速/逐帧/静音/循环真的改到元素上，站点复位后被重新按回',
    !!(vidCtl.rateAfter === 1.25 && vidCtl.loopAfter === true && vidCtl.pausedDuringSeek && /逐帧 前进 33\.3ms →/.test(vidCtl.seekToast || '') && vidCtl.diag.seekable >= 1
        && vidCtl.mutedAfter === true && vidCtl.rateSticky === 1.25
        && !vidCtl.speed.missing && !vidCtl.loop.missing && !vidCtl.seek.missing && !vidCtl.mute.missing), { vidCtl });
}

// 过程日志全部进右侧悬浮日志窗：工具栏按钮旁边不许再出现状态文字
const progSplit = await cdp.ev(page, `(async()=>{
  const shadow=document.getElementById('mtb-root').shadowRoot;
  const fire=(type,extra)=>chrome.runtime.sendMessage(Object.assign({action:'mtbEvent', type}, extra));
  const dock=shadow.querySelector('.logbox');
  const texts=()=>[...(dock?dock.querySelectorAll('.ln .tx'):[])].map((x)=>x.textContent.trim());
  fire('modelProgress', { warmFor:'vlm', phase:'download', loaded:1, total:100, text:'download 1/100' });
  await new Promise(r=>setTimeout(r,300));
  const afterDownload=texts().some((t)=>/download 1\\/100/.test(t));
  fire('aiProgress', { text:'推理中…' });
  await new Promise(r=>setTimeout(r,300));
  const afterAi=texts().some((t)=>/推理中/.test(t));
  fire('aiProgress', { text:'' });
  await new Promise(r=>setTimeout(r,300));
  return {
    afterDownload, afterAi,
    shown: !!(dock && dock.classList.contains('show')),
    busy: !!(dock && dock.querySelector('.ln.busy')),
    chip: !!shadow.querySelector('.wrap .status'),
    last: texts().slice(-1)[0] || null,
  };
})()`);
step('下载/推理日志进右侧悬浮窗，结束后不再挂着进行中，按钮旁无状态条',
    !!(progSplit.afterDownload && progSplit.afterAi && progSplit.shown && !progSplit.busy && !progSplit.chip), { progSplit });

const logDockRows = await cdp.ev(page, `(async()=>{
  const M=window.__mtb, shadow=document.getElementById('mtb-root').shadowRoot;
  const dock=shadow.querySelector('.logbox');
  const rows=()=>dock.querySelectorAll('.ln').length;
  const before=rows();
  M.toolbar.onLog('准备模型…');
  await new Promise(r=>setTimeout(r,140));
  const shown=dock.classList.contains('show'), busy=!!dock.querySelector('.ln.busy');
  M.toolbar.onLog('推理中…');
  await new Promise(r=>setTimeout(r,140));
  const sameRow=rows()===before+1;          // 同一任务原地刷新，不该一行变多行
  M.toolbar.onLog('');
  await new Promise(r=>setTimeout(r,140));
  const tx=[...dock.querySelectorAll('.ln .tx')].slice(-1)[0].textContent;
  return { shown, busy, sameRow, timed:/·\\s*\\d+(\\.\\d+)?(s|ms)$/.test(tx), stillBusy:!!dock.querySelector('.ln.busy'), tx };
})()`);
step('日志窗：进行中原地刷一行、结束补耗时并去掉进行中',
    !!(logDockRows.shown && logDockRows.busy && logDockRows.sameRow && logDockRows.timed && !logDockRows.stillBusy), { logDockRows });

const lock = await cdp.ev(page, `(async()=>{
  const shadow=document.getElementById('mtb-root').shadowRoot, wrap=shadow.querySelector('.wrap');
  const el=document.getElementById('big'); el.scrollIntoView({block:'center'});
  await new Promise(r=>setTimeout(r,150));
  const q=el.getBoundingClientRect();
  document.dispatchEvent(new MouseEvent('mouseover',{clientX:q.left+40,clientY:q.top+40,bubbles:true,composed:true}));
  await new Promise(r=>setTimeout(r,700));
  const a={l:parseFloat(wrap.style.left),t:parseFloat(wrap.style.top),show:wrap.classList.contains('show')};
  // 同一张图内移动指针 + 强制重探 + 页面滚动：都不许让已经显示的工具栏自己挪
  document.dispatchEvent(new MouseEvent('mousemove',{clientX:q.left+q.width/2,clientY:q.top+q.height/2,bubbles:true,composed:true}));
  await new Promise(r=>setTimeout(r,300));
  window.__mtb.refresh();
  window.scrollTo(0,100);
  await new Promise(r=>setTimeout(r,600));
  const b={l:parseFloat(wrap.style.left),t:parseFloat(wrap.style.top),show:wrap.classList.contains('show')};
  window.scrollTo(0,0);
  // 指针离开媒体 → 收起；再悬停另一张图 → 按新图重新锚定
  document.dispatchEvent(new MouseEvent('mouseover',{clientX:2,clientY:2,bubbles:true,composed:true}));
  await new Promise(r=>setTimeout(r,450));
  const hidden=!wrap.classList.contains('show');
  const other=document.getElementById('over'); other.scrollIntoView({block:'center'});
  await new Promise(r=>setTimeout(r,150));
  const o=other.getBoundingClientRect();
  document.dispatchEvent(new MouseEvent('mouseover',{clientX:o.left+o.width/2,clientY:o.top+o.height/2,bubbles:true,composed:true}));
  await new Promise(r=>setTimeout(r,700));
  const c={l:parseFloat(wrap.style.left),t:parseFloat(wrap.style.top),show:wrap.classList.contains('show'),hit:window.__mtb.state.media&&window.__mtb.state.media.el.id};
  return { a,b,c,hidden };
})()`);
step('工具栏显示后就锁位：移动/重探/滚动都不动，收起再弹出才重新锚定',
    !!(lock.a.show && lock.b.show && lock.b.l === lock.a.l && lock.b.t === lock.a.t && lock.hidden && lock.c.show && lock.c.hit === 'over'), { lock });

const layer = await cdp.ev(page, `(async()=>{
  const hitAt=async(id,fx,fy)=>{
    const el=document.getElementById(id); el.scrollIntoView({block:'center'});
    await new Promise(r=>setTimeout(r,150));
    const q=el.getBoundingClientRect();
    const x=fx==='c'?q.left+q.width/2:q.left+fx, y=fy==='c'?q.top+q.height/2:q.top+fy;
    document.dispatchEvent(new MouseEvent('mouseover',{clientX:x,clientY:y,bubbles:true,composed:true}));
    await new Promise(r=>setTimeout(r,700));
    const m=window.__mtb.state.media;
    return m ? (m.el.id||m.el.tagName) : null;
  };
  return {
    onTop: await hitAt('over','c','c'),               // 压在上面的小图
    onBottomOnly: await hitAt('under',20,380),        // 只属于下面那张大图的范围
    peTop: await hitAt('toppe','c','c'),              // pointer-events:none 的最上层图
  };
})()`);
step('只命中最上层图片：压在上面的图优先，pointer-events:none 也算最上层',
    layer.onTop === 'over' && layer.onBottomOnly === 'under' && layer.peTop === 'toppe', { layer });

const contentErrors = cdp.pageErrors().filter((e) => !/favicon|404 \(Not Found\)/i.test(e));
step('内容脚本阶段无页面异常', contentErrors.length === 0, { errors: contentErrors.slice(0, 6) });

// ============================================ 2) AI 宿主与真实模型
if (DO_AI) {
    const url = `http://127.0.0.1:${PORT}/test/harness_ai.html${ONLY ? '?only=' + ONLY : ''}${ONLY === 'ms' && process.env.MS_TASKS ? '&tasks=' + process.env.MS_TASKS : ''}${process.env.VP ? '&vp=' + process.env.VP : ''}`;
    try { fs.writeFileSync(PLOG, ''); } catch (e) { /* ignore */ }
    const ap = await cdp.open(url);
    const LIMIT = process.env.AI_WAIT ? parseInt(process.env.AI_WAIT, 10) : 320;
    let done = null;
    for (let i = 0; i < LIMIT; i++) {
        await wait(1500);
        done = await cdp.ev(ap, `window.__aiFinished ? window.__aiDone : null`);
        if (done) break;
        if (i % 20 === 19) console.log('   …模型下载/推理中 ' + Math.round((i + 1) * 1.5) + 's');
    }
    if (done && done.steps) for (const s of done.steps) step('AI · ' + s.name, s.ok, s);
    else {
        const partial = await cdp.ev(ap, `({steps: (window.__aiDone&&window.__aiDone.steps)||null, log: document.getElementById('log').textContent.slice(-900)})`);
        step('AI 宿主页面完成', false, { note: '超时未收尾', partial });
    }
    const pl = fs.existsSync(PLOG) ? fs.readFileSync(PLOG, 'utf8').split(String.fromCharCode(10)).slice(-5).join(' / ') : '';
    const aiErrors = cdp.pageErrors().filter((e) => !/favicon|404 \(Not Found\)/i.test(e));
    step('AI 阶段无页面异常', aiErrors.length === 0, { errors: aiErrors.slice(0, 5), proxy: pl.slice(0, 400) });
}

// ============================================ 3) 设置页（普通网页 + chrome 桩，逐个点按钮）
if (ONLY === 'options' || argv.includes('--options') || (DO_AI && !ONLY)) {
    const ap = await cdp.open(`http://127.0.0.1:${PORT}/test/harness_options.html`);
    const LIMIT = process.env.OPT_WAIT ? parseInt(process.env.OPT_WAIT, 10) : 150;
    let od = null;
    for (let i = 0; i < LIMIT; i++) {
        await wait(1000);
        od = await cdp.ev(ap, `window.__optFinished ? window.__optDone : null`);
        if (od) break;
    }
    if (od && od.steps) for (const s of od.steps) step('设置页 · ' + s.name, s.ok, s);
    else {
        const partial = await cdp.ev(ap, `({steps: (window.__optDone&&window.__optDone.steps)||null, log: document.getElementById('log').textContent.slice(-1400)})`);
        step('设置页阶段完成', false, { note: '超时未收尾', partial });
    }
}

console.log(String.fromCharCode(10) + '=== 汇总 ===');
const failed = steps.filter((s) => !s.ok);
console.log(JSON.stringify({ total: steps.length, failed: failed.length, names: failed.map((s) => s.name) }, null, 1));
fs.writeFileSync(path.join(ROOT, 'test/out_browser.json'), JSON.stringify({ steps, faceImage: !!FACE }, null, 1));
cdp.close();
try { proc.kill(); } catch (e) { /* 已退出 */ }
server.close();
setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 文件锁 */ } }, 400);
process.exit(failed.length ? 1 : 0);
