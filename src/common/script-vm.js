// 用户自定义脚本的执行引擎：QuickJS 编译成 wasm，在宿主（offscreen）页里解释执行。
// 为什么要它：MV3 的 extension_pages CSP 禁止 'unsafe-eval'（只放行 'wasm-unsafe-eval'），
// 所以在 wasm 里跑 JS 解释器就能执行用户代码，既不需要 manifest 的 sandbox 页，也不放松 CSP。
//
// 桥接刻意做成"单向轮询"：VM 内 ctx.fetch(...) 只把请求 push 进 globalThis.__queue 并返回一个
// VM 侧 Promise；宿主每轮把队列取空、执行服务、再用 evalCode 把结果注回 __hostResolve。
// 全程只用 evalCode / dump / executePendingJobs，不做 host→VM 的函数注入，避免版本 API 差异。

const PRELUDE = `
globalThis.__pending = {};
globalThis.__queue = [];
globalThis.__seq = 1;
globalThis.__result = { state: 'running' };
globalThis.__hostCall = function (name, argJson) {
  return new Promise(function (resolve, reject) {
    var id = __seq++;
    __pending[id] = { resolve: resolve, reject: reject };
    __queue.push({ id: id, name: name, argJson: argJson });
  });
};
globalThis.__hostResolve = function (id, ok, payloadJson) {
  var p = __pending[id];
  if (!p) return 0;
  delete __pending[id];
  var value;
  try { value = payloadJson === null || payloadJson === undefined ? undefined : JSON.parse(payloadJson); }
  catch (e) { value = String(payloadJson); }
  if (ok) p.resolve(value);
  else p.reject(new Error((value && value.message) || String(value)));
  return 1;
};
`;

/** ctx 的 JS 外壳：每个方法都是 __hostCall(服务名, JSON.stringify(参数)) 的糖 */
const CTX_PRELUDE = `
(function () {
  var c = globalThis.ctx || {};
  function svc(name) { return function (arg) { return globalThis.__hostCall(name, JSON.stringify(arg === undefined ? {} : arg)); }; }
  c.fetch = function (o) { return globalThis.__hostCall('fetch', JSON.stringify(Object.assign({ as: 'text' }, o || {}))); };
  c.host = svc('ops');
  c.ai = function (task, o) { return globalThis.__hostCall('ai', JSON.stringify(Object.assign({ task: task }, o || {}))); };
  c.comfySend = svc('comfy');
  c.download = function (dataUrl, filename) { return globalThis.__hostCall('download', JSON.stringify({ dataUrl: dataUrl, filename: filename })); };
  c.encode = svc('encode');
  c.openUrl = function (url) { return globalThis.__hostCall('emitUi', JSON.stringify({ action: 'openTab', url: url })); };
  c.storage = {
    get: function (keys) { return globalThis.__hostCall('storage.get', JSON.stringify({ keys: keys })); },
    set: function (obj) { return globalThis.__hostCall('storage.set', JSON.stringify(obj || {})); },
  };
  c.panel = function (spec) { return globalThis.__hostCall('emitUi', JSON.stringify({ action: 'panel', spec: spec })); };
  c.toast = function (text, isError) { globalThis.__ui = globalThis.__ui || []; globalThis.__ui.push({ type: 'toast', text: String(text), isError: !!isError }); return true; };
  c.overlay = function (spec) { globalThis.__ui = globalThis.__ui || []; globalThis.__ui.push({ type: 'overlay', spec: spec }); return true; };
  c.copyText = function (t) { globalThis.__ui = globalThis.__ui || []; globalThis.__ui.push({ type: 'copy', text: String(t) }); return true; };
  c.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); };
  c.util = {
    formatBytes: function (n) { return (!isFinite(n) || n < 0) ? '?' : (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB'); },
    ratioText: function (w, h) { return (w && h) ? (w / h).toFixed(3) + ':1' : '?'; },
    sanitizeFilename: function (s) { return String(s || 'file').replace(/[\\\\/:*?"<>|]+/g, '_'); },
  };
  globalThis.ctx = c;
})();
`;

let modulePromise = null;

function injectClassicScript(url) {
    return new Promise((resolve, reject) => {
        if (globalThis.QJS) return resolve(globalThis.QJS);
        const s = document.createElement('script');
        s.src = url;
        s.onload = () => (globalThis.QJS ? resolve(globalThis.QJS) : reject(new Error('quickjs 全局对象 QJS 未出现: ' + url)));
        s.onerror = () => reject(new Error('quickjs 引擎脚本加载失败: ' + url + '（先跑 node scripts/setup-vendor.mjs）'));
        document.head.appendChild(s);
    });
}

export async function loadQuickJs(vendorBase) {
    if (!modulePromise) {
        modulePromise = (async () => {
            const QJS = await injectClassicScript(`${vendorBase}/quickjs/quickjs-emscripten.global.js`);
            const variant = (await import(`${vendorBase}/quickjs/index.mjs`)).default;
            // asyncify 变体必须走 async 入口，否则会把 FFI 方法集合当类 new
            const maker = variant && variant.type === 'async'
                ? (QJS.newQuickJSAsyncWASMModuleFromVariant || QJS.newQuickJSWASMModuleFromVariant)
                : QJS.newQuickJSWASMModuleFromVariant;
            if (!maker) throw new Error('quickjs 引擎缺少构造入口');
            const mod = await maker(variant);
            return { mod, QJS };
        })().catch((e) => { modulePromise = null; throw e; });
    }
    return modulePromise;
}

function evalJson(context, expr) {
    const r = context.evalCode(expr);
    if (r.error) { const e = context.dump(r.error); r.error.dispose(); throw new Error('VM 求值失败: ' + (e.message || JSON.stringify(e))); }
    // consume() 会自己释放句柄，再 dispose 就是 use-after-free
    const text = r.value.consume((v) => context.dump(v));
    try { return JSON.parse(text); } catch (e) { return null; }
}

/**
 * 每个同步 VM 步骤都套一个中断时限：evalCode / executePendingJobs 会占住宿主线程，
 * 用户脚本写成 while(true){} 时没有它就能把 offscreen 页永久冻死。
 * 中断触发后 QuickJS 抛 InternalError("interrupted")，被宿主当成脚本错误收回。
 */
function makeStepper(context, runtime, timeoutMs) {
    const t0 = Date.now();
    let deadline = Infinity;
    let armed = false;
    try {
        runtime.setInterruptHandler(() => Date.now() > deadline);
        armed = true;
    } catch (e) { /* 变体没有该 API：只剩整体超时兜底 */ }
    return function step(fn) {
        deadline = Date.now() + Math.max(200, Math.min(5000, t0 + timeoutMs - Date.now()));
        try { return fn(); } finally { if (armed) deadline = Infinity; }
    };
}

/**
 * @param {string} code 函数体（可 return），或 module.exports = async (ctx) => {...}
 * @param {object} ctxData 注入 VM 的上下文，必须可 JSON 化
 * @param {(name:string,payload:any)=>Promise<any>} services 宿主服务
 */
export async function runUserScript({ code, ctxData, services, vendorBase, timeoutMs = 30000, memoryLimitMB = 96 }) {
    const { mod } = await loadQuickJs(vendorBase);
    const runtime = mod.newRuntime();
    try { runtime.setMemoryLimit(Math.round(memoryLimitMB * 1048576)); } catch (e) { /* 版本差异忽略 */ }
    const context = runtime.newContext();
    const step = makeStepper(context, runtime, timeoutMs);
    const close = () => {
        try { runtime.removeInterruptHandler(); } catch (e) { /* 变体没有该 API */ }
        try { context.dispose(); } catch (e) { /* 已释放 */ }
        try { runtime.dispose(); } catch (e) { /* 已释放 */ }
    };

    const json = JSON.stringify(ctxData || {});
    const seeded = step(() => context.evalCode(`${PRELUDE}\nglobalThis.ctx = ${json};\n${CTX_PRELUDE}`, 'prelude.js'));
    if (seeded.error) {
        const err = context.dump(seeded.error);
        seeded.error.dispose();
        close();
        return { ok: false, error: '引擎初始化失败: ' + (err.message || JSON.stringify(err)) };
    }
    seeded.value.dispose();

    const body = /module\s*\.\s*exports\s*=/.test(code)
        ? `const module = { exports: {} };\nglobalThis.__entry = function(){ const m = {}; ${code.replace(/module\s*\.\s*exports\s*=/, 'm.exports =')}; return m.exports; }();`
        : `globalThis.__entry = async function (ctx) { ${code} };`;
    const start = step(() => context.evalCode(`(function(){ ${body}\n})();`, 'user-script-body.js'));
    if (start.error) {
        const err = context.dump(start.error);
        start.error.dispose();
        close();
        return { ok: false, error: '语法错误: ' + (err.message || err.stack || JSON.stringify(err)) };
    }
    start.value.dispose();

    const launch = step(() => context.evalCode(`(async () => {
        try {
            const r = await (globalThis.__entry && globalThis.__entry(globalThis.ctx));
            globalThis.__result = { state: 'ok', value: r === undefined ? {} : r };
        } catch (e) {
            // QuickJS 的 stack 只有 "at …" 行，不含 message，得自己拼回头一行
            var m = '';
            if (e && typeof e === 'object') {
                if (e.message) m += (e.name || 'Error') + ': ' + e.message;
                if (e.stack) m += (m ? '\\n' : '') + e.stack;
                if (!m) m = JSON.stringify(e);
            } else m = String(e);
            globalThis.__result = { state: 'error', message: m };
        }
    })();`, 'user-script-run.js'));
    if (launch.error) {
        const err = context.dump(launch.error);
        launch.error.dispose();
        close();
        const m = err.message || JSON.stringify(err);
        return { ok: false, error: /interrupt/i.test(m) ? '脚本卡住被中断（同步死循环会占住宿主线程，已强制停止）' : '启动脚本失败: ' + m };
    }
    launch.value.dispose();

    const t0 = Date.now();
    for (;;) {
        const drained = step(() => evalJson(context, 'JSON.stringify(globalThis.__queue.splice(0, globalThis.__queue.length))')) || [];
        for (const req of drained) {
            let payload;
            try { payload = req.argJson ? JSON.parse(req.argJson) : undefined; } catch (e) { payload = req.argJson; }
            let ok = true, out;
            try { out = await services(req.name, payload); }
            catch (e) { ok = false; out = { message: String(e && e.message || e) }; }
            let injected;
            try { injected = JSON.stringify(JSON.stringify(out === undefined ? null : out)); }
            catch (e) { injected = 'null'; }
            const r = step(() => context.evalCode(`globalThis.__hostResolve(${req.id}, ${ok ? 1 : 0}, ${injected})`));
            if (r.error) r.error.dispose(); else r.value.dispose();
        }

        // 0.32 的 executePendingJobs() 直接返回作业数（不是 Result 句柄），别去 dispose
        try { step(() => context.runtime.executePendingJobs()); } catch (e) { /* 引擎自行处理 / 已被中断 */ }

        const state = step(() => evalJson(context, 'JSON.stringify(globalThis.__result.state !== "running" ? { s: globalThis.__result.state, m: globalThis.__result.message, v: globalThis.__result.value, ui: globalThis.__ui || [] } : null)'));
        if (state && state.s && state.s !== 'running') {
            close();
            if (state.s === 'error') return { ok: false, error: state.m || '脚本执行失败' };
            return { ok: true, result: normalizeResult(state.v, state.ui) };
        }
        if (Date.now() - t0 > timeoutMs) {
            close();
            return { ok: false, error: `脚本执行超时（${Math.round(timeoutMs / 1000)}s），或写成了不可中断的死循环` };
        }
        await new Promise((r) => setTimeout(r, 8));
    }
}

function normalizeResult(r, ui) {
    let out = {};
    if (r === undefined || r === null) out = {};
    else if (typeof r === 'string') out = { text: r };
    else if (typeof r === 'object') out = r;
    else out = { text: String(r) };
    for (const c of ui || []) {
        if (c.type === 'toast') { out.toast = c.text; out.isError = c.isError; }
        if (c.type === 'overlay') out.overlay = c.spec;
        if (c.type === 'copy') out.copyText = c.text;
    }
    return out;
}

/** 语法检查：只编译不执行，供设置页按钮用 */
export async function compileUserScript({ code, vendorBase }) {
    const { mod } = await loadQuickJs(vendorBase);
    const runtime = mod.newRuntime();
    const context = runtime.newContext();
    try {
        const r = context.evalCode(`(async function (ctx) {\n${code}\n})`, 'syntax-check.js');
        if (r.error) {
            const err = context.dump(r.error);
            r.error.dispose();
            return { ok: false, error: err.message || JSON.stringify(err) };
        }
        r.value.dispose();
        return { ok: true };
    } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
    } finally {
        try { context.dispose(); } catch (e) { /* ignore */ }
        try { runtime.dispose(); } catch (e) { /* ignore */ }
    }
}
