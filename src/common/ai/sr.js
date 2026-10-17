// AI 超分。swin2SR 走 transformers.js 的 image-to-image 管线；
// 其它 ONNX 超分模型（Real-ESRGAN 等）走通用裸 ORT 通道，支持任意用户 URL。

import { clamp, toNum } from '../util.js';
import { mkPx } from '../imgops/geometry.js';
import { canvasInput } from './input.js';
import { modelIdFor } from './sources.js';

export const SR_PRESETS = [
    { id: 'swin2sr-x2', name: 'Swin2SR 经典 x2（约 8MB，干净放大）', model: 'Xenova/swin2SR-classical-sr-x2-64', ms: 'cjc1887415157/swin2SR-classical-sr-x2-64', scale: 2, via: 'tj' },
    { id: 'swin2sr-light-x2', name: 'Swin2SR 轻量 x2（约 5MB，最快）', model: 'Xenova/swin2SR-lightweight-x2-64', ms: 'cjc1887415157/swin2SR-lightweight-x2-64', scale: 2, via: 'tj' },
    { id: 'swin2sr-x4', name: 'Swin2SR 经典 x4（约 10MB）', model: 'Xenova/swin2SR-classical-sr-x4-64', ms: 'cjc1887415157/swin2SR-classical-sr-x4-64', scale: 4, via: 'tj' },
    { id: 'swin2sr-real-x4', name: 'Swin2SR 真实退化 x4（压图/噪声友好）', model: 'Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr', ms: 'cjc1887415157/swin2SR-realworld-sr-x4-64-bsrgan-psnr', scale: 4, via: 'tj' },
    { id: 'esrgan-x4', name: 'Real-ESRGAN x4plus（用户自备 ONNX URL）', model: '', scale: 4, via: 'ort' },
];

export function resolveSr(ai = {}) {
    const p = SR_PRESETS.find((x) => x.id === (ai.srPreset || 'swin2sr-x2')) || SR_PRESETS[0];
    return { preset: p, model: ai.srModel || modelIdFor(ai, p), scale: toNum(ai.srScale, p.scale), via: ai.srModelUrl ? 'ort' : p.via };
}

function toCHW(px) {
    const { width, height, data } = px;
    const n = width * height;
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        out[i] = data[i * 4] / 255;
        out[n + i] = data[i * 4 + 1] / 255;
        out[2 * n + i] = data[i * 4 + 2] / 255;
    }
    return out;
}

function fromCHW(t, { assumeRange255 = false } = {}) {
    const dims = t.dims;
    let c = 3, h, w;
    if (dims.length === 4) [, c, h, w] = dims;
    else if (dims.length === 3) [c, h, w] = dims;
    else throw new Error('超分输出形状不支持: ' + dims.join('x'));
    const n = w * h;
    const out = new Uint8ClampedArray(n * 4);
    const d = t.data;
    const scale = assumeRange255 ? 1 : 255;
    const off = assumeRange255 ? 0 : 0;
    for (let i = 0; i < n; i++) {
        out[i * 4] = clamp(Math.round(d[i] * scale + off), 0, 255);
        out[i * 4 + 1] = clamp(Math.round(d[n + i] * scale + off), 0, 255);
        out[i * 4 + 2] = clamp(Math.round(d[(c >= 3 ? 2 * n : 0) + i] * scale + off), 0, 255);
        out[i * 4 + 3] = c === 4 ? clamp(Math.round(d[3 * n + i] * scale), 0, 255) : (data_alpha(px) );
    }
    return mkPx(w, h, out);

    function data_alpha() { return 255; }
}

// 裸 ORT 通用路径：读元数据里的放大倍数，没有则按输出张量尺寸推断
export async function srGeneric(px, session, { tile = 0, overlap = 16, onProgress } = {}) {
    const ort = globalThis.ort;
    const inputName = session.inputNames[0];
    const meta = session.metadata?.getModelMetadata?.() || {};
    const declaredScale = toNum(meta.customOpsMetadata?.scale || meta.description?.match(/scale[:\s]*([24])/)?.[1] || 0, 0);
    const src = px;
    if (!tile || tile >= Math.max(px.width, px.height)) {
        const t = new ort.Tensor('float32', toCHW(px), [1, 3, px.height, px.width]);
        const res = await session.run({ [inputName]: t });
        const outT = res[session.outputNames[0]];
        return { image: fromCHW(outT, { assumeRange255: maxValue(outT) > 1.5 }), scale: declaredScale || (outT.dims[3] / px.width) };
    }
    const tiles = planTiles(px.width, px.height, tile, overlap);
    const estScale = declaredScale || 2;
    const outW = Math.round(px.width * estScale), outH = Math.round(px.height * estScale);
    const canvas = mkPx(outW, outH);
    let done = 0;
    for (const tl of tiles) {
        const sub = cropPx(px, tl);
        const t = new ort.Tensor('float32', toCHW(sub), [1, 3, sub.height, sub.width]);
        const res = await session.run({ [inputName]: t });
        const outT = res[session.outputNames[0]];
        const img = fromCHW(outT, { assumeRange255: maxValue(outT) > 1.5 });
        const sX = img.width / sub.width, sY = img.height / sub.height;
        pastePx(img, canvas, tl.x * sX, tl.y * sY, { skipEdge: tl.inner });
        onProgress && onProgress('tile', ++done / tiles.length);
    }
    return { image: canvas, scale: estScale, tiles: tiles.length };
}

function maxValue(t) {
    let m = 0;
    const d = t.data;
    for (let i = 0; i < d.length; i += 97) if (d[i] > m) m = d[i];
    return m;
}

function cropPx(px, r) {
    const out = new Uint8ClampedArray(r.width * r.height * 4);
    for (let y = 0; y < r.height; y++) {
        const sy = (r.y + y) * px.width + r.x;
        out.set(px.data.subarray(sy * 4, (sy + r.width) * 4), y * r.width * 4);
    }
    return mkPx(r.width, r.height, out);
}

function pastePx(src, dst, dx, dy, { skipEdge = null } = {}) {
    dx = Math.round(dx); dy = Math.round(dy);
    for (let y = 0; y < src.height; y++) {
        const ty = dy + y;
        if (ty < 0 || ty >= dst.height) continue;
        for (let x = 0; x < src.width; x++) {
            const tx = dx + x;
            if (tx < 0 || tx >= dst.width) continue;
            if (skipEdge) {
                const ix = x + skipEdge.x, iy = y + skipEdge.y;
                if (ix < skipEdge.w && iy < skipEdge.h) continue;
            }
            const si = (y * src.width + x) * 4, di = (ty * dst.width + tx) * 4;
            dst.data[di] = src.data[si]; dst.data[di + 1] = src.data[si + 1];
            dst.data[di + 2] = src.data[si + 2]; dst.data[di + 3] = src.data[si + 3];
        }
    }
}

function planTiles(w, h, tile, overlap) {
    const out = [];
    for (let y = 0; y < h; y += Math.max(1, tile - overlap)) {
        for (let x = 0; x < w; x += Math.max(1, tile - overlap)) {
            const tw = Math.min(tile, w - x), th = Math.min(tile, h - y);
            out.push({ x, y, width: tw, height: th, inner: { x: x === 0 ? 0 : overlap / 2, y: y === 0 ? 0 : overlap / 2, w: tw - (x + tw === w ? 0 : overlap / 2), h: th - (y + th === h ? 0 : overlap / 2) } });
            if (x + tw >= w) break;
        }
        if (y + th >= h) break;
    }
    return out;
}

export class SrRunner {
    constructor({ tf, device, dtype, progress, onEvent, vendorBase }) {
        this.tf = tf; this.device = device; this.dtype = dtype; this.vendorBase = vendorBase;
        this.progress = progress || (() => {}); this.onEvent = onEvent || (() => {});
        this.cache = new Map();
    }

    async runTj(px, modelId) {
        if (!this.cache.has('pipe:' + modelId)) {
            const p = this.tf.pipeline
                ? await this.tf.pipeline('image-to-image', modelId, { device: this.device, dtype: this.dtype, progress_callback: this.progress })
                : null;
            if (!p) throw new Error('无 image-to-image 管线');
            this.cache.set('pipe:' + modelId, p);
        }
        const p = this.cache.get('pipe:' + modelId);
        // ImageToImagePipeline._call 单图入参直接返回 RawImage（不是 {image}），
        // 传数组才会返回 RawImage[]
        const out = await p(canvasInput(px, this.tf));
        const img = Array.isArray(out) ? out[0] : out;
        if (!img || !img.width || !img.data) throw new Error('image-to-image 返回形状不认识: ' + Object.keys(img || {}).join(','));
        const data = img.channels === 4 ? new Uint8ClampedArray(img.data) : (() => {
            const rgba = new Uint8ClampedArray(img.width * img.height * 4);
            for (let i = 0, j = 0; i < img.width * img.height; i++, j += 4) {
                rgba[j] = img.data[i * img.channels];
                rgba[j + 1] = img.channels > 1 ? img.data[i * img.channels + 1] : rgba[j];
                rgba[j + 2] = img.channels > 2 ? img.data[i * img.channels + 2] : rgba[j];
                rgba[j + 3] = img.channels === 4 ? img.data[i * img.channels + 3] : 255;
            }
            return rgba;
        })();
        return { image: mkPx(img.width, img.height, data), scale: img.width / px.width, via: 'tj' };
    }

    async runOrt(px, urlOrModelId, { tile = 0, fileName } = {}) {
        const key = 'ort:' + (urlOrModelId || fileName);
        if (!this.cache.has(key)) {
            const { loadOrtSession } = await import('./ort-load.js');
            const s = await loadOrtSession({ url: urlOrModelId, fileName, dtype: this.dtype, progress: this.progress, device: this.device, vendorBase: this.vendorBase });
            this.cache.set(key, s);
        }
        return { ...await srGeneric(px, this.cache.get(key), { tile }), via: 'ort' };
    }
}
