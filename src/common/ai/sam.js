// SAM 交互分割（transformers.js 4.3.1 真实 API，已对照 dist/transformers.js 源码）：
//   processor(image, { input_points, input_labels, input_boxes }) → { pixel_values, original_sizes, input_sizes }
//   model.get_image_embeddings({ pixel_values }) → { image_embeddings, image_positional_embeddings }
//   model.forward({ image_embeddings, image_positional_embeddings, input_points, input_labels }) → { pred_masks, iou_scores }
//   processor.post_process_masks(pred_masks, original_sizes, input_sizes) → Tensor[]（已按原图尺寸二值化）
// 注意：坐标用**原图像素**，processor 自己按 resize 因子换算，绝不能预先缩放。

import { clamp } from '../util.js';
import { canvasInput } from './input.js';

export const SAM_PRESETS = [
    { id: 'slimsam', name: 'slimSAM（最快，约 13MB）', model: 'Xenova/slimsam-77-uniform', dtype: 'quantized' },
    { id: 'mobilesam', name: 'MobileSAM（约 40MB）', model: 'onnx-community/mobilesam-1.0.0-hf', dtype: 'q4' },
    { id: 'sam-vit-b', name: 'SAM ViT-B（精度优先，约 400MB+）', model: 'Xenova/sam-vit-base', dtype: 'quantized' },
    { id: 'sam2-small', name: 'SAM 2 Small（单帧提示）', model: 'onnx-community/sam2-hiera-small', dtype: 'q4' },
];

export function resolveSam(ai = {}) {
    const p = SAM_PRESETS.find((x) => x.id === (ai.samPreset || 'slimsam')) || SAM_PRESETS[0];
    return { model: ai.samModel || p.model, dtype: ai.samDtype || p.dtype, preset: p };
}

export class SamRunner {
    constructor({ tf, device, dtype, modelId, progress, vendorBase }) {
        this.tf = tf; this.device = device; this.dtype = dtype; this.modelId = modelId;
        this.progress = progress || (() => {});
        this.vendorBase = vendorBase;
        this.model = null; this.processor = null;
        this.embCache = new Map();
    }

    async load() {
        if (this.model) return this;
        const { SamModel, SamProcessor } = this.tf;
        if (!SamModel || !SamProcessor) throw new Error('当前 transformers.js 未导出 SamModel/SamProcessor');
        const opts = { device: this.device, dtype: this.dtype, progress_callback: this.progress };
        this.model = await SamModel.from_pretrained(this.modelId, opts);
        this.processor = await SamProcessor.from_pretrained(this.modelId, opts);
        return this;
    }

    /**
     * @param {{width,height,data}} px 原图像素
     * @param {number[][]} points [[x,y], ...] 原图像素坐标
     * @param {number[]} labels 1=前景 0=背景
     */
    async segmentPoints(px, points, labels, { boxes = null } = {}) {
        await this.load();
        const input = canvasInput(px, this.tf);
        const pt = points.map((p) => [[Math.round(p[0]), Math.round(p[1])]]);          // [batch, point_batch, n, 2]
        const lb = labels.map((v) => [v]);                                              // [batch, point_batch, n]
        const kwargs = {};
        if (points.length) { kwargs.input_points = pt; kwargs.input_labels = lb; }
        if (boxes) kwargs.input_boxes = [boxes.map((b) => [b.x, b.y, b.x + b.width, b.y + b.height])];
        const inputs = await this.processor(input, kwargs);
        const modelInputs = { ...inputs };
        delete modelInputs.original_sizes;
        delete modelInputs.reshaped_input_sizes;
        delete modelInputs.input_size;
        const emb = await this.model.get_image_embeddings({ pixel_values: inputs.pixel_values });
        const out = await this.model.forward({
            ...modelInputs,
            image_embeddings: emb.image_embeddings,
            image_positional_embeddings: emb.image_positional_embeddings,
        });
        const masks = await this.processor.post_process_masks(
            out.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes,
        );
        return {
            masks: masks.map((t) => tensorToMask(t, px.width, px.height)),
            scores: (out.iou_scores ? Array.from(out.iou_scores.data) : []).map((v) => Number(v.toFixed(3))),
            lowRes: null,
        };
    }

    async box(px, rect) {
        return this.segmentPoints(px, [[rect.x + rect.width / 2, rect.y + rect.height / 2]], [1], { boxes: [rect] });
    }

    /** 自动模式：网格点各出一个遮罩，去重后返回 */
    async auto(px, { grid = 2, iouMin = 0 } = {}) {
        const pts = [], labs = [];
        for (let gy = 1; gy <= grid; gy++) for (let gx = 1; gx <= grid; gx++) {
            pts.push([px.width * gx / (grid + 1), px.height * gy / (grid + 1)]);
            labs.push(1);
        }
        const r = await this.segmentPoints(px, pts, labs);
        const items = r.masks.map((m, i) => ({ mask: m, score: r.scores[i] ?? 0 }))
            .filter((x) => x.score >= iouMin)
            .filter((x) => { let on = 0; for (const v of x.mask.data) if (v > 127) on++; return on > 8 && on < x.mask.width * x.mask.height * 0.999; });
        return items;
    }
}

/** post_process_masks 出来的是原尺寸的 0/1 张量，摊平成灰度遮罩 */
function tensorToMask(t, w, h) {
    const dims = t.dims || [];
    const data = t.data;
    let mw, mh, off = 0;
    if (dims.length === 4) { const [, , hh, ww] = dims; mw = ww; mh = hh; }
    else if (dims.length === 3) { const [, hh, ww] = dims; mw = ww; mh = hh; }
    else if (dims.length === 2) { [mh, mw] = dims; }
    else throw new Error('遮罩形状不明: ' + dims.join('x'));
    const out = new Uint8ClampedArray(w * h);
    const sx = mw / w, sy = mh / h;
    for (let y = 0; y < h; y++) {
        const my = clamp(Math.floor(y * sy), 0, mh - 1);
        for (let x = 0; x < w; x++) {
            const mx = clamp(Math.floor(x * sx), 0, mw - 1);
            const v = data[off + my * mw + mx];
            out[y * w + x] = (v > 0.5 || v >= 128) ? 255 : 0;
        }
    }
    return { width: w, height: h, data: out };
}
