// 极简 CDP browser 会话客户端：所有目标都通过 Target.attachToTarget(flatten) 复用一条 WS。
// 品牌版 Chrome/Edge 从 137 起忽略 --load-extension，必须用 Chrome for Testing。
import fs from 'node:fs';
import path from 'node:path';

export function findChromeForTesting(root) {
    if (!fs.existsSync(root)) return null;
    const stack = [root];
    while (stack.length) {
        const d = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { stack.push(p); continue; }
            if (/^chrome(\.exe)?$/i.test(e.name)) {
                try { if (fs.statSync(p).size > 1048576) return p; } catch (e2) { /* ignore */ }
            }
        }
    }
    return null;
}

export class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.mid = 0;
        this.pend = new Map();
        this.events = [];
    }

    static async connect(port) {
        const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        const ws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise((r) => { ws.onopen = r; });
        const c = new Cdp(ws);
        ws.onmessage = (ev) => {
            const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
            if (m.method === 'Runtime.exceptionThrown' || m.method === 'Runtime.consoleAPICalled' || m.method === 'Log.entryAdded') {
                c.events.push({ ...m, sessionId: m.sessionId || null });
            }
            if (m.id && c.pend.has(m.id)) {
                const { resolve, reject } = c.pend.get(m.id);
                c.pend.delete(m.id);
                m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
            }
        };
        return c;
    }

    send(method, params = {}, sessionId = null) {
        return new Promise((resolve, reject) => {
            const id = ++this.mid;
            this.pend.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
    }

    async targets() {
        const { targetInfos } = await this.send('Target.getTargets');
        return targetInfos;
    }

    async waitForServiceWorker(pattern = /\/background\.js$/, ms = 20000) {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            const t = (await this.targets()).find((x) => x.type === 'service_worker' && pattern.test(x.url));
            if (t) return t;
            await new Promise((r) => setTimeout(r, 300));
        }
        return null;
    }

    sessions = new Map();

    async attach(targetId) {
        const r = await this.send('Target.attachToTarget', { targetId, flatten: true });
        const sessionId = r.sessionId || targetId;
        this.sessions.set(targetId, sessionId);
        await this.send('Runtime.enable', {}, sessionId).catch(() => {});
        await this.send('Log.enable', {}, sessionId).catch(() => {});
        return sessionId;
    }

    async open(url) {
        const { targetId } = await this.send('Target.createTarget', { url, background: false });
        const sessionId = await this.attach(targetId);
        await this.send('Page.enable', {}, sessionId).catch(() => {});
        return sessionId;
    }

    async urlOf(targetId) {
        const t = (await this.targets()).find((x) => x.targetId === targetId);
        return t ? t.url : null;
    }

    async waitUrl(targetId, want, ms = 15000) {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            const u = await this.urlOf(targetId);
            if (u === want) return true;
            await new Promise((r) => setTimeout(r, 250));
        }
        return false;
    }

    async ev(sess, expression) {
        const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 240000 }, sess);
        if (r.exceptionDetails) {
            return { __error: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n').slice(0, 4).join(' | ') };
        }
        return r.result?.value;
    }

    pageErrors() {
        const out = [];
        for (const e of this.events) {
            if (e.method === 'Runtime.exceptionThrown') out.push('EXC ' + String(e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text).split('\n').slice(0, 3).join(' | '));
            if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') out.push('ERR ' + String(e.params.entry.text).slice(0, 220));
        }
        return [...new Set(out)];
    }

    close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}
