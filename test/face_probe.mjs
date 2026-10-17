// 跑 test/face_probe.html 并把 JSON 打出来。用法：node test/face_probe.mjs [face_lena.jpg|face_messi5.jpg]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Cdp, findChromeForTesting } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const IMG = process.argv[2] || 'face_lena.jpg';
const BROWSER = findChromeForTesting(path.join(ROOT, 'test', '.browsers'));
if (!BROWSER) { console.log('需要 Chrome for Testing'); process.exit(1); }
const PORT = 9700 + Math.floor(Math.random() * 80);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.jpg': 'image/jpeg', '.png': 'image/png', '.onnx': 'application/octet-stream', '.json': 'application/json' };

const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mtb-probe-'));
const proc = spawn(BROWSER, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--remote-debugging-port=${PORT + 5}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let cdp = null;
for (let i = 0; i < 90; i++) { await wait(300); try { cdp = await Cdp.connect(PORT + 5); break; } catch (e) { /* 等启动 */ } }
if (!cdp) { console.log('CDP 不可达'); process.exit(1); }

const PAGE = process.env.PAGE || 'face_probe.html';
const sess = await cdp.open(`http://127.0.0.1:${PORT}/test/${PAGE}?img=${IMG}`);
let done = false;
for (let i = 0; i < 160; i++) {
    await wait(1000);
    done = await cdp.ev(sess, `!!window.__done`);
    if (done) break;
}
const out = await cdp.ev(sess, `window.__probe ? window.__probe() : null`);
const annot = await cdp.ev(sess, `window.__annot || null`);
if (annot && annot.startsWith('data:image/png;base64,')) {
    fs.writeFileSync(path.join(ROOT, 'test/out_face_' + IMG.replace(/\..*/, '') + '.png'), Buffer.from(annot.split(',')[1], 'base64'));
    console.log('已写注记图: test/out_face_' + IMG.replace(/\..*/, '') + '.png');
}
console.log('==== ' + IMG + ' (' + (done ? '完成' : '超时') + ') ====');
console.log(JSON.stringify(out, null, 1));
console.log('==== 页面错误 ====');
console.log(cdp.pageErrors().slice(0, 8).join('\n') || '（无）');
cdp.close();
try { proc.kill(); } catch (e) { /* 已退出 */ }
server.close();
setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 锁 */ } }, 300);
process.exit(0);
