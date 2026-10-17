// 探测 manifest 哪个字段导致 Chrome 拒绝加载：逐个变体启动 CfT，看 service worker 是否注册。
// 用法：node scripts/probe-manifest.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MANIFEST = path.join(ROOT, 'manifest.json');
const ORIG = fs.readFileSync(MANIFEST, 'utf8');
const CHROME = process.env.CHROME || (() => {
    const root = path.join(ROOT, 'test', '.browsers');
    const stack = [root];
    while (stack.length) {
        const d = stack.pop();
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { stack.push(p); continue; }
            if (/^chrome(\.exe)?$/i.test(e.name) && fs.statSync(p).size > 1048576) return p;
        }
    }
})() || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const variants = [
    { name: '原始 manifest', patch: () => JSON.parse(ORIG) },
    { name: '去掉 content_security_policy', patch: (m) => { delete m.content_security_policy; return m; } },
    { name: 'CSP 加回 unsafe-eval（Edge 应拒绝加载）', patch: (m) => { m.content_security_policy.extension_pages = "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; object-src 'self'"; return m; } },
    { name: 'CSP 保持当前（仅 wasm-unsafe-eval）', patch: (m) => { m.content_security_policy.extension_pages = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"; return m; } },
    { name: '内容脚本 module:false', patch: (m) => { m.content_scripts[0].module = false; return m; } },
    { name: '去掉 background.type:module', patch: (m) => { delete m.background.type; return m; } },
    { name: '去掉 offscreen 权限', patch: (m) => { m.permissions = m.permissions.filter((p) => p !== 'offscreen'); return m; } },
    { name: '最小 manifest', patch: () => ({
        manifest_version: 3, name: 'probe', version: '1',
        permissions: ['storage'], background: { service_worker: 'background.js' },
    }) },
];

async function tryVariant(m) {
    const port = 9600 + Math.floor(Math.random() * 300);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mtb-probe-'));
    fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
    const proc = spawn(CHROME, [
        '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
        `--load-extension=${ROOT}`, `--disable-extensions-except=${ROOT}`,
        '--no-first-run', '--no-default-browser-check', 'about:blank',
    ], { stdio: 'ignore' });
    let got = null, stderrHint = '';
    for (let i = 0; i < 30; i++) {
        await wait(300);
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            const sw = list.find((t) => /service_worker|background/.test(t.type + t.url) && new URL(t.url).host.length === 32 && !/rollup|thunk/.test(t.url));
            if (sw) { got = sw.url; break; }
        } catch (e) { /* 还没起 */ }
    }
    try { proc.kill(); } catch (e) { /* ignore */ }
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 锁 */ } }, 300);
    return { got, stderrHint };
}

const results = [];
for (const v of variants) {
    const base = JSON.parse(ORIG);
    let m;
    try { m = v.patch(base); } catch (e) { results.push({ name: v.name, ok: false, why: 'patch 失败 ' + e.message }); continue; }
    const r = await tryVariant(m);
    results.push({ name: v.name, ok: !!r.got, url: r.got });
    console.log(`${r.got ? 'LOADED' : '  FAIL'}  ${v.name}`);
}
fs.writeFileSync(MANIFEST, ORIG);
console.log('\n结论：');
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.url ? '  ' + r.url : ''}`);
const firstFail = results.find((r) => !r.ok);
if (firstFail) console.log(`\n首个导致加载失败的字段组：${firstFail.name}`);
else console.log('\n全部变体都能加载——原始 manifest 没问题，失败原因在别处。');
