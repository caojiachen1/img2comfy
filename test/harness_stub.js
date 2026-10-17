// 页面侧 chrome API 桩：只为验证内容脚本包（探测/工具栏/拖拽/算子链），不模拟扩展特权链路。
// host 请求交给 window.__mtbStubHandlers（由 harness_page.html 的 module 脚本注册）。
(function () {
    const storage = { mtbSettings: undefined };
    const listeners = [];
    const calls = [];
    window.__mtbStubHandlers = {};
    window.__mtbStubCalls = calls;

    function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

    globalThis.chrome = {
        runtime: {
            getURL: (p) => '/' + String(p).replace(/^\/+/, ''),
            id: 'stub-ext-id',
            lastError: null,
            sendMessage: (msg, cb) => {
                calls.push({ action: msg && msg.action, type: msg && msg.type, at: Date.now() });
                const h = msg && window.__mtbStubHandlers[msg.action];
                // 真实 API：给了回调走回调，没给回调返回 Promise
                const promise = new Promise((resolve) => {
                    const finish = (r) => { if (typeof cb === 'function') cb(r); resolve(r); };
                if (h) Promise.resolve(h(msg)).then(finish, (e) => finish({ ok: false, error: String(e && e.message || e) }));
                else if (msg && msg.action === 'getState') finish({ ok: true, settings: clone(storage.mtbSettings) });
                else if (msg && msg.action === 'patchSettings') {
                    storage.mtbSettings = Object.assign({}, storage.mtbSettings || {}, msg.patch || {});
                    if (msg.patch && msg.patch.toolbar) storage.mtbSettings.toolbar = Object.assign({}, (storage.mtbSettings.toolbar || {}), msg.patch.toolbar);
                    finish({ ok: true, settings: clone(storage.mtbSettings) });
                }
                else if (msg && msg.action === 'ensureHost') finish({ ok: true, mode: 'stub' });
                else if (msg && msg.action === 'mtbEvent') {
                    // 与 background.js 的 mtbEvent 转发同形：扩展页收 target:'ext' 的那一份
                    window.__mtbStubRelay = (window.__mtbStubRelay || 0) + 1;
                    const { action: _drop, ...rest } = msg;
                        for (const fn of listeners.slice()) { if (typeof fn !== 'function') continue; try { fn({ action: 'mtbHostEvent', target: 'ext', ...rest }, {}, () => {}); } catch (e) { window.__mtbStubRelayErr = String(e && e.message || e); } }
                    finish({ ok: true, type: msg.type });
                }
                else if (msg && msg.action === 'openOptions') finish({ ok: true });
                else if (msg && msg.action === 'openTab') finish({ ok: true });
                else if (msg && (msg.action === 'downloadDataUrl' || msg.action === 'downloadUrl')) finish({ ok: true, id: 1 });
                else if (msg && msg.action === 'captureVisibleTab') finish({ success: false, error: 'stub 不提供截图' });
                else finish({ ok: false, error: 'stub 未处理 ' + (msg && msg.action) });
                });
                return promise;
            },
            onMessage: { addListener: (fn) => listeners.push(fn), removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } },
        },
        storage: {
            local: {
                get: (keys, cb) => {
                    const out = {};
                    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
                    for (const k of list) if (storage[k] !== undefined) out[k] = clone(storage[k]);
                    if (typeof cb === 'function') cb(out);
                    return Promise.resolve(out);
                },
                set: (obj, cb) => { for (const k of Object.keys(obj)) storage[k] = clone(obj[k]); if (typeof cb === 'function') cb(); fire(obj); return Promise.resolve(); },
            },
            onChanged: { addListener: (fn) => { listeners.push({ change: fn }); } },
        },
        tabs: { query: (q, cb) => cb([]), create: (o) => Promise.resolve({ id: 1 }) },
    };

    function fire(patch) {
        for (const l of listeners) {
            if (l && l.change) {
                const changes = {};
                for (const k of Object.keys(patch)) changes[k] = { newValue: clone(patch[k]) };
                try { l.change(changes, 'local'); } catch (e) { /* 桩里忽略 */ }
            }
        }
    }
    window.__mtbStubSetStorage = (obj) => { for (const k of Object.keys(obj)) storage[k] = clone(obj[k]); fire(obj); };
    window.__mtbStubGetStorage = () => clone(storage);
})();
