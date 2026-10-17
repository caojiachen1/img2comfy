// 色彩与色调算子。约定：所有强度类参数用 -100..100 或 0..200 的直观区间，
// 与设置页滑块一致；内部换算成乘性/加性系数。

import { clamp, toNum, toInt } from '../util.js';
import { mkPx, clonePx } from './geometry.js';

export function mapPixels(src, fn) {
    const out = new Uint8ClampedArray(src.data.length);
    const d = src.data;
    for (let i = 0; i < d.length; i += 4) fn(d[i], d[i + 1], d[i + 2], d[i + 3], out, i);
    return mkPx(src.width, src.height, out);
}

export function applyLuts(src, lutR, lutG, lutB) {
    const out = new Uint8ClampedArray(src.data.length);
    const d = src.data;
    for (let i = 0; i < d.length; i += 4) {
        out[i] = lutR[d[i]]; out[i + 1] = lutG[d[i + 1]]; out[i + 2] = lutB[d[i + 2]]; out[i + 3] = d[i + 3];
    }
    return mkPx(src.width, src.height, out);
}

function buildLut(fn) {
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = fn(i);
    return lut;
}

export function hexToRgb(hex) {
    const s = String(hex || '').replace('#', '').trim();
    if (/^[0-9a-f]{3}$/i.test(s)) {
        return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)];
    }
    if (/^[0-9a-f]{6}$/i.test(s)) {
        return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
    }
    if (/^[0-9a-f]{8}$/i.test(s)) {
        return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), parseInt(s.slice(6, 8), 16)];
    }
    return [255, 255, 255];
}

export function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

export function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d > 1e-6) {
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
    }
    return [h, s, l];
}

function hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
}

export function hslToRgb(h, s, l) {
    if (s <= 1e-6) { const v = l * 255; return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

export function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 1e-6) {
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
    }
    return [h, max <= 1e-6 ? 0 : d / max, max];
}

export function hsvToRgb(h, s, v) {
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    switch (((i % 6) + 6) % 6) {
        case 0: return [v * 255, t * 255, p * 255];
        case 1: return [q * 255, v * 255, p * 255];
        case 2: return [p * 255, v * 255, t * 255];
        case 3: return [p * 255, q * 255, v * 255];
        case 4: return [t * p * 255, p * q * 255, v * 255];
        default: return [v * 255, p * t * 255, q * 255];
    }
}

// 亮度公式默认 Rec.709，ccir601 与既有代码/老素材习惯一致，保留可选
function luma(r, g, b, mode = 'luma709') {
    if (mode === 'average') return (r + g + b) / 3;
    if (mode === 'lightness') return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
    if (mode === 'max') return Math.max(r, g, b);
    if (mode === 'ccir601') return 0.299 * r + 0.587 * g + 0.114 * b;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function toGray(src, mode = 'luma709') {
    const { width, height, data } = src;
    const out = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 0; j < out.length; i += 4, j++) {
        out[j] = clamp(Math.round(luma(data[i], data[i + 1], data[i + 2], mode)), 0, 255);
    }
    return { width, height, data: out };
}

export function brightness(src, amount = 0) {
    const v = toNum(amount, 0) * 2.55;
    return mapPixels(src, (r, g, b, a, o, i) => {
        o[i] = r + v; o[i + 1] = g + v; o[i + 2] = b + v; o[i + 3] = a;
    });
}

export function contrast(src, amount = 0) {
    const c = 1 + toNum(amount, 0) / 100;
    return mapPixels(src, (r, g, b, a, o, i) => {
        o[i] = (r - 128) * c + 128; o[i + 1] = (g - 128) * c + 128; o[i + 2] = (b - 128) * c + 128; o[i + 3] = a;
    });
}

export function saturation(src, amount = 0) {
    const s = 1 + toNum(amount, 0) / 100;
    return mapPixels(src, (r, g, b, a, o, i) => {
        const l = luma(r, g, b);
        o[i] = l + (r - l) * s; o[i + 1] = l + (g - l) * s; o[i + 2] = l + (b - l) * s; o[i + 3] = a;
    });
}

// vibrance：只提低饱和像素，避免皮肤/红蓝溢出
export function vibrance(src, amount = 0) {
    const v = toNum(amount, 0) / 100;
    return mapPixels(src, (r, g, b, a, o, i) => {
        const l = luma(r, g, b);
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = mx <= 0 ? 0 : (mx - mn) / mx;
        const f = 1 + v * (1 - sat);
        o[i] = l + (r - l) * f; o[i + 1] = l + (g - l) * f; o[i + 2] = l + (b - l) * f; o[i + 3] = a;
    });
}

export function hueRotate(src, degrees = 0) {
    const d = toNum(degrees, 0) / 360;
    if (!d) return clonePx(src);
    return mapPixels(src, (r, g, b, a, o, i) => {
        const [h, s, l] = rgbToHsl(r, g, b);
        const [nr, ng, nb] = hslToRgb((h + d) % 1, s, l);
        o[i] = nr; o[i + 1] = ng; o[i + 2] = nb; o[i + 3] = a;
    });
}

// 色温按白平衡增益的逆操作做：偏暖 = R 增 B 减，并轻微补偿 G 保亮度
export function temperature(src, amount = 0) {
    const t = toNum(amount, 0) / 100;
    return mapPixels(src, (r, g, b, a, o, i) => {
        o[i] = r * (1 + t * 0.25);
        o[i + 1] = g * (1 - Math.abs(t) * 0.03);
        o[i + 2] = b * (1 - t * 0.25);
        o[i + 3] = a;
    });
}

export function tint(src, amount = 0) {
    const t = toNum(amount, 0) / 100;
    return mapPixels(src, (r, g, b, a, o, i) => {
        o[i] = r * (1 - t * 0.12);
        o[i + 1] = g * (1 + t * 0.2);
        o[i + 2] = b * (1 - t * 0.12);
        o[i + 3] = a;
    });
}

export function gamma(src, value = 1) {
    const g = Math.max(0.05, toNum(value, 1));
    const inv = 1 / g;
    const lut = buildLut((i) => 255 * Math.pow(i / 255, inv));
    return applyLuts(src, lut, lut, lut);
}

export function levels(src, { inBlack = 0, inWhite = 100, gammaValue = 1, outBlack = 0, outWhite = 100, channel = 'rgb' } = {}) {
    const lo = toNum(inBlack, 0) / 100 * 255;
    const hi = toNum(inWhite, 100) / 100 * 255;
    const g = Math.max(0.05, toNum(gammaValue, 1));
    const oLo = toNum(outBlack, 0) / 100 * 255;
    const oHi = toNum(outWhite, 100) / 100 * 255;
    const span = Math.max(1, hi - lo);
    const fn = (v) => {
        let x = clamp((v - lo) / span, 0, 1);
        x = Math.pow(x, 1 / g);
        return oLo + x * (oHi - oLo);
    };
    const lut = buildLut(fn);
    if (channel === 'luma') {
        return mapPixels(src, (r, g2, b, a, o, i) => {
            const l = luma(r, g2, b), nl = fn(l);
            const d = nl - l;
            o[i] = r + d; o[i + 1] = g2 + d; o[i + 2] = b + d; o[i + 3] = a;
        });
    }
    if (channel === 'r') return applyLuts(src, lut, (x) => x, (x) => x);
    if (channel === 'g') return applyLuts(src, (x) => x, lut, (x) => x);
    if (channel === 'b') return applyLuts(src, (x) => x, (x) => x, lut);
    return applyLuts(src, lut, lut, lut);
}

export function posterize(src, levelsCount = 4) {
    const n = Math.max(2, toInt(levelsCount, 4));
    const step = 255 / (n - 1);
    const lut = buildLut((i) => Math.round(Math.round(i / step) * step));
    return applyLuts(src, lut, lut, lut);
}

export function invert(src, { alpha = false } = {}) {
    return mapPixels(src, (r, g, b, a, o, i) => {
        o[i] = 255 - r; o[i + 1] = 255 - g; o[i + 2] = 255 - b; o[i + 3] = alpha ? 255 - a : a;
    });
}

export function grayscale(src, mode = 'luma709') {
    return mapPixels(src, (r, g, b, a, o, i) => {
        const l = luma(r, g, b, mode);
        o[i] = l; o[i + 1] = l; o[i + 2] = l; o[i + 3] = a;
    });
}

export function sepia(src, amount = 100) {
    const t = clamp(toNum(amount, 100) / 100, 0, 1);
    return mapPixels(src, (r, g, b, a, o, i) => {
        const sr = 0.393 * r + 0.769 * g + 0.189 * b;
        const sg = 0.349 * r + 0.686 * g + 0.168 * b;
        const sb = 0.272 * r + 0.534 * g + 0.131 * b;
        o[i] = r + (sr - r) * t; o[i + 1] = g + (sg - g) * t; o[i + 2] = b + (sb - b) * t; o[i + 3] = a;
    });
}

export function duotone(src, { dark = '#1a1a2e', light = '#e8e8e8', amount = 100 } = {}) {
    const d = hexToRgb(dark), l = hexToRgb(light);
    const t = clamp(toNum(amount, 100) / 100, 0, 1);
    const lutR = new Uint8ClampedArray(256), lutG = new Uint8ClampedArray(256), lutB = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
        const k = i / 255;
        lutR[i] = d[0] + (l[0] - d[0]) * k;
        lutG[i] = d[1] + (l[1] - d[1]) * k;
        lutB[i] = d[2] + (l[2] - d[2]) * k;
    }
    const out = mapPixels(src, (r, g, b, a, o, i) => {
        const v = luma(r, g, b);
        o[i] = lutR[v]; o[i + 1] = lutG[v]; o[i + 2] = lutB[v]; o[i + 3] = a;
    });
    return t >= 1 ? out : blend(src, out, 'normal', t * 100);
}

// 叠加纯色（水印底色、遮色块）
export function colorOverlay(src, { color = '#000000', opacity = 30, blend: mode = 'normal' } = {}) {
    const c = hexToRgb(color);
    const flat = mkPx(src.width, src.height);
    for (let i = 0; i < flat.data.length; i += 4) {
        flat.data[i] = c[0]; flat.data[i + 1] = c[1]; flat.data[i + 2] = c[2]; flat.data[i + 3] = 255;
    }
    return blend(src, flat, mode, opacity);
}

const BLEND_MODES = {
    normal: (a, b) => b,
    multiply: (a, b) => (a * b) / 255,
    screen: (a, b) => 255 - ((255 - a) * (255 - b)) / 255,
    overlay: (a, b) => (a <= 128 ? (2 * a * b) / 255 : 255 - (2 * (255 - a) * (255 - b)) / 255),
    // Photoshop/CSS 标准 soft-light：Cb<=0.5 用二次衰减，否则用 D(Cb) 提升
    softLight: (a, b) => {
        const A = a / 255, B = b / 255;
        const D = (x) => (x <= 0.25 ? ((16 * x - 12) * x + 4) * x : Math.sqrt(x));
        return (B <= 0.5 ? A - (1 - 2 * B) * A * (1 - A) : A + (2 * B - 1) * (D(A) - A)) * 255;
    },
    hardLight: (a, b) => (b <= 128 ? (2 * a * b) / 255 : 255 - (2 * (255 - a) * (255 - b)) / 255),
    difference: (a, b) => Math.abs(a - b),
    exclusion: (a, b) => a + b - (2 * a * b) / 255,
    lighten: (a, b) => Math.max(a, b),
    darken: (a, b) => Math.min(a, b),
    add: (a, b) => a + b,
};

export function blend(base, top, mode = 'normal', opacity = 100) {
    const op = clamp(toNum(opacity, 100) / 100, 0, 1);
    if (op <= 0) return clonePx(base);
    const fn = BLEND_MODES[mode] || BLEND_MODES.normal;
    const w = Math.min(base.width, top.width), h = Math.min(base.height, top.height);
    const out = clonePx(base);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * base.width + x) * 4, j = (y * top.width + x) * 4;
            const ta = (top.data[j + 3] / 255) * op;
            if (ta <= 0) continue;
            for (let c = 0; c < 3; c++) {
                const mixed = fn(base.data[i + c], top.data[j + c]);
                out.data[i + c] = base.data[i + c] * (1 - ta) + mixed * ta;
            }
            out.data[i + 3] = out.data[i + 3] * (1 - ta) + top.data[j + 3] * ta;
        }
    }
    return out;
}

// 白平衡：grey-world 最稳，percentile 抗大面积单色干扰，manual 给高级用户
export function whiteBalance(src, { method = 'grey-world', strength = 100, rGain = 1, gGain = 1, bGain = 1 } = {}) {
    const d = src.data;
    let gains = [rGain, gGain, bGain];
    if (method === 'grey-world' || method === 'percentile' || method === 'auto') {
        const sums = [0, 0, 0];
        let n = 0;
        if (method === 'percentile') {
            const histR = new Int32Array(256), histG = new Int32Array(256), histB = new Int32Array(256);
            for (let i = 0; i < d.length; i += 4) { histR[d[i]]++; histG[d[i + 1]]++; histB[d[i + 2]]++; n++; }
            const cut = (hist) => {
                const lo = Math.floor(n * 0.02), hi = n - lo;
                let acc = 0, low = 0, high = 255;
                for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= lo) { low = v; break; } }
                acc = 0;
                for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n - hi) { high = v; break; } }
                return (low + high) / 2;
            };
            gains = [cut(histR), cut(histG), cut(histB)];
            const mean = (gains[0] + gains[1] + gains[2]) / 3;
            gains = gains.map((g) => (g > 1 ? mean / g : 1));
        } else {
            for (let i = 0; i < d.length; i += 4) {
                if (d[i + 3] < 8) continue;
                sums[0] += d[i]; sums[1] += d[i + 1]; sums[2] += d[i + 2]; n++;
            }
            if (!n) return clonePx(src);
            const avg = [sums[0] / n, sums[1] / n, sums[2] / n];
            const gray = (avg[0] + avg[1] + avg[2]) / 3;
            gains = avg.map((a) => (a > 1 ? gray / a : 1));
        }
    }
    const s = clamp(toNum(strength, 100) / 100, 0, 1);
    gains = gains.map((g) => 1 + (g - 1) * s);
    return mapPixels(src, (r, g, b, a, o, i) => {
        o[i] = r * gains[0]; o[i + 1] = g * gains[1]; o[i + 2] = b * gains[2]; o[i + 3] = a;
    });
}

export function histogramOf(src, bins = 256, channel = 'luma') {
    const h = new Float64Array(bins);
    const d = src.data;
    for (let i = 0; i < d.length; i += 4) {
        const v = channel === 'luma' ? luma(d[i], d[i + 1], d[i + 2])
            : channel === 'r' ? d[i] : channel === 'g' ? d[i + 1] : d[i + 2];
        h[clamp(Math.round((v / 255) * (bins - 1)), 0, bins - 1)]++;
    }
    return h;
}

export function equalizeHist(src, { channel = 'luma', clip = 0 } = {}) {
    const d = src.data;
    if (channel !== 'luma') {
        const mk = (ch) => {
            const h = new Int32Array(256);
            for (let i = 0; i < d.length; i += 4) h[d[i + ch]]++;
            const total = d.length / 4;
            const lut = new Uint8ClampedArray(256);
            let acc = 0;
            for (let v = 0; v < 256; v++) { acc += h[v]; lut[v] = Math.round((acc / total) * 255); }
            return lut;
        };
        return applyLuts(src, mk(0), mk(1), mk(2));
    }
    const h = new Int32Array(256);
    for (let i = 0; i < d.length; i += 4) h[Math.round(luma(d[i], d[i + 1], d[i + 2]))]++;
    const total = d.length / 4;
    let acc = 0;
    const lut = new Float64Array(256);
    for (let v = 0; v < 256; v++) { acc += h[v]; lut[v] = (acc / total) * 255 - v; }
    return mapPixels(src, (r, g, b, a, o, i) => {
        const l = luma(r, g, b);
        const delta = lut[clamp(Math.round(l), 0, 255)];
        o[i] = r + delta; o[i + 1] = g + delta; o[i + 2] = b + delta; o[i + 3] = a;
    });
}

// CLAHE：分块限幅直方图均衡 + 块间双线性插值，只做亮度通道以保色
export function clahe(src, { clipLimit = 3, tiles = 8 } = {}) {
    const { width, height, data } = src;
    const tx = Math.max(1, toInt(tiles, 8)), ty = tx;
    const tw = Math.ceil(width / tx), th = Math.ceil(height / ty);
    const lumaMap = new Float32Array(width * height);
    for (let i = 0, j = 0; j < lumaMap.length; j++, i += 4) lumaMap[j] = luma(data[i], data[i + 1], data[i + 2]);

    const luts = [];
    const clip = Math.max(1, clipLimit);
    for (let b = 0; b < tx * ty; b++) {
        const bx = (b % tx) * tw, by = Math.floor(b / tx) * th;
        const bw = Math.min(tw, width - bx), bh = Math.min(th, height - by);
        const hist = new Float64Array(256);
        let count = 0;
        for (let y = 0; y < bh; y++) {
            for (let x = 0; x < bw; x++) { hist[Math.round(lumaMap[(by + y) * width + bx + x])]++; count++; }
        }
        const limit = Math.max(1, Math.round((count / 256) * clip));
        let excess = 0;
        for (let v = 0; v < 256; v++) if (hist[v] > limit) { excess += hist[v] - limit; hist[v] = limit; }
        const add = excess / 256;
        for (let v = 0; v < 256; v++) hist[v] += add;
        const lut = new Float64Array(256);
        let acc = 0;
        for (let v = 0; v < 256; v++) { acc += hist[v]; lut[v] = (acc / (bw * bh)) * 255; }
        luts.push(lut);
    }
    const tileLut = (cx, cy) => luts[clamp(cy, 0, ty - 1) * tx + clamp(cx, 0, tx - 1)];
    return mapPixels(src, (r, g, b, a, o, i) => {
        const px = i / 4;
        const x = px % width, y = Math.floor(px / width);
        const fx = x / tw - 0.5, fy = y / th - 0.5;
        const cx = clamp(Math.floor(fx), 0, tx - 1), cy = clamp(Math.floor(fy), 0, ty - 1);
        const gx = clamp(fx - cx, 0, 1), gy = clamp(fy - cy, 0, 1);
        const v = clamp(Math.round(luma(r, g, b)), 0, 255);
        const l00 = tileLut(cx, cy)[v], l10 = tileLut(cx + 1, cy)[v];
        const l01 = tileLut(cx, cy + 1)[v], l11 = tileLut(cx + 1, cy + 1)[v];
        const nl = l00 * (1 - gx) * (1 - gy) + l10 * gx * (1 - gy) + l01 * (1 - gx) * gy + l11 * gx * gy;
        const delta = nl - v;
        o[i] = r + delta; o[i + 1] = g + delta; o[i + 2] = b + delta; o[i + 3] = a;
    });
}

// 自动色阶：按百分位裁切黑白场，percent 默认 0.5%
export function autoLevels(src, { percent = 0.5, channel = 'luma' } = {}) {
    const p = clamp(toNum(percent, 0.5), 0, 49) / 100;
    const hist = histogramOf(src, 256, channel);
    const total = src.width * src.height;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * p) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * p) { hi = v; break; } }
    if (hi - lo < 8) return clonePx(src);
    return levels(src, { inBlack: (lo / 255) * 100, inWhite: (hi / 255) * 100, channel });
}

export function autoEnhance(src, { strength = 100 } = {}) {
    const s = clamp(toNum(strength, 100) / 100, 0, 1.5);
    let out = autoLevels(src, { percent: 0.4 });
    out = gamma(out, 1 / (1 + 0.06 * s));
    out = vibrance(out, 14 * s);
    out = contrast(out, 6 * s);
    return out;
}

export function channelMixer(src, { r = [100, 0, 0], g = [0, 100, 0], b = [0, 0, 100] } = {}) {
    const M = [r, g, b].map((row) => row.map((v) => toNum(v, 0) / 100));
    return mapPixels(src, (x, y, z, a, o, i) => {
        o[i] = x * M[0][0] + y * M[0][1] + z * M[0][2];
        o[i + 1] = x * M[1][0] + y * M[1][1] + z * M[1][2];
        o[i + 2] = x * M[2][0] + y * M[2][1] + z * M[2][2];
        o[i + 3] = a;
    });
}

export function curves(src, { channel = 'rgb', points = [[0, 0], [255, 255]] } = {}) {
    const pts = (points || []).map((p) => [clamp(toNum(p[0], 0), 0, 255), clamp(toNum(p[1], 0), 0, 255)]).sort((a, b) => a[0] - b[0]);
    if (pts.length < 2) return clonePx(src);
    const lut = buildLut((v) => {
        if (v <= pts[0][0]) return pts[0][1];
        for (let k = 1; k < pts.length; k++) {
            if (v <= pts[k][0]) {
                const t = (v - pts[k - 1][0]) / Math.max(1e-6, pts[k][0] - pts[k - 1][0]);
                // Catmull-Rom 风格平滑：用邻近段斜率做三次插值，避免折点
                const p0 = pts[Math.max(0, k - 2)], p1 = pts[k - 1], p2 = pts[k], p3 = pts[Math.min(pts.length - 1, k + 1)];
                const m1 = (p2[1] - p0[1]) / Math.max(1e-6, p2[0] - p0[0]);
                const m2 = (p3[1] - p1[1]) / Math.max(1e-6, p3[0] - p1[0]);
                const t2 = t * t, t3 = t2 * t;
                return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 * (p2[0] - p1[0])
                    + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2 * (p2[0] - p1[0]);
            }
        }
        return pts[pts.length - 1][1];
    });
    if (channel === 'r') return applyLuts(src, lut, (v) => v, (v) => v);
    if (channel === 'g') return applyLuts(src, (v) => v, lut, (v) => v);
    if (channel === 'b') return applyLuts(src, (v) => v, (v) => v, lut);
    return applyLuts(src, lut, lut, lut);
}

export { luma, clonePx, mkPx, buildLut };
