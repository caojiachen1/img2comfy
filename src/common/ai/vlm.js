// 多模态对话（看图说话 / 提问 / OCR）。优先走 pipeline('image-text-to-text')，
// 失败再手工装配 processor + model + tokenizer，两条路都试一遍以便兼容不同导出布局。

import { clamp } from '../util.js';
import { canvasInput } from './input.js';

export const VLM_PRESETS = [
    { id: 'qwen3vl-2b', name: 'Qwen3-VL-2B（onnx-community 导出，q4 约 1.1-1.5GB）', model: 'onnx-community/Qwen3-VL-2B-Instruct-ONNX', dtypes: ['q4', 'q4f16', 'quantized', 'fp16'], bytes: 1_300_000_000, note: '布局含 decoder_model_merged_q4/vision_encoder_q4；需 WebGPU 才有可用速度' },
    { id: 'qwen2vl-2b', name: 'Qwen2-VL-2B（导出档位最全，兼容兜底）', model: 'onnx-community/Qwen2-VL-2B-Instruct', dtypes: ['q4', 'q4f16', 'bnb4', 'int8', 'fp16'], bytes: 2_500_000_000, note: 'Qwen3 布局报错时切这个' },
    { id: 'smolvlm2-500m', name: 'SmolVLM2-500M（q4 约 220MB+视觉塔，速度快）', model: 'HuggingFaceTB/SmolVLM2-500M-Video-Instruct', dtypes: ['q4', 'int8', 'q4f16', 'fp16'], bytes: 500_000_000, note: '已核实仓库含 onnx/decoder_model_merged_q4.onnx；CPU 也可跑' },
    { id: 'smolvlm2-2p2b', name: 'SmolVLM2-2.2B（更准，约 1GB）', model: 'HuggingFaceTB/SmolVLM2-2.2B-Instruct', dtypes: ['q4', 'fp16'], bytes: 1_100_000_000 },
];

export function resolveVlm(ai = {}) {
    const p = VLM_PRESETS.find((x) => x.id === (ai.vlmPreset || 'qwen3vl-2b')) || VLM_PRESETS[0];
    return {
        model: ai.vlmModel || p.model,
        dtype: ai.vlmDtype || (ai.device === 'webgpu' ? (p.dtypes.includes('fp16') ? 'fp16' : p.dtypes[0]) : p.dtypes[0]),
        preset: p,
    };
}

const SYS = '你是图像理解助手。只输出结论内容，不要复述问题。使用简体中文回答。';

export class VlmRunner {
    constructor({ tf, device, dtype, modelId, progress, onEvent, vendorBase }) {
        this.tf = tf; this.device = device; this.dtype = dtype; this.modelId = modelId;
        this.progress = progress || (() => {});
        this.onEvent = onEvent || (() => {});
        this.vendorBase = vendorBase;
        this.engine = null;
    }

    async load() {
        if (this.engine) return this.engine;
        const { pipeline, AutoProcessor, AutoModelForVision2Seq, AutoImageProcessor, AutoTokenizer } = this.tf;
        const opts = { device: this.device, dtype: this.dtype, progress_callback: this.progress };
        if (pipeline) {
            for (const task of ['image-text-to-text', 'image-to-text']) {
                try {
                    const p = await pipeline(task, this.modelId, opts);
                    this.engine = { kind: 'pipeline', p, processor: p.processor, model: p.model, tokenizer: p.tokenizer };
                    this.onEvent('vlm-engine', { kind: 'pipeline', task });
                    return this.engine;
                } catch (e) {
                    this.onEvent('vlm-engine-fail', { task, error: String(e && e.message || e).slice(0, 200) });
                }
            }
        }
        const Proc = AutoProcessor || this.tf.Qwen3VLProcessor || this.tf.Qwen2VLProcessor || AutoImageProcessor;
        const Model = AutoModelForVision2Seq || this.tf.Qwen3VLForConditionalGeneration || this.tf.Qwen2VLForConditionalGeneration;
        if (!Proc || !Model) throw new Error('transformers.js 未提供 VLM 相关类');
        const processor = await Proc.from_pretrained(this.modelId, opts);
        const model = await Model.from_pretrained(this.modelId, opts);
        const tokenizer = await (AutoTokenizer || this.tf.AutoTokenizer).from_pretrained(this.modelId, opts);
        this.engine = { kind: 'manual', processor, model, tokenizer };
        this.onEvent('vlm-engine', { kind: 'manual' });
        return this.engine;
    }

    async ask(px, question, { maxNewTokens = 96, temperature = 0.2, system = SYS } = {}) {
        const eng = await this.load();
        const messages = [];
        if (system) messages.push({ role: 'system', content: [{ type: 'text', text: system }] });
        messages.push({
            role: 'user',
            content: [
                { type: 'image', image: rawImage(px, this.tf) },
                { type: 'text', text: question },
            ],
        });
        const t0 = Date.now();
        if (eng.kind === 'pipeline') {
            const out = await eng.p(messages, { max_new_tokens: clamp(maxNewTokens, 8, 512), do_sample: temperature > 0, temperature: temperature || undefined });
            const text = Array.isArray(out) ? (out[0]?.generated_text ?? String(out[0])) : String(out);
            return { text: clean(text), ms: Date.now() - t0, engine: 'pipeline' };
        }
        const inputs = await eng.processor(messages, { text: messages });
        const ids = await eng.model.generate({ ...inputs, max_new_tokens: clamp(maxNewTokens, 8, 512) });
        const sliced = sliceNewTokens(ids, inputs);
        return { text: clean(eng.tokenizer.decode(sliced, { skip_special_tokens: true })), ms: Date.now() - t0, engine: 'manual' };
    }

    async describe(px, opts = {}) {
        return this.ask(px, opts.prompt || '请用中文描述这张图片：主体、场景、风格、构图，以及画面中所有可读文字。', { maxNewTokens: 160, ...opts });
    }

    async ocr(px, opts = {}) {
        const r = await this.ask(px, '只输出图片里出现的文字，逐行照抄，不要翻译、不要解释。没有文字就只输出 NONE。', { maxNewTokens: 220, temperature: 0, ...opts });
        return { ...r, text: /^NONE\s*$/.test(r.text.trim()) ? '（图中无文字）' : r.text };
    }

    async tags(px, opts = {}) {
        const r = await this.ask(px, '用不超过 12 个中文标签概括这张图，逗号分隔，只输出标签。', { maxNewTokens: 48, temperature: 0.1, ...opts });
        return { ...r, tags: r.text.split(/[,，、\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, 12) };
    }
}

function rawImage(px, tf) {
    return canvasInput(px, tf);
}

// generate() 通常把 prompt 的 token 也带在输出前部，需要切掉
function sliceNewTokens(ids, inputs) {
    try {
        const promptLen = inputs.input_ids?.dims?.[1] || 0;
        const dims = ids.dims || [];
        if (dims.length === 2 && promptLen && dims[1] > promptLen) {
            return ids.data.slice(promptLen * dims[0]).slice(0, dims[1] - promptLen);
        }
        return ids.data;
    } catch (e) {
        return ids.data;
    }
}

function clean(t) {
    return String(t || '')
        .replace(/<\|[^|]*\|>/g, '')
        .replace(/^assistant\s*/i, '')
        .replace(/[\u0000-\u0008\u000b-\u001f]/g, '')
        .trim();
}
