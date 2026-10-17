// 视觉小模型：图像分类/标签、零样本标签（CLIP）、深度估计。

import { clamp } from '../util.js';
import { mkPx } from '../imgops/geometry.js';
import { canvasInput } from './input.js';
import { tensorToPixels } from '../ai-io.js';
import { modelIdFor } from './sources.js';

export { modelIdFor };

export const TAG_PRESETS = [
    { id: 'mobilenetv4', name: 'MobileNetV4 小（约 10MB，ImageNet 标签）', model: 'onnx-community/mobilenetv4_conv_small.e2400_r224_in1k', ms: 'cjc1887415157/mobilenetv4_conv_small.e2400_r224_in1k', dtype: 'q4' },
    { id: 'vit-base', name: 'ViT Base（约 90MB，更准）', model: 'Xenova/vit-base-patch16-224', ms: 'cjc1887415157/vit-base-patch16-224', dtype: 'q4' },
    { id: 'clip-zero-shot', name: 'CLIP 零样本（自定义中文/英文标签）', model: 'Xenova/clip-vit-base-patch32', ms: 'cjc1887415157/clip-vit-base-patch32', dtype: 'q4' },
];

export const DEPTH_PRESETS = [
    { id: 'depth-anything-small', name: 'Depth Anything Small（约 50MB）', model: 'Xenova/depth-anything-small-hf', ms: 'cjc1887415157/depth-anything-small-hf', dtype: 'q4' },
    { id: 'depth-anything-base', name: 'Depth Anything Base（约 100MB）', model: 'Xenova/depth-anything-base-hf', ms: 'cjc1887415157/depth-anything-base-hf', dtype: 'q4' },
];

export class VisionRunner {
    constructor({ tf, device, dtype, progress, vendorBase }) {
        this.tf = tf; this.device = device; this.dtype = dtype; this.vendorBase = vendorBase;
        this.progress = progress || (() => {});
        this.cache = new Map();
    }

    async pipe(task, modelId, extra = {}) {
        const key = task + ':' + modelId;
        if (!this.cache.has(key)) {
            if (!this.tf.pipeline) throw new Error('无 pipeline API');
            this.cache.set(key, await this.tf.pipeline(task, modelId, { device: this.device, dtype: this.dtype, progress_callback: this.progress, ...extra }));
        }
        return this.cache.get(key);
    }

    // 管线签名是 _call(image, { top_k })（snake_case），传 topK 会被静默忽略、永远只回 5 条
    async classify(px, { model, topK = 8, threshold = 0.2 } = {}) {
        const p = await this.pipe('image-classification', model);
        const labels = listOf(await p(canvasInput(px, this.tf), { top_k: topK }));
        return {
            labels: labels.slice(0, topK).map((o) => ({ label: o.label, score: Number((o.score ?? o.confidence ?? 0).toFixed(3)) })),
            filtered: labels.filter((o) => (o.score ?? o.confidence ?? 0) >= threshold).slice(0, topK).map((o) => o.label),
        };
    }

    // 压缩后的签名是 _call(image, candidateLabels, { hypothesis_template })：
    // 候选标签走的是第二个位置参数，塞进 options 里会直接 "s.map is not a function"
    async zeroShot(px, { model, candidateLabels = [], template } = {}) {
        const p = await this.pipe('zero-shot-image-classification', model);
        const out = await p(canvasInput(px, this.tf), candidateLabels, template ? { hypothesis_template: template } : {});
        return { labels: listOf(out).map((o) => ({ label: o.label ?? o.candidate_label, score: Number((o.score ?? 0).toFixed(3)) })) };
    }

    async depth(px, { model, colormap = 'viridis' } = {}) {
        const p = await this.pipe('depth-estimation', model);
        const out = await p(canvasInput(px, this.tf));
        // DepthEstimationPipeline 返回 { predicted_depth: Tensor }
        const raw = out?.predicted_depth ?? out?.depth;
        if (!raw) throw new Error('深度模型返回形状不认识: ' + Object.keys(out || {}).join(','));
        const gray = tensorToPixels(raw.dims.length === 4 ? { dims: raw.dims.slice(2), data: raw.data } : raw);
        return {
            gray: { width: gray.width, height: gray.height, data: gray.data },
            color: colorizeDepth(gray, colormap),
            normalizedTo: raw.dims?.join('x'),
        };
    }
}

const VIRIDIS = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
const INFERNO = [[0, 0, 4], [87, 16, 134], [198, 51, 118], [249, 137, 10], [252, 255, 164]];
const GRAY = [[0, 0, 0], [255, 255, 255]];

// transformers.js 的分类/零样本管线：单图返回扁平数组，批量才返回 [[...]]。
// 硬取 out[0] 会拿到第一个结果对象（.slice 直接抛），零样本那条更是被 ?.map 静默吞成空数组。
export function listOf(out) {
    if (Array.isArray(out)) return Array.isArray(out[0]) ? out[0] : out;
    if (out && Array.isArray(out.labels)) return out.labels;
    if (out && Array.isArray(out.output)) return out.output;
    return [];
}

function colorizeDepth(gray, name) {    const stops = name === 'inferno' ? INFERNO : name === 'gray' ? GRAY : VIRIDIS;
    const out = mkPx(gray.width, gray.height);
    const g = gray.data;
    for (let i = 0, j = 0; i < out.data.length; i += 4, j++) {
        // depth 张量已归一化到 0..255 灰度；近=亮，远=暗 由 colormap 顺序决定
        const t = g[j] / 255 * (stops.length - 1);
        const k = clamp(Math.floor(t), 0, stops.length - 2);
        const f = t - k;
        out.data[i] = stops[k][0] + (stops[k + 1][0] - stops[k][0]) * f;
        out.data[i + 1] = stops[k][1] + (stops[k + 1][1] - stops[k][1]) * f;
        out.data[i + 2] = stops[k][2] + (stops[k + 1][2] - stops[k][2]) * f;
        out.data[i + 3] = 255;
    }
    return out;
}
