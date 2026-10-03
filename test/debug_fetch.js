// 极简跨域 fetch 对照实验：同源 vs 跨源（js/mp4）、不同 init
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-f-'));
    const proc = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
        '--headless=new', '--remote-debugging-port=9336', `--user-data-dir=${profile}`,
        '--no-first-run', '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' });
    let targets = null;
    for (let i = 0; i < 60; i++) { await wait(300); try { targets = await (await fetch('http://127.0.0.1:9336/json')).json(); break; } catch (e) {} }
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let mid = 0; const pending = new Map();
    const send = (m, p = {}) => new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
    await new Promise(r => { ws.onopen = r; });
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: 'http://192.168.156.1:8765/test/index.html?fetchprobe=' + Date.now() });
    await wait(4000);
    const out = (await send('Runtime.evaluate', {
        awaitPromise: true, returnByValue: true,
        expression: `(async () => {
            const tries = {};
            const T = async (k, url, init) => { try { const r = await fetch(url, init); tries[k] = r.status; } catch (e) { tries[k] = 'ERR ' + e.message; } };
            const mp4 = 'http://192.168.156.1:8766/test/media/sample.mp4';
            await T('cross-8766-js', 'http://192.168.156.1:8766/test/harness.js', {});
            await T('cross-8766-mp4-plain', mp4, {});
            await T('cross-8766-mp4-nostore', mp4, { cache: 'no-store' });
            await T('cross-8766-mp4-bust', mp4 + '?bust=1', {});
            await T('same-8765-mp4-plain', 'http://192.168.156.1:8765/test/media/sample.mp4', {});
            return tries;
        })()`,
    })).result.value;
    console.log(JSON.stringify(out, null, 1));
    ws.close(); proc.kill(); fs.rmSync(profile, { recursive: true, force: true }); process.exit(0);
}
main().catch(e => { console.log('FATAL', e); process.exit(1); });
