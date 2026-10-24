// 多模态「看图说话 / 提问 / OCR」现在完全走外部 LLM API（OpenAI 兼容的 /chat/completions）。
// 浏览器里跑不动那份 1.4GB 权重，也不再让用户下模型：这里只管三件事——
// 把端点写成什么样子都能用、请求体形状对不对、应答里那段文字怎么取出来。

import { clamp, toInt, toNum } from '../util.js';

export const LLM_DEFAULTS = {
    endpoint: '',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.2,
    maxTokens: 512,
    // 送进 API 的图先夹到这个最长边再转 JPEG：base64 太长会把消息体撑爆，而多模态模型本来就先缩图
    imageMaxDim: 1024,
    imageQuality: 0.85,
    timeoutSec: 90,
};

const MAX_TOKENS_LIMIT = 8192;
const TIMEOUT_LIMIT = [5, 600];

/** 这三个 AI 任务只调外部接口，不需要 transformers.js 运行时，也不该触发模型下载 */
export const LLM_TASKS = new Set(['describe', 'ask', 'ocr']);

export function normalizeLlm(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const sec = toNum(src.timeoutSec, LLM_DEFAULTS.timeoutSec);
    return {
        endpoint: String(src.endpoint || '').trim(),
        // 密钥留不留空格是常见误填；Bearer 后面也不许重复带
        apiKey: String(src.apiKey || '').trim().replace(/^Bearer\s+/i, ''),
        model: String(src.model || '').trim() || LLM_DEFAULTS.model,
        temperature: clamp(toNum(src.temperature, LLM_DEFAULTS.temperature), 0, 2),
        maxTokens: clamp(toInt(src.maxTokens, LLM_DEFAULTS.maxTokens), 16, MAX_TOKENS_LIMIT),
        imageMaxDim: clamp(toInt(src.imageMaxDim, LLM_DEFAULTS.imageMaxDim), 256, 4096),
        imageQuality: clamp(toNum(src.imageQuality, LLM_DEFAULTS.imageQuality), 0.4, 1),
        timeoutSec: clamp(sec, TIMEOUT_LIMIT[0], TIMEOUT_LIMIT[1]),
    };
}

/** 端点只填到主机名或 /v1 也能用；已经写全 chat/completions 的原样不动 */
export function chatEndpoint(input) {
    const s = String(input || '').trim().replace(/\/+$/, '');
    if (!s) return '';
    if (/\/chat\/completions$/i.test(s)) return s;
    let withProto = s;
    if (!/^https?:\/\//i.test(withProto)) withProto = 'https://' + withProto;
    let u;
    try { u = new URL(withProto); } catch (e) { return s; }
    const path = u.pathname.replace(/\/+$/, '');
    if (!path || path === '/') u.pathname = '/v1/chat/completions';
    else u.pathname = path + '/chat/completions';
    return u.toString();
}

/** 没密钥也能跑：本机 Ollama / LM Studio / vLLM 这类默认不开鉴权 */
export function llmReady(llm) {
    const l = normalizeLlm(llm);
    return !!l.endpoint;
}

export function buildChatRequest(llmRaw, { system, user, imageDataUrl }) {
    const llm = normalizeLlm(llmRaw);
    const content = [];
    if (imageDataUrl) content.push({ type: 'image_url', image_url: { url: imageDataUrl } });
    content.push({ type: 'text', text: String(user || '') });
    const messages = [];
    if (system) messages.push({ role: 'system', content: String(system) });
    messages.push({ role: 'user', content });
    return {
        url: chatEndpoint(llm.endpoint),
        headers: {
            'content-type': 'application/json',
            ...(llm.apiKey ? { authorization: 'Bearer ' + llm.apiKey } : {}),
        },
        body: {
            model: llm.model,
            messages,
            temperature: llm.temperature,
            max_tokens: llm.maxTokens,
            stream: false,
        },
        timeoutMs: Math.round(llm.timeoutSec * 1000),
        model: llm.model,
    };
}

function joinParts(c) {
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return '';
    return c.map((p) => (typeof p === 'string' ? p : String((p && (p.text || p.content)) || ''))).join('');
}

/** OpenAI 兼容应答里文字可能出现的位置有好几种，逐个试；全空就报「应答里没有文字」 */
export function parseChatReply(json) {
    const j = json && typeof json === 'object' ? json : {};
    const choice = Array.isArray(j.choices) ? j.choices[0] : null;
    const msg = choice && (choice.message || choice.delta);
    let text = '';
    if (msg) text = joinParts(msg.content);
    if (!text && choice && typeof choice.text === 'string') text = choice.text;
    if (!text && typeof j.output_text === 'string') text = j.output_text;
    if (!text && Array.isArray(j.results)) text = joinParts(j.results);
    return {
        text: String(text || '').trim(),
        model: j.model || (msg && msg.model) || '',
        usage: j.usage || null,
        finish: (choice && choice.finish_reason) || '',
    };
}

const clip = (t, n = 180) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** 把 HTTP 状态码翻译成「下一步该改哪里」，而不是只甩一个 401 */
export function llmErrorText(status, payload) {
    const body = clip(payload, 200);
    const hint = body ? '（返回：' + body + '）' : '';
    if (status === 401 || status === 403) return '密钥不对或被拒：检查设置里的 API 密钥' + hint;
    if (status === 404) return '端点或模型名不存在：检查端点路径与模型名（本机服务要先跑起来）' + hint;
    if (status === 429) return '被限流了：稍后再试，或把并发/额度调低' + hint;
    if (status === 400) return '请求被拒（多半是模型不支持图片或 max_tokens 超限）' + hint;
    if (status >= 500) return '服务端出错 ' + status + hint;
    return 'HTTP ' + status + hint;
}

/** 出错时把密钥从任何日志/回显里抹掉 */
export function redactKey(text, apiKey) {
    const s = String(text || '');
    const k = String(apiKey || '').trim();
    if (!k) return s;
    return s.split(k).join('***');
}
