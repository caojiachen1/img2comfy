// 聚焦调试：全屏时 wrap 的真实渲染位置 + cross2 桥信息
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9337;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-fs-'));
    const proc = spawn(EDGE, [
        '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
        '--no-first-run', '--autoplay-policy=no-user-gesture-required', '--window-size=1600,900', 'about:blank',
    ], { stdio: 'ignore' });
    let targets = null;
    for (let i = 0; i < 60; i++) { await wait(300); try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch (e) {} }
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let mid = 0; const pending = new Map();
    const send = (m, p = {}) => new Promise((resolve, reject) => {
        const id = ++mid; pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method: m, params: p }));
    });
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
            msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        }
    };
    await new Promise(r => { ws.onopen = r; });
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: 'http://192.168.156.1:8765/test/index.html?fsdbg=' + Date.now() });
    await wait(4500);

    const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
    const realClick = async (x, y) => {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
            await send('Input.dispatchMouseEvent', {
                type, x: Math.round(x), y: Math.round(y),
                button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1,
            });
        }
    };

    // 进入容器全屏（用合成事件触发 requestFullscreen 不可靠，先滚到可见再用真实点击）
    console.log('pre:', JSON.stringify(await evalJs(`(() => {
        document.querySelector('#case-plain').scrollIntoView({block:'center'});
        const r = document.getElementById('fs-btn').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, scrollY: Math.round(scrollY), vh: innerHeight };
    })()`)));
    const b1 = await evalJs(`(() => { const r = document.getElementById('fs-btn').getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2}; })()`);
    await realClick(b1.x, b1.y);
    await wait(1000);
    console.log('fs state:', JSON.stringify(await evalJs(`(() => {
        const wrap = document.getElementById('comfyui-extension-wrap');
        if (!wrap) return 'no wrap';
        const cs = getComputedStyle(wrap);
        const b = wrap.querySelector('button');
        const br = b.getBoundingClientRect();
        return {
            fs: !!document.fullscreenElement, fsTag: document.fullscreenElement && document.fullscreenElement.tagName,
            wrapDisplay: wrap.style.display, wrapTop: wrap.style.top, wrapLeft: wrap.style.left,
            offsetTop: wrap.offsetTop, offsetLeft: wrap.offsetLeft,
            btnRect: [br.left | 0, br.top | 0, br.width | 0, br.height | 0],
            at: (() => { const a = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2); return a ? a.tagName + '.' + a.id : String(a); })(),
            probePoint: (() => { const a = document.elementFromPoint(innerWidth - 60, 20); return a ? a.tagName + '.' + a.id : String(a); })(),
            viewport: [innerWidth, innerHeight], scrollY: Math.round(scrollY),
        };
    })()`)));
    ws.close(); try { proc.kill(); } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
}
main().catch(e => { console.log('FATAL', e); process.exit(1); });
