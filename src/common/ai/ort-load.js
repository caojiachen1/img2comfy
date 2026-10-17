// ORT 会话装载：wasm 文件在扩展 vendor 目录，权重从镜像源下载并进 Cache API。
// 同时把 globalThis.ort 备好，供各 AI 模块直接 new ort.Tensor(...)。

import { openCache, noteDownload, makeProgressFetch } from '../ai-io.js';
import { modelUrlFor } from '../ai-env.js';
import { applyWasmPaths } from '../runtime-install.js';

let ortPromise = null;

export async function ensureOrt(vendorBase) {
    const base = vendorBase || globalThis.__MTB_VENDOR || new URL('../../../vendor', import.meta.url).toString().replace(/\/$/, '');
    const mod = await import(`${base}/transformers.web.min.mjs`);
    // transformers.js 不一定再导出 ort 命名空间，裸会话需要从本地 ORT bundle 直接取
    if (!globalThis.ort) {
        let ort = mod.ort || null;
        if (!ort || !ort.InferenceSession) {
            const names = ['ort.webgpu.bundle.min.mjs', 'ort.all.bundle.min.mjs', 'ort.bundle.min.mjs'];
            for (const n of names) {
                try {
                    const o = await import(`${base}/${n}`);
                    if (o && o.InferenceSession) { ort = { InferenceSession: o.InferenceSession, Tensor: o.Tensor, env: o.env, ...o }; globalThis.__MTB_ORT_BUNDLE = n; break; }
                } catch (e) { /* 换下一个 */ }
            }
        }
        if (!ort || !ort.InferenceSession) throw new Error('vendor 里没有可用的 onnxruntime-web bundle，请重跑 node scripts/setup-vendor.mjs');
        globalThis.ort = ort;
        if (ort.env && ort.env.onnx && ort.env.onnx.wasm) ort.env.onnx.wasm.wasmPaths = base + '/';
        else if (ort.env && ort.env.wasm) ort.env.wasm.wasmPaths = base + '/';
    }
    if (!globalThis.Tensor && mod.Tensor) globalThis.Tensor = mod.Tensor;
    // 包里没有 wasm 时（用户没跑 setup-vendor），改用设置页「安装运行时」下到 Cache 的那份
    await applyWasmPaths(globalThis.ort, base);
    return mod;
}

export async function fetchModelBytes({ url, ai, progress, fileName }) {
    const cache = await openCache();
    if (cache) {
        const hit = await cache.match(url);
        if (hit) {
            progress && progress('cache', 1, 1, url);
            const blob = await hit.blob();
            return new Uint8Array(await blob.arrayBuffer());
        }
    }
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`模型下载失败 HTTP ${res.status} (${url})`);
    const total = Number(res.headers.get('content-length') || 0);
    const buf = await res.arrayBuffer();
    noteDownload(url, buf.byteLength, fileName || url);
    if (cache && res.ok) { try { await cache.put(url, new Response(buf.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } })); } catch (e) { /* 配额满：内存里仍能跑 */ } }
    progress && progress('download', buf.byteLength, total || buf.byteLength, url);
    return new Uint8Array(buf);
}

// 通用裸 ORT 会话：优先本地 vendor 权重，其次 modelUrl，再次镜像源上的仓库文件
export async function loadOrtSession({ url, ai = {}, fileName, dtype = 'q4', progress, device = 'wasm', vendorBase = null }) {
    await ensureOrt(vendorBase);
    const ort = globalThis.ort;
    if (!ort) throw new Error('onnxruntime-web 未就绪');
    let bytes = null;
    let source = '';
    if (url) {
        bytes = await fetchModelBytes({ url, ai, progress, fileName });
        source = url;
    } else if (fileName) {
        const u = modelUrlFor(ai.modelId || globalThis.__MTB_MODEL_ID || '', fileName, ai.hub === 'custom' ? ai : { hub: ai.hub || 'hf-mirror', hubCustom: ai.hubCustom });
        bytes = await fetchModelBytes({ url: u, ai, progress, fileName });
        source = u;
    } else {
        throw new Error('loadOrtSession 需要 url 或 fileName');
    }
    const opts = { logSeverityLevel: 3 };
    const providers = device === 'webgpu' && globalThis.navigator?.gpu ? ['webgpu', 'wasm'] : ['wasm'];
    if (providers.includes('webgpu')) {
        try {
            await ort.env?.wasm?.init?.({});
        } catch (e) { /* 已经初始化 */ }
    }
    let session;
    try {
        session = await ort.InferenceSession.create(bytes, { ...opts, executionProviders: providers });
    } catch (e) {
        if (providers.length > 1) {
            session = await ort.InferenceSession.create(bytes, { ...opts, executionProviders: ['wasm'] });
            session.__fellBackFromWebGpu = true;
        } else throw e;
    }
    session.__source = source;
    return session;
}

// 给 transformers.js 用的下载进度包装（它内部会调 fetch）
export function progressBridge(cb) {
    return makeProgressFetch((info) => cb && cb('download', info.loaded, info.total, info.url));
}

export function guessScaleFromShape(inDims, outDims) {
    try {
        const ih = inDims[inDims.length - 2], ow = outDims[outDims.length - 1], iw = inDims[inDims.length - 1], oh = outDims[outDims.length - 2];
        const sx = ow / iw, sy = oh / ih;
        if (Math.abs(sx - sy) < 0.01 && sx >= 1) return Math.round(sx * 100) / 100;
        if (sx >= 1 && sy >= 1) return [sx, sy];
    } catch (e) { /* 固定尺寸模型无法推断 */ }
    return null;
}
