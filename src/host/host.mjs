// 宿主页面（offscreen 或后台标签）主循环：图像编解码、算子链执行、AI 任务、
// 用户脚本执行桥接（QuickJS/wasm，见 src/common/script-vm.js）

import { bytesToBase64, base64ToBytes, dataUrlToBytes, bytesToDataUrl, sniffMime, formatBytes, sanitizeFilename } from '../common/util.js';
import { mkPx, clonePx, resize } from '../common/imgops/geometry.js';
import { runChain, STEPS } from '../common/steps.js';
import { AiEngine } from '../common/ai/index.js';
import { describeRuntime } from '../common/ai-env.js';

const VENDOR_BASE = chrome.runtime.getURL('vendor');

globalThis.__MTB_VENDOR = VENDOR_BASE;

let engine = null;
let aiSettings = null;

export function isHostPage() {
    return /mtb-host=1/.test(location.search);
}

function sendBg(msg) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ ...msg, __from: 'host' }, (res) => {
                if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
                else resolve(res);
            });
        } catch (e) { resolve({ ok: false, error: e.message }); }
    });
}

async function emit(type, data = {}) {
    await sendBg({ action: 'mtbEvent', type, ...data });
}

// 模型/wasm 下载进度只发给设置页和控制台，推理状态才发到工具栏旁边
function routeProgress(p) {
    emit(p && (p.download || p.phase === 'download') ? 'modelProgress' : 'aiProgress', p || {});
}

// ---------------------------------------------------------------- 编解码

async function decodeBytes(bytes) {
    const mime = sniffMime(bytes);
    const blob = new Blob([bytes], { type: mime });
    let bmp;
    try {
        bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (e) {
        bmp = await createImageBitmap(blob);
    }
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const id = ctx.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close?.();
    return { px: mkPx(id.width, id.height, new Uint8ClampedArray(id.data)), mime, naturalWidth: bmp?.width || id.width, naturalHeight: bmp?.height || id.height };
}

async function encodePx(px, format = 'png', quality = 0.92) {
    const canvas = new OffscreenCanvas(px.width, px.height);
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(px.data, px.width, px.height), 0, 0);
    const type = format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
    const blob = await canvas.convertToBlob({ type, quality: type === 'image/png' ? undefined : quality });
    return { bytes: new Uint8ClampedArray(await blob.arrayBuffer()), mime: type, bytes_len: blob.size };
}

function maskToDataUrl(mask) {
    const canvas = new OffscreenCanvas(mask.width, mask.height);
    const ctx = canvas.getContext('2d');
    const id = new ImageData(mask.width, mask.height);
    for (let i = 0; i < mask.width * mask.height; i++) {
        id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = mask.data[i];
        id.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    return canvas.toDataURL ? canvasToDataUrl(canvas) : null;
}

async function canvasToDataUrl(canvas) {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), 'image/png');
}

// ---------------------------------------------------------------- 用户脚本（QuickJS/wasm）
// 不引入 manifest 的 sandbox 页、也不放松 CSP：用户代码在 wasm 内的 QuickJS 解释执行。
// VM 与 host 之间只有同步调用 + 请求队列，避免 host 回调 Promise 与 VM 作业互相等待死锁。

async function callService(name, payload) {
    if (name === 'fetch') return await sendBg({ action: 'proxyFetch', ...payload });
    if (name === 'comfy') return await sendBg({ action: 'sendImageToComfyUI', ...payload });
    if (name === 'storage.get') return await chrome.storage.local.get((payload && payload.keys) || []);
    if (name === 'storage.set') { await chrome.storage.local.set(payload || {}); return { ok: true }; }
    if (name === 'emitUi') { await emit('toolUi', { payload }); return { ok: true }; }
    if (name === 'ai') return await runAiTask(payload.task, payload);
    if (name === 'ops') return await runOpTask(payload);
    if (name === 'download') return await sendBg({ action: 'downloadDataUrl', dataUrl: payload.dataUrl, filename: sanitizeFilename(payload.filename || 'mtb') });
    if (name === 'encode') return await HANDLERS.encode(payload);
    throw new Error('未知服务: ' + name);
}

async function runUserScript(scriptId, code, ctxData) {
    const { runUserScript: run } = await import('../common/script-vm.js');
    return await run({ code, ctxData, vendorBase: VENDOR_BASE, services: callService });
}


// ---------------------------------------------------------------- 任务

async function acquireImage(req) {
    let bytes = null, mime = 'image/png';
    if (req.dataUrl) {
        const parsed = dataUrlToBytes(req.dataUrl);
        bytes = parsed.bytes; mime = parsed.mime;
    } else if (req.bytesB64) {
        bytes = base64ToBytes(req.bytesB64); mime = sniffMime(bytes);
    } else if (req.url) {
        const r = await sendBg({ action: 'fetchMedia', url: req.url, pageUrl: req.pageUrl, filename: req.filename });
        if (!r || !r.ok) throw new Error(r?.error || '抓取图片失败');
        bytes = base64ToBytes(r.data); mime = r.mime || sniffMime(bytes);
    } else throw new Error('没有图片来源');
    const { px } = await decodeBytes(bytes);
    return { px, mime, bytes, bytesLen: bytes.length };
}

async function runOpTask(req) {
    const { px, mime, bytesLen } = await acquireImage(req);
    const chain = (req.chain || []).filter((s) => s && STEPS[s.op]);
    const out = runChain(px, chain);
    const result = { reports: out.reports, boxes: out.boxes, points: out.points, lines: out.lines, sourceBytes: bytesLen, sourceMime: mime };
    if (out.image && out.image !== px) {
        const enc = await encodePx(out.image, req.format || 'png', req.quality || 0.92);
        result.dataUrl = bytesToDataUrl(enc.bytes, enc.mime);
        result.width = out.image.width; result.height = out.image.height;
        result.outBytes = enc.bytes_len;
    } else if (req.echoSource && req.url) {
        result.dataUrl = bytesToDataUrl(bytes, mime);
        result.width = px.width; result.height = px.height;
    }
    return result;
}

async function runAiTask(task, req) {
    if (!engine) engine = new AiEngine({ vendorBase: VENDOR_BASE, onEvent: (t, d) => emit(t, d), onProgress: routeProgress });
    if (req.ai) { aiSettings = req.ai; await engine.prepare(req.ai); }
    if (req.confirmBudget) engine.confirmBudget(req.confirmBudget);
    const acquired = req.dataUrl || req.bytesB64 || req.url ? await acquireImage(req) : null;
    const payload = { ...req, px: acquired?.px };
    if (req.maskAs === 'dataUrl') {
        const r = await engine.task(task, payload);
        if (r.masks) r.masks = undefined;
        if (r.overlay) r.overlay = await Promise.all(r.overlay.map(async (o) => o.type === 'mask' ? { ...o, maskUrl: await canvasToDataUrl(maskToCanvas(o.mask)) } : o));
        return r;
    }
    const r = await engine.task(task, payload);
    if (r.masks) {
        r.masks = await Promise.all(r.masks.map((m) => canvasToDataUrl(maskToCanvas(m))));
        r.maskCount = r.masks.length;
    }
    if (r.overlay) {
        for (const o of r.overlay) {
            if (o.type === 'mask' && o.mask) o.maskUrl = await canvasToDataUrl(maskToCanvas(o.mask));
            delete o.mask;
        }
    }
    if (r.image) {
        const enc = await encodePx(r.image, req.format || 'png', req.quality || 0.95);
        r.dataUrl = bytesToDataUrl(enc.bytes, enc.mime);
        r.width = r.image.width; r.height = r.image.height;
        delete r.image;
    }
    if (acquired) { r.sourceWidth = acquired.px.width; r.sourceHeight = acquired.px.height; }
    return r;
}

function maskToCanvas(mask) {
    const canvas = new OffscreenCanvas(mask.width, mask.height);
    const ctx = canvas.getContext('2d');
    const id = new ImageData(mask.width, mask.height);
    for (let i = 0; i < mask.width * mask.height; i++) {
        id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = id.data[i * 4 + 3] = mask.data[i];
    }
    ctx.putImageData(id, 0, 0);
    return canvas;
}

const HANDLERS = {
    ping: async () => ({ ok: true, host: true, runtime: describeRuntime(), vendor: VENDOR_BASE }),
    runtimeStatus: async () => { const m = await import('../common/runtime-install.js'); return { ok: true, status: await m.runtimeStatus({ vendorBase: VENDOR_BASE }) }; },
    installRuntime: async (req) => {
        const m = await import('../common/runtime-install.js');
        const r = await m.installRuntime({
            vendorBase: VENDOR_BASE, onlyRequired: req.onlyRequired !== true,
            onProgress: (p) => emit('runtimeProgress', p),
        });
        return { ok: !!r.ok, installed: r.installed, errors: r.errors, status: r.status };
    },
    clearRuntime: async () => { const m = await import('../common/runtime-install.js'); return { ok: true, cleared: await m.clearRuntimeCache() }; },
    runtime: async (req) => { const e = await ensureEngine(req.ai); return { ok: true, runtime: e.runtime || describeRuntime() }; },
    probeVlm: async (req) => {
        const e = await ensureEngine(req.ai);
        const r = await e.task('describe', { ...req, px: await acquireImage(req).then((x) => x.px) });
        return { ok: true, ...r };
    },
    op: runOpTask,
    ai: (req) => runAiTask(req.task, req),
    encode: async (req) => {
        const { px } = await acquireImage(req);
        const target = req.maxSide && Math.max(px.width, px.height) > req.maxSide
            ? resize(px, Math.round(px.width * Math.min(1, req.maxSide / Math.max(px.width, px.height))), Math.round(px.height * Math.min(1, req.maxSide / Math.max(px.width, px.height))), 'lanczos3')
            : px;
        const enc = await encodePx(target, req.format || 'png', req.quality || 0.92);
        return { ok: true, dataUrl: bytesToDataUrl(enc.bytes, enc.mime), width: target.width, height: target.height, bytes: enc.bytes_len };
    },
    decodeInfo: async (req) => {
        const { px, mime, bytesLen } = await acquireImage(req);
        return { ok: true, width: px.width, height: px.height, mime, bytes: bytesLen, bytesText: formatBytes(bytesLen) };
    },
    script: async (req) => {
        const acquired = req.image !== false ? await acquireImage(req).catch(() => null) : null;
        const ctxData = {
            ...req.ctx,
            dataUrl: acquired ? bytesToDataUrl(acquired.bytes, acquired.mime) : null,
            width: acquired?.px.width, height: acquired?.px.height,
            mime: acquired?.mime, bytes: acquired?.bytesLen,
        };
        const result = await runUserScript(req.scriptId, req.code, ctxData);
        return { ok: true, result };
    },
    compile: async (req) => {
        const { compileUserScript } = await import('../common/script-vm.js');
        return await compileUserScript({ code: req.code || '', vendorBase: VENDOR_BASE });
    },
    'script-host': async (req) => {
        // 用户脚本请求 host 侧再跑一次算子/AI（例如脚本改了尺寸后要继续处理）
        if (req.op) return runOpTask(req);
        if (req.task) return runAiTask(req.task, req);
        throw new Error('script-host 需要 op 或 task');
    },
};

async function ensureEngine(ai) {
    if (!engine) engine = new AiEngine({ vendorBase: VENDOR_BASE, onEvent: (t, d) => emit(t, d), onProgress: routeProgress });
    if (ai && ai !== aiSettings) { aiSettings = ai; await engine.prepare(ai); }
    return engine;
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (!req || req.action !== 'mtbHost') return;
    const h = HANDLERS[req.type];
    if (!h) { sendResponse({ ok: false, error: '宿主未知任务类型: ' + req.type }); return; }
    h(req).then((r) => sendResponse({ ok: true, ...(r || {}) }))
        .catch((e) => {
            console.warn('[mtb host] 失败:', req.type, e);
            sendResponse({ ok: false, error: String(e && e.message || e), stack: String(e && e.stack || '').split('\n').slice(0, 4).join(' | ') });
        });
    return true;
});

window.__mtbHost = { engine: () => engine, acquireImage, encodePx, decodeBytes, runOpTask, runAiTask, emit };
