// 本页图片下拉面板的真浏览器回归：九宫格缩略图不弹 / 查看器大图弹、按作者分组、
// 全选后由后台串行发送到假 ComfyUI（API 模式），核对上传与 /prompt 次数。
// 用法：node test/gallery_probe.mjs [--headed]（扩展页在无头里可能打不开，默认有头更稳）
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Cdp, findChromeForTesting } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BROWSER = findChromeForTesting(path.join(ROOT, 'test', '.browsers'));
if (!BROWSER) { console.log('需要 Chrome for Testing：npx @puppeteer/browsers install chrome@stable --path test/.browsers'); process.exit(1); }
const HEADED = process.argv.includes('--headed');
const WEIBO_HOST = process.argv.includes('--weibo-host');
const PAGE_HOST = WEIBO_HOST ? 'weibo.com' : '127.0.0.1';
const BASE = Number(process.env.GALLERY_PORT) || (9300 + Math.floor(Math.random() * 80));
const SITE = BASE;
const CDP = BASE + 200;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = [];
const step = (name, ok, info = {}) => { steps.push({ name, ok: !!ok, ...info }); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}  ${JSON.stringify(info).slice(0, 260)}`); };
const OUT = path.join(ROOT, 'test/out_gallery.json');
function dump() {
    const failed = steps.filter((s) => !s.ok);
    const summary = { total: steps.length, failed: failed.length, names: failed.map((s) => s.name) };
    try { fs.writeFileSync(OUT, JSON.stringify({ summary, steps }, null, 1)); } catch (e) { /* ignore */ }
    return summary;
}

// —— 测试图：400x300 纯色 PNG ——
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
function makePng(w = 400, h = 300, color = [70, 110, 180]) {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { d[i * 4] = color[0]; d[i * 4 + 1] = color[1]; d[i * 4 + 2] = color[2]; d[i * 4 + 3] = 255; }
    return pngFromRgba(w, h, d);
}
const PNG = makePng();
const PNG_LONG = makePng(150, 1800, [120, 90, 160]);   // 真微博长图的形状（比例 12，短边 150）

// —— 夹具：按真微博桌面版信息流（weibo.com/mygroups）复刻 ——
// 表头实测形状（class 是 CSS Module 哈希过的，词根稳定）：
//   <a class="_default_x" href="/u/<uid>"><img src="https://tvax1.sinaimg.cn/crop.../…"></a>   ← 头像，链接 innerText 是空的
//   <a class="_link_x _bolder_x" href="/mygroups?gid=…">账户名</a>                                ← 名字指回分组页，不是用户主页
//   <a class="_time_x" href="/<uid>/<bid>">18小时前</a>                                            ← 时间也包成指向本条的链接
// 正文里的 @提及是 <a href="/n/<昵称>">@某某</a>，它过去会被当成发帖人（真页面把「李一桐工作室」错标成「@李一桐Happy」）。
// 九宫格每格：一个内容图（/orj360/）+ 一个 20×14 的 GIF/长图角标 + 一条本格自己的永久链接。
// 最后还有一条被虚拟列表搬到 top:-9753 的回收帖，用户现在根本看不到它，它的图也不该出现在面板里。
const accounts = [
    { uid: '6000000101', name: '甲', mention: '甲的转发对象', strong: true },
    { uid: '6000000102', name: '乙', strong: true },
    { uid: '6000000103', name: '丙小佳的微博日常' },
    { uid: '6000000104', name: '丁当的摄影日记簿' },
];
const PIC = (n, i) => `http://wx${1 + (i % 4)}.sinaimg.cn:${SITE}/orj360/${n}.png`;
function authorHtml(a) {
    // strong：名字那条链接本身就是用户主页（移动版那种）；否则只能靠 class 词根认出账户名
    const cls = a.strong ? '_cut_cssmod_97 _name_cssmod_5' : '_link_cssmod_124 _bolder_cssmod_9';
    const href = a.strong ? `http://weibo.com/u/${a.uid}` : `http://weibo.com/mygroups?gid=4660985254641891`;
    const mention = a.mention ? ` <a class="" href="http://weibo.com/n/${encodeURIComponent(a.mention)}">@${a.mention}</a>` : '';
    return `<a class="_default_cssmod_3" href="http://weibo.com/u/${a.uid}">`
        + `<img class="_avatar_cssmod_1" src="http://tvax1.sinaimg.cn:${SITE}/crop.0.0.1080.1080.180/${a.uid}a.png" width="52" height="52" alt=""></a>`
        + `<a class="${cls}" href="${href}">${a.name}</a>${mention}`;
}
function postHtml(a, ai, from, extra = '') {
    const cells = Array.from({ length: 9 }, (_, k) => {
        const n = from + k;
        return `<li class="cell m-auto-box"><div class="m-img-box m-imghold-square">`
            + `<a class="thumb" href="javascript:void(0)"><img src="${PIC(n, k)}" width="180" height="135" alt="${a.name}图${n}"></a></div>`
            + `<img class="badge" src="http://h5.sinaimg.cn:${SITE}/upload/1000/808/badge${n}.png" width="20" height="14" alt="">`
            + `<a class="perma" href="http://weibo.com/${a.uid}/Rp${n}cell"></a></li>`;
    }).join('');
    return `<article class="post card9 weibo-main"><header>${authorHtml(a)} `
        + `<a class="_time_cssmod_33" href="http://weibo.com/${a.uid}/Pm${a.uid}${ai}">18小时前</a></header>`
        + `<p>${a.name}的第${ai + 1}条微博正文，九宫格九张图必须算同一条</p>`
        + `<ul class="grid m-auto-list">${cells}</ul>${extra}</article>`;
}
// 被折叠的九宫格（角标「+6」= 一共 15 张，DOM 里只有 9 张）：多出来的只能问 /ajax/statuses/show
function foldHtml() {
    const a = { uid: '6000009001', name: '折叠图账号' };
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>折叠九宫格测试</title>
<style>body{background:#0d1016;color:#ddd;font:13px system-ui;margin:20px}
.post{background:#171b23;border:1px solid #2a3040;border-radius:10px;padding:12px;margin:0 0 18px;width:600px}
header a{color:#8ab4ff;text-decoration:none;margin-right:6px}
.grid{display:grid;grid-template-columns:repeat(3,180px);gap:6px;margin-top:8px;padding:0;list-style:none}
.cell{position:relative}
.grid img.badge{position:absolute;top:2px;right:2px;width:20px;height:14px}
.grid img{width:180px;height:135px;object-fit:cover;display:block;background:#000}</style></head><body>
${postHtml(a, 0, 951, `<div class="picture"><span class="_picNum_a3hty_94">+6</span></div>`)}
</body></html>`;
}
const STASH = `<div class="recycled" style="position:absolute;top:-9753px;left:0;width:600px">`
    + postHtml({ uid: '6000000105', name: '戊被回收的旧帖' }, 9, 901) + `</div>`;
function fixtureHtml(extra = false) {
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>九宫格批量测试</title>
<style>
body{background:#0d1016;color:#ddd;font:13px system-ui;margin:20px;position:relative}
.post{background:#171b23;border:1px solid #2a3040;border-radius:10px;padding:12px;margin:0 0 18px;width:600px}
header a{color:#8ab4ff;text-decoration:none;margin-right:6px}
header ._bolder_cssmod_9,header ._name_cssmod_5{font-weight:700}
.grid{display:grid;grid-template-columns:repeat(3,180px);gap:6px;margin-top:8px;padding:0;list-style:none}
.cell{position:relative}
.grid img.badge{position:absolute;top:2px;right:2px;width:20px;height:14px}
.thumb{display:block;line-height:0}
.grid img{width:180px;height:135px;object-fit:cover;display:block;cursor:zoom-in;background:#000}
#viewer{display:none;position:fixed;inset:0;z-index:9999;background:#000d;align-items:center;justify-content:center}
#viewer img{width:800px;height:600px;object-fit:contain;cursor:zoom-out}
</style></head><body>
${accounts.map((a, ai) => postHtml(a, ai, 1 + ai * 9)).join('\n')}
${STASH}
${extra ? `<article class="post"><header><a class="name" rel="author" href="https://weibo.com/u/1005">戊</a></header><p>戊的第一条微博</p>
<img data-original="https://wx1.sinaimg.cn/orj360/fixture.jpg" src="https://wx1.sinaimg.cn/wap180/fixture.jpg" width="180" height="135" alt="戊的微博图" style="display:block;width:180px;height:135px;background:#333"></article>
<article class="post"><header><a class="name" rel="author" href="https://weibo.com/u/1005">戊</a> <a href="https://weibo.com/1234567890/R8xKzQ2Lm">微博正文</a></header><p>戊的第二条微博</p>
<img data-original="https://wx2.sinaimg.cn/square/fixture2.jpg" src="https://wx2.sinaimg.cn/tw420/fixture2.jpg" width="180" height="135" alt="戊第二条的微博图" style="display:block;width:180px;height:135px;background:#333"></article>` : ''}
<div id="viewer"><img id="viewerImg" alt="大图"></div>
<script>
document.querySelectorAll('.thumb').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  const img = a.querySelector('img');
  document.getElementById('viewerImg').src = img.src;
  document.getElementById('viewer').style.display = 'flex';
}));
document.getElementById('viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer') e.target.style.display = 'none'; });
</script></body></html>`;
}

// 一条"只有滚到才挂载"的微博：面板要是偷偷滚页面，它就会挂进 DOM —— 拿它当探针，验证采集不碰用户的页面
function gridHtml(label, uid, from, count) {
    const cells = Array.from({ length: count }, (_, k) => {
        const n = from + k;
        return `<li class="cell m-auto-box"><div class="m-img-box m-imghold-square"><img src="http://127.0.0.1:${SITE}/img/${n}.png" width="180" height="135" alt="${label}图${n}"></div></li>`;
    }).join('');
    return `<ul class="grid m-auto-list">${cells}</ul>`;
}
function lazyHtml() {
    const late = `<article class="post card9 weibo-main"><header><a class="name" rel="author" href="https://weibo.com/u/2002">${'晚'}</a></header><p>第二条：滚出来才挂进 DOM</p>${gridHtml('晚', 2002, 600, 9)}</article>`;
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>虚拟列表批量测试</title>
<style>body{background:#0d1016;color:#ddd;font:13px system-ui;margin:20px}
.post{background:#171b23;border:1px solid #2a3040;border-radius:10px;padding:12px;margin:0 0 18px;width:600px}
.name{color:#8ab4ff;text-decoration:none;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(3,180px);gap:6px;margin-top:8px;padding:0;list-style:none}
.grid img{width:180px;height:135px;object-fit:cover;display:block;background:#000}</style></head><body>
<article class="post card9 weibo-main"><header><a class="name" rel="author" href="https://weibo.com/u/2001">${'早'}</a></header><p>第一条：一进来就在 DOM 里</p>${gridHtml('早', 2001, 500, 9)}</article>
<div style="height:1500px">下面空一大段，逼着采集器真的去滚动</div>
<div id="late"></div>
<script>
const LATE = ${JSON.stringify(late)};
let done = false;
// 后台标签页不重绘，scroll 事件会被推迟，所以用定时器读滚动位置：
// 语义不变（不滚就永远不挂载），但不依赖渲染帧
setInterval(() => {
  if (done || window.scrollY < 200) return;
  done = true;
  document.getElementById('late').innerHTML = LATE;
}, 200);
</script></body></html>`;
}

// 专门收集「容易被误杀」的三种形状：长图（比例 12，短边 150）、还没解码且在跳过渲染的容器里的懒图、
// 以及 1×1 的 data: 占位图（这个必须不收）。前两种是用户报「少一大堆」时被丢掉的真实形状。
const PLACEHOLDER_1PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
function shapesHtml() {
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>易误杀形状测试</title>
<style>body{background:#0d1016;color:#ddd;font:13px system-ui;margin:20px}
.post{background:#171b23;border:1px solid #2a3040;border-radius:10px;padding:12px;margin:0 0 18px;width:600px}
header a{color:#8ab4ff;text-decoration:none;margin-right:6px}</style></head><body>
<article class="post card9 weibo-main"><header>${authorHtml({ uid: '6000007001', name: '长图账号', strong: true })}
 <a class="_time_cssmod_33" href="http://weibo.com/6000007001/Ps7001">1小时前</a></header><p>长图和正常图都要收</p>
<img class="longpic" src="http://wx1.sinaimg.cn:${SITE}/orj360/750.png" width="150" height="1800" alt="一条长图" style="display:block;width:150px;height:1800px;background:#222">
<img src="http://wx1.sinaimg.cn:${SITE}/orj360/753.png" width="180" height="135" alt="正常图" style="display:block;width:180px;height:135px;background:#222"></article>
<article class="post card9 weibo-main"><header>${authorHtml({ uid: '6000007002', name: '未解码容器账号' })}
 <a class="_time_cssmod_33" href="http://weibo.com/6000007002/Ps7002">2小时前</a></header><p>容器跳过渲染，图还没解码</p>
<div style="content-visibility:hidden"><img src="http://wx2.sinaimg.cn:${SITE}/slow/751.png" width="180" height="135" alt="懒图一">
<img src="http://wx3.sinaimg.cn:${SITE}/slow/752.png" width="180" height="135" alt="懒图二"></div>
<img src="${PLACEHOLDER_1PX}" width="180" height="135" alt="1像素占位">
<img src="/u/false" width="200" height="200" alt="同域坏地址" style="display:block;width:200px;height:200px;background:#333"></article>
<article class="post card9 weibo-main"><header>${authorHtml({ uid: '6000007003', name: '转发账号' })}
 <a class="_time_cssmod_33" href="http://weibo.com/6000007003/Ps7003">3小时前</a></header><p>转发复用别人用过的图，也必须算自己的一条</p>
<img src="http://wx1.sinaimg.cn:${SITE}/orj360/753.png" width="180" height="135" alt="转发来的图" style="display:block;width:180px;height:135px;background:#222">
<img src="http://wx4.sinaimg.cn:${SITE}/large/753.png" width="180" height="135" alt="同一条里的同一张" style="display:block;width:180px;height:135px;background:#222"></article>
</body></html>`;
}

// 微博信息流筛选：照真页面的虚拟列表复刻 —— 每条微博放在绝对定位的 .vue-recycle-scroller__item-view 槽里
// （transform: translateY），只隐藏 article 会留下 300px 的空槽，正是用户说的「原地一块黑、把上下顶开」。
// 6 条帖子：纯文字 / 有图 / 有视频 / 有图+抽奖 / 转发+有图 / 有音乐。
function filterHtml() {
    const H = 300;
    const posts = [
        // 底部操作条上的「转发」图标（woo-font--retweet）每条微博都有：它绝不能被当成「这条是转发」
        { uid: '6000009001', name: '纯文字账号', body: '<p>今天就随便聊聊，什么图都没有。</p><i class="woo-font woo-font--retweet _retweetIcon_198pe_119"></i>', cls: '' },
        { uid: '6000009002', name: '有图账号', body: '<p>两张图的日常</p>' + [901, 902].map((n) => `<img src="http://wx1.sinaimg.cn:${SITE}/orj360/${n}.png" width="200" height="200" alt="图${n}" style="width:200px;height:200px;background:#222">`).join(''), cls: '' },
        { uid: '6000009003', name: '有视频账号', body: `<p>一段视频</p><div class="_videoBox_abcde_132" style="width:200px;height:120px;background:#222">视频</div>`, cls: '' },
        { uid: '6000009004', name: '抽奖账号', body: `<p>转发抽奖送周边</p><img src="http://wx1.sinaimg.cn:${SITE}/orj360/904.png" width="200" height="200" alt="图904" style="width:200px;height:200px;background:#222">`, cls: '' },
        { uid: '6000009005', name: '转发账号', body: `<p class="_reText_abc_48">//@原作者 这条是转发的</p><img src="http://wx1.sinaimg.cn:${SITE}/orj360/905.png" width="200" height="200" alt="图905" style="width:200px;height:200px;background:#222">`, cls: 'retweet _retweet_abc_86' },
        { uid: '6000009006', name: '有音乐账号', body: `<p>一首歌</p><div class="_musicBox_abc_1" style="height:80px;background:#222">音乐</div>`, cls: '' },
    ];
    const items = [
        { mid: '9001', created_at: 'Tue Oct 20 10:00:00 +0800 2026', text: '今天就随便聊聊，什么图都没有。' },
        { mid: '9002', created_at: 'Tue Oct 20 10:01:00 +0800 2026', text: '两张图的日常', pic_ids: ['a', 'b'] },
        { mid: '9003', created_at: 'Tue Oct 20 10:02:00 +0800 2026', text: '一段视频', page_info: { object_type: 'video' } },
        { mid: '9004', created_at: 'Wed Oct 21 10:03:00 +0800 2026', text: '转发抽奖送周边', pic_ids: ['c'] },
        { mid: '9005', created_at: 'Wed Oct 21 10:04:00 +0800 2026', text: '//@原作者 这条是转发的', retweeted_status: { mid: 'origin' }, pic_ids: ['d'] },
        { mid: '9006', created_at: 'Wed Oct 21 10:05:00 +0800 2026', text: '一首歌', page_info: { object_type: 'music' } },
    ];
    const slots = posts.map((a, i) => `<div class="vue-recycle-scroller__item-view" style="position:absolute;left:0;right:0;top:0;height:${H}px;transform:translateY(${i * H}px) translateX(0px)">
  <article class="post card9 weibo-main ${a.cls}" data-mid="${items[i].mid}" style="height:${H - 12}px;overflow:hidden"><header>${authorHtml({ uid: a.uid, name: a.name })}
    <a class="_time_cssmod_33" href="http://weibo.com/${a.uid}/Pf${a.uid.slice(-3)}" title="${i < 3 ? '2026-10-20' : '2026-10-21'} 09:00">1小时前</a></header>${a.body}</article>
</div>`).join('\n');
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>信息流筛选测试</title>
<style>body{background:#0d1016;color:#ddd;font:13px system-ui;margin:0;padding:20px}
.post{background:#171b23;border:1px solid #2a3040;border-radius:10px;padding:12px;margin:6px;box-sizing:border-box}
header a{color:#8ab4ff;text-decoration:none;margin-right:6px}
.vue-recycle-scroller{position:relative;height:${posts.length * H}px}
.vue-recycle-scroller__item-wrapper{position:relative}</style></head><body>
<div class="vue-recycle-scroller"><div class="vue-recycle-scroller__item-wrapper">
${slots}
</div></div>
<div id="app"></div>
<script>
// 实验模式会在页面主世界里找 #app._vnode.component.data.list —— 这里给一个同形状的假根，
// 数组和目录里的帖子一一对应；__mtbRerender 模拟 Vue 收到数组变化后的重渲染。
window.__mtbFeed = ${JSON.stringify(items)};
document.getElementById('app')._vnode = { component: { type: { name: 'Home' }, data: { list: window.__mtbFeed }, subTree: null } };
window.__mtbRerender = function () {
    const ids = new Set(window.__mtbFeed.map(function (x) { return x.mid; }));
    document.querySelectorAll('article[data-mid]').forEach(function (a) {
        a.parentElement.style.display = ids.has(a.getAttribute('data-mid')) ? '' : 'none';
    });
    return ids.size;
};
</script>
</body></html>`;
}

// 内层容器自己滚的信息流（x.com 那类）：滚过顶部的帖子 rect.top 是大负数，
// 但它们的文档位置是正的 —— 回收节点判定必须把容器的 scrollTop 加回去，不然就把好图当回收帖误杀
function scrollerHtml() {
    // 4 条帖子才够深：容器可视区 320px，内容约 1900px，能真的滚到 1500，
    // 让第一条帖子的图 rect.top 落到 -1200 以下 —— 不然「只加 window.scrollY」的旧算法根本碰不到阈值
    const posts = [
        { uid: '6000008001', name: '容器里第一条' },
        { uid: '6000008002', name: '容器里第二条' },
        { uid: '6000008004', name: '容器里第三条' },
        { uid: '6000008005', name: '容器里第四条' },
    ].map((a, ai) => postHtml(a, ai, 801 + ai * 9)).join('\n');
    const stash = postHtml({ uid: '6000008003', name: '容器里的回收帖' }, 9, 891);
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>内层滚动容器测试</title>
<style>body{background:#0d1016;color:#ddd;font:13px system-ui;margin:20px}
.feed{position:relative;height:320px;overflow-y:auto;border:1px solid #2a3040}
.post{background:#171b23;border:1px solid #2a3040;border-radius:10px;padding:12px;margin:0 0 18px;width:600px}
header a{color:#8ab4ff;text-decoration:none;margin-right:6px}
.grid{display:grid;grid-template-columns:repeat(3,180px);gap:6px;margin-top:8px;padding:0;list-style:none}
.cell{position:relative}
.grid img.badge{position:absolute;top:2px;right:2px;width:20px;height:14px}
.grid img{width:180px;height:135px;object-fit:cover;display:block;background:#000}</style></head><body>
<div class="feed">${posts}<div class="recycled" style="position:absolute;top:-9000px;left:0">${stash}</div></div>
<script>
// 后台标签页不一定立刻接受 scrollTop，重试到真的滚起来为止（断言里会验它确实滚了 1500）
const tick = () => { const f = document.querySelector('.feed'); if (f && f.scrollTop < 1000) f.scrollTop = 1500; };
addEventListener('load', tick); setInterval(tick, 200);
</script>
</body></html>`;
}

const counters = { uploads: 0, prompts: 0, filenames: [], imgProxy: 0, tiers: {}, dest: {}, tierDest: {} };
const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/nine.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(u.searchParams.get('shapes') === '1' ? shapesHtml()
            : u.searchParams.get('fold') === '1' ? foldHtml()
                : u.searchParams.get('filter') === '1' ? filterHtml()
                : u.searchParams.get('scroller') === '1' ? scrollerHtml()
                    : u.searchParams.get('lazy') === '1' ? lazyHtml() : fixtureHtml(u.searchParams.get('extra') === 'weibo'));
        return;
    }
    // 折叠九宫格的补齐接口（形状照抄微博 /ajax/statuses/show）：DOM 里 9 张，这里给 6 张额外图
    if (u.pathname === '/ajax/statuses/show') {
        const pids = ['FOLD01', 'FOLD02', 'FOLD03', 'FOLD04', 'FOLD05', 'FOLD06'];
        const pic_infos = {};
        pids.forEach((p, i) => {
            pic_infos[p] = { large: { url: `http://wx2.sinaimg.cn:${SITE}/orj960/96${i + 1}.png`, width: 960, height: 1445 } };
        });
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: 1, pic_ids: pids, pic_infos }));
        return;
    }
    // 故意不响应的图：浏览器永远解码不完（naturalWidth 保持 0），用来验「没解码的图也该收进列表」
    if (/^\/slow\/\d+\.png$/.test(u.pathname)) {
        req.socket.setTimeout(0);
        return;
    }
    if (/\.png$/i.test(u.pathname)) {
        // 页面自己加载的 <img> 是 sec-fetch-dest:image；后台代理 fetch 的才是我们要验的路径，
        // 顺带记下请求了哪一档（orj360/mw690/mw2000/large）
        const dest = String(req.headers['sec-fetch-dest'] || '(none)');
        const referer = String(req.headers.referer || '');
        counters.dest[dest] = (counters.dest[dest] || 0) + 1;
        if (referer.includes(PAGE_HOST) && dest !== 'image') {
            counters.imgProxy++;
            const tier = u.pathname.split('/')[1] || '?';
            if (/^(?:orj\d+|mw\d+|wap\d+|tw\d+|square|bmiddle|large|thumb\d*)$/i.test(tier)) {
                counters.tiers[tier] = (counters.tiers[tier] || 0) + 1;
            }
            counters.tierDest = counters.tierDest || {};
            counters.tierDest[dest] = (counters.tierDest[dest] || 0) + 1;
        }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        res.end(/\/750\.png$/.test(u.pathname) ? PNG_LONG : PNG);
        return;
    }
    if (u.pathname === '/upload/image' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            counters.uploads++;
            const body = Buffer.concat(chunks).toString('latin1');
            const m = body.match(/filename="([^"]+)"/);
            if (m) counters.filenames.push(m[1]);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ name: m ? m[1] : 'x.png' }));
        });
        return;
    }
    if (u.pathname === '/prompt' && req.method === 'POST') {
        req.resume();
        req.on('end', () => {
            counters.prompts++;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ prompt_id: 'p' + counters.prompts }));
        });
        return;
    }
    res.writeHead(404);
    res.end('not found');
});
await new Promise((r) => server.listen(SITE, '127.0.0.1', r));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mtb-gallery-'));
// 夹具里的图走真微博的 CDN 形状（wx*.sinaimg.cn / tvax1 / h5），两种模式都要解析到本地，
// 才能验尺寸档位 orj360 → mw690（卡片）→ mw2000（查看器）→ large（只有发送才用）。
// 走不走微博分支只由页面 host 决定，所以 weibo.com 只在 --weibo-host 时映射。
// 注意：--host-resolver-rules 的多条规则必须用「逗号」分隔，用空格拼会整条失效（页面直接变成打不开）。
const HOST_MAPS = ['MAP wx1.sinaimg.cn 127.0.0.1', 'MAP wx2.sinaimg.cn 127.0.0.1',
    'MAP wx3.sinaimg.cn 127.0.0.1', 'MAP wx4.sinaimg.cn 127.0.0.1',
    'MAP tvax1.sinaimg.cn 127.0.0.1', 'MAP h5.sinaimg.cn 127.0.0.1'];
if (WEIBO_HOST) HOST_MAPS.unshift('MAP weibo.com 127.0.0.1');
const proc = spawn(BROWSER, [
    ...(HEADED ? [] : ['--headless=new']), '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    `--load-extension=${ROOT}`, `--disable-extensions-except=${ROOT}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1400,900',
    `--host-resolver-rules=${HOST_MAPS.join(',')}`,
    'about:blank',
], { stdio: 'ignore' });
let cdp = null;
for (let i = 0; i < 100; i++) { await wait(300); try { cdp = await Cdp.connect(CDP); break; } catch (e) { /* 等启动 */ } }
if (!cdp) { console.log(JSON.stringify({ fatal: 'CDP 不可达' })); process.exit(1); }

function unpackedId(dir) {
    return crypto.createHash('sha256').update(Buffer.from(dir, 'utf16le')).digest('hex').slice(0, 32)
        .split('').map((x) => String.fromCharCode(97 + parseInt(x, 16))).join('');
}
const extId = unpackedId(ROOT);
let swSess = null;
for (let i = 0; i < 60 && !swSess; i++) {
    await wait(300);
    const sw = (await cdp.targets()).find((t) => t.type === 'service_worker' && new URL(t.url).host === extId);
    if (sw) swSess = await cdp.attach(sw.targetId).catch(() => null);
}
step('扩展加载 / 认领 SW', !!swSess, { extId });

const page = await cdp.open(`http://${PAGE_HOST}:${SITE}/nine.html`);
for (let i = 0; i < 40; i++) { if (await cdp.ev(page, `!!document.getElementById('mtb-root')`)) break; await wait(300); }
const ready = await cdp.ev(page, `({root:!!document.getElementById('mtb-root'), imgs:document.images.length})`);
step('内容脚本注入', !!(ready && ready.root && ready.imgs >= 18), { ready });

const thumbHover = await cdp.ev(page, `(async()=>{
  const img=document.querySelector('.grid img');
  const wrap=document.getElementById('mtb-root').shadowRoot.querySelector('.wrap');
  let shown=false;
  for(let i=0;i<5&&!shown;i++){
    const b=img.getBoundingClientRect(); const x=b.left+b.width/2, y=b.top+b.height/2;
    img.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,composed:true,clientX:x,clientY:y}));
    document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,composed:true,clientX:x,clientY:y}));
    await new Promise((res)=>setTimeout(res,200));
    shown=wrap.classList.contains('show');
  }
  return {shown};
})()`);
step('九宫格缩略图悬停不弹工具栏', thumbHover && !thumbHover.shown, thumbHover);

const viewerHover = await cdp.ev(page, `(async()=>{
  document.querySelector('.thumb').click();
  await new Promise(r=>setTimeout(r,150));
  const img=document.getElementById('viewerImg');
  const wrap=document.getElementById('mtb-root').shadowRoot.querySelector('.wrap');
  const fire=()=>{const r=img.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;
    img.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,composed:true,clientX:x,clientY:y}));
    document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,composed:true,clientX:x,clientY:y}));};
  let shown=false;
  for(let i=0;i<14&&!shown;i++){fire();await new Promise(r=>setTimeout(r,180));shown=wrap.classList.contains('show');}
  return {shown, buttons:[...wrap.querySelectorAll('button.btn')].map(b=>b.textContent.trim()).slice(0,8)};
})()`);
step('点开后的大图悬停出工具栏', !!(viewerHover && viewerHover.shown && viewerHover.buttons.length >= 3), viewerHover);
await cdp.ev(page, `(()=>{document.getElementById('viewer').style.display='none';return true})()`);
await wait(500);

const tabInfo = await cdp.ev(swSess, `chrome.tabs.query({}).then(ts=>ts.filter(t=>(t.url||'').includes('${PAGE_HOST}:${SITE}/nine.html')).map(t=>({id:t.id,url:t.url,title:t.title})))`);
const tabId = tabInfo && tabInfo[0] && tabInfo[0].id;
step('找到夹具标签页', !!tabId, { tabId, tabInfo });

const cfg = {
    server: `http://127.0.0.1:${SITE}`,
    mode: 'api',
    workflowJson: JSON.stringify({ 1: { class_type: 'LoadImage', inputs: { image: '' } } }),
    targetNodeId: '1',
    targetNodeType: '',
    uploadFolders: 'input',
    autoQueue: false,
};
const setOk = await cdp.ev(swSess, `(async()=>{const d=await chrome.storage.local.get(['mtbSettings']);const s=d.mtbSettings||{};s.comfy=Object.assign({},s.comfy,${JSON.stringify(cfg)});await chrome.storage.local.set({mtbSettings:s});return s.comfy.server})()`);
step('写入测试 ComfyUI 配置', setOk === cfg.server, { server: setOk });

// 不传 tabId：模拟扩展 popup 自己找当前活动标签页；按 popup 最大尺寸渲染
const gallery = await cdp.open(`chrome-extension://${extId}/gallery.html`);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, gallery);
// 同一份微博形状的 HTML，两个分支的预期不同：微博分支靠表头 class 词根（_link_/_name_）认账户名（4 组）；
// 非微博 host 走通用规则，认不出 `_link_ …` 指回分组页的那种（丙丁并进页面组 = 3 组）。
const EXP_GROUPS = WEIBO_HOST ? 4 : 3;
const EXP_AUTHORS = WEIBO_HOST ? ['甲', '乙', '丙', '丁'] : ['甲', '乙'];
let info = null;
for (let i = 0; i < 80; i++) {
    info = await cdp.ev(gallery, `(()=>{const gs=[...document.querySelectorAll('.g-group:not(.g-junk) .g-group-name')].map(x=>x.textContent);return {groups:gs.length,names:gs,cards:document.querySelectorAll('.g-card').length,summary:(document.querySelector('#summary')||{}).textContent||'',err:(document.querySelector('#emptyTitle')||{}).textContent||''}})()`);
    if (info && info.groups === EXP_GROUPS && info.cards === 36) break;
    await wait(300);
}
step(`本页图片按发帖账户分成 ${EXP_GROUPS} 组、共 36 张`, !!(info && info.groups === EXP_GROUPS && info.cards === 36), info);
step('分组名是作者不是时间/链接文字', !!(info && EXP_AUTHORS.every((n) => info.names.some((x) => x.replace(/^@/, '').includes(n)))
    // 「18小时前」那条时间链接、和正文里的 @提及，都不能顶掉表头的账户名
    && info.names.every((x) => !/小时前|天前|分钟前/.test(x) && !x.includes('转发对象'))
    && !(WEIBO_HOST && info.names.some((x) => x.includes('未识别账号')))), { names: info && info.names });
// 虚拟列表搬画布外的回收帖（top:-9753）：图还在 DOM 里、尺寸也正常，但不该出现在面板里
step('被虚拟列表搬到画布外的回收帖不混进列表', !!(info && info.cards === 36 && info.names.every((x) => !x.includes('被回收'))), { names: info && info.names, cards: info && info.cards });
// 少掉的图必须说清楚去哪儿了，不能闷声丢；「无用图片」收进折叠组而不是丢掉
const dropNote = await cdp.ev(gallery, `(()=>{const s=document.querySelector('#summary');return {text:s.textContent,title:s.title}})()`);
step('摘要写明「无用图片 N 张」并给出原因分布',
    !!(dropNote && /无用图片 \d+ 张/.test(dropNote.text) && /画布外|回收|图标|重复|头像/.test(dropNote.title)), dropNote);

// 大卡片 + 懒加载：只有进过视口的才该出图，滚到底后其余必须补上
let loaded = null;
for (let i = 0; i < 40; i++) {
    loaded = await cdp.ev(gallery, `(()=>{const imgs=[...document.querySelectorAll('.g-card img')];
      return {n:imgs.length,loaded:imgs.filter(x=>x.naturalWidth>0).length,fail:document.querySelectorAll('.g-card.imgfail').length,
        card:document.querySelectorAll('.g-card[data-tier="card"]').length,thumbTier:document.querySelectorAll('.g-card[data-tier="thumb"]').length}})()`);
    if (loaded && loaded.loaded >= 6) break;
    await wait(250);
}
step('首屏卡片直接显示 mw690 大图（不铺页面小图）', !!(loaded && loaded.loaded >= 6 && loaded.loaded < 36 && !loaded.fail
    && loaded.card >= 6 && loaded.thumbTier === 0), { ...loaded, imgProxy: counters.imgProxy });
// 后台目标拿不到多少渲染帧，IntersectionObserver 只会补发一部分，所以只断言"滚动后出图数明显变多且零失败"
const scrolled = await cdp.ev(gallery, `(async()=>{const m=document.querySelector('.g-main');
  for(let y=0;y<=m.scrollHeight;y+=360){m.scrollTop=y;await new Promise(r=>setTimeout(r,110));}
  await new Promise(r=>setTimeout(r,1200));
  const imgs=[...document.querySelectorAll('.g-card img')];
  const out={n:imgs.length,loaded:imgs.filter(x=>x.naturalWidth>0).length,fail:document.querySelectorAll('.g-card.imgfail').length};
  m.scrollTop=0; return out;
})()`);
step('滚到底后继续补出图（懒加载不丢图、无加载失败）', !!(scrolled && scrolled.n === 36 && scrolled.loaded > 6
    && !scrolled.fail), { ...scrolled, imgProxy: counters.imgProxy });

const layout = await cdp.ev(gallery, `(()=>{
  const de=document.documentElement, m=document.querySelector('.g-main');
  const rects=[...document.querySelectorAll('.g-group')].map((x)=>{const r=x.getBoundingClientRect();return {left:Math.round(r.left),top:Math.round(r.top),bottom:Math.round(r.bottom)}});
  const stacked=rects.length>1&&rects.every((r,i)=>i===0?(r.left===rects[0].left):(r.left===rects[0].left&&r.top>=rects[i-1].bottom-1));
  const card=document.querySelector('.g-card').getBoundingClientRect();
  const thumb=document.querySelector('.g-thumb').getBoundingClientRect();
  return {sw:de.scrollWidth,sh:de.scrollHeight,iw:innerWidth,ih:innerHeight,bh:Math.round(document.body.getBoundingClientRect().height),
    mainScroll:m.scrollHeight,mainClient:m.clientHeight,stacked,rects,
    cols:Number(getComputedStyle(document.querySelector('#groups')).getPropertyValue('--cols').trim()),
    card:Math.round(card.width), thumb:Math.round(thumb.width),
    square: Math.abs(thumb.width-thumb.height)<=2,
    url:(document.querySelector('.g-url')||{}).textContent||'',
    tags:[...(document.querySelector('.g-bar')||{querySelectorAll:()=>[]}).querySelectorAll('.g-tag')].map(x=>x.textContent),
    zoom:((document.querySelector('.g-bar .g-zoom')||{}).textContent)||'',
    fit:(()=>{const im=document.querySelector('.g-card img'); if(!im) return ''; return getComputedStyle(im).objectFit;})(),
    bg:(()=>{const im=document.querySelector('.g-card img'); if(!im) return ''; return getComputedStyle(im).backgroundColor;})(),
    imgH:(()=>{const im=document.querySelector('.g-card img'); return im?Math.round(im.getBoundingClientRect().height):0;})(),
    thumbH:(()=>{const t=document.querySelector('.g-thumb'); return t?Math.round(t.getBoundingClientRect().height):0;})()};
})()`);
step('微博分组一律上下排列（不并列）', !!(layout && layout.stacked), { rects: layout && layout.rects, card: layout && layout.card });
step('大卡片网格：每行固定三张、方形缩略图、URL 与角标齐全、无横向滚动', !!(layout && layout.sw <= layout.iw + 1
    && layout.stacked && layout.cols === 3 && layout.card >= 180 && layout.square
    && /^https?:/.test(layout.url) && layout.tags.length === 2
    && !layout.tags.some((t) => /档位|mw\d+|orj\d+|large|缩略图|sinaimg/.test(t))
    && layout.zoom === '⤢'), layout);
// 用户要求：不截断、等比例、多余留黑边（夹具图 4:3 放进方形框，contain 后上下应有黑边）
step('卡片图不裁切（object-fit: contain）+ 黑底铺满方框（等比留黑边）', !!(layout && layout.fit === 'contain'
    && layout.bg === 'rgb(0, 0, 0)' && layout.thumbH > 0 && layout.imgH === layout.thumbH),
    { fit: layout && layout.fit, bg: layout && layout.bg, imgH: layout && layout.imgH, thumbH: layout && layout.thumbH });

// 浏览器给 popup 的可视区可能比 800 小：面板要钉成实际视口宽，宽度刚好铺满、不出横向滚动条。
// 后台标签页的 setTimeout 会被节流到 1s 一档，所以轮询等它自己收敛，别写死等待时长。
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 600, deviceScaleFactor: 1, mobile: false }, gallery);
// 后台目标上改模拟视口不一定派发 resize，手动补一发（产品侧就是靠这个事件重钉面板尺寸）
await cdp.ev(gallery, `dispatchEvent(new Event('resize'))`);
const narrowProbe = `(()=>{const de=document.documentElement,b=document.body;
  const gs=[...document.querySelectorAll('.g-group')].map((x)=>{const r=x.getBoundingClientRect();return {left:Math.round(r.left),top:Math.round(r.top)}});
  return {iw:innerWidth,bw:Math.round(b.getBoundingClientRect().width),sw:de.scrollWidth,sh:de.scrollHeight,ih:innerHeight,
    cols:getComputedStyle(document.querySelector('#groups')).getPropertyValue('--cols').trim(),
    card:Math.round(document.querySelector('.g-card').getBoundingClientRect().width),
    stacked:gs.length>1&&gs.every((r,i)=>i===0||(r.left===gs[0].left&&r.top>gs[i-1].top))}})()`;
let narrow = null;
for (let i = 0; i < 30; i++) {
    narrow = await cdp.ev(gallery, narrowProbe);
    if (narrow && narrow.bw === narrow.iw && narrow.sw <= narrow.iw + 1) break;
    await wait(300);
}
step('560 窄视口仍保持每行三张、宽度刚好铺满且无横向滚动', !!(narrow && narrow.sw <= narrow.iw + 1 && narrow.sh <= narrow.ih + 1
    && narrow.bw === narrow.iw && narrow.stacked && Number(narrow.cols) === 3 && narrow.card >= 140), narrow);
// 用户要的是「每行三张」：480 宽也要三张，只有再窄才退两列
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 600, deviceScaleFactor: 1, mobile: false }, gallery);
await cdp.ev(gallery, `dispatchEvent(new Event('resize'))`);
let tiny = null;
for (let i = 0; i < 30; i++) {
    tiny = await cdp.ev(gallery, narrowProbe);
    if (tiny && tiny.bw === tiny.iw && tiny.sw <= tiny.iw + 1) break;
    await wait(300);
}
step('480 宽仍保持每行三张（低于才退两列）', !!(tiny && Number(tiny.cols) === 3 && tiny.card >= 130 && tiny.sw <= tiny.iw + 1), tiny);
try {
    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' }, gallery);
    fs.writeFileSync(path.join(ROOT, 'test/out_gallery_narrow.png'), Buffer.from(shot2.data, 'base64'));
} catch (e) { /* 仅排查用 */ }
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, gallery);
await cdp.ev(gallery, `dispatchEvent(new Event('resize'))`);
for (let i = 0; i < 30; i++) {
    const back = await cdp.ev(gallery, narrowProbe);
    if (back && back.bw === back.iw && back.iw === 800) break;
    await wait(300);
}
// 大窗模式：popup 撑死 800 宽，?wide=1 走独立窗口，同一份面板要能铺满更大的窗口
const wide = await cdp.open(`chrome-extension://${extId}/gallery.html?wide=1&tabId=${tabId}`);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false }, wide);
let wideInfo = null;
for (let i = 0; i < 60; i++) {
    wideInfo = await cdp.ev(wide, `(()=>{const de=document.documentElement,m=document.querySelector('.g-main');
      const gs=[...document.querySelectorAll('.g-group')].map((x)=>{const r=x.getBoundingClientRect();return {left:Math.round(r.left),top:Math.round(r.top)}});
      return {wide:de.classList.contains('wide'),groups:gs.length,cards:document.querySelectorAll('.g-card').length,
        card:Math.round((document.querySelector('.g-card')||{getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width),
        btnHidden:document.querySelector('#btnWide').hidden,sw:de.scrollWidth,sh:de.scrollHeight,iw:innerWidth,ih:innerHeight,
        stacked:gs.length>1&&gs.every((r,i)=>i===0||(r.left===gs[0].left&&r.top>gs[i-1].top))}})()`);
    if (wideInfo && wideInfo.cards === 36) break;
    await wait(250);
}
step('大窗模式铺满窗口、卡片明显变大且不溢出', !!(wideInfo && wideInfo.wide && wideInfo.cards === 36 && wideInfo.stacked
    && wideInfo.btnHidden && wideInfo.card >= 260 && wideInfo.sw <= wideInfo.iw + 1 && wideInfo.sh <= wideInfo.ih + 1), wideInfo);
try {
    const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png' }, wide);
    fs.writeFileSync(path.join(ROOT, 'test/out_gallery_wide.png'), Buffer.from(shot3.data, 'base64'));
} catch (e) { /* 仅排查用 */ }
await cdp.ev(swSess, `chrome.tabs.query({}).then(ts=>Promise.all(ts.filter(t=>(t.url||'').includes('gallery.html?wide=1')).map(t=>chrome.tabs.remove(t.id)))).then(()=>true)`).catch(() => {});

await wait(200);
try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, gallery);
    fs.writeFileSync(path.join(ROOT, 'test/out_gallery.png'), Buffer.from(shot.data, 'base64'));
} catch (e) { /* 截图只用于排查，不影响断言 */ }

const groupSel = await cdp.ev(gallery, `(()=>{const c=document.querySelector('.g-group input[type=checkbox]');c.click();return {checked:c.checked,count:document.querySelector('#selCount').textContent,sel:document.querySelectorAll('.g-card.sel').length}})()`);
step('分组全选只选该组 9 张', !!(groupSel.checked && groupSel.sel === 9 && /9/.test(groupSel.count)), groupSel);
await cdp.ev(gallery, `(()=>{const c=document.querySelector('.g-group input[type=checkbox]');c.click();return true})()`);
const lb = await cdp.ev(gallery, `(async()=>{
  document.querySelector('.g-zoom').click();
  await new Promise(r=>setTimeout(r,150));
  const el=document.querySelector('#lightbox');
  const out={open:!el.hidden,meta:document.querySelector('#lbMeta').textContent};
  document.querySelector('#lbClose').click();
  out.closed=el.hidden;
  return out;
})()`);
step('缩略图角标能打开大图预览并关闭', !!(lb && lb.open && lb.closed && /1\/36/.test(lb.meta)), lb);
// 卡片只拉 card 档（mw690，实测 41KB），查看器拉 full 档（mw2000，实测 283KB）；
// 浏览阶段谁都不该去拉 large 原图（实测 7008×4672 / 4.2MB，一张就把面板拖死在缩略图上）。
// 普通站点分支不改图片地址（weibo=false），所以那边根本不该出现档位请求。
const tierDom = await cdp.ev(gallery, `(()=>{const cs=[...document.querySelectorAll('.g-card')];
  return {cards:cs.length, card:cs.filter(c=>c.dataset.tier==='card').length, thumb:cs.filter(c=>c.dataset.tier==='thumb').length,
    full:cs.filter(c=>c.dataset.tier==='full'||c.dataset.tier==='orig').length, lb:(document.querySelector('#lbImg')||{dataset:{}}).dataset.tier||''}})()`);
step(WEIBO_HOST ? '卡片实际显示 mw690、查看器升 mw2000，没有退回缩略图' : '普通站点分支不改图片地址（卡片按原地址显示）',
    WEIBO_HOST ? !!(tierDom && tierDom.card >= 6 && tierDom.thumb === 0 && tierDom.lb === 'full')
        : !counters.tiers.large,
    { tierDom, tiers: counters.tiers });

// 微博分支：同一份采集器传 weibo:true，验证账户分组与 orj360→large 升级
const extra = await cdp.open(`http://${PAGE_HOST}:${SITE}/nine.html?extra=weibo`);
await wait(1200);
const extraIds = await cdp.ev(swSess, `chrome.tabs.query({}).then(ts=>ts.filter(t=>(t.url||'').includes('extra=weibo')).map(t=>t.id))`);
const extraTabId = extraIds && extraIds[0];
const wres = extraTabId ? await cdp.ev(gallery, `(async()=>{
  const m=await import('/src/gallery/collect.mjs');
  const rr=await chrome.scripting.executeScript({target:{tabId:${extraTabId}},func:m.collectPageImages,args:[{weibo:true,max:400}]});
  return rr[0]&&rr[0].result;
})()`) : null;
const witems = wres ? wres.groups.filter((g) => !g.junk).flatMap((g) => g.items) : [];
step('微博模式：按 6 条微博分组（九宫格 9 张算一条）、缩略图一律升到 large、卡片/查看器各用自己的档位',
    !!(wres && wres.weibo === true && wres.groups.filter((g) => !g.junk).length === 6 && wres.total === 38
        && wres.groups.filter((g) => !g.junk).filter((g) => g.items.length === 9).length === 4
        && new Set(wres.groups.filter((g) => !g.junk).map((g) => g.label)).size === 5
        && wres.groups.some((g) => /第二条/.test(g.sub || ''))
        && witems.some((x) => /\/large\/fixture\.jpg$/i.test(x.url))
        && witems.some((x) => /\/large\/fixture2\.jpg$/i.test(x.url))
        && !witems.some((x) => /\/(?:orj\d+|mw\d+|wap\d+|tw\d+|square|bmiddle|thumb\d*)\//i.test(x.url))
        && witems.every((x) => /\/mw690\//i.test(x.card) && /\/mw2000\//i.test(x.full))
        // 画布外那条回收帖（top:-9753）的 9 张不能混进来
        && !witems.some((x) => /被回收/.test(x.alt || ''))),
    { groups: wres && wres.groups.map((g) => g.label), total: wres && wres.total, tiers: witems.slice(-1).map((x) => [x.url, x.card, x.full]) });
if (extraTabId) await cdp.ev(swSess, `chrome.tabs.remove(${extraTabId}).then(()=>true)`).catch(() => {});
// 三种容易被误杀的真实形状：长图（比例 12、短边 150）、还没解码且在跳过渲染容器里的懒图、1×1 的 data: 占位图。
// 前两种必须收（面板是自己带 Referer 取字节的，浏览器解不解码跟能不能给用户看不相干），最后一种必须不收。
const shapesPage = await cdp.open(`http://${PAGE_HOST}:${SITE}/nine.html?shapes=1`);
await wait(900);
const shapeIds = await cdp.ev(swSess, `chrome.tabs.query({}).then(ts=>ts.filter(t=>(t.url||'').includes('shapes=1')).map(t=>t.id))`);
const shapeTabId = shapeIds && shapeIds[0];
const sres = shapeTabId ? await cdp.ev(gallery, `(async()=>{
  const m=await import('/src/gallery/collect.mjs');
  const rr=await chrome.scripting.executeScript({target:{tabId:${shapeTabId}},func:m.collectPageImages,args:[{weibo:true,max:400}]});
  return rr[0]&&rr[0].result;
})()`) : null;
const sit = sres ? sres.groups.filter((g) => !g.junk).flatMap((g) => g.items) : [];
step('长图（比例 12）与未解码的懒图都收；1×1 占位图不收；转发复用同一 pid 也各算一条（组内仍去重）',
    !!(sres && sit.length === 5 && sres.groups.filter((g) => !g.junk).length === 3
        && [/\/750\.png$/, /\/751\.png$/, /\/752\.png$/].every((re) => sit.some((x) => re.test(x.url)))
        && sit.filter((x) => /\/753\.png$/.test(x.url)).length === 2
        && sres.groups.every((g) => new Set(g.items.map((x) => x.url)).size === g.items.length)
        && sit.every((x) => !/^data:image\//i.test(x.url))
        && sit.some((x) => /\/750\.png$/.test(x.url) && x.height >= 1800)),
    { groups: sres && sres.groups.map((g) => [String(g.label).slice(0, 10), g.items.length]), items: sit.map((x) => [String(x.url).replace(/^https?:\/\/[^/]+/, '').slice(0, 24), x.width + 'x' + x.height]) });
// 同域坏地址（解析成 https://weibo.com/u/false）既不算内容图，也不该进无用图片组
const badUrl = sres ? sres.groups.flatMap((g) => g.items).filter((x) => /\/u\/false/i.test(String(x.url))) : [];
step('同域坏地址（/u/false）不收，也不进无用图片组', !!(sres && badUrl.length === 0), { bad: badUrl.map((x) => x.url) });
if (shapeTabId) await cdp.ev(swSess, `chrome.tabs.remove(${shapeTabId}).then(()=>true)`).catch(() => {});
// 折叠九宫格：DOM 里只有 9 张，角标「+6」的另外 6 张必须靠微博接口补齐（真页面实测 15 张只挂 9 张）
const foldPage = await cdp.open(`http://${PAGE_HOST}:${SITE}/nine.html?fold=1`);
await wait(900);
const foldIds = await cdp.ev(swSess, `chrome.tabs.query({}).then(ts=>ts.filter(t=>(t.url||'').includes('fold=1')).map(t=>t.id))`);
const foldTabId = foldIds && foldIds[0];
const fres = foldTabId ? await cdp.ev(gallery, `(async()=>{
  const m=await import('/src/gallery/collect.mjs');
  const rr=await chrome.scripting.executeScript({target:{tabId:${foldTabId}},func:m.collectPageImages,args:[{weibo:true,max:400}]});
  return rr[0]&&rr[0].result;
})()`) : null;
const fitems = fres ? (fres.groups.find((g) => !g.junk) || { items: [] }).items : [];
step('被折叠的九宫格靠接口补齐（DOM 9 张 + 接口 6 张 = 15 张，补来的也有大图档）',
    !!(fres && fres.total === 15 && fres.enriched === 6 && fitems.length === 15
        && fitems.filter((x) => /\/96\d\.png$/.test(x.url)).length === 6
        && fitems.every((x) => /\/mw690\//.test(x.card) && /\/mw2000\//.test(x.full))),
    { total: fres && fres.total, enriched: fres && fres.enriched, got: fitems.length, sample: fitems.slice(-2).map((x) => [String(x.url).replace(/^https?:\/\/[^/]+/, ''), String(x.card).replace(/^https?:\/\/[^/]+/, '')]) });
if (foldTabId) await cdp.ev(swSess, `chrome.tabs.remove(${foldTabId}).then(()=>true)`).catch(() => {});

// 内层容器自己滚的信息流：滚过顶部的帖子 rect.top 是大负数，但文档位置是正的，必须仍被收进来；
// 同一个容器里 top:-9000 的回收节点照旧挡掉
const scrollerPage = await cdp.open(`http://${PAGE_HOST}:${SITE}/nine.html?scroller=1`);
await wait(900);
const scrollIds = await cdp.ev(swSess, `chrome.tabs.query({}).then(ts=>ts.filter(t=>(t.url||'').includes('scroller=1')).map(t=>t.id))`);
const scrollerTabId = scrollIds && scrollIds[0];
const cresRaw = scrollerTabId ? await cdp.ev(gallery, `(async()=>{
  const m=await import('/src/gallery/collect.mjs');
  const rr=await chrome.scripting.executeScript({target:{tabId:${scrollerTabId}},func:m.collectPageImages,args:[{weibo:true,max:400}]});
  const st=await chrome.scripting.executeScript({target:{tabId:${scrollerTabId}},func:()=>({
    scrollTop:Math.round(document.querySelector('.feed').scrollTop),
    firstTop:Math.round(document.querySelector('.feed article').getBoundingClientRect().top)})});
  return { res: rr[0]&&rr[0].result, st: st[0]&&st[0].result };
})()`) : null;
const cres = cresRaw && cresRaw.res;
const cstate = cresRaw && cresRaw.st;
const cit = cres ? cres.groups.filter((g) => !g.junk).flatMap((g) => g.items) : [];
// 前置条件也必须是断言的一部分：容器真的滚了 1500、第一条帖子的 rect.top 真的负到 -800 以外，
// 这条测试才有意义（后台标签页里 scrollTop 不一定生效，写死一次就会变成永远绿的假绿）
step('内层滚动容器里滚过的帖子不算回收节点（容器 scrollTop 要加回文档坐标）',
    !!(cres && cstate && cstate.scrollTop >= 1200 && cstate.firstTop < -1200
        && cit.length === 36 && cres.groups.filter((g) => !g.junk).length === 4
        && cres.groups.filter((g) => !g.junk).every((g) => g.items.length === 9)
        && cres.groups.every((g) => !/回收/.test(String(g.label)))),
    { scroll: cstate, got: cres && cres.total, groups: cres && cres.groups.map((g) => [String(g.label).slice(0, 12), g.items.length]), dropHist: cres && cres.dropHist });
if (scrollerTabId) await cdp.ev(swSess, `chrome.tabs.remove(${scrollerTabId}).then(()=>true)`).catch(() => {});
// 组内「反选」：只翻转这一条微博的勾选，别的组一条不动（用户要的是发过几张之后能把剩下的挑出来）
const invScope = await cdp.ev(gallery, `(async()=>{
  const gs=[...document.querySelectorAll('.g-group:not(.g-junk)')];
  const selIn=(g)=>[...g.querySelectorAll('.g-card')].filter(c=>c.classList.contains('sel')).length;
  gs[0].querySelector('.g-group-head input[type=checkbox]').click();
  gs[1].querySelector('.g-group-head input[type=checkbox]').click();
  await new Promise(r=>setTimeout(r,250));
  const before={a:selIn(gs[0]),b:selIn(gs[1]),total:document.querySelectorAll('.g-card.sel').length};
  gs[0].querySelector('.g-group-inv').click();
  await new Promise(r=>setTimeout(r,250));
  const after={a:selIn(gs[0]),b:selIn(gs[1]),total:document.querySelectorAll('.g-card.sel').length,
    count:document.querySelector('#selCount').textContent};
  gs[0].querySelector('.g-group-inv').click();
  await new Promise(r=>setTimeout(r,250));
  const back={a:selIn(gs[0]),total:document.querySelectorAll('.g-card.sel').length};
  return {before,after,back,hasInv:gs.every((g)=>!!g.querySelector('.g-group-inv'))};
})()`);
step('组内反选只翻转这一条微博：别组不动，再点一次能翻回来',
    !!(invScope && invScope.hasInv && invScope.before.a === 9 && invScope.before.b === 9 && invScope.before.total === 18
        && invScope.after.a === 0 && invScope.after.b === 9 && invScope.after.total === 9 && /9/.test(invScope.after.count)
        && invScope.back.a === 9 && invScope.back.total === 18), invScope);
await cdp.ev(gallery, `document.querySelector('#btnClear').click()`);
await wait(200);
await cdp.ev(gallery, `(()=>{const c=document.querySelector('#selAll');c.click();return c.checked})()`);
await wait(250);
const sel = await cdp.ev(gallery, `({text:document.querySelector('#selCount').textContent, cards:document.querySelectorAll('.g-card.sel').length})`);
step('全选 36 张', sel && sel.cards === 36 && /36/.test(sel.text), sel);

await cdp.ev(gallery, `document.querySelector('#btnSendRun').click()`);
let sent = null;
for (let i = 0; i < 160; i++) {
    sent = await cdp.ev(gallery, `({status:document.querySelector('#status').textContent, sent:document.querySelectorAll('.g-card.sent').length, failed:document.querySelectorAll('.g-card.failed').length, running:!document.querySelector('#btnCancel').hidden})`);
    if (sent && /完成|停止/.test(sent.status)) break;
    await wait(250);
}
step('批量发送完成且 36 张全部成功', !!(sent && sent.sent === 36 && sent.failed === 0 && /成功 36/.test(sent.status)), sent);
const bstate = await cdp.ev(gallery, `(async()=>{const r=await chrome.runtime.sendMessage({action:'galleryBatchState'});return r&&r.state})()`);
step('批次实际跑在后台（状态已完成 36/0）', !!(bstate && bstate.running === false && bstate.ok === 36 && bstate.fail === 0 && bstate.finishedAt > 0), { running: bstate && bstate.running, ok: bstate && bstate.ok, fail: bstate && bstate.fail });
step('假 ComfyUI 收到 36 次上传 / 36 次排队', counters.uploads === 36 && counters.prompts === 36, { uploads: counters.uploads, prompts: counters.prompts });
step('上传文件名带上序号且互不重复', counters.filenames.length === 36 && new Set(counters.filenames).size === 36 && counters.filenames.every((n) => /^mtb_/.test(n)), { names: counters.filenames.slice(0, 3) });
// 只有真正发给 ComfyUI 才拉 large 原图（浏览阶段一张都不该拉，见前面那条档位断言）
step('发送时才取 large 原图（36 张）', (counters.tiers.large || 0) >= 36, counters.tiers);

// 用户的真实场景：一条九宫格先发了 3 张，点一下组里的「反选」就要把这条里剩下没发的 6 张选中。
// 发送成功的卡片勾不会掉，所以「组内翻转」正好等于「取消已发送、选中未发送」
const invPart = await cdp.ev(gallery, `(async()=>{
  document.querySelector('#btnClear').click();
  await new Promise(r=>setTimeout(r,200));
  const g=document.querySelector('.g-group:not(.g-junk)');
  const cs=[...g.querySelectorAll('.g-card')];
  cs.slice(0,3).forEach((c)=>c.click());
  await new Promise(r=>setTimeout(r,250));
  return {picked:cs.filter((c)=>c.classList.contains('sel')).length,
    total:document.querySelectorAll('.g-card.sel').length};
})()`);
await cdp.ev(gallery, `document.querySelector('#btnSend').click()`);
let sent3 = null;
for (let i = 0; i < 120; i++) {
    sent3 = await cdp.ev(gallery, `({status:document.querySelector('#status').textContent, sent:document.querySelectorAll('.g-card.sent').length, running:!document.querySelector('#btnCancel').hidden})`);
    if (sent3 && /完成|停止/.test(sent3.status)) break;
    await wait(250);
}
const invAfter = await cdp.ev(gallery, `(async()=>{
  const g=document.querySelector('.g-group:not(.g-junk)');
  const cs=[...g.querySelectorAll('.g-card')];
  const sentStillSel=cs.filter((c)=>c.classList.contains('sent')&&c.classList.contains('sel')).length;
  g.querySelector('.g-group-inv').click();
  await new Promise(r=>setTimeout(r,250));
  return {sentStillSel,
    nowSel:cs.filter((c)=>c.classList.contains('sel')).length,
    sentNowSel:cs.filter((c)=>c.classList.contains('sent')&&c.classList.contains('sel')).length,
    unsentNowSel:cs.filter((c)=>!c.classList.contains('sent')&&c.classList.contains('sel')).length,
    otherGroups:document.querySelectorAll('.g-card.sel').length};
})()`);
step('发过几张后点组内反选：选中的正好是这条里没发过的那几张',
    !!(invPart && invPart.picked === 3 && invPart.total === 3 && sent3 && sent3.sent === 3 && !sent3.running
        && invAfter.sentStillSel === 3 && invAfter.nowSel === 6 && invAfter.sentNowSel === 0
        && invAfter.unsentNowSel === 6 && invAfter.otherGroups === 6), { invPart, sent3, invAfter });
await cdp.ev(gallery, `document.querySelector('#btnClear').click()`);
await wait(200);

// 工具栏那条路：脚本不传 filename 时后台必须给出唯一名，否则 overwrite:true 让后一张盖掉前一张
const legacy = await cdp.ev(swSess, `(async()=>{
  const d=await chrome.storage.local.get(['mtbSettings']);const s=d.mtbSettings||{};s.customScripts=s.customScripts||[];
  s.customScripts.push({id:'probe-comfy-run',name:'探针：发送并执行',type:'script',entry:'body',media:['image'],enabled:true,builtin:false,
    code:'const r = await ctx.comfySend({ imgSrc: ctx.media.src, autoQueue: ctx.params.autoQueue }); return { toast: r.ok ? (r.uploaded||"ok") : ("ERR "+r.error), isError: !r.ok };',
    params:{ autoQueue: true }});
  s.tools=s.tools||{};s.tools['probe-comfy-run']={visible:true,location:'inline'};
  await chrome.storage.local.set({mtbSettings:s});return true;
})()`);
step('注入不带 filename 的探针脚本', !!legacy, { legacy });
await cdp.ev(page, `(()=>{document.querySelector('.grid img').scrollIntoView({block:'center'});return true})()`);
await wait(400);
const before = counters.uploads;
// 九宫格小图是被抑制的（不弹工具栏），所以走「点开查看器的大图」那条路，跟用户实际点按钮的场景一致
const probeToast = await cdp.ev(page, `(async()=>{
  document.querySelector('.thumb').click();
  await new Promise(res=>setTimeout(res,200));
  const img=document.getElementById('viewerImg');
  const root=document.getElementById('mtb-root').shadowRoot;
  let btn=null;
  for(let i=0;i<12&&!btn;i++){
    const r=img.getBoundingClientRect(); const x=r.left+r.width/2, y=r.top+r.height/2;
    img.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,composed:true,clientX:x,clientY:y}));
    document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,composed:true,clientX:x,clientY:y}));
    await new Promise(res=>setTimeout(res,200));
    btn=[...root.querySelectorAll('button.btn')].find((b)=>/探针/.test(b.textContent));
  }
  if(!btn) return { noBtn:true, media:!!window.__probeMedia, buttons:[...root.querySelectorAll('button.btn')].map(b=>b.textContent.trim()) };
  btn.click();
  for(let i=0;i<40;i++){ const t=root.querySelector('.toast'); if(t&&t.classList.contains('show')&&/web_|失败|ERR/.test(t.textContent)) break; await new Promise(res=>setTimeout(res,250)); }
  const out={ toast:(root.querySelector('.toast')||{}).textContent||'' };
  document.getElementById('viewer').style.display='none';
  return out;
})()`);
const probeNames = counters.filenames.slice(counters.filenames.length - Math.max(0, counters.uploads - before));
step('脚本没传 filename 也拿到唯一名（不再固定 web_image.png）',
    !!(probeToast && !probeToast.noBtn && !/失败|ERR/.test(probeToast.toast) && counters.uploads > before
        && /^web_[a-z0-9]+\.(jpg|jpeg|png|webp)$/i.test(probeNames[0] || '')),
    { toast: probeToast && probeToast.toast, probeNames });
await cdp.ev(swSess, `(async()=>{const d=await chrome.storage.local.get(['mtbSettings']);const s=d.mtbSettings||{};s.customScripts=(s.customScripts||[]).filter(x=>x.id!=='probe-comfy-run');delete (s.tools||{})['probe-comfy-run'];await chrome.storage.local.set({mtbSettings:s});return true})()`);

// 采集绝不碰用户正在看的页面：不滚动、不缩放（夹具的第二条微博只有被滚到才会挂进 DOM，
// 它没挂进来就证明面板没偷偷滚页面）
const lazyPage = await cdp.open(`http://${PAGE_HOST}:${SITE}/nine.html?lazy=1`);
await wait(1200);
const lazyIds = await cdp.ev(swSess, `chrome.tabs.query({}).then(ts=>ts.filter(t=>(t.url||'').includes('lazy=1')).map(t=>t.id))`);
const lazyTabId = lazyIds && lazyIds[0];
const lazyGallery = lazyTabId ? await cdp.open(`chrome-extension://${extId}/gallery.html?tabId=${lazyTabId}`) : null;
let lazy = null;
for (let i = 0; i < 60; i++) {
    lazy = lazyGallery && await cdp.ev(lazyGallery, `(()=>{const gs=[...document.querySelectorAll('.g-group:not(.g-junk) .g-group-name')].map(x=>x.textContent);
      return {groups:gs.length,names:gs,cards:document.querySelectorAll('.g-card').length,summary:(document.querySelector('#summary')||{}).textContent||''}})()`);
    if (lazy && lazy.cards >= 9) break;
    await wait(300);
}
await wait(2500);
const lazyState = await cdp.ev(lazyPage, `(()=>({mounted:!!document.querySelector('#late article'),y:Math.round(window.scrollY),zoom:(document.body.style.zoom||'')+(document.documentElement.style.zoom||'')}))()`);
step('采集不碰页面：不滚动不缩放，滚出来才挂载的那条不会被偷偷捞进来',
    !!(lazy && !lazyState.mounted && lazyState.y === 0 && lazy.groups === 1 && lazy.cards === 9), { lazy, lazyState });

// 换用户自己滚（这里是测试代替用户滚，不是面板滚）：第二条挂进 DOM 后点刷新，
// 新挂载的必须补上、第一条一条不丢 —— 「少一大堆」的另一半就是刷新后数量不涨/反降
await cdp.ev(lazyPage, `window.scrollTo(0, 1200)`);
await wait(1500);
await cdp.ev(lazyGallery, `document.querySelector('#btnRefresh').click()`);
let grown = null;
for (let i = 0; i < 30; i++) {
    grown = await cdp.ev(lazyGallery, `(()=>{const gs=[...document.querySelectorAll('.g-group:not(.g-junk) .g-group-name')].map(x=>x.textContent);
      return {groups:gs.length,names:gs,cards:document.querySelectorAll('.g-card').length}})()`);
    if (grown && grown.cards >= 18) break;
    await wait(300);
}
const lateMounted = await cdp.ev(lazyPage, `(()=>({mounted:!!document.querySelector('#late article'),y:Math.round(window.scrollY)}))()`);
step('用户自己滚过之后再刷新，新挂载的补上、旧的一条不丢',
    !!(lateMounted && lateMounted.mounted && grown && grown.groups === 2 && grown.cards === 18
        && ['早', '晚'].every((n) => grown.names.some((x) => x.includes(n)))), { lateMounted, grown });

// 再扫一轮（点「刷新」）分组键必须还是同一条微博，不能因为图片懒加载换了地址就拆成两组
// 先让页面"懒加载"出一张新图（30×20，不会被当成内容图，但会改变这条微博的第一张图），
// 再点刷新：分组键要是依赖图片地址，这条微博就会被拆成两组
const injected = await cdp.ev(page, `(()=>{const h=document.querySelector('.post header');
  const im=document.createElement('img');im.src='http://127.0.0.1:${SITE}/img/999.png';im.width=30;im.height=20;im.alt='';
  h.insertBefore(im,h.firstChild);return !!h.querySelector('img');})()`);
await cdp.ev(gallery, `document.querySelector('#btnRefresh').click()`);
await wait(2500);
const again = await cdp.ev(gallery, `(()=>{const gs=[...document.querySelectorAll('.g-group:not(.g-junk) .g-group-name')].map(x=>x.textContent);
  return {groups:gs.length,names:gs,cards:document.querySelectorAll('.g-card').length}})()`);
step('重复扫描不会把同一条微博拆成两组（分组键稳定）',
    !!(injected && again && again.groups === EXP_GROUPS && again.cards === 36 && EXP_AUTHORS.every((n) => again.names.some((x) => x.includes(n)))),
    { injected, again, first: info });

// popup 一关就没了：面板是 action popup，用户点一下网页它就销毁，重开是新文档。
// 把「丁」这条从 DOM 摘掉（模拟虚拟列表卸载），重开的面板只看页面应该只剩 27 张；
// 后台按标签页存了采集结果，所以必须还是 36 张 —— 滚过的内容不会清零。
const removed = await cdp.ev(page, `(()=>{const a=document.querySelectorAll('article');const d=a[3];
  const n=d?d.querySelectorAll('.grid .thumb img').length:0; if(d)d.remove(); return n;})()`);
const reopen = await cdp.open(`chrome-extension://${extId}/gallery.html?tabId=${tabId}`);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, reopen);
let re = null;
for (let i = 0; i < 60; i++) {
    re = await cdp.ev(reopen, `(()=>{const gs=[...document.querySelectorAll('.g-group:not(.g-junk) .g-group-name')].map(x=>x.textContent);
      return {groups:gs.length,names:gs,cards:document.querySelectorAll('.g-card').length,summary:(document.querySelector('#summary')||{}).textContent||''}})()`);
    if (re && re.cards === 36) break;
    await wait(300);
}
step('面板重开不丢：后台按标签页缓存，卸载掉的微博仍在列表里',
    !!(removed === 9 && re && re.cards === 36 && re.groups === EXP_GROUPS
        && (!WEIBO_HOST || re.names.some((x) => x.includes('丁当')))), { removed, re });
// 「只看屏幕附近」：把页面视口压成 300 高再扫一次，这样「视口上下各一屏」的窗口最多盖住两条微博，
// 剩下的必须被过滤掉（不压视口的话整个夹具本来就在 ±1 屏里，断言等于没断）
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 300, deviceScaleFactor: 1, mobile: false }, page);
await cdp.ev(reopen, `document.querySelector('#btnRefresh').click()`);
await wait(1800);
const onlyView = await cdp.ev(reopen, `(async()=>{const c=document.querySelector('#onlyView');
  c.checked=true;c.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,600));
  return {cards:document.querySelectorAll('.g-card').length,groups:document.querySelectorAll('.g-group').length,
    summary:document.querySelector('#summary').textContent,
    off:/屏幕外/.test(document.querySelector('#summary').textContent)}})()`);
step('「只看屏幕附近」过滤掉视口上下各一屏之外的图', !!(onlyView && onlyView.cards > 0 && onlyView.cards < 36 && onlyView.off), onlyView);
await cdp.send('Emulation.clearDeviceMetricsOverride', {}, page).catch(() => { /* 无所谓 */ });

// 无用图片：题目要求「去掉筛选、收进一个可展开的分组」，默认折叠且展开前不建卡片
await cdp.ev(reopen, `(()=>{const c=document.querySelector('#onlyView');c.checked=false;c.dispatchEvent(new Event('change'));return true})()`);
await wait(500);
const junkInfo = await cdp.ev(reopen, `(()=>{const g=document.querySelector('.g-junk');return {
  exists:!!g, name:g?g.querySelector('.g-group-name').textContent:'', btn:g?g.querySelector('.g-junk-toggle').textContent:'',
  cards:g?g.querySelectorAll('.g-card').length:-1, hidden:g?g.querySelector('.g-grid').hidden:null,
  contentCards:document.querySelectorAll('.g-card').length, summary:document.querySelector('#summary').textContent}})()`);
step('无用图片收进最后一个默认折叠的分组，展开前不建卡片',
    !!(junkInfo.exists && /无用图片/.test(junkInfo.name) && junkInfo.btn === '展开' && junkInfo.cards === 0
        && junkInfo.hidden === true && junkInfo.contentCards === 36 && /无用图片 \d+ 张/.test(junkInfo.summary)), junkInfo);
const junkOpen = await cdp.ev(reopen, `(async()=>{document.querySelector('.g-junk-toggle').click();await new Promise(r=>setTimeout(r,400));
  const g=document.querySelector('.g-junk');const gr=g.querySelector('.g-grid');
  return {cards:g.querySelectorAll('.g-card').length,hidden:gr.hidden,display:getComputedStyle(gr).display,btn:g.querySelector('.g-junk-toggle').textContent}})()`);
step('展开无用图片后能看到卡片（也能量勾选发送）', !!(junkOpen.cards > 0 && junkOpen.hidden === false && junkOpen.display === 'grid' && junkOpen.btn === '收起'), junkOpen);
// 收回去必须真的不再占位：.g-grid{display:grid} 会盖掉 [hidden]，必须显式 [hidden]{display:none}
const junkShut = await cdp.ev(reopen, `(async()=>{document.querySelector('.g-junk-toggle').click();await new Promise(r=>setTimeout(r,300));
  const g=document.querySelector('.g-junk');const gr=g.querySelector('.g-grid');
  return {display:getComputedStyle(gr).display,shown:[...gr.querySelectorAll('.g-card')].filter(c=>c.getBoundingClientRect().height>0).length,btn:g.querySelector('.g-junk-toggle').textContent}})()`);
step('无用图片可以再收回去（收起后不显示任何卡片）', !!(junkShut.display === 'none' && junkShut.shown === 0 && junkShut.btn === '展开'), junkShut);
await cdp.ev(swSess, `chrome.tabs.query({}).then(ts=>Promise.all(ts.filter(t=>(t.url||'').includes('gallery.html?tabId=${tabId}')).map(t=>chrome.tabs.remove(t.id)))).then(()=>true)`).catch(() => { /* 关不掉就算了 */ });

// 打开面板自动滚到当前正在看的那条微博：把页面滚到 900（乙在视口里），新开一个面板
await cdp.ev(page, `window.scrollTo(0, 900)`);
await wait(700);
const jumpTab = await cdp.open(`chrome-extension://${extId}/gallery.html?tabId=${tabId}`);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, jumpTab);
let jump = null;
for (let i = 0; i < 40; i++) {
    jump = await cdp.ev(jumpTab, `(()=>{const m=document.querySelector('.g-main');
      const cur=document.querySelector('.g-current .g-group-name');
      const view=(document.querySelector('#summary')||{}).textContent||'';
      return {scrollTop:Math.round(m?m.scrollTop:0), cur:cur?cur.textContent:'', cards:document.querySelectorAll('.g-card').length, view}})()`);
    if (jump && jump.cards >= 18 && jump.cur) break;
    await wait(300);
}
step('打开面板自动滚到当前正在看的那条微博（高亮该组）', !!(jump && jump.scrollTop > 40 && /乙/.test(jump.cur)), jump);
await cdp.ev(swSess, `chrome.tabs.query({}).then(ts=>Promise.all(ts.filter(t=>(t.url||'').includes('gallery.html?tabId=${tabId}')).map(t=>chrome.tabs.remove(t.id)))).then(()=>true)`).catch(() => {});

// 打开面板不该有「先大后小」的跳：故意用 560×600 视口（比 CSS 兜底的 800 窄，所以钉尺寸之前卡片是偏大的），
// 遮罩必须盖住这段，揭开之后每张卡片宽度一路不再变化
const bootTab = await cdp.open(`chrome-extension://${extId}/gallery.html?tabId=${tabId}`);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 600, deviceScaleFactor: 1, mobile: false }, bootTab);
const bootWatch = await cdp.ev(bootTab, `(async()=>{
  const cardW=()=>{const c=document.querySelector('.g-card');return c?Math.round(c.getBoundingClientRect().width):0};
  let sawMask=false, hidden=false, firstW=0, changed=0; const t0=Date.now();
  while (Date.now()-t0 < 5000) {
    const m=document.getElementById('bootMask');
    if (m && !m.hidden) sawMask=true;
    if (m && m.hidden) { hidden=true; const w=cardW(); if (w>0) { if (!firstW) firstW=w; else if (Math.abs(w-firstW)>1) changed++; } }
    if (hidden && firstW>0 && Date.now()-t0>1800) break;
    await new Promise(r=>setTimeout(r,30));
  }
  const de=document.documentElement, g=document.querySelector('#groups');
  return {sawMask, hidden, firstW, changed, card:cardW(),
    pin:(de.style.getPropertyValue('--panel-w')||''), vw:innerWidth,
    cols:Number(getComputedStyle(g).getPropertyValue('--cols').trim())};
})()`);
step('打开面板不跳：遮罩盖住撑尺寸的过程，揭开后卡片宽度不再变化',
    !!(bootWatch && bootWatch.sawMask && bootWatch.hidden && bootWatch.vw === 560
        && /^\d+px$/.test(bootWatch.pin) && bootWatch.firstW > 100 && bootWatch.changed === 0
        && bootWatch.cols === 3 && bootWatch.card === bootWatch.firstW), bootWatch);
await cdp.ev(swSess, `chrome.tabs.query({}).then(ts=>Promise.all(ts.filter(t=>(t.url||'').includes('gallery.html?tabId=${tabId}')).map(t=>chrome.tabs.remove(t.id)))).then(()=>true)`).catch(() => { /* 关不掉就算了 */ });

// 退出面板再打开，勾的还必须在那儿：popup 每次都是新文档，所以勾选只能靠后台按标签页存的那份
const selTabA = await cdp.open(`chrome-extension://${extId}/gallery.html?tabId=${tabId}`);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, selTabA);
let readyA = null;
for (let i = 0; i < 40; i++) {
    readyA = await cdp.ev(selTabA, `({cards:document.querySelectorAll('.g-card').length,mask:!!(document.getElementById('bootMask')||{hidden:true}).hidden})`);
    if (readyA && readyA.cards === 36 && readyA.mask) break;
    await wait(300);
}
const markA = await cdp.ev(selTabA, `(async()=>{
  const cs=[...document.querySelectorAll('.g-group:not(.g-junk) .g-card')].slice(0,3);
  cs.forEach((c)=>c.click());
  await new Promise(r=>setTimeout(r,800));
  return {keys:cs.map((c)=>c.dataset.key), sel:document.querySelectorAll('.g-card.sel').length,
    count:document.querySelector('#selCount').textContent};
})()`);
// 连面板一起关掉（等同用户点网页把 popup 收起），再重新打开一个全新文档
await cdp.ev(swSess, `chrome.tabs.query({}).then(ts=>Promise.all(ts.filter(t=>(t.url||'').includes('gallery.html?tabId=${tabId}')).map(t=>chrome.tabs.remove(t.id)))).then(()=>true)`).catch(() => { /* 关不掉就算了 */ });
await wait(500);
const selTabB = await cdp.open(`chrome-extension://${extId}/gallery.html?tabId=${tabId}`);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, selTabB);
let backB = null;
for (let i = 0; i < 40; i++) {
    backB = await cdp.ev(selTabB, `(()=>({cards:document.querySelectorAll('.g-card').length,
      sel:[...document.querySelectorAll('.g-card.sel')].map((c)=>c.dataset.key),
      count:document.querySelector('#selCount').textContent}))()`);
    if (backB && backB.cards === 36 && backB.sel.length > 0) break;
    await wait(300);
}
step('退出图片面板再打开：之前勾选的三张仍然是勾选状态',
    !!(readyA && readyA.cards === 36 && markA && markA.sel === 3 && /已选 3/.test(markA.count)
        && backB && backB.cards === 36 && backB.sel.length === 3
        && backB.sel.every((k) => markA.keys.includes(k)) && /已选 3/.test(backB.count)),
    { readyA, markA, backB });

async function runWeiboFilterChecks() {
    const filterPage = await cdp.open(`http://${PAGE_HOST}:${SITE}/nine.html?filter=1`);
    await wait(1600);
    const filterTabIds = await cdp.ev(swSess, `chrome.tabs.query({}).then(ts=>ts.filter(t=>(t.url||'').includes('filter=1')).map(t=>t.id))`);
    const filterTabId = filterTabIds && filterTabIds[0];
    const fp = await cdp.open(`chrome-extension://${extId}/gallery.html?tabId=${filterTabId}`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, fp);
    const tabState = await cdp.ev(fp, `(async()=>{
      // 面板刚弹出来时模块可能还没执行完（tab 的 onclick 还没绑上），所以点完要确认真的切过去了再走
      let ok=false;
      for(let i=0;i<60;i++){const b=document.querySelector('#gTabs button[data-panel="filter"]');
        if(b&&!b.disabled){b.click();await new Promise(r=>setTimeout(r,200));if(b.classList.contains('active')){ok=true;break;}}
        await new Promise(r=>setTimeout(r,180));}
      await new Promise(r=>setTimeout(r,400));
      return {ok, tabs:[...document.querySelectorAll('#gTabs button')].map(x=>[x.textContent.trim(),x.classList.contains('active')]),
        formVisible:!document.querySelector('#panelFilter').hidden, imagesHidden:document.querySelector('#panelImages').hidden,
        types:[...document.querySelectorAll('[data-wf-type]')].map(x=>x.dataset.wfType+':'+(x.checked?1:0)).join(','),
        status:document.querySelector('#wfStatus').textContent};
    })()`).catch(() => null);
    step('面板顶部有「图片 / 筛选微博」两个 tab，切过去就是微博原生样式的表单（类型默认全勾）',
        !!(tabState && tabState.ok && tabState.tabs.length === 2 && tabState.tabs[1][1] === true
            && tabState.formVisible && tabState.imagesHidden
            && tabState.types === 'original:1,repost:1,text:1,image:1,video:1,music:1'), tabState);

    const readFeed = () => cdp.ev(filterPage, `(()=>{
      const slots=[...document.querySelectorAll('.vue-recycle-scroller__item-view')];
      const rows=slots.map((s)=>{const a=s.querySelector('article');const links=[...(a?a.querySelectorAll('header a'):[])];
        return {name:links[1]?links[1].textContent.trim():'', hidden:!!(a&&a.getAttribute('data-mtb-filtered')==='1'),
          articleZero:!!!a||a.offsetHeight===0, top:Math.round(s.getBoundingClientRect().top)};});
      const vis=slots.filter((s)=>getComputedStyle(s).display!=='none');
      const gap=vis.length>1?Math.round(vis[1].getBoundingClientRect().top-vis[0].getBoundingClientRect().bottom):0;
      const chipHost=document.getElementById('mtb-filter-chip');
      const chip=chipHost&&chipHost.shadowRoot?chipHost.shadowRoot.querySelector('.chip'):null;
      return {total:rows.length, hidden:rows.filter(r=>r.hidden).map(r=>r.name), shown:rows.filter(r=>!r.hidden).map(r=>r.name),
        zeroed:rows.filter(r=>r.hidden).every(r=>r.articleZero), gap, chip:chip?{hidden:chip.hidden,text:chip.textContent}:null};
    })()`);
    const setForm = (js) => cdp.ev(fp, `(async()=>{${js};await new Promise(r=>setTimeout(r,650));
      return {status:document.querySelector('#wfStatus').textContent,
        stored:(await chrome.storage.local.get(['mtbSettings'])).mtbSettings.weiboFilter};})()`);

    const f0 = await readFeed();
    const first = await setForm(`document.querySelector('[data-wf-type="text"]').click()`);
    const f1 = await readFeed();
    step('取消「纯文字」立刻生效：那条整条 display:none、自身零高',
        !!(f0 && f0.total === 6 && f0.hidden.length === 0
            && first.stored.site === PAGE_HOST && first.stored.enabled === true
            && /已隐藏 1 条/.test(first.status)
            && f1.hidden.length === 1 && /纯文字/.test(f1.hidden[0]) && f1.zeroed
            && f1.chip && f1.chip.hidden === false && /已隐藏 1 条/.test(f1.chip.text)), { f0, first: { status: first.status, site: first.stored.site }, f1 });

    const second = await setForm(`(()=>{const d=document.querySelector('#wfFrom');d.value='2026-10-21';d.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const f2 = await readFeed();
    step('时间从 2026-10-21 起：20 号发的都被挡，和「取消纯文字」叠加成 3 条',
        !!(f2 && f2.hidden.length === 3 && f2.hidden.some((x) => /有图/.test(x)) && f2.hidden.some((x) => /有视频/.test(x))
            && /已隐藏 3 条/.test(second.status) && f2.zeroed), { second: second.status, hidden: f2 && f2.hidden });

    const third = await setForm(`(()=>{const k=document.querySelector('#wfKeywords');k.value='抽奖';k.dispatchEvent(new Event('input',{bubbles:true}));
      const m=document.querySelector('#wfKeywordMode');m.value='none';m.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const f3 = await readFeed();
    step('关键字「不含 抽奖」同样立刻生效，三个条件叠加成 4 条',
        !!(f3 && f3.hidden.length === 4 && f3.hidden.some((x) => /抽奖/.test(x))
            && /已隐藏 4 条/.test(third.status) && f3.zeroed), { third: third.status, hidden: f3 && f3.hidden });

    // 底部操作条那条「转发图标」每条微博都有：取消「原创」只该挡掉真正原创的那几条，
    // 绝不能因为图标类名带 retweet 就把所有帖子都当成转发（那样这一步会一条都藏不住）
    const forth = await setForm(`document.querySelector('[data-wf-type="original"]').click()`);
    const f4 = await readFeed();
    step('取消「原创」只挡原创，转发那条留下（转发图标不算转发）',
        !!(f4 && f4.hidden.length === 5 && f4.shown.length === 1 && /转发/.test(f4.shown[0])
            && /已隐藏 5 条/.test(forth.status) && f4.zeroed), { forth: forth.status, hidden: f4 && f4.hidden, shown: f4 && f4.shown });

    const cleared = await setForm(`document.querySelector('#wfClear').click()`);
    const f5 = await readFeed();
    step('清除筛选：六条全部回来、槽位恢复原样、提示条消失',
        !!(f5 && f5.hidden.length === 0 && f5.shown.length === 6
            && f5.chip && f5.chip.hidden === true && cleared.stored.enabled === false), { cleared: { enabled: cleared.stored.enabled, status: cleared.status }, f5 });

    // 实验模式：后台把一段代码注入页面主世界，直接改微博自己的信息流数组（夹具里是 #app._vnode.component.data.list）。
    // 这条路不碰 DOM，列表自己重排 → 被筛掉的帖子真的不存在，不留空位。失败会自动退回上面的页面隐藏。
    const readList = () => cdp.ev(filterPage, `(()=>{
      const g=document.getElementById('app');
      const list=g&&g._vnode&&g._vnode.component&&g._vnode.component.data&&g._vnode.component.data.list;
      return {len:list?list.length:-1, mids:list?list.map((x)=>String(x.mid)):[]};
    })()`);
    const setTypesForExp = await setForm(`(()=>{const t=document.querySelector('[data-wf-type="text"]');if(t.checked)t.click();
      const k=document.querySelector('#wfKeywords');k.value='抽奖';k.dispatchEvent(new Event('input',{bubbles:true}));
      const m=document.querySelector('#wfKeywordMode');m.value='none';m.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const expOff = await readList();
    const expOn = await setForm(`(()=>{const c=document.querySelector('#wfExperimental');c.click();})()`);
    const expList = await readList();
    step('实验模式：页面内部列表里直接少了两条（9001 纯文字 / 9004 抽奖），不是靠藏 DOM',
        !!(expOn.stored.experimental === true && /实验模式/.test(expOn.status)
            && expOff && expOff.len === 6
            && expList && expList.len === 4
            && !expList.mids.includes('9001') && !expList.mids.includes('9004')
            && expList.mids.join(',') === '9002,9003,9005,9006'), { expOn: { status: expOn.status, experimental: expOn.stored.experimental }, before: expOff, after: expList });
    const rerendered = await cdp.ev(filterPage, `(()=>{const n=window.__mtbRerender&&window.__mtbRerender();
      const vis=[...document.querySelectorAll('article[data-mid]')].filter((a)=>getComputedStyle(a.parentElement).display!=='none').map((a)=>a.getAttribute('data-mid'));
      return {n, vis, domHidden:[...document.querySelectorAll('article')].filter((a)=>a.getAttribute('data-mtb-filtered')==='1').length};})()`);
    step('实验模式下 DOM 里只剩这 4 条，而且没有被我们自己加过 display:none（重排交给页面）',
        !!(rerendered && rerendered.n === 4 && rerendered.vis.join(',') === '9002,9003,9005,9006' && rerendered.domHidden === 0), rerendered);
    const expBack = await setForm(`(()=>{const c=document.querySelector('#wfExperimental');c.click();})()`);
    const backList = await readList();
    step('关掉实验模式：列表恢复成 6 条、退回页面隐藏（会留空位）',
        !!(expBack.stored.experimental === false && backList && backList.len === 6
            && backList.mids.join(',') === '9001,9002,9003,9004,9005,9006'
            && /页面隐藏/.test(expBack.status)), { status: expBack.status, list: backList });

    // 用户报的 bug：单页应用里换到另一个微博页面（主页/分组），新列表被旧页面的帖子覆盖。
    // 夹具里模拟一次 SPA 导航：换成一个全新的数组（不同 mid）+ 改 hash，再改一次条件触发重算。
    const navSetup = await cdp.ev(filterPage, `(()=>{
      const app=document.getElementById('app');
      window.__mtbNav2=[
        {mid:'9101',created_at:'Wed Oct 21 11:00:00 +0800 2026',text:'新页面纯文字'},
        {mid:'9102',created_at:'Wed Oct 21 11:01:00 +0800 2026',text:'新页面有图',pic_ids:['n1']},
        {mid:'9103',created_at:'Wed Oct 21 11:02:00 +0800 2026',text:'新页面视频',page_info:{object_type:'video'}},
        {mid:'9104',created_at:'Wed Oct 21 11:03:00 +0800 2026',text:'新页面抽奖',pic_ids:['n2']},
        {mid:'9105',created_at:'Wed Oct 21 11:04:00 +0800 2026',text:'新页面转发',retweeted_status:{mid:'o2'},pic_ids:['n3']},
        {mid:'9106',created_at:'Wed Oct 21 11:05:00 +0800 2026',text:'新页面音乐',page_info:{object_type:'music'}}
      ];
      // 让目录里的帖子换成新页面的内容（模拟 Vue 重新渲染）
      const arts=[...document.querySelectorAll('article[data-mid]')];
      window.__mtbNav2.forEach((it,i)=>{const a=arts[i];if(!a)return;a.setAttribute('data-mid',it.mid);const p=a.querySelector('p');if(p)p.textContent=it.text;});
      // 真页面切页后，上一个信息流的组件还挂在 Vue 树里，而且它的数组可能更长：
      // 这里把旧列表多塞两条、作为「旧组件」挂进子树，逼实现必须靠「渲染出来的帖子」认当前列表
      window.__mtbFeed.push({mid:'9007',created_at:'Wed Oct 21 09:00:00 +0800 2026',text:'旧页面遗留一',pic_ids:['x']},
        {mid:'9008',created_at:'Wed Oct 21 09:01:00 +0800 2026',text:'旧页面遗留二',pic_ids:['y']});
      const root=app._vnode.component;
      root.subTree={children:[{component:{type:{name:'OldFeed'},data:{list:window.__mtbFeed},subTree:null}}]};
      root.data.list = window.__mtbNav2;
      location.hash = '#spa-second-page';
      return {len:window.__mtbNav2.length,oldLen:window.__mtbFeed.length};
    })()`);
    const navOn = await setForm(`(()=>{const c=document.querySelector('#wfExperimental');if(!c.checked)c.click();
      const v=document.querySelector('[data-wf-type="video"]');if(v.checked)v.click();})()`);
    const navList = await cdp.ev(filterPage, `(()=>({len:window.__mtbNav2.length,mids:window.__mtbNav2.map((x)=>String(x.mid))}))()`);
    step('换了微博页面（SPA 导航）后只按新页面的列表筛：旧页面（还挂在 Vue 树里、更长）一条都不许混进来',
        !!(navSetup && navSetup.len === 6 && navSetup.oldLen === 8 && navOn.stored.experimental === true
            && navList && navList.len === 3 && navList.mids.join(',') === '9102,9105,9106'), { navSetup, navList });
    const navOff = await setForm(`(()=>{const c=document.querySelector('#wfExperimental');if(c.checked)c.click();})()`);
    const navBack = await cdp.ev(filterPage, `(()=>({len:window.__mtbNav2.length,mids:window.__mtbNav2.map((x)=>String(x.mid))}))()`);
    step('换页后关掉实验模式：新页面的 6 条原样回来（不会被上一页的快照污染或清空）',
        !!(navOff.stored.experimental === false && navBack && navBack.len === 6
            && navBack.mids.join(',') === '9101,9102,9103,9104,9105,9106'), navBack);
    // 边界：换页之后、新页面还没被筛过就先把筛选关掉 —— 绝不能把新页面清空
    const raceSetup = await cdp.ev(filterPage, `(()=>{
      const app=document.getElementById('app');
      window.__mtbNav3=[
        {mid:'9201',created_at:'Wed Oct 21 12:00:00 +0800 2026',text:'第三个页面一',pic_ids:['z1']},
        {mid:'9202',created_at:'Wed Oct 21 12:01:00 +0800 2026',text:'第三个页面二',pic_ids:['z2']}
      ];
      app._vnode.component.data.list = window.__mtbNav3;
      location.hash = '#spa-third-page';
      return window.__mtbNav3.length;
    })()`);
    const raceRes = await cdp.ev(fp, `chrome.runtime.sendMessage({action:'applyWeiboFilterPage',tabId:${filterTabId},filter:null,enabled:false})`);
    const raceList = await cdp.ev(filterPage, `window.__mtbNav3.map((x)=>String(x.mid))`);
    step('换页后第一次调用就是「关掉筛选」：新页面两条一条都不许被清掉',
        !!(raceSetup === 2 && raceRes && raceRes.ok === true && Array.isArray(raceList)
            && raceList.join(',') === '9201,9202'), { raceSetup, raceRes, raceList });

    if (filterTabId) await cdp.ev(swSess, `chrome.tabs.remove(${filterTabId}).then(()=>true)`).catch(() => { /* 关不掉就算了 */ });
    await cdp.ev(swSess, `chrome.tabs.query({}).then(ts=>Promise.all(ts.filter(t=>(t.url||'').includes('gallery.html?tabId=${filterTabId}')).map(t=>chrome.tabs.remove(t.id)))).then(()=>true)`).catch(() => { /* 关不掉就算了 */ });
}

if (WEIBO_HOST) await runWeiboFilterChecks();
else {
    // 站点门禁：微博筛选只该挂在微博域名下。先把条件开到最严，普通站点也必须一动不动、连提示条都不出现
    await cdp.ev(swSess, `(async()=>{const d=await chrome.storage.local.get(['mtbSettings']);const s=d.mtbSettings||{};
      s.weiboFilter={enabled:true,image:'yes',video:'any',keywordMode:'off',keywords:[]};await chrome.storage.local.set({mtbSettings:s});return true})()`);
    await wait(700);
    const gate = await cdp.ev(page, `(()=>({chip:!!document.getElementById('mtb-filter-chip'),hidden:[...document.querySelectorAll('article')].filter((e)=>e.getAttribute('data-mtb-filtered')==='1').length}))()`);
    step('非微博站点不挂信息流筛选（条件开到最严也不插提示条、不改任何帖子）', !!(gate && !gate.chip && gate.hidden === 0), gate);
    await cdp.ev(swSess, `(async()=>{const d=await chrome.storage.local.get(['mtbSettings']);const s=d.mtbSettings||{};
      s.weiboFilter={enabled:false,image:'any',video:'any',keywordMode:'off',keywords:[]};await chrome.storage.local.set({mtbSettings:s});return true})()`);
}

const summary = dump();
console.log('\n=== 汇总 ===\n' + JSON.stringify(summary, null, 1));
cdp.close();
try { proc.kill(); } catch (e) { /* ignore */ }
server.close();
process.exit(summary.failed ? 1 : 0);
