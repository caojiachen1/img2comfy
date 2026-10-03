// 聚焦调试：v-taint 的内部取帧管线逐层探查 + c4 探测现场 + cross2 现场收尾
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9334;
const PAGE_URL = 'http://192.168.156.1:8765/test/index.html?debug=' + Date.now();

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-dbg-'));
    const proc = spawn(EDGE, [
        '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
        '--no-first-run', '--autoplay-policy=no-user-gesture-required', '--window-size=1600,900', 'about:blank',
    ], { stdio: 'ignore' });
    let targets = null;
    for (let i = 0; i < 60; i++) { await wait(300); try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch (e) {} }
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let mid = 0; const pending = new Map(); const consoleLines = [];
    const send = (m, p = {}) => new Promise((resolve, reject) => {
        const id = ++mid; pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method: m, params: p }));
    });
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.method === 'Runtime.consoleAPICalled') {
            const text = (msg.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ');
            consoleLines.push(`[${msg.params.type}] ${text}`);
        }
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
            msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        }
    };
    await new Promise(r => { ws.onopen = r; });
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: PAGE_URL });
    await wait(4500);

    const evalJs = async (label, expr) => {
        const r = (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result;
        console.log(`--- ${label} ---`);
        console.log(JSON.stringify(r.value !== undefined ? r.value : r, null, 1));
        return r.value;
    };

    // 1) v-taint 管线逐层：taint? fetch? blob? v2 metadata? seek? draw 像素采样
    await evalJs('pipeline', `(async () => {
        const v = document.getElementById('v-taint');
        const out = { src: v.src, currentTime: v.currentTime, vw: v.videoWidth };
        try {
            const c = document.createElement('canvas'); c.width = 4; c.height = 4;
            c.getContext('2d').drawImage(v, 0, 0, 4, 4);
            c.getContext('2d').getImageData(0, 0, 1, 1);
            out.taint = false;
        } catch (e) { out.taint = String(e.name); }
        out.fetch = await (async () => {
            try {
                const res = await fetch(v.currentSrc, { credentials: 'include' });
                if (!res.ok) return 'HTTP ' + res.status;
                const blob = await res.blob();
                return { ok: true, size: blob.size, type: blob.type };
            } catch (e) { return 'throw: ' + e.message; }
        })();
        if (out.fetch.ok) {
            const url = URL.createObjectURL(await (await fetch(v.currentSrc, { credentials: 'include' })).blob());
            const v2 = document.createElement('video');
            v2.muted = true; v2.preload = 'auto'; v2.src = url;
            out.v2meta = await new Promise((resolve) => {
                const to = setTimeout(() => resolve('metadata timeout'), 15000);
                v2.addEventListener('loadedmetadata', () => { clearTimeout(to); resolve({ vw: v2.videoWidth, dur: v2.duration }); }, { once: true });
                v2.addEventListener('error', () => { clearTimeout(to); resolve('v2 error: ' + (v2.error && v2.error.message)); }, { once: true });
            });
            if (out.v2meta && out.v2meta.vw) {
                out.seek = await new Promise((resolve) => {
                    const to = setTimeout(() => resolve('seek timeout'), 10000);
                    v2.addEventListener('seeked', () => { clearTimeout(to); resolve('seeked to ' + v2.currentTime); }, { once: true });
                    v2.currentTime = Math.min(v.currentTime || 1, (v2.duration || 1) - 0.05);
                });
                await new Promise(r => setTimeout(r, 300));
                const c = document.createElement('canvas'); c.width = v2.videoWidth; c.height = v2.videoHeight;
                const g = c.getContext('2d');
                g.drawImage(v2, 0, 0, c.width, c.height);
                const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data);
                out.draw = {
                    size: [c.width, c.height],
                    center: px(c.width >> 1, c.height >> 1),
                    q1: px(100, 100), q3: px(c.width - 100, c.height - 100),
                };
            }
        }
        return out;
    })()`);

    // 2) c4 探测现场：video 状态 + 命中栈 + 探测函数重放
    await evalJs('c4-probe', `(async () => {
        const v = document.getElementById('v-penone');
        v.scrollIntoView({ block: 'center' });
        await new Promise(r => setTimeout(r, 200));
        const r = v.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        return {
            ready: [v.readyState, v.videoWidth], rect: [r.left | 0, r.top | 0, r.width | 0, r.height | 0],
            stack: document.elementsFromPoint(cx, cy).map(n => n.tagName + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className ? '.' + n.className : '')),
            pe: getComputedStyle(v).pointerEvents,
            wrapAfterHover: (document.dispatchEvent(new MouseEvent('mouseover', { clientX: cx, clientY: cy, bubbles: true })),
                             document.dispatchEvent(new MouseEvent('mousemove', { clientX: cx, clientY: cy, bubbles: true })),
                             (document.getElementById('comfyui-extension-wrap') || {}).style ? document.getElementById('comfyui-extension-wrap').style.display : 'no-wrap'),
        };
    })()`);

    // 3) cross2：悬停后收日志与告警
    await evalJs('cross2', `(async () => {
        document.getElementById('fr-cross2').scrollIntoView({ block: 'center' });
        await new Promise(r => setTimeout(r, 300));
        const logs = await window.__collectComfyLogs();
        const c2 = logs.find(f => f.frameHref.includes('cross2'));
        return { diag: c2.diag, log: (c2.log || []).map(e => e.payload ? 'SEND len=' + e.payload.dataUrl.length : 'ALERT ' + e.alert) };
    })()`);

    console.log('--- console from page ---');
    for (const l of consoleLines.slice(-40)) console.log(l);
    ws.close(); try { proc.kill(); } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
}
main().catch(e => { console.log('FATAL ' + e); process.exit(1); });
