// 视频取帧：4 级降级链，全部来自旧实现并经测试矩阵验证。
// 1) 直接画布取帧 2) CORS 克隆 video（免整包下载） 3) 整包 refetch 重建 4) 标签页截图裁剪。

import { trimBorder } from '../common/imgops/geometry.js';
import { resize as resizePx, mkPx } from '../common/imgops/geometry.js';
import { friendlyText } from '../common/ext-state.js';

const MEDIA_FETCH_CAP = 500 * 1024 * 1024;
const corsCloneCache = new Map();
const refetchCache = new Map();

export function bgSend(msg) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ ...msg, __from: 'content', pageUrl: location.href }, (res) => {
                if (chrome.runtime.lastError) resolve({ ok: false, error: friendlyText(chrome.runtime.lastError.message) });
                else resolve(res);
            });
        } catch (e) { resolve({ ok: false, error: friendlyText(e && e.message) }); }
    });
}

function canvasOf(video) {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.getContext('2d').getImageData(0, 0, 1, 1); // 触发跨域污染检查
    return canvas;
}

function frameOffsetInTop() {
    let dx = 0, dy = 0, w = window;
    try {
        while (w !== w.top) {
            const fe = w.frameElement;
            if (!fe) return null;
            const r = fe.getBoundingClientRect();
            dx += r.left; dy += r.top;
            w = w.parent;
        }
    } catch (e) { return null; }
    return { dx, dy, vw: w.innerWidth, vh: w.innerHeight };
}

async function cropScreenshot(dataUrl, rect) {
    const off = frameOffsetInTop();
    if (!off) throw new Error('视频位于跨域 iframe 中且画面受跨域保护，无法通过截图取帧');
    const dpr = window.devicePixelRatio || 1;
    const left = Math.max(rect.left + off.dx, 0), top = Math.max(rect.top + off.dy, 0);
    const right = Math.min(rect.right + off.dx, off.vw), bottom = Math.min(rect.bottom + off.dy, off.vh);
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const sw = Math.round((right - left) * dpr), sh = Math.round((bottom - top) * dpr);
            if (sw <= 0 || sh <= 0) { reject(new Error('视频不在可视区域内，无法截图取帧')); return; }
            const canvas = document.createElement('canvas');
            canvas.width = sw; canvas.height = sh;
            canvas.getContext('2d').drawImage(img, Math.round(left * dpr), Math.round(top * dpr), sw, sh, 0, 0, sw, sh);
            resolve(canvas);
        };
        img.onerror = () => reject(new Error('标签页截图解析失败'));
        img.src = dataUrl;
    });
}

async function fetchMediaBlob(src, onProgress) {
    await bgSend({ action: 'allowDirectMediaFetch', url: src });
    try {
        let res;
        try {
            res = await fetch(src, { credentials: 'include', cache: 'no-store' });
        } catch (e) {
            res = await fetch(src, { credentials: 'omit', cache: 'no-store' });
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const total = parseInt(res.headers.get('Content-Length') || '0', 10);
        if (total > MEDIA_FETCH_CAP) {
            res.body?.cancel?.().catch(() => {});
            throw new Error('视频文件过大（' + Math.round(total / 1048576) + 'MB），超出内部取帧上限');
        }
        if (res.body && res.body.getReader) {
            const reader = res.body.getReader();
            const chunks = [];
            let received = 0, last = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.length;
                if (received > MEDIA_FETCH_CAP) { reader.cancel().catch(() => {}); throw new Error('视频文件过大，超出内部取帧上限'); }
                const text = total ? '⏳ ' + Math.min(99, Math.round((received / total) * 100)) + '%' : '⏳ ' + (received / 1048576).toFixed(1) + 'MB';
                if (text !== last) { last = text; onProgress && onProgress(text); }
            }
            return new Blob(chunks, { type: res.headers.get('Content-Type') || 'video/mp4' });
        }
        const blob = await res.blob();
        if (blob.size > MEDIA_FETCH_CAP) throw new Error('视频文件过大，超出内部取帧上限');
        return blob;
    } finally {
        bgSend({ action: 'removeDirectMediaFetch' });
    }
}

async function captureViaCorsClone(video, src, onProgress) {
    await bgSend({ action: 'allowDirectMediaFetch', url: src });
    try {
        if (!corsCloneCache.has(src)) {
            const p = (async () => {
                const v2 = document.createElement('video');
                v2.crossOrigin = 'use-credentials';
                v2.muted = true; v2.preload = 'metadata'; v2.src = src;
                try {
                    await new Promise((resolve, reject) => {
                        const to = setTimeout(() => reject(new Error('CORS 克隆加载超时')), 15000);
                        v2.addEventListener('loadedmetadata', () => { clearTimeout(to); resolve(); }, { once: true });
                        v2.addEventListener('error', () => { clearTimeout(to); reject(new Error('CORS 克隆加载失败')); }, { once: true });
                    });
                    return v2;
                } catch (e) {
                    corsCloneCache.delete(src);
                    v2.removeAttribute('src'); v2.load();
                    throw e;
                }
            })();
            corsCloneCache.set(src, p);
            if (corsCloneCache.size > 3) {
                const oldest = corsCloneCache.keys().next().value;
                if (oldest !== src) {
                    Promise.resolve(corsCloneCache.get(oldest)).then((v) => { v.removeAttribute('src'); v.load(); }).catch(() => {});
                    corsCloneCache.delete(oldest);
                }
            }
        }
        const v2 = await corsCloneCache.get(src);
        onProgress && onProgress('⏳ 解码中');
        const t = video.currentTime || 0;
        const clamped = (isFinite(v2.duration) && v2.duration > 0) ? Math.max(0, Math.min(t, v2.duration - 0.05)) : t;
        await new Promise((resolve, reject) => {
            const to = setTimeout(() => reject(new Error('CORS 克隆 seek 超时')), 15000);
            v2.addEventListener('seeked', () => { clearTimeout(to); resolve(); }, { once: true });
            v2.currentTime = clamped;
        });
        if (!v2.videoWidth || !v2.videoHeight) throw new Error('CORS 克隆画面未就绪');
        return canvasOf(v2);
    } finally {
        bgSend({ action: 'removeDirectMediaFetch' });
    }
}

async function captureViaRefetch(video, src, onProgress) {
    if (!refetchCache.has(src)) {
        const p = fetchMediaBlob(src, onProgress)
            .then((blob) => ({ url: URL.createObjectURL(blob) }))
            .catch((e) => { refetchCache.delete(src); throw e; });
        refetchCache.set(src, p);
        if (refetchCache.size > 3) {
            const oldest = refetchCache.keys().next().value;
            if (oldest !== src) {
                Promise.resolve(refetchCache.get(oldest)).then((en) => URL.revokeObjectURL(en.url)).catch(() => {});
                refetchCache.delete(oldest);
            }
        }
    }
    const entry = await refetchCache.get(src);
    onProgress && onProgress('⏳ 解码中');
    const v2 = document.createElement('video');
    v2.muted = true; v2.playsInline = true; v2.preload = 'auto'; v2.src = entry.url;
    await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('重建视频加载超时')), 20000);
        v2.addEventListener('loadedmetadata', () => { clearTimeout(to); resolve(); }, { once: true });
        v2.addEventListener('error', () => { clearTimeout(to); reject(new Error('重建视频加载失败')); }, { once: true });
    });
    const t = video.currentTime || 0;
    const clamped = (isFinite(v2.duration) && v2.duration > 0) ? Math.max(0, Math.min(t, v2.duration - 0.05)) : t;
    await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('重建视频 seek 超时')), 10000);
        v2.addEventListener('seeked', () => { clearTimeout(to); resolve(); }, { once: true });
        v2.currentTime = clamped;
    });
    if (!v2.videoWidth || !v2.videoHeight) throw new Error('重建视频画面未就绪');
    return canvasOf(v2);
}

function canvasToPx(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return mkPx(id.width, id.height, new Uint8ClampedArray(id.data));
}

function pxToCanvas(px) {
    const c = document.createElement('canvas');
    c.width = px.width; c.height = px.height;
    c.getContext('2d').putImageData(new ImageData(px.data, px.width, px.height), 0, 0);
    return c;
}

// 返回 {canvas, dataUrl, method, via}；dataUrl 走 PNG，保证无损
export async function captureVideoFrame(video, { onProgress, trim = true, maxSide = 0, format = 'png', quality = 0.95 } = {}) {
    if (!video.videoWidth || !video.videoHeight) throw new Error('视频画面尚未加载，请稍候再试');
    let canvas = null, via = 'canvas';
    try {
        canvas = canvasOf(video);
    } catch (e) {
        canvas = null;
    }
    if (!canvas) {
        const src = video.currentSrc || video.src || '';
        if (/^https?:/i.test(src)) {
            try { canvas = await captureViaCorsClone(video, src, onProgress); via = 'cors-clone'; }
            catch (e) { console.debug('[mtb] 免下载取帧失败:', e && e.message); }
            if (!canvas) {
                try { canvas = await captureViaRefetch(video, src, onProgress); via = 'refetch'; }
                catch (e) { console.debug('[mtb] 内部取帧失败，降级截图:', e && e.message); }
            }
        }
    }
    if (!canvas) {
        via = 'screenshot';
        onProgress && onProgress('⏳ 截图取帧');
        let shot = null;
        document.getElementById('mtb-root')?.style && (document.getElementById('mtb-root').style.visibility = 'hidden');
        try {
            const res = await bgSend({ action: 'captureVisibleTab' });
            shot = res && res.success ? res.dataUrl : null;
            if (!shot && res && res.error && /MAX_CAPTURE_VISIBLE_TAB/i.test(res.error)) {
                throw new Error('截图接口限流（连续点击过快），请等 1 秒再试');
            }
        } finally {
            const r = document.getElementById('mtb-root');
            if (r) r.style.visibility = 'visible';
        }
        if (!shot) throw new Error('无法截取标签页画面（视频画布受跨域保护且截图失败）');
        canvas = await cropScreenshot(shot, video.getBoundingClientRect());
    }
    if (trim) {
        const trimmed = trimBorder(canvasToPx(canvas), { mode: 'black', tolerance: 30, contentRatio: 0.015, maxTrimRatio: 0.45, minKeepRatio: 0.3 });
        if (trimmed.trimmed) canvas = pxToCanvas(trimmed.image);
    }
    if (maxSide && Math.max(canvas.width, canvas.height) > maxSide) {
        const s = maxSide / Math.max(canvas.width, canvas.height);
        const px = resizePx(canvasToPx(canvas), Math.round(canvas.width * s), Math.round(canvas.height * s), 'lanczos3');
        canvas = pxToCanvas(px);
    }
    const mime = format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
    const dataUrl = canvas.toDataURL(mime, mime === 'image/png' ? undefined : quality);
    return { canvas, dataUrl, method: via, width: canvas.width, height: canvas.height, mime };
}

// 顺序取多帧（导出帧序列/拼图用）：同一 video 上串行 seek，避免并发抢解码器
export async function captureFrames(video, times, opts = {}) {
    const out = [];
    const wasPaused = video.paused;
    for (const t of times) {
        try { video.pause(); } catch (e) { /* 某些播放器会忽略 */ }
        await seekTo(video, t);
        const f = await captureVideoFrame(video, opts);
        out.push({ time: t, ...f });
    }
    if (!wasPaused) { try { await video.play(); } catch (e) { /* 自动播放策略可能拒绝 */ } }
    return out;
}

export function seekTo(video, t) {
    return new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('seek 超时')), 12000);
        const done = () => { clearTimeout(to); resolve(); };
        video.addEventListener('seeked', done, { once: true });
        const dur = isFinite(video.duration) ? video.duration : 0;
        video.currentTime = dur ? Math.max(0, Math.min(t, dur - 0.001)) : t;
    });
}

export function videoTimeList(video, count, { from = 0, to = 0 } = {}) {
    const dur = isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (!dur) return [video.currentTime || 0];
    const a = from > 0 ? from : 0;
    const b = to > 0 ? Math.min(to, dur) : dur;
    const n = Math.max(1, Math.round(count));
    const list = [];
    for (let i = 0; i < n; i++) list.push(a + (b - a) * ((i + 0.5) / n));
    return list;
}
