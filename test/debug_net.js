// 抓 fetch 失败的真实网络层错误（net::ERR_xxx）
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9335;
const PAGE_URL = 'http://192.168.156.1:8765/test/index.html?netdbg=' + Date.now();
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-net-'));
    const proc = spawn(EDGE, [
        '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
        '--no-first-run', '--window-size=1600,900', 'about:blank',
    ], { stdio: 'ignore' });
    let targets = null;
    for (let i = 0; i < 60; i++) { await wait(300); try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch (e) {} }
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let mid = 0; const pending = new Map();
    const netEvents = [];
    const send = (m, p = {}) => new Promise((resolve, reject) => {
        const id = ++mid; pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method: m, params: p }));
    });
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.method === 'Network.requestWillBeSent' && msg.params.request.url.includes('sample.mp4')) {
            netEvents.push({ ev: 'request', url: msg.params.request.url.slice(0, 60), headers: Object.keys(msg.params.request.headers) });
        }
        if (msg.method === 'Network.responseReceived' && msg.params.response.url.includes('sample.mp4')) {
            netEvents.push({ ev: 'response', status: msg.params.response.status, headers: msg.params.response.headers });
        }
        if (msg.method === 'Network.loadingFailed' && (msg.params.errorText || '').length >= 0) {
            netEvents.push({ ev: 'FAILED', errorText: msg.params.errorText, canceled: msg.params.canceled, type: msg.params.type });
        }
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
            msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        }
    };
    await new Promise(r => { ws.onopen = r; });
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Page.navigate', { url: PAGE_URL });
    await wait(4500);

    const r = (await send('Runtime.evaluate', {
        awaitPromise: true, returnByValue: true,
        expression: `(async () => {
            const v = document.getElementById('v-taint');
            const tries = {};
            for (const [k, init] of Object.entries({
                'omit': { credentials: 'omit' },
                'include': { credentials: 'include' },
                'mode-cors': { mode: 'cors', credentials: 'omit' },
            })) {
                try {
                    const res = await fetch(v.currentSrc, init);
                    tries[k] = 'status ' + res.status;
                    try { const b = await res.blob(); tries[k] += ' blob=' + b.size; } catch (e) { tries[k] += ' blobfail ' + e.message; }
                } catch (e) { tries[k] = 'throw: ' + e.message; }
            }
            return tries;
        })()`,
    })).result.value;
    console.log(JSON.stringify({ fetchTries: r, netEvents }, null, 1));
    ws.close(); try { proc.kill(); } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
}
main().catch(e => { console.log('FATAL ' + e); process.exit(1); });
