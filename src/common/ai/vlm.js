// 多模态对话（看图说话 / 提问 / OCR）。优先走 pipeline('image-text-to-text')，
// 失败再手工装配 processor + model + tokenizer，两条路都试一遍以便兼容不同导出布局。

import { clamp } from '../util.js';
import { canvasInput } from './input.js';
import { modelIdFor } from './sources.js';

export const VLM_PRESETS = [
    { id: 'qwen3vl-2b', name: 'Qwen3-VL-2B（onnx-community 导出，q4 约 1.45GB）', model: 'onnx-community/Qwen3-VL-2B-Instruct-ONNX', ms: 'cjc1887415157/Qwen3-VL-2B-Instruct-ONNX', dtypes: ['q4', 'q4f16', 'quantized', 'fp16'], bytes: 1_450_000_000, note: '布局含 decoder_model_merged_q4/vision_encoder_q4；需 WebGPU 才有可用速度' },
    { id: 'qwen2vl-2b', name: 'Qwen2-VL-2B（导出档位最全，兼容兜底）', model: 'onnx-community/Qwen2-VL-2B-Instruct', ms: 'cjc1887415157/Qwen2-VL-2B-Instruct', dtypes: ['q4', 'q4f16', 'bnb4', 'int8', 'fp16'], bytes: 2_500_000_000, note: 'Qwen3 布局报错时切这个' },
    { id: 'smolvlm2-500m', name: 'SmolVLM2-500M（q4 约 460MB，速度快）', model: 'HuggingFaceTB/SmolVLM2-500M-Video-Instruct', ms: 'cjc1887415157/SmolVLM2-500M-Video-Instruct', dtypes: ['q4', 'int8', 'q4f16', 'fp16'], bytes: 462_000_000, lang: 'en', note: '只输出英文（词表对中文会退化成 ）；CPU 也能跑' },
    { id: 'smolvlm2-256m', name: 'SmolVLM2-256M（q4 约 250MB，最省，CPU 首选）', model: 'HuggingFaceTB/SmolVLM2-256M-Video-Instruct', ms: 'cjc1887415157/SmolVLM2-256M-Video-Instruct', dtypes: ['q4', 'q4f16', 'int8', 'fp16'], bytes: 252_000_000, lang: 'en', note: '只输出英文；实测 12 token 约 60s（wasm 单线程）' },
];

// 自建 ModelScope 镜像只带 q4 与 q4f16 两档，所以源是它时 WebGPU 取 q4f16 而不是 fp16（必然 404）；
// 切回 HF 源才允许默认 fp16。
export function resolveVlm(ai = {}) {
    const p = VLM_PRESETS.find((x) => x.id === (ai.vlmPreset || 'qwen3vl-2b')) || VLM_PRESETS[0];
    const gpu = ai.device === 'webgpu';
    const want = !gpu ? ['q4'] : (ai.hub === 'modelscope' ? ['q4f16', 'fp16', 'q4'] : ['fp16', 'q4f16', 'q4']);
    return {
        model: ai.vlmModel || modelIdFor(ai, p),
        dtype: ai.vlmDtype || (want.find((d) => p.dtypes.includes(d)) || p.dtypes[0]),
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
        const { pipeline, AutoProcessor, AutoModelForImageTextToText, AutoModelForVision2Seq, AutoImageProcessor, AutoTokenizer } = this.tf;
        const opts = { device: this.device, dtype: this.dtype, progress_callback: this.progress };
        if (pipeline) {
            // 只认 image-text-to-text：这一版没有它，就别退到 image-to-text —— 那是纯描述管线，
            // 吃的是图像不是会话，把 messages 传进去会在 RawImage.read 里抛
            // "Unsupported input type: object"，而且就算不抛也答不了「提问/OCR」。
            try {
                const p = await pipeline('image-text-to-text', this.modelId, opts);
                this.engine = { kind: 'pipeline', p, processor: p.processor, model: p.model, tokenizer: p.tokenizer };
                this.onEvent('vlm-engine', { kind: 'pipeline', task: 'image-text-to-text' });
                return this.engine;
            } catch (e) {
                this.onEvent('vlm-engine-fail', { task: 'image-text-to-text', error: String(e && e.message || e).slice(0, 200) });
            }
        }
        const Proc = AutoProcessor || this.tf.Qwen3VLProcessor || this.tf.Qwen2VLProcessor || AutoImageProcessor;
        // 必须先试 AutoModelForImageTextToText：qwen3_vl / qwen2_vl 这些只在它那张映射表里，
        // 而 AutoModelForVision2Seq 的表没有 → 直接抛 "Unsupported model type: qwen3_vl"
        const Model = AutoModelForImageTextToText || AutoModelForVision2Seq || this.tf.Qwen3VLForConditionalGeneration || this.tf.Qwen2VLForConditionalGeneration;
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
        const inputs = await feed(eng.processor, messages);
        const ids = await eng.model.generate(inputs, {
            max_new_tokens: clamp(maxNewTokens, 8, 512),
            ...(temperature > 0 ? { do_sample: true, temperature } : {}),
        });
        const text = clean(decodeNewTokens(eng.tokenizer, ids, inputs));
        // SmolVLM2 这类英文模型的词表对中文输出会退化成字节替换符；
        // 与其把  贴给用户当答案，不如直接说清该换模型或换语言
        if (!text || /^\uFFFD+$/u.test(text)) throw new Error('模型输出无法解码（当前模型对中文支持差：换 Qwen 系模型，或把提示词/提问改成英文）');
        return { text, ms: Date.now() - t0, engine: 'manual' };
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

// 这版 vendor 没有 image-text-to-text 管线，只能手工装配；三处形状都与 python 版直觉不同，
// 全部按 test/vlm_call_probe.html 在这份构建上实测出来的签名写死：
//   processor 是 (texts, images, kwargs)，不是 (images, { text })；
//   generate 的解码参数走第二个参数，混进 inputs 会被忽略；
//   tokenizer.decode 只吃 number 数组，而 ids.data 是 BigInt64Array（直接 slice 传进去就抛
//   "token_ids must be a non-empty array of integers"）。
async function feed(processor, messages) {
    const images = [];
    for (const m of messages) for (const c of m.content || []) if (c.type === 'image' && c.image) images.push(c.image);
    let texts = null;
    const tok = processor.tokenizer;
    if (tok && typeof tok.apply_chat_template === 'function') {
        try {
            const t = tok.apply_chat_template(messages, { add_generation_prompt: true, tokenize: false });
            texts = Array.isArray(t) ? t : [String(t)];
        } catch (e) { texts = null; }
    }
    if (!texts) texts = messages.map((m) => (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
    const opts = { padding: true };
    // 这份构建里被实测可用的是 _call(texts, images, kwargs)；基类 __call__ 的第一参数是 images，
    // 传反了会在 RawImage.read 里抛 "Unsupported input type: object"
    if (typeof processor._call === 'function') return await processor._call(texts, images, opts);
    return await processor(texts, images, opts);
}

// generate() 把 prompt 的 token 也带在输出前部，要按行切掉再解码
function decodeNewTokens(tokenizer, ids, inputs) {
    const dims = Array.from(ids.dims || []);
    const flat = Array.from(ids.data, Number);
    const rows = dims.length === 2 ? Array.from({ length: dims[0] }, (_, r) => flat.slice(r * dims[1], (r + 1) * dims[1])) : [flat];
    const plen = inputs?.input_ids?.dims?.[1] || 0;
    const cut = dims.length === 2 && dims[1] > plen ? rows.map((r) => r.slice(plen)) : rows;
    const out = tokenizer.batch_decode(cut, { skip_special_tokens: true });
    return Array.isArray(out) ? String(out[0] ?? '') : String(out ?? '');
}

function clean(t) {
    return String(t || '')
        .replace(/<\|[^|]*\|>/g, '')
        .replace(/^assistant\s*/i, '')
        .replace(/[\u0000-\u0008\u000b-\u001f]/g, '')
        .trim();
}
