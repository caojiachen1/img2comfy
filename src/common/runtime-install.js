// 运行时自动安装：把 ORT 的 wasm 后端从「必须自己跑 node 脚本」变成「设置页点一下」。
//
// 为什么只能这样：MV3 扩展页的 script-src 是 'self'，跨源脚本与 blob: 模块都进不来，
// 所以 JS 与 .mjs glue 必须随扩展打包；但 .wasm 走的是 wasm-unsafe-eval + 普通 fetch，
// 可以先下进 Cache API、再用 blob: 地址交给 ORT —— 已用 test/wasm_probe.html 实测：
// 26.8MB wasm → Cache → blob → InferenceSession 建立 330ms、推理 56ms、输出正确。
//
// 版本必须和打包里的 .mjs glue 对上，否则 ORT 会报 ABI 不匹配。这里按 transformers.js
// 4.3.1 精确锁死它依赖的 onnxruntime-web 开发版，并在装完后用字节数复核。

export const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';
export const CACHE_NAME = 'mtb-runtime-v1';

export const RUNTIME_FILES = [
    {
        name: 'ort-wasm-simd-threaded.asyncify.wasm', bytes: 26861777, required: true,
        label: 'ORT WASM 后端（asyncify）', note: 'CPU 推理必需；扩展页没有 SharedArrayBuffer，ORT 只会选这一份',
    },
    {
        name: 'ort-wasm-simd-threaded.jsep.wasm', bytes: 28352885, required: false,
        label: 'ORT WASM 后端（jsep）', note: '仅在跨域隔离可用的环境里才会被选，装了更保险',
    },
    {
        name: 'ort-wasm-simd-threaded.wasm', bytes: 14264838, required: false,
        label: 'ORT WASM 后端（threaded）', note: '需要 SharedArrayBuffer，扩展页用不到',
    },
];

// 多个镜像轮询：首选自己镜像到 ModelScope 的 wasm（本机实测 9~15 MB/s，且 resolve 直链带 CORS），
// jsDelivr 及其国内友好别名次之，unpkg 兜底。版本对不上时 ModelScope 上就是 404，会自动落到下一个源。
export function cdnUrls(name) {
    const p = `onnxruntime-web@${ORT_VERSION}/dist/${name}`;
    return [
        `https://www.modelscope.cn/models/cjc1887415157/mtb-ort-wasm/resolve/master/${name}`,
        `https://cdn.jsdelivr.net/npm/${p}`,
        `https://fastly.jsdelivr.net/npm/${p}`,
        `https://gcore.jsdelivr.net/npm/${p}`,
        `https://unpkg.com/${p}`,
    ];
}

export function cacheKey(name) { return `https://mtb.runtime/${name}`; }

export function openRuntimeCache() {
    if (!globalThis.caches) return Promise.resolve(null);
    return caches.open(CACHE_NAME);
}

async function sizeOf(response) {
    const h = Number(response.headers.get('x-size'));
    if (Number.isFinite(h) && h > 0) return h;
    return (await response.arrayBuffer()).byteLength;
}

/** 现状：包里有没有、Cache 里有没有、字节对不对 */
export async function runtimeStatus({ vendorBase } = {}) {
    const cache = await openRuntimeCache();
    const files = [];
    for (const f of RUNTIME_FILES) {
        let inPackage = 0, inCache = 0;
        if (vendorBase) {
            const r = await fetch(`${vendorBase}/${f.name}`, { method: 'HEAD' }).catch(() => null);
            if (r && r.ok) inPackage = Number(r.headers.get('content-length')) || 0;
        }
        if (cache) {
            const hit = await cache.match(cacheKey(f.name)).catch(() => null);
            if (hit) inCache = await sizeOf(hit);
        }
        const have = Math.max(inPackage, inCache);
        files.push({ ...f, inPackage, inCache, have, ready: have === f.bytes, source: inPackage ? 'package' : (inCache ? 'cache' : 'missing') });
    }
    const needBytes = RUNTIME_FILES.filter((f) => f.required).reduce((a, b) => a + b.bytes, 0);
    const allBytes = RUNTIME_FILES.reduce((a, b) => a + b.bytes, 0);
    return {
        ortVersion: ORT_VERSION, cacheName: CACHE_NAME, files,
        ready: files.filter((f) => f.required).every((f) => f.ready),
        requiredBytes: needBytes, totalBytes: allBytes,
        cachedBytes: files.reduce((a, f) => a + f.inCache, 0),
        packageBytes: files.reduce((a, f) => a + f.inPackage, 0),
        storage: globalThis.navigator?.storage?.estimate ? await navigator.storage.estimate().catch(() => null) : null,
    };
}

async function fetchWithProgress(url, onProgress, signal, { stallMs = 25000 } = {}) {
    // 卡住的源不能把整次安装拖死：一段时间没有新字节就掐掉，换下一个源
    const ctrl = new AbortController();
    let timer = null;
    const arm = () => {
        if (!stallMs) return;
        clearTimeout(timer);
        timer = setTimeout(() => ctrl.abort(), stallMs);
    };
    const onOuterAbort = () => ctrl.abort();
    if (signal) signal.addEventListener ? signal.addEventListener('abort', onOuterAbort) : (signal.onabort = onOuterAbort);
    arm();
    try {
        const res = await fetch(url, { signal: ctrl.signal, cache: 'force-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length')) || 0;
        if (!res.body || !res.body.getReader) {
            const buf = await res.arrayBuffer();
            if (onProgress) onProgress(buf.byteLength, buf.byteLength, url);
            return buf;
        }
        const reader = res.body.getReader();
        const chunks = [];
        let loaded = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length) arm();
            chunks.push(value);
            loaded += value.length;
            if (onProgress) onProgress(loaded, total, url);
        }
        const out = new Uint8Array(loaded);
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        return out.buffer;
    } catch (e) {
        if (e && e.name === 'AbortError') throw new Error(signal && signal.aborted ? '已取消' : `${stallMs / 1000}s 内没有数据（换下一个源）`);
        throw e;
    } finally {
        clearTimeout(timer);
        if (signal && signal.removeEventListener) signal.removeEventListener('abort', onOuterAbort);
    }
}

/**
 * 安装缺的 wasm。onProgress({file,index,total,loaded,size,phase,speed})。
 * 每个文件都按 CDN 列表依次试；下回来先核字节数，再写进 Cache API。
 */
export async function installRuntime({ vendorBase, onlyRequired = true, onProgress, signal, stallMs = 25000 } = {}) {
    const cache = await openRuntimeCache();
    if (!cache) throw new Error('这个环境没有 Cache API，无法自动安装（请改用 node scripts/setup-vendor.mjs）');
    const st = await runtimeStatus({ vendorBase });
    const todo = st.files.filter((f) => (onlyRequired ? f.required : true) && !f.ready);
    const report = { ok: true, installed: [], skipped: [], errors: [] };
    for (let i = 0; i < todo.length; i++) {
        const f = todo[i];
        const want = f.bytes;
        let done = false;
        for (const url of cdnUrls(f.name)) {
            try {
                if (onProgress) onProgress({ file: f.name, label: f.label, index: i, total: todo.length, loaded: 0, size: want, phase: 'start', url });
                const t0 = Date.now();
                const buf = await fetchWithProgress(url, (loaded, total) => {
                    const secs = Math.max(0.2, (Date.now() - t0) / 1000);
                    if (onProgress) onProgress({ file: f.name, label: f.label, index: i, total: todo.length, loaded, size: total || want, phase: 'download', speed: loaded / secs, url });
                }, signal, { stallMs });
                if (buf.byteLength !== want) {
                    report.errors.push(`${f.name} ← ${url}：字节数 ${buf.byteLength} ≠ 期望 ${want}（版本不匹配，换源）`);
                    continue;
                }
                await cache.put(cacheKey(f.name), new Response(buf, { headers: { 'Content-Type': 'application/wasm', 'x-size': String(buf.byteLength) } }));
                report.installed.push({ name: f.name, bytes: buf.byteLength, ms: Date.now() - t0, url });
                if (onProgress) onProgress({ file: f.name, label: f.label, index: i, total: todo.length, loaded: want, size: want, phase: 'done', url });
                done = true;
                break;
            } catch (e) {
                if (e && e.name === 'AbortError') throw e;
                report.errors.push(`${f.name} ← ${url}：${String(e && e.message || e).slice(0, 120)}`);
            }
        }
        if (!done) report.ok = false;
    }
    report.status = await runtimeStatus({ vendorBase });
    return report;
}

export async function clearRuntimeCache() {
    const ok = await caches.delete(CACHE_NAME);
    return { ok, cacheName: CACHE_NAME };
}

/**
 * 给 ORT 指路：包里有就用包里的（现状），否则用 Cache 里的字节造 blob: 地址。
 * .mjs glue 永远来自扩展包（blob 模块被 CSP 挡），所以版本必须与 ORT_VERSION 一致。
 */
export async function applyWasmPaths(ort, vendorBase) {
    const name = 'ort-wasm-simd-threaded.asyncify.wasm';
    const glue = `${vendorBase}/ort-wasm-simd-threaded.asyncify.mjs`;
    if (vendorBase) {
        const r = await fetch(`${vendorBase}/${name}`, { method: 'HEAD' }).catch(() => null);
        if (r && r.ok) return { source: 'package' };
    }
    const cache = await openRuntimeCache();
    const hit = cache ? await cache.match(cacheKey(name)).catch(() => null) : null;
    if (!hit) {
        const err = new Error('缺 ORT wasm 运行时（约 26MB）。到设置页「AI 与模型 → 运行时」点「安装运行时」，或在本目录跑 node scripts/setup-vendor.mjs');
        err.code = 'RUNTIME_MISSING';
        throw err;
    }
    const bytes = await hit.arrayBuffer();
    const want = (RUNTIME_FILES.find((f) => f.name === name) || {}).bytes || 0;
    if (want && bytes.byteLength !== want) {
        // 断流时写进 Cache 的半截 wasm 不会报「下载失败」，而是让 ORT 在 _free 里
        // 抛 memory access out of bounds —— 直接判死并删掉，让「安装运行时」重下一份
        await cache.delete(cacheKey(name));
        const err = new Error(`已下载的 ORT 运行时不完整（${bytes.byteLength}/${want} 字节），已丢弃；请到设置页「AI 与模型 → 运行时」重新点「安装运行时」`);
        err.code = 'RUNTIME_CORRUPT';
        throw err;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));
    ort.env.wasm.wasmPaths = { wasm: url, mjs: glue };
    return { source: 'cache', bytes: bytes.byteLength, blobUrl: url.slice(0, 24) + '…' };
}
