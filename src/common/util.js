// 通用小工具：无 chrome / DOM 依赖，content、host、options 共用。

export const MB = 1048576;

export function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a, b, t) {
    return a + (b - a) * t;
}

export function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

// 数值容错解析：设置页所有 input 都走这里，空/非法一律回落到默认值
export function toNum(v, def = 0) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : def;
}

export function toInt(v, def = 0) {
    return Math.round(toNum(v, def));
}

export function deepMerge(base, patch) {
    if (Array.isArray(base) || Array.isArray(patch)) return clone(patch !== undefined ? patch : base);
    if (!isObj(base)) return clone(patch === undefined ? base : patch);
    const out = clone(base);
    if (!isObj(patch)) return out;
    for (const k of Object.keys(patch)) {
        out[k] = isObj(patch[k]) && isObj(base[k]) ? deepMerge(base[k], patch[k]) : clone(patch[k]);
    }
    return out;
}

export function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function clone(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(clone);
    const o = {};
    for (const k of Object.keys(v)) o[k] = clone(v[k]);
    return o;
}

let idSeq = 0;
export function uid(prefix = 't') {
    idSeq = (idSeq + 1) % 100000;
    return `${prefix}_${Date.now().toString(36)}${idSeq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export function formatBytes(n) {
    if (!isNum(n) || n < 0) return '?';
    if (n < 1024) return n + ' B';
    if (n < MB) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    if (n < 1024 * MB) return (n / MB).toFixed(n < 10 * MB ? 1 : 0) + ' MB';
    return (n / (1024 * MB)).toFixed(2) + ' GB';
}

export function formatDuration(sec) {
    if (!isNum(sec)) return '--:--';
    const s = Math.max(0, sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
    const ss = r.toFixed(2).padStart(5, '0');
    return (h > 0 ? h + ':' : '') + mm + ':' + ss;
}

// Windows/Linux 文件名非法字符；站点 URL 路径段常含冒号（抖音 tplv 参数），必须清洗
export function sanitizeFilename(name, max = 120) {
    let s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
    if (s.length > max) s = s.slice(0, max);
    if (!s) s = 'image_' + Date.now();
    return s;
}

// 内容指纹（采样 FNV-1a + 长度）：判断「同名的是不是同一张图」，不用把整张图算一遍
export function bytesFingerprint(bytes) {
    const n = bytes ? bytes.length : 0;
    let h = 0x811c9dc5;
    const step = n > 65536 ? Math.floor(n / 65536) : 1;
    for (let i = 0; i < n; i += step) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return n + ':' + h.toString(16);
}

// ComfyUI 的 /upload/image 带 overwrite:true，同名不同内容会互相盖掉（用户报的「只剩最后一张」）。
// 同一张图重复发还是复用同名，只有内容不同才加 _2/_3 序号。
export function uniqueUploadName(used, filename, fingerprint) {
    const seen = used.get(filename);
    if (seen === undefined) { used.set(filename, fingerprint); return filename; }
    if (seen === fingerprint) return filename;
    const dot = String(filename).lastIndexOf('.');
    const base = dot > 0 ? String(filename).slice(0, dot) : String(filename);
    const ext = dot > 0 ? String(filename).slice(dot) : '';
    for (let i = 2; i < 1000; i++) {
        const cand = `${base}_${i}${ext}`;
        const s = used.get(cand);
        if (s === undefined) { used.set(cand, fingerprint); return cand; }
        if (s === fingerprint) return cand;
    }
    const tail = `${base}_${Date.now().toString(36)}${ext}`;
    used.set(tail, fingerprint);
    return tail;
}

export function extFromMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('png')) return 'png';
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    if (m.includes('webp')) return 'webp';
    if (m.includes('gif')) return 'gif';
    if (m.includes('avif')) return 'avif';
    if (m.includes('bmp')) return 'bmp';
    if (m.includes('svg')) return 'svg';
    if (m.includes('tiff')) return 'tif';
    if (m.includes('mp4')) return 'mp4';
    if (m.includes('webm')) return 'webm';
    return 'png';
}

export function mimeFromExt(name) {
    const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    const e = m ? m[1].toLowerCase() : '';
    return ({
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
        gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
        mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4s: 'video/mp4',
    })[e] || 'application/octet-stream';
}

export function baseNameFromUrl(url) {
    try {
        const u = new URL(url);
        const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
        return seg || '';
    } catch (e) {
        return '';
    }
}

export function filenameFromUrl(url, fallbackExt = 'png') {
    const base = baseNameFromUrl(url);
    if (base && base.includes('.')) return sanitizeFilename(base);
    const host = (() => { try { return new URL(url).hostname; } catch (e) { return 'web'; } })();
    return sanitizeFilename(`${host}_${Date.now()}.${fallbackExt}`);
}

// 模板替换：链接型工具用 {src} {width} {height} {time} {pageUrl} {filename} 等占位符
export function fillTemplate(tpl, vars) {
    return String(tpl || '').replace(/\{([a-zA-Z0-9_.]+)\}/g, (all, key) => {
        const v = vars[key];
        if (v === undefined || v === null) return '';
        return encodeURIComponent(String(v));
    });
}

export function fillTemplateRaw(tpl, vars) {
    return String(tpl || '').replace(/\{([a-zA-Z0-9_.]+)\}/g, (all, key) => {
        const v = vars[key];
        return v === undefined || v === null ? '' : String(v);
    });
}

export function debounce(fn, ms = 200) {
    let t = null;
    return (...args) => {
        if (t) clearTimeout(t);
        t = setTimeout(() => { t = null; fn(...args); }, ms);
    };
}

export function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

export function bytesToBase64(bytes) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

export function base64ToBytes(b64) {
    const bin = atob(b64.replace(/^data:[^,]*;base64,/, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function dataUrlToBytes(dataUrl) {
    const i = String(dataUrl).indexOf(',');
    if (i < 0) throw new Error('不是合法的 dataURL');
    const meta = dataUrl.slice(0, i);
    const mime = /^data:([^;,]*)/.exec(meta)?.[1] || 'application/octet-stream';
    if (meta.includes(';base64')) return { mime, bytes: base64ToBytes(dataUrl.slice(i + 1)) };
    return { mime, bytes: new TextEncoder().encode(decodeURIComponent(dataUrl.slice(i + 1))) };
}

export function bytesToDataUrl(bytes, mime = 'image/png') {
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

// dataURL 头部嗅探真实类型：站点经常把 jpeg 标成 png 或反之
export function sniffMime(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const hex = (n) => Array.from(b.slice(0, n)).map((x) => x.toString(16).padStart(2, '0')).join('');
    const s = hex(Math.min(12, b.length));
    if (s.startsWith('89504e47')) return 'image/png';
    if (s.startsWith('ffd8ff')) return 'image/jpeg';
    if (s.startsWith('47494638')) return 'image/gif';
    if (s.startsWith('424d')) return 'image/bmp';
    if (b.length >= 12 && s.slice(0, 8) === '52494646' && hex(12).slice(16) === '57454250') return 'image/webp';
    if (b.length >= 12 && s.slice(0, 8) === '52494646') {
        const sub = hex(12).slice(16);
        if (sub === '41564946') return 'image/avif';
        if (sub === '57454250') return 'image/webp';
    }
    if (s.startsWith('000001')) return 'video/mp4';
    if (hex(4) === '1a45dfa3') return 'video/webm';
    return 'image/png';
}

export function ratioText(w, h) {
    if (!w || !h) return '?';
    const g = (a, b) => (b ? g(b, a % b) : a);
    const d = g(w, h) || 1;
    const rw = w / d, rh = h / d;
    if (rw <= 64 && rh <= 64) return `${rw}:${rh}`;
    return `${(w / h).toFixed(3)}:1`;
}

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 相对/绝对坐标互转，裁剪与标注叠加都要用
export function normRect(r, w, h) {
    let { x = 0, y = 0, width = w, height = h } = r || {};
    if (r && r.relative) {
        x *= w; y *= h; width *= w; height *= h;
    }
    x = clamp(Math.round(x), 0, w);
    y = clamp(Math.round(y), 0, h);
    width = clamp(Math.round(width), 0, w - x);
    height = clamp(Math.round(height), 0, h - y);
    return { x, y, width, height };
}

export function pick(obj, keys) {
    const out = {};
    for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
    return out;
}
