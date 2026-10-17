// transformers.js 运行环境装配：镜像源、设备（WebGPU/WASM）、dtype、wasm 路径。
// 只在宿主页面（offscreen 或标签页）里调用一次，随后各模型模块共用。

import { applyWasmPaths } from './runtime-install.js';

let installed = null;   // {tf, ort, device, capabilities}

export const HUBS = {
    'hf-mirror': { name: 'hf-mirror（国内可达）', base: 'https://hf-mirror.com', revision: 'main' },
    huggingface: { name: 'huggingface.co', base: 'https://huggingface.co', revision: 'main' },
    // ModelScope 的仓库路径与 HF 同形，但默认分支叫 master；它只镜像了部分 HF 仓库，
    // 找不到模型时报 404，此时应回落到 hf-mirror
    modelscope: { name: 'ModelScope 魔搭（国内快，需该仓库已被镜像）', base: 'https://www.modelscope.cn', revision: 'master' },
    jsdelivr: { name: 'jsDelivr CDN', base: 'https://cdn.jsdelivr.net/gh/huggingface-js-placeholder', revision: 'main' },
    custom: { name: '自定义', base: '', revision: 'main' },
};

export function hubBase(aiSettings) {
    const h = HUBS[aiSettings.hub] || HUBS['hf-mirror'];
    if (aiSettings.hub === 'custom') return (aiSettings.hubCustom || '').replace(/\/$/, '');
    return h.base;
}

// jsDelivr 走 hf 的仓库镜像形式
export function modelUrlFor(modelId, file, aiSettings) {
    const base = hubBase(aiSettings);
    if (aiSettings.hub === 'jsdelivr') {
        const [repo, rev = 'main'] = modelId.split('@');
        const [owner, name] = repo.split('/');
        return `https://cdn.jsdelivr.net/hf/${owner}--${name}/${rev}/${file}`;
    }
    return `${base}/${modelId}/resolve/${(HUBS[aiSettings.hub] || HUBS['hf-mirror']).revision}/${file}`;
}

export async function probeDevice(requested = 'auto') {
    const out = { webgpu: false, adapter: null, reason: '' };
    if (requested === 'wasm') return { ...out, reason: '用户指定 CPU(wasm)' };
    try {
        if (!globalThis.navigator || !globalThis.navigator.gpu) { out.reason = '浏览器无 WebGPU'; return out; }
        // Windows 上 Chromium 会忽略 powerPreference 并在控制台刷一条警告（crbug.com/369219127），
        // 所以只在别的平台给这个提示。
        const isWindows = /Windows/i.test(String(globalThis.navigator.userAgentData?.platform || globalThis.navigator.platform || ''));
        const adapter = await globalThis.navigator.gpu.requestAdapter(isWindows ? undefined : { powerPreference: 'high-performance' });
        if (!adapter) { out.reason = '无可用 GPU 适配器'; return out; }
        out.webgpu = true;
        const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo().catch(() => null) : null) || {};
        out.adapter = {
            vendor: info.vendor || '',
            architecture: info.architecture || '',
            device: info.device || '',
            description: info.description || '',
            features: Array.from(adapter.features || []),
            limits: { maxMemoryBufferSize: adapter.limits?.maxBufferStorageSize || 0 },
        };
        return out;
    } catch (e) {
        out.reason = 'WebGPU 探测失败: ' + (e && e.message);
        return out;
    }
}

// 宿主页面里 transformers.js 的 wasm glue 与 ort wasm 都在 vendor/ 下，
// 必须把 wasmPaths 指过去，否则 ORT 会去找 CDN（MV3 扩展页禁止远端脚本）。
export async function installTransformers({ ai, onProgress, vendorBase }) {
    if (installed && installed.aiHub === ai.hub && installed.hubCustom === ai.hubCustom) return installed;
    const mod = await import(`${vendorBase}/transformers.web.min.mjs`);
    const { env, ...rest } = mod;
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;
    env.backends.onnx.wasm.wasmPaths = vendorBase + '/';
    env.backends.onnx.wasm.proxy = false;
    env.backends.onnx.wasm.numThreads = Math.min(4, globalThis.navigator?.hardwareConcurrency || 1);
    // 包里没有 wasm 时改用设置页装到 Cache 的那份（blob: 地址）；glue 仍来自扩展包
    await applyWasmPaths({ env: { wasm: env.backends.onnx.wasm } }, vendorBase);
    const cap = await probeDevice(ai.device);
    const device = ai.device === 'auto' ? (cap.webgpu ? 'webgpu' : 'wasm') : (ai.device === 'webgpu' && !cap.webgpu ? 'wasm' : ai.device);
    if (ai.hub !== 'huggingface') {
        // remoteHost 必须是带协议的完整源（transformers.js 直接拼 `${remoteHost}/${template}`），
        // 之前剥掉协议会得到 "hf-mirror.com/Xenova/..." 这种非法 URL
        const full = hubBase(ai).replace(/\/+$/, '');
        env.remoteHost = ai.hub === 'jsdelivr' ? 'https://cdn.jsdelivr.net' : full;
        env.remotePathTemplate = ai.hub === 'jsdelivr' ? 'hf/{model}/resolve/{revision}/'
            : (ai.hub === 'modelscope' ? '{model}/resolve/master/' : '{model}/resolve/{revision}/');
    }
    installed = { tf: rest, env, device, requested: ai.device, capabilities: cap, aiHub: ai.hub, hubCustom: ai.hubCustom, vendorBase };
    return installed;
}

export function currentRuntime() {
    return installed;
}

export function describeRuntime() {
    if (!installed) return { ready: false };
    return {
        ready: true,
        device: installed.device,
        requested: installed.requested,
        webgpu: installed.capabilities.webgpu,
        adapter: installed.capabilities.adapter,
        reason: installed.capabilities.reason,
        hub: installed.aiHub,
    };
}

export function pickDtype(modelEntry, device) {
    if (modelEntry.dtype) return modelEntry.dtype;
    if (device === 'webgpu') return 'fp16';
    const list = modelEntry.dtypes || ['q4', 'int8', 'fp32'];
    return list[0];
}

export async function probeFileSizes(urls) {
    const out = [];
    let total = 0;
    for (const u of urls) {
        let size = 0;
        try {
            const r = await fetch(u, { method: 'HEAD' });
            if (r.ok) size = Number(r.headers.get('content-length') || 0);
        } catch (e) { /* HEAD 不被支持时按未知处理 */ }
        out.push({ url: u, size });
        total += size;
    }
    return { files: out, total };
}
