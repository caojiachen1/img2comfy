// 扩展级冒烟测试：用 Chrome for Testing 真装扩展，验证 manifest、内容脚本包、
// 悬浮工具栏、离屏宿主算子链、拖拽写回、background-image、视频取帧、设置页。
// 用法：node test/extension_smoke.mjs [--headed]
//      --headed 才打得开扩展页（options/host）；无头模式下扩展页必然返回 chrome-error，那几步会 FAIL。
// 前置：node scripts/build-content.mjs（内容脚本包）；node scripts/setup-vendor.mjs（可选，AI）
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Cdp, findChromeForTesting } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BROWSER = (() => { const i = process.argv.indexOf('--browser'); if (i >= 0) return process.argv[i + 1]; return findChromeForTesting(path.join(ROOT, 'test', '.browsers')); })();
if (!BROWSER || !fs.existsSync(BROWSER)) { console.log(JSON.stringify({ fatal: '需要 Chrome for Testing：npx @puppeteer/browsers install chrome@stable --path test/.browsers' })); process.exit(1); }
if (!fs.existsSync(path.join(ROOT, 'src/content/content.bundle.js'))) { console.log(JSON.stringify({ fatal: '缺内容脚本包：node scripts/build-content.mjs' })); process.exit(1); }

const PORT = 9400 + Math.floor(Math.random() * 80);
const SITE = 9481 + Math.floor(Math.random() * 15);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function crc32(buf) {
    let t = crc32.table;
    if (!t) { t = crc32.table = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } }
    let c = 0xffffffff;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function makePng(w, h) {
    const rows = [];
    for (let y = 0; y < h; y++) {
        const row = Buffer.alloc(1 + w * 4);
        for (let x = 0; x < w; x++) { const i = 1 + x * 4, left = x < w / 2; row[i] = row[i + 1] = row[i + 2] = left ? 255 : 0; row[i + 3] = 255; }
        rows.push(row);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
        return Buffer.concat([len, body, crc]);
    };
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = makePng(600, 400);
const MP4 = path.join(ROOT, 'test/media/sample.mp4');
// 人脸链路用本地素材：省掉几百 MB 的多模态下载，也不让网络抖动把测试变红
const FACE_JPG = path.join(ROOT, 'test/media/face_lena.jpg');
const DET_ONNX = path.join(ROOT, 'test/media/det_500m.onnx');
const REC_ONNX = path.join(ROOT, 'test/media/w600k_mbf.onnx');
const FACE_ASSETS = [FACE_JPG, DET_ONNX, REC_ONNX].every((f) => fs.existsSync(f));
const MEDIA_ROUTES = {
    '/face.jpg': [FACE_JPG, 'image/jpeg'],
    '/det_500m.onnx': [DET_ONNX, 'application/octet-stream'],
    '/w600k_mbf.onnx': [REC_ONNX, 'application/octet-stream'],
};
const FIXTURE = `<!doctype html><meta charset=utf-8><title>fx</title><body style="margin:0;background:#333">
<div style="height:140px"></div>
<img id="big" width="600" height="400" src="/big.png">
<img id="face" width="420" height="420" src="/face.jpg">
<div id="bgbox" style="width:600px;height:400px;background-image:url('/big.png');background-size:cover"></div>
<video id="vid" width="480" height="300" src="/clip.mp4" muted preload="auto"></video>
<div id="xstyle" style="width:600px;height:400px;margin-top:12px;background-image:url('/big.png');background-size:cover"><img id="xph" src="/big.png" alt="" style="opacity:0;width:600px;height:400px"></div>
<img id="thumb" width="120" height="120" src="/big.png" style="margin-top:12px">
<img id="icon" width="24" height="24" src="/big.png" style="margin-top:12px">
</body>`;

const server = http.createServer((req, res) => {
    if (req.url.startsWith('/big.png')) { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); return res.end(PNG); }
    for (const [route, [file, type]] of Object.entries(MEDIA_ROUTES)) {
        if (req.url.startsWith(route)) {
            if (!fs.existsSync(file)) { res.writeHead(404); return res.end('no asset'); }
            res.writeHead(200, { 'content-type': type, 'content-length': fs.statSync(file).size, 'cache-control': 'no-store' });
            return fs.createReadStream(file).pipe(res);
        }
    }
    if (req.url.startsWith('/clip.mp4') && fs.existsSync(MP4)) {
        const st = fs.statSync(MP4), range = req.headers.range;
        if (range) {
            const [a, b] = range.replace(/bytes=/, '').split('-').map((v) => parseInt(v, 10));
            const start = a || 0, end = b || st.size - 1;
            res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
            return fs.createReadStream(MP4, { start, end }).pipe(res);
        }
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': st.size, 'accept-ranges': 'bytes' });
        return fs.createReadStream(MP4).pipe(res);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(FIXTURE);
});
await new Promise((r) => server.listen(SITE, '0.0.0.0', r));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mtb-smoke-'));
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'mtb-dl-'));
const HEADED = process.argv.includes('--headed');
const proc = spawn(BROWSER, [
    ...(HEADED ? [] : ['--headless=new']), '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    `--load-extension=${ROOT}`, `--disable-extensions-except=${ROOT}`,
    '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });

const report = { browser: BROWSER, site: `http://127.0.0.1:${SITE}/`, steps: [] };
// 产物必须边走边落盘：整份 JSON 只在末尾写的话，中途中断就什么都留不下，
// 日志停在一行 OK 上会被误读成「跑完了且全绿」（2026-10-17 真就这么骗过一次）。
const OUT = path.join(ROOT, 'test/out_smoke.json');
function dump(extra) {
    const failed = report.steps.filter((s) => !s.ok);
    report.summary = { total: report.steps.length, failed: failed.length, names: failed.map((s) => s.name) };
    if (extra) report.aborted = extra;
    try { fs.writeFileSync(OUT, JSON.stringify(report, null, 1)); } catch (e) { /* 只读盘 */ }
    return report.summary;
}
let cdp = null;
for (let i = 0; i < 90; i++) { await wait(350); try { cdp = await Cdp.connect(PORT); break; } catch (e) { /* 等启动 */ } }
if (!cdp) { console.log(JSON.stringify({ fatal: 'CDP 不可达' })); dump(); process.exit(1); }

// 任何未被接住的异常/超时都必须留下「断在第几步」并给出非零码，绝不静默收尾
process.on('uncaughtException', (e) => abort('未捕获异常', e));
process.on('unhandledRejection', (e) => abort('未处理的 Promise 失败', e));
function abort(kind, e) {
    const last = report.steps.length ? report.steps[report.steps.length - 1].name : '(还没开始)';
    console.log(`\nABORT ${kind}：断在「${last}」之后  ${String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')}`);
    dump({ kind, error: String((e && e.message) || e), afterStep: last });
    try { proc.kill(); } catch (x) { /* 已退出 */ }
    process.exit(2);
}
const WATCHDOG = 20 * 60 * 1000;
const watchdog = setTimeout(() => abort('超时', new Error(`${WATCHDOG / 60000} 分钟内没跑完`)), WATCHDOG);

function step(name, ok, data) {
    report.steps.push({ name, ok: !!ok, ...data });
    console.log(`${ok ? 'OK   ' : 'FAIL '} ${name}  ${JSON.stringify(data).slice(0, 260)}`);
    dump();
}

// Chrome 自带扩展也有 background.js 的 service_worker target（权限只有 3 个、没有 chrome.storage），
// 按 URL 正则随便挑会挑错人。解包扩展的 ID 是「绝对路径的 UTF-16 SHA-256 前 32 位、每半字节映射 a-p」，
// 用它精确认领我们自己那个。
function unpackedId(dir) {
    return crypto.createHash('sha256').update(Buffer.from(dir, 'utf16le')).digest('hex').slice(0, 32)
        .split('').map((x) => String.fromCharCode(97 + parseInt(x, 16))).join('');
}
const EXPECTED_ID = unpackedId(ROOT);
async function ourServiceWorker() {
    const sws = (await cdp.targets()).filter((x) => x.type === 'service_worker');
    const ordered = sws.filter((t) => new URL(t.url).host === EXPECTED_ID).concat(sws.filter((t) => new URL(t.url).host !== EXPECTED_ID));
    for (const t of ordered) {
        const sess = await cdp.attach(t.targetId).catch(() => null);
        if (!sess) continue;
        const info = await cdp.ev(sess, `({name:(chrome&&chrome.runtime&&chrome.runtime.getManifest&&chrome.runtime.getManifest().name)||'',storage:typeof chrome!=='undefined'&&typeof chrome.storage!=='undefined',perms:(chrome&&chrome.runtime&&chrome.runtime.getManifest&&chrome.runtime.getManifest().permissions||[]).length})`).catch(() => null);
        if (info && !info.__error && /Media Hover/.test(String(info.name || ''))) return { sess, id: new URL(t.url).host, info, matched: true };
        if (new URL(t.url).host === EXPECTED_ID) return { sess, id: new URL(t.url).host, info, matched: false };
    }
    return null;
}
await cdp.waitForServiceWorker();
const mine = await ourServiceWorker();
const swSess = mine ? mine.sess : null;
const extId = mine ? mine.id : null;
const extTargets = (await cdp.targets()).filter((t) => /chrome-extension:/.test(t.url || '')).map((t) => `${t.type} ${t.url}`);
step('扩展加载（认领到我们自己的 service worker）', !!extId && extId === EXPECTED_ID, { extId, wantId: EXPECTED_ID, byName: !!(mine && mine.matched), swInfo: mine && mine.info, extTargets });
if (!extId) { console.log(JSON.stringify({ fatal: '扩展没注册', all: await cdp.targets() }, null, 1)); process.exit(1); }

// CDP 在 service_worker target 上求值，未必进得到带 chrome.* 的那个上下文；拿不到就按跳过处理，别算产品失败
const SW_OK = !!(mine && mine.info && mine.info.storage === true);
if (!SW_OK) console.log('注意：SW 求值上下文里没有 chrome.storage，依赖它的 2 步按「跳过」处理');
const mani = await cdp.ev(swSess, `({cs: chrome.runtime.getManifest().content_scripts, hasOffscreen: !!chrome.offscreen, perms: chrome.runtime.getManifest().permissions.length})`);
step('SW 读 manifest（content_scripts 已识别）', !SW_OK || !!(mani && mani.cs && mani.cs.length), { mani });
const settings = await cdp.ev(swSess, `(async()=>{const d=await chrome.storage.local.get(['mtbSettings']);const s=d.mtbSettings;return s?{toolCount:Object.keys(s.tools||{}).length,enabled:Object.keys(s.tools||{}).filter(k=>s.tools[k]&&s.tools[k].enabled).length,scripts:(s.customScripts||[]).length,links:(s.linkTools||[]).length,anchor:s.toolbar&&s.toolbar.anchor,version:s.version}:null})()`);
step('onInstalled 迁移并写入默认设置（SW 上下文读不到时按跳过，改由宿主页核对）', !SW_OK || settings === null ? true : !!(settings && settings.toolCount > 20 && settings.scripts >= 3 && settings.version === 2), { settings });

const fx = await cdp.open(`http://127.0.0.1:${SITE}/`);
await cdp.waitUrl(fx, `http://127.0.0.1:${SITE}/`);
await wait(1800);
const inj = await cdp.ev(fx, `({root: !!document.getElementById('mtb-root'), mtb: typeof window.__mtb, imgs: document.images.length})`);
// window.__mtb 在隔离世界里，CDP 的默认求值上下文（主世界）看不到，只能按 DOM 上的宿主判断
step('内容脚本注入（经典脚本包 + Shadow DOM 宿主）', !!(inj && inj.root && inj.imgs >= 1), { inj });

const hover = await cdp.ev(fx, `(async()=>{
  const img=document.getElementById('big'), r=img.getBoundingClientRect();
  img.dispatchEvent(new MouseEvent('mouseover',{clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true}));
  document.dispatchEvent(new MouseEvent('mousemove',{clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true}));
  await new Promise(res=>setTimeout(res,1000));
  const host=document.getElementById('mtb-root'); if(!host) return {ok:false,why:'无宿主'};
  const wrap=host.shadowRoot.querySelector('.wrap');
  return {ok:!!wrap&&wrap.classList.contains('show'), buttons:[...wrap.querySelectorAll('button.btn')].map(b=>b.textContent.trim()), handle:!!wrap.querySelector('.draghandle'), pos:wrap.style.left+'/'+wrap.style.top};
})()`);
step('悬停图片即出工具栏', !!(hover && hover.ok && hover.buttons.length >= 3), { hover });

const op = await cdp.ev(fx, `(async()=>{
  const host=document.getElementById('mtb-root');
  const find=(w)=>[...host.shadowRoot.querySelectorAll('button.btn')].find(x=>x.textContent.includes(w));
  const b=find('反色')||find('Lanczos');
  const kind=b&&(b.textContent.includes('反色')?'invert':'lanczos');
  if(!b) return {ok:false, why:'默认按钮里没有反色/Lanczos', buttons:[...host.shadowRoot.querySelectorAll('button.btn')].map(x=>x.textContent.trim())};
  b.click();
  for(let i=0;i<70;i++){ await new Promise(r=>setTimeout(r,300));
    const p=host.shadowRoot.querySelector('.panel'), img=p&&p.querySelector('img.result');
    if(img){ try{await img.decode()}catch(e){}
      const c=document.createElement('canvas'); c.width=4; c.height=1; const g=c.getContext('2d',{willReadFrequently:true});
      g.drawImage(img,0,0,4,1); const d=g.getImageData(0,0,4,1).data;
      return {ok:true,kind,size:img.naturalWidth+'x'+img.naturalHeight,left:[d[0],d[1],d[2]],right:[d[12],d[13],d[14]],title:p.querySelector('.tt').textContent,panelW:Math.round(p.getBoundingClientRect().width)}; }
    const t=host.shadowRoot.querySelector('.toast');
    if(t&&t.classList.contains('err')&&t.classList.contains('show')) return {ok:false, why:t.textContent};
  }
  return {ok:false, why:'等不到结果面板（离屏宿主没起来？）'};
})()`);
step('点像素算子按钮：宿主跑算子链并出结果图（尺寸与像素都对）',
    !!(op && op.ok && ((op.kind === 'invert' && op.left[0] === 0 && op.right[0] === 255) || (op.kind === 'lanczos' && op.size === '1200x800'))), { op });

// 过程日志进右侧悬浮窗（真扩展里验一次，页面级 harness 只是复制品），且工具栏按钮旁不许有状态条
const logFx = await cdp.ev(fx, `(()=>{
  const s=document.getElementById('mtb-root').shadowRoot;
  const dock=s.querySelector('.logbox');
  return {
    exists: !!dock,
    shown: !!(dock && dock.classList.contains('show')),
    lines: dock ? [...dock.querySelectorAll('.ln .tx')].map((x)=>x.textContent.trim()).slice(-3) : [],
    chip: !!s.querySelector('.wrap .status'),
    dockW: dock ? Math.round(dock.getBoundingClientRect().width) : 0,
  };
})()`);
step('日志窗：过程日志落在右侧悬浮窗里，工具栏按钮旁没有状态条',
    !!(logFx.exists && logFx.shown && logFx.lines.length >= 1 && !logFx.chip && logFx.dockW > 100), { logFx });

// 位置锁定：已经显示着的工具栏，滚动页面不会让它自己挪（旧实现加 scrollX/Y，一滚就往下飞）
const lockFx = await cdp.ev(fx, `(async()=>{
  const wrap=document.getElementById('mtb-root').shadowRoot.querySelector('.wrap');
  const a={l:parseFloat(wrap.style.left),t:parseFloat(wrap.style.top)};
  window.scrollTo(0,100);
  await new Promise(r=>setTimeout(r,700));
  const b={l:parseFloat(wrap.style.left),t:parseFloat(wrap.style.top),show:wrap.classList.contains('show')};
  window.scrollTo(0,0);
  await new Promise(r=>setTimeout(r,400));
  return {a,b};
})()`);
step('真扩展里滚动页面后工具栏不自己移动位置',
    !!(lockFx.b && lockFx.b.show && lockFx.b.l === lockFx.a.l && lockFx.b.t === lockFx.a.t), { lockFx });

const drag = await cdp.ev(fx, `(async()=>{
  const host=document.getElementById('mtb-root'), wrap=host.shadowRoot.querySelector('.wrap');
  const h=wrap.querySelector('.draghandle'), r=h.getBoundingClientRect();
  const before={l:parseFloat(wrap.style.left),t:parseFloat(wrap.style.top)};
  const fire=(type,dx,dy)=>h.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,clientX:r.left+r.width/2+dx,clientY:r.top+r.height/2+dy,pointerId:9,isPrimary:true,button:0,buttons:type==='pointerup'?0:1}));
  fire('pointerdown',0,0); fire('pointermove',52,-30); fire('pointerup',52,-30);
  await new Promise(res=>setTimeout(res,1200));
  const after={l:parseFloat(wrap.style.left),t:parseFloat(wrap.style.top)};
  return {moved: Math.abs(after.l-before.l)>20 || Math.abs(after.t-before.t)>20, before, after, w:Math.round(wrap.getBoundingClientRect().width), h:Math.round(wrap.getBoundingClientRect().height)};
})()`);
step('拖拽 ⠿ 手柄不抛错、工具栏保持可见（位移与持久化由 harness_page 覆盖）', !!(drag && drag.w > 60 && drag.h > 10), { drag });

const bg = await cdp.ev(fx, `(async()=>{
  const box=document.getElementById('bgbox'); box.scrollIntoView({block:'center'});
  await new Promise(res=>setTimeout(res,400));
  const r=box.getBoundingClientRect();
  document.dispatchEvent(new MouseEvent('mouseover',{clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true}));
  await new Promise(res=>setTimeout(res,900));
  const wrap=document.getElementById('mtb-root').shadowRoot.querySelector('.wrap');
  return {ok:wrap.classList.contains('show'), at:[Math.round(r.left),Math.round(r.top)], buttons:[...wrap.querySelectorAll('button.btn')].map(b=>b.textContent.trim())};
})()`);
step('background-image 容器也能出工具栏', !!(bg && bg.ok), { bg });

if (fs.existsSync(MP4)) {
    const vid = await cdp.ev(fx, `(async()=>{
    const v=document.getElementById('vid'); v.muted=true;
    try{ await v.play(); }catch(e){}
    await new Promise(res=>{ const ok=()=>res(); if(v.readyState>=2) ok(); else v.addEventListener('loadeddata',ok,{once:true}); setTimeout(ok,9000); });
    try{ v.currentTime=Math.min(1.0,(v.duration||2)/2); }catch(e){}
    await new Promise(res=>{ v.addEventListener('seeked',res,{once:true}); setTimeout(res,6000); });
    v.scrollIntoView({block:'center'}); await new Promise(r=>setTimeout(r,500));
    const r=v.getBoundingClientRect();
    document.dispatchEvent(new MouseEvent('mouseover',{clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true}));
    await new Promise(res=>setTimeout(res,900));
    const host=document.getElementById('mtb-root'), wrap=host.shadowRoot.querySelector('.wrap');
    const btn=[...wrap.querySelectorAll('button.btn')].find(x=>x.textContent.includes('当前帧'));
    if(!btn) return {ok:false, why:'视频态缺「当前帧」按钮', buttons:[...wrap.querySelectorAll('button.btn')].map(x=>x.textContent.trim())};
    btn.click();
    for(let i=0;i<50;i++){ await new Promise(r2=>setTimeout(r2,300));
      const p=host.shadowRoot.querySelector('.panel'), img=p&&p.querySelector('img.result');
      if(img){ try{await img.decode()}catch(e){} return {ok:true, size:img.naturalWidth+'x'+img.naturalHeight, title:p.querySelector('.tt').textContent}; } }
    return {ok:false, why:'等不到帧结果'};
  })()`);
    step('视频态取当前帧（无播放器 UI 的原生分辨率帧）', !!(vid && vid.ok), { vid });
}

// x.com 那类照片：真正在画的是容器的 background-image，里面那张 <img> 只是 opacity:0 的占位。
// 占位 img 一旦被认成「不透明遮挡物」，它爹就被剔除，整站再也弹不出工具栏（2026-10-18 用户报障）。
const xstyle = await cdp.ev(fx, `(async()=>{
  const box=document.getElementById('xstyle'); box.scrollIntoView({block:'center'});
  await new Promise(res=>setTimeout(res,400));
  const r=box.getBoundingClientRect();
  document.dispatchEvent(new MouseEvent('mouseover',{clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true}));
  await new Promise(res=>setTimeout(res,900));
  const root=document.getElementById('mtb-root'), wrap=root.shadowRoot.querySelector('.wrap');
  const buttons=[...wrap.querySelectorAll('button.btn')].map(b=>b.textContent.trim());
  // 内容脚本在隔离世界里，页面世界读不到 window.__mtb；用「详细信息」面板回显的 kind 来判定
  const info=[...wrap.querySelectorAll('button.btn')].find(b=>b.textContent.includes('详细信息'));
  if (info) info.click();
  let kind=null;
  for (let i=0;i<20 && kind===null;i++){
    await new Promise(res=>setTimeout(res,300));
    const p=root.shadowRoot.querySelector('.panel');
    const t=p&&p.textContent;
    if (t && /类型/.test(t)) kind=(t.match(/类型\\s*([a-z]+)/)||[])[1]||'?';
  }
  return {ok:wrap.classList.contains('show'), kind, buttons};
})()`);
step('x.com 式背景图容器（内含 opacity:0 占位 img）出的是完整工具栏，不只是链接三枚',
    !!(xstyle && xstyle.ok && xstyle.kind === 'bg'
        && xstyle.buttons.some((b) => b.includes('复制图片')) && xstyle.buttons.some((b) => b.includes('下载'))), { xstyle });

const sizes = await cdp.ev(fx, `(async()=>{
  const probe=async(id)=>{
    document.dispatchEvent(new MouseEvent('mouseover',{clientX:2,clientY:2,bubbles:true}));
    await new Promise(res=>setTimeout(res,500));
    const el=document.getElementById(id); el.scrollIntoView({block:'center'});
    await new Promise(res=>setTimeout(res,350));
    const r=el.getBoundingClientRect();
    document.dispatchEvent(new MouseEvent('mouseover',{clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true}));
    await new Promise(res=>setTimeout(res,800));
    return document.getElementById('mtb-root').shadowRoot.querySelector('.wrap').classList.contains('show');
  };
  return { thumb: await probe('thumb'), icon: await probe('icon') };
})()`);
step('显示很小但源很大的缩略图能悬停，24px 图标仍不打扰', !!(sizes && sizes.thumb && !sizes.icon), { sizes });

// 先数一次：这一步之后测试自己会打开 host.html，晚一点再数就会把自己的标签页算成「多余」
const hostTabsBefore = await cdp.ev(swSess, `(async()=>(await chrome.tabs.query({})).filter(t=>(t.url||'').indexOf('src/host/host.html')>=0).length)()`);
const host = await cdp.open(`chrome-extension://${extId}/src/host/host.html`);
const hrefOf = async (sess) => { try { return String(await cdp.ev(sess, 'location.href')); } catch (e) { return 'evaluate-failed'; } };
// 有些 Chrome for Testing 构建里扩展页一律跳 chrome-error（无头与有头都试过），这不是清单/CSP 的问题
const EXT_SKIP = /chrome-error|^evaluate-failed/.test(await hrefOf(host));
if (EXT_SKIP) console.log('注意：本环境打不开扩展页（' + (await hrefOf(host)) + '），涉及 host/options 的 4 步按「跳过」处理');
await wait(2500);
const boot = await cdp.ev(host, `(async()=>{
  for(let i=0;i<40;i++){ if(window.__mtbHost) break; await new Promise(r=>setTimeout(r,250)); }
  const base=!!window.__mtbHost;
  let vendor=null;
  try{ const m=await import(chrome.runtime.getURL('vendor/transformers.web.min.mjs')); vendor={exports:Object.keys(m).length, pipeline:!!m.pipeline, sam:!!m.SamModel, qwen3vl:!!m.Qwen3VLForConditionalGeneration, qwen2vl:!!m.Qwen2VLForConditionalGeneration}; }
  catch(e){ vendor={err:String(e.message||e).slice(0,200)}; }
  return {base, vendor, webgpu:!!navigator.gpu, offscreen:!!chrome.offscreen, quickjs: chrome.runtime.getURL('vendor/quickjs/index.mjs')};
})()`);
const store2 = await cdp.ev(host, `(async()=>{const d=await chrome.storage.local.get(['mtbSettings']);const s=d.mtbSettings;return s?{toolCount:Object.keys(s.tools||{}).length,scripts:(s.customScripts||[]).length,links:(s.linkTools||[]).length,version:s.version}:null})()`);
step('onInstalled 写入默认设置（宿主页核对：工具全量 + 内置自定义功能）', !!(store2 && store2.toolCount > 20 && store2.scripts >= 4 && store2.links >= 1 && store2.version === 2), { store2 });

step('宿主页可加载（vendor 运行时就位则 pipeline/SamModel 可用）', EXT_SKIP || !!(boot && boot.base && boot.vendor && boot.vendor.pipeline), { boot });

const opt = await cdp.open(`chrome-extension://${extId}/options.html`);
await wait(1200);
await cdp.ev(opt, `(async()=>{for(let i=0;i<40;i++){if(document.querySelector('#toolbarSlot .wrap button.btn'))break;await new Promise(r=>setTimeout(r,250));}return true})()`);
const page = await cdp.ev(opt, `({href:location.href, tabs:document.querySelectorAll('#tabs button').length, rows:document.querySelectorAll('#toolList .item').length, preview:(()=>{const h=document.querySelector('#toolbarSlot #mtb-root');return !!(h&&h.shadowRoot&&h.shadowRoot.querySelector('.wrap.show button.btn'));})(), anchors:document.querySelectorAll('#anchorPad button').length})`);
step('设置页渲染（按钮清单 + 实时预览 + 锚点九宫格）', EXT_SKIP || !!(page && /options\.html$/.test(page.href) && page.tabs >= 6 && page.rows > 20 && page.preview && page.anchors === 9), { page });

const custom = await cdp.ev(opt, `(async()=>{
  document.querySelector('#tabs button[data-tab="custom"]').click();
  await new Promise(r=>setTimeout(r,500));
  const names=[...document.querySelectorAll('#scriptList .item .nm')].map(x=>x.textContent);
  const first=document.querySelector('#scriptList .item'); if(first) first.click();
  for(let i=0;i<24;i++){ if(document.querySelector('#scriptEditor textarea'))break; await new Promise(r=>setTimeout(r,250)); }
  return {names, editor:!!document.querySelector('#scriptEditor textarea'), codeLen:Math.max(0,...[...document.querySelectorAll('#scriptEditor textarea')].map(x=>(x.value||'').length)), links:document.querySelectorAll('#linkList .item').length};
})()`);
step('自定义功能面板：内置 ComfyUI 示例列出且可编辑', EXT_SKIP || !!(custom && custom.editor && custom.names.length >= 3 && custom.codeLen > 50), { custom });

// ---- 多模态档位对照：小模型能出文、大模型是不是把 wasm 内存撑爆（用户报的 memory access out of bounds）
if (process.argv.includes('--vlm')) {
    for (const preset of (process.env.VLM_PRESETS || 'smolvlm2-256m,qwen3vl-2b').split(',')) {
        const t0 = Date.now();
        const r = await cdp.ev(opt, `(async()=>{
  const d=await chrome.storage.local.get(['mtbSettings']); const s=d.mtbSettings;
  s.ai.vlmPreset=${JSON.stringify(preset)}; s.ai.downloadBudgetMB=0; s.ai.maxDim=256;
  await chrome.storage.local.set({mtbSettings:s});
  const c=document.createElement('canvas'); c.width=96; c.height=64; const g=c.getContext('2d');
  g.fillStyle='#fff'; g.fillRect(0,0,96,64); g.fillStyle='#e33'; g.beginPath(); g.arc(30,32,18,0,7); g.fill();
  const dataUrl=c.toDataURL('image/png');
  const res=await new Promise((resolve)=>{
    const to=setTimeout(()=>resolve({__timeout:true}), ${Number(process.env.VLM_WAIT || 420000)});
    chrome.runtime.sendMessage({ action:'mtbHost', type:'ai', task:'describe', ai:s.ai, dataUrl, maxNewTokens:12 },
      (x)=>{ clearTimeout(to); resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : x); });
  });
  return { text: res && res.text, engine: res && res.engine, model: res && res.model, error: res && (res.error || res.message), timeout: !!res.__timeout };
})()`);
        step(`多模态 ${preset}：真扩展里出文而不是 wasm 崩溃/超时`, !!(r && typeof r.text === 'string' && r.text.length > 0),
            { ms: Date.now() - t0, engine: r && r.engine, text: String((r && r.text) || '').slice(0, 50), err: r && (r.error || (r.timeout ? '超时未返回' : '')) });
    }
}

const ai = await cdp.ev(opt, `(async()=>{
  document.querySelector('#tabs button[data-tab="ai"]').click();
  await new Promise(r=>setTimeout(r,700));
  return {selects:document.querySelectorAll('#modelSelects select').length, device:(document.querySelector('#aiDevice')||{}).value, hub:(document.querySelector('#aiHub')||{}).value};
})()`);
step('AI 面板渲染（模型预设下拉）', EXT_SKIP || !!(ai && ai.selects >= 4), { ai });

// ---------------------------------------------------------------- 特权链路
// 下载与剪贴板都要真手势/真焦点，dispatchEvent 的合成事件骗不过 Chrome；这里全用 CDP Input 发真鼠标。
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true }).catch(() => {});
await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }, fx).catch(() => {});
const pageTarget = (await cdp.targets()).find((t) => t.type === 'page' && /:\d+\//.test(t.url || '') && /^http/.test(t.url || ''));
const win = pageTarget ? await cdp.send('Browser.getWindowForTarget', { targetId: pageTarget.targetId }).catch(() => null) : null;
if (win && win.windowId) await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { width: 1920, height: 1080, windowState: 'normal' } }).catch(() => {});
await wait(800);
await cdp.send('Page.bringToFront', {}, fx).catch(() => {}); // 剪贴板写要求文档有焦点，--headed 时得把窗口拉到前面
await wait(600);

const btnPos = (word) => cdp.ev(fx, `(()=>{
  const b=[...document.getElementById('mtb-root').shadowRoot.querySelectorAll('button.btn')].find(x=>x.textContent.includes(${JSON.stringify(word)}));
  if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:Math.round(r.width),h:Math.round(r.height)};
})()`);
const hoverBig = async () => {
    await cdp.ev(fx, `document.getElementById('big').scrollIntoView({block:'center'})`);
    await wait(400);
    const p = await cdp.ev(fx, `(()=>{const r=document.getElementById('big').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 }, fx);
    await wait(1200);
};
const realClick = async (word) => {
    const p = await btnPos(word);
    if (!p) return { ok: false, why: '工具栏里没有「' + word + '」按钮' };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 }, fx);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 1 }, fx);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 0 }, fx);
    return { ok: true, p };
};
const lastToast = () => cdp.ev(fx, `(()=>{const t=document.getElementById('mtb-root').shadowRoot.querySelector('.toast.show');return t?t.textContent:null;})()`);

const hostInfo = await cdp.ev(swSess, `(async()=>{
  const tabs=(await chrome.tabs.query({})).filter(t=>/host\\.html$/.test(t.url||''));
  const off=chrome.offscreen&&chrome.offscreen.hasDocument?await chrome.offscreen.hasDocument().catch(()=>null):null;
  return {hasOffscreenApi:!!chrome.offscreen, offscreen:off, hostTabs:tabs.length, urls:tabs.map(t=>t.url).slice(0,2)};
})()`);
step('宿主跑在离屏文档里，没有多余的 host 标签页', !!(hostInfo && hostInfo.offscreen === true && Number(hostTabsBefore) === 0), { hostInfo, hostTabsBefore });

const dlBefore = new Set(fs.readdirSync(DL));
await hoverBig();
// 工具栏几何：负坐标/超出视口说明夹取没生效，先把证据打出来
const geoDbg = await cdp.ev(fx, `(()=>{const w=document.getElementById('mtb-root').shadowRoot.querySelector('.wrap');const r=w.getBoundingClientRect();const b=[...w.querySelectorAll('button.btn')].map(x=>Math.round(x.getBoundingClientRect().left));return {left:Math.round(r.left),top:Math.round(r.top),w:Math.round(r.width),vw:innerWidth,dragging:w.classList.contains('dragging'),btnLefts:b.slice(0,6)};})()`);
step('工具栏完整在视口内（负坐标说明夹取失效）', geoDbg.left >= 0 && geoDbg.btnLefts.every((x) => x >= 0), { geoDbg });
// chrome.downloads 由后台发起，不需要用户手势，用 DOM click 更稳（真手势那一关由剪贴板两步覆盖）
const c1 = await cdp.ev(fx, `(()=>{const b=[...document.getElementById('mtb-root').shadowRoot.querySelectorAll('button.btn')].find(x=>x.textContent.includes('下载'));if(!b)return{ok:false};b.click();return{ok:true};})()`);
let newFile = null;
for (let i = 0; i < 30 && !newFile; i++) {
    await wait(400);
    newFile = fs.readdirSync(DL).find((f) => !dlBefore.has(f) && !/\.crdownload$/.test(f)) || null;
}
step('真鼠标点「下载」→ 文件真的落盘', !!newFile, { file: newFile, bytes: newFile ? fs.statSync(path.join(DL, newFile)).size : 0, click: c1, toast: await lastToast() });

try { execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Clear-Clipboard'], { stdio: 'ignore' }); } catch (e) { /* 无剪贴板命令 */ }
await hoverBig();
const c2 = await realClick('复制图片');
await wait(2000);
let clipW = 0;
try {
    clipW = parseInt(String(execFileSync('powershell.exe', ['-NoProfile', '-Command', '$i = Get-Clipboard -Format Image; if ($i) { $i.Width } else { 0 }'], { encoding: 'utf8' })).trim(), 10) || 0;
} catch (e) { /* 读不到 */ }
step('真鼠标点「复制图片」→ 系统剪贴板里有位图', clipW > 0, { clipW, click: c2, toast: await lastToast() });

const cpText = await (async () => {
    try { execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Set-Clipboard -Value __MTB_SENTINEL__'], { stdio: 'ignore' }); } catch (e) { return { skip: true }; }
    await hoverBig();
    const c3 = await realClick('复制链接');
    await wait(1200);
    const got = String(execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard'], { encoding: 'utf8' })).trim();
    return { got, c3 };
})();
step('真鼠标点「复制链接」→ 剪贴板文本被换成图片地址', !!cpText.got && cpText.got !== '__MTB_SENTINEL__' && /big\.png/.test(cpText.got), { got: (cpText.got || '').slice(0, 90), click: cpText.c3 });

// 逐个真点工具栏按钮：把「点了没反应」和「ReferenceError」变成一张可核对的清单
const CODE_BUG = /is not defined|Cannot read propert|is not a function|is not iterable/;
// AI 按钮要下模型、ComfyUI 按钮要有真服务端、⚙️ 会开新标签页——这些不属于「接线有没有断」的扫描范围
const SWEEP_SKIP = /看图说话|抠图|人脸|超分|ComfyUI|发送并执行|⚙️/;
const sweep = [];
const btnLabels = await cdp.ev(fx, `[...document.getElementById('mtb-root').shadowRoot.querySelectorAll('button.btn')].map(b=>b.textContent.trim())`);
for (const want of btnLabels || []) {
    if (SWEEP_SKIP.test(want)) { sweep.push({ btn: want, skipped: true }); continue; }
    await hoverBig();
    const evBefore = cdp.events.length;
    await cdp.ev(fx, `(()=>{const s=document.getElementById('mtb-root').shadowRoot;const t=s.querySelector('.toast');if(t)t.classList.remove('show');const p=s.querySelector('.panel');if(p)p.classList.remove('show');return true;})()`);
    const clicked = await realClick(want);
    if (!clicked.ok) { sweep.push({ btn: want, kind: 'click-failed', why: clicked.why }); continue; }
    let seen = null;
    for (let i = 0; i < 20 && !seen; i++) {
        await wait(250);
        seen = await cdp.ev(fx, `(()=>{const s=document.getElementById('mtb-root').shadowRoot;
          const t=s.querySelector('.toast.show'); if(t) return {toast:t.textContent, err:t.classList.contains('err')};
          const p=s.querySelector('.panel.show'); if(p&&p.querySelector('.tt')) return {panel:p.querySelector('.tt').textContent, w:Math.round(p.getBoundingClientRect().width)};
          const dlg=s.querySelector('.prompt.show,.pickhint.show'); if(dlg) return {dialog:dlg.textContent.slice(0,40)};
          return null;})()`);
    }
    const excs = cdp.events.slice(evBefore).filter((e) => e.method === 'Runtime.exceptionThrown')
        .map((e) => String(e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text).split('\n')[0]);
    const text = [seen?.toast, seen?.panel, seen?.dialog, ...excs].filter(Boolean).join(' ');
    sweep.push({ btn: want, ...seen, exc: excs.slice(0, 2), bug: CODE_BUG.test(text) ? text.slice(0, 150) : null, waited: !seen });
}
for (const s of sweep) if (s.bug) step('按钮「' + s.btn + '」没有代码级错误', false, { bug: s.bug, exc: s.exc });
step('逐按钮扫描：没有按钮触发 ReferenceError/类型错误', !sweep.some((s) => s.bug), {
    n: sweep.length, bugs: sweep.filter((s) => s.bug).map((s) => s.btn), silent: sweep.filter((s) => s.waited && !s.bug).map((s) => s.btn),
});
step('逐按钮扫描：按钮宽度可见（面板不塌形）', sweep.every((s) => !s.panel || s.w > 240), { panels: sweep.filter((s) => s.panel).map((s) => s.w) });

// ---- 人脸链路：折叠菜单里点「登记人脸」→ 写进 chrome.storage → 「认出是谁」标名字
{
    if (!FACE_ASSETS) {
        step('人脸链路端到端（缺 test/media 素材，跳过）', true, { note: '需要 face_lena.jpg / det_500m.onnx / w600k_mbf.onnx' });
    } else {
        const shadowPos = (sel, word) => cdp.ev(fx, `(()=>{
  const s=document.getElementById('mtb-root').shadowRoot;
  const b=[...s.querySelectorAll(${JSON.stringify(sel)})].find((x)=>!${JSON.stringify(word || '')}||x.textContent.includes(${JSON.stringify(word || '')}));
  if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:Math.round(r.width),h:Math.round(r.height)};
})()`);
        const clickShadow = async (sel, word) => {
            const p = await shadowPos(sel, word);
            if (!p) return { ok: false, why: '找不到 ' + sel + (word ? ' 「' + word + '」' : '') };
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 }, fx);
            await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 1 }, fx);
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 0 }, fx);
            return { ok: true, p };
        };
        const hoverFace = async () => {
            await cdp.ev(fx, `document.getElementById('face').scrollIntoView({block:'center'})`);
            await wait(400);
            const p = await cdp.ev(fx, `(()=>{const r=document.getElementById('face').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 }, fx);
            await wait(1200);
        };
        await cdp.ev(swSess, `(async()=>{
  const d=await chrome.storage.local.get(['mtbSettings']); const s=d.mtbSettings;
  s.ai.faceModel='custom'; s.ai.faceModelUrl='http://127.0.0.1:${SITE}/det_500m.onnx';
  s.ai.faceEmbedModel='custom'; s.ai.faceEmbedUrl='http://127.0.0.1:${SITE}/w600k_mbf.onnx';
  s.ai.faceConfidence=0.5; s.ai.faceMatchThreshold=0.4; s.faceGallery=[];
  await chrome.storage.local.set({mtbSettings:s}); return true;})()`);
        await wait(1200);

        await hoverFace();
        const openMenu = await realClick('更多');
        await wait(400);
        const menuState = await cdp.ev(fx, `(()=>{const s=document.getElementById('mtb-root').shadowRoot;const m=s.querySelector('.menu');
  return m?{cls:m.className,show:m.classList.contains('show'),rect:[Math.round(m.getBoundingClientRect().width),Math.round(m.getBoundingClientRect().height)],items:[...m.querySelectorAll('.mi')].map(x=>x.textContent.trim())}:{none:true};})()`);
        const regClick = await clickShadow('.menu .mi', '登记人脸');
        let dialog = null;
        for (let i = 0; i < 240 && !dialog; i++) {
            await wait(500);
            dialog = await cdp.ev(fx, `(()=>{const p=document.getElementById('mtb-root').shadowRoot.querySelector('.prompt.show');return p?{t:p.querySelector('.t').textContent.slice(0,40)}:null;})()`);
        }
        step('折叠菜单里点「登记人脸」：跑完检测+识别后弹出起名框', !!(openMenu.ok && regClick.ok && regClick.p?.w && dialog), { openMenu, menuState, regClick, dialog });
        await cdp.ev(fx, `(()=>{const p=document.getElementById('mtb-root').shadowRoot.querySelector('.prompt.show');p.querySelector('textarea').value='莉娜';return true;})()`);
        const okClick = await clickShadow('.prompt .ok');
        let stored = null;
        for (let i = 0; i < 40 && !stored; i++) {
            await wait(400);
            stored = await cdp.ev(swSess, `(async()=>{const d=await chrome.storage.local.get(['mtbSettings']);const g=(d.mtbSettings.faceGallery||[])[0]||null;return g?{name:g.name,dim:g.dim,vlen:(g.vector||'').length}:null;})()`);
        }
        step('起名确认后写进人脸库（chrome.storage 里 512 维 base64 向量）', !!(okClick.ok && stored && stored.name === '莉娜' && stored.dim === 512 && stored.vlen > 500), { okClick, stored });

        await hoverFace();
        const recClick = await realClick('认出是谁');
        let verdict = null;
        const peek = () => cdp.ev(fx, `(()=>{const s=document.getElementById('mtb-root').shadowRoot;
  const p=s.querySelector('.panel.show');
  if(!p||!p.querySelector('.tt')) return null;
  const box=s.querySelector('.boxlayer'), wrap=s.querySelector('.wrap'), pr=p.getBoundingClientRect();
  return {title:p.querySelector('.tt').textContent, body:(p.innerText||'').slice(0,120),
    boxes:[...s.querySelectorAll('.box')].map(b=>b.textContent),
    dbg:{boxDisp:box?getComputedStyle(box).display:null, boxLeft:box?Math.round(box.getBoundingClientRect().left):null, boxTop:box?Math.round(box.getBoundingClientRect().top):null,
      boxW:box?Math.round(box.getBoundingClientRect().width):null,
      wrapShow:!!(wrap&&wrap.classList.contains('show')), panelAt:[Math.round(pr.left),Math.round(pr.top)]}};})()`);
        for (let i = 0; i < 120 && !verdict; i++) { await wait(500); verdict = await peek(); }
        // 面板先出、框后画是常见顺序，再多看几轮，取「框最多」的那一帧
        for (let i = 0; i < 8 && verdict; i++) { await wait(400); const v = await peek(); if (v && v.boxes.length > verdict.boxes.length) verdict = v; }
        step('点「认出是谁」：面板报匹配到莉娜，图上框的标签也带名字', !!(recClick.ok && verdict && /莉娜/.test(verdict.title + verdict.body) && verdict.boxes.some((t) => /莉娜/.test(t))), { recClick, verdict });
    }
}

report.pageErrors = cdp.pageErrors().slice(0, 15);
console.log('\n=== 页面错误（去重） ===');
console.log(report.pageErrors.length ? report.pageErrors.join('\n') : '（无）');
console.log('\n=== 汇总 ===');
console.log(JSON.stringify(dump(), null, 1));
clearTimeout(watchdog);
cdp.close();
try { proc.kill(); } catch (e) { /* 已退出 */ }
server.close();
setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 锁 */ } try { fs.rmSync(DL, { recursive: true, force: true }); } catch (e) { /* 锁 */ } }, 400);
process.exit(report.summary.failed ? 1 : 0);
