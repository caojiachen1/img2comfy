// AI 任务公共设施：模型下载进度、本地缓存索引、张量<->像素互转。
// 权重缓存走 Cache API（持久、配额大），transformers.js 的 IndexedDB 只存 metadata。

import { formatBytes } from './util.js';

const CACHE_NAME = 'mtb-models-v1';
const LS_KEY = 'mtbModelCache';

export function cacheKeyFor(url) {
    return new Request(url, { method: 'GET' });
}

export async function openCache() {
    if (!('caches' in globalThis)) return null;
    try {
        return await caches.open(CACHE_NAME);
    } catch (e) {
        return null;
    }
}

// 包一层 fetch，把字节进度报给 UI；transformers.js 通过 env.customFetch 用它
export function makeProgressFetch(onProgress) {
    return async (input, init = {}) => {
        const res = await fetch(input, { ...init, cache: 'default' });
        try {
            const url = typeof input === 'string' ? input : input.url;
            if (/\/resolve\//.test(url) && res.ok && res.body) {
                const total = Number(res.headers.get('content-length') || 0);
                let loaded = 0;
                const stream = res.body.pipeThrough(new TransformStream({
                    transform(chunk, controller) {
                        loaded += chunk.byteLength;
                        if (onProgress) onProgress({ url, loaded, total });
                        controller.enqueue(chunk);
                    },
                }));
                return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
            }
        } catch (e) { /* 计数失败不影响请求本身 */ }
        return res;
    };
}

export function readIndex() {
    try {
        return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    } catch (e) {
        return {};
    }
}

export function writeIndex(index) {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify(index));
    } catch (e) { /* 配额满时忽略，缓存仍然可用 */ }
}

export async function noteDownload(url, bytes, modelId) {
    const idx = readIndex();
    const entry = idx[url] || { bytes: 0, hits: 0 };
    entry.bytes = Math.max(entry.bytes, bytes || 0);
    entry.hits += 1;
    entry.at = Date.now();
    entry.model = modelId || entry.model || '';
    idx[url] = entry;
    writeIndex(idx);
    return idx;
}

export async function cacheSummary() {
    const cache = await openCache();
    const idx = readIndex();
    let total = 0;
    const keys = [];
    if (cache) {
        const reqs = await cache.keys();
        for (const r of reqs) {
            let size = idx[r.url]?.bytes || 0;
            if (!size) {
                try {
                    const res = await cache.match(r);
                    const blob = res && await res.blob();
                    size = blob ? blob.size : 0;
                } catch (e) { size = 0; }
            }
            total += size;
            keys.push({ url: r.url, bytes: size, model: idx[r.url]?.model || '' });
        }
    }
    keys.sort((a, b) => b.bytes - a.bytes);
    return { total, totalText: formatBytes(total), count: keys.length, entries: keys };
}

export async function clearCache(modelUrlPrefix = '') {
    const cache = await openCache();
    if (!cache) return { cleared: 0 };
    const reqs = await cache.keys();
    let cleared = 0;
    for (const r of reqs) {
        if (modelUrlPrefix && !r.url.includes(modelUrlPrefix)) continue;
        if (await cache.delete(r)) cleared++;
    }
    const idx = readIndex();
    for (const k of Object.keys(idx)) {
        if (!modelUrlPrefix || k.includes(modelUrlPrefix)) delete idx[k];
    }
    writeIndex(idx);
    return { cleared };
}

// 下载预算闸门：超出 ai.downloadBudgetMB 时要求用户确认，避免偷偷拉 GB 级权重
export async function guardBudget(bytesNeeded, budgetMB, confirmed) {
    if (!bytesNeeded || !budgetMB) return { ok: true };
    if (bytesNeeded <= budgetMB * 1048576) return { ok: true };
    if (confirmed) return { ok: true };
    return {
        ok: false,
        reason: `首次下载约 ${formatBytes(bytesNeeded)}，超过设置的预算 ${formatBytes(budgetMB * 1048576)}。请在设置里提高预算或确认继续。`,
    };
}

export function tensorToPixels(tensor) {
    const dims = tensor.dims;
    if (dims.length === 3) {
        const [c, h, w] = dims;
        const data = new Uint8ClampedArray(w * h * 4);
        const src = tensor.data;
        for (let i = 0; i < w * h; i++) {
            data[i * 4] = clamp8(src[i]);
            data[i * 4 + 1] = clamp8(src[w * h + i]);
            data[i * 4 + 2] = clamp8(src[2 * w * h + i]);
            data[i * 4 + 3] = 255;
        }
        return { width: w, height: h, data, channels: c };
    }
    if (dims.length === 2) {
        const [h, w] = dims;
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) {
            const v = clamp8(src_norm(tensor.data[i]));
            data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
            data[i * 4 + 3] = 255;
        }
        return { width: w, height: h, data, channels: 1 };
    }
    if (dims.length === 4) {
        const [n, c, h, w] = dims;
        const data = new Uint8ClampedArray(w * h * 4);
        const src = tensor.data;
        for (let i = 0; i < w * h; i++) {
            data[i * 4] = clamp8(src[i]);
            data[i * 4 + 1] = clamp8(src[w * h + i]);
            data[i * 4 + 2] = clamp8(src[2 * w * h + i]);
            data[i * 4 + 3] = c >= 4 ? clamp8(src[3 * w * h + i]) : 255;
        }
        return { width: w, height: h, data, channels: c, batch: n };
    }
    throw new Error('不支持的张量形状: ' + dims.join('x'));

    function src_norm(v) { return v <= 1 ? v * 255 : v; }
    function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }
}

export function pixelsToTensorFloat(px, { mean = [0.5, 0.5, 0.5], std = [0.5, 0.5, 0.5], scale = 1 } = {}) {
    const { width, height, data } = px;
    const n = width * height;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        for (let c = 0; c < 3; c++) {
            const v = (data[i * 4 + c] / 255) / scale;
            arr[c * n + i] = (v - mean[c]) / std[c];
        }
    }
    return { data: arr, dims: [1, 3, height, width] };
}
