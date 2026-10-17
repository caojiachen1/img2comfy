// 空间域滤波、噪声、局部效果与蒙版类算子。

import { clamp, toNum, toInt } from '../util.js';
import { mkPx, clonePx } from './geometry.js';
import { mapPixels, hexToRgb, rgbToHsv, luma } from './color.js';

export function gaussianKernel1D(sigma) {
    const s = Math.max(0.1, toNum(sigma, 1));
    const radius = Math.max(1, Math.ceil(s * 3));
    const k = new Float64Array(radius * 2 + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
        const v = Math.exp(-(i * i) / (2 * s * s));
        k[i + radius] = v; sum += v;
    }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    return { k, radius };
}

// 横向一维卷积：结果按行缓存，避免为整图开 Float32 临时缓冲
function convolveHorizontal(src, out, k, radius) {
    const { width, height, data } = src;
    for (let y = 0; y < height; y++) {
        const row = y * width * 4;
        for (let x = 0; x < width; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let i = -radius; i <= radius; i++) {
                const sx = clamp(x + i, 0, width - 1);
                const wgt = k[i + radius];
                const p = row + sx * 4;
                r += data[p] * wgt; g += data[p + 1] * wgt; b += data[p + 2] * wgt; a += data[p + 3] * wgt;
            }
            const o = row + x * 4;
            out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
        }
    }
}

export function gaussianBlur(src, sigma = 2) {
    const { k, radius } = gaussianKernel1D(sigma);
    const tmp = new Uint8ClampedArray(src.width * src.height * 4);
    convolveHorizontal(src, tmp, k, radius);
    const stage = mkPx(src.width, src.height, tmp);
    const out = new Uint8ClampedArray(stage.data.length);
    const { width, height, data } = stage;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let i = -radius; i <= radius; i++) {
                const sy = clamp(y + i, 0, height - 1);
                const wgt = k[i + radius];
                const p = (sy * width + x) * 4;
                r += data[p] * wgt; g += data[p + 1] * wgt; b += data[p + 2] * wgt; a += data[p + 3] * wgt;
            }
            const o = (y * width + x) * 4;
            out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
        }
    }
    return mkPx(width, height, out);
}

export function boxBlur(src, radius = 3) {
    const r = Math.max(1, toInt(radius, 3));
    const { width, height, data } = src;
    const tmp = new Float32Array(width * height * 4);
    const win = r * 2 + 1;
    for (let y = 0; y < height; y++) {
        for (let c = 0; c < 4; c++) {
            let acc = 0;
            for (let x = -r; x <= r; x++) acc += data[(y * width + clamp(x, 0, width - 1)) * 4 + c];
            for (let x = 0; x < width; x++) {
                tmp[(y * width + x) * 4 + c] = acc / win;
                const add = data[(y * width + clamp(x + r + 1, 0, width - 1)) * 4 + c];
                const sub = data[(y * width + clamp(x - r, 0, width - 1)) * 4 + c];
                acc += add - sub;
            }
        }
    }
    const out = new Uint8ClampedArray(data.length);
    for (let x = 0; x < width; x++) {
        for (let c = 0; c < 4; c++) {
            let acc = 0;
            for (let y = -r; y <= r; y++) acc += tmp[(clamp(y, 0, height - 1) * width + x) * 4 + c];
            for (let y = 0; y < height; y++) {
                out[(y * width + x) * 4 + c] = acc / win;
                acc += tmp[(clamp(y + r + 1, 0, height - 1) * width + x) * 4 + c]
                    - tmp[(clamp(y - r, 0, height - 1) * width + x) * 4 + c];
            }
        }
    }
    return mkPx(width, height, out);
}

export function convolve(src, kernel, { divisor = 0, offset = 0, edge = 'clamp' } = {}) {
    const size = kernel.length;
    const half = Math.floor(size / 2);
    let div = divisor;
    if (!div) { div = kernel.flat().reduce((a, b) => a + b, 0); if (!div) div = 1; }
    const { width, height, data } = src;
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let j = 0; j < size; j++) {
                for (let i = 0; i < size; i++) {
                    let sx = x + i - half, sy = y + j - half;
                    if (edge === 'clamp') { sx = clamp(sx, 0, width - 1); sy = clamp(sy, 0, height - 1); }
                    else if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
                    const wgt = kernel[j][i];
                    if (!wgt) continue;
                    const p = (sy * width + sx) * 4;
                    r += data[p] * wgt; g += data[p + 1] * wgt; b += data[p + 2] * wgt; a += data[p + 3] * wgt;
                }
            }
            const o = (y * width + x) * 4;
            out[o] = r / div + offset; out[o + 1] = g / div + offset; out[o + 2] = b / div + offset; out[o + 3] = a / div;
        }
    }
    return mkPx(width, height, out);
}

export const KERNELS = {
    identity: [[0, 0, 0], [0, 1, 0], [0, 0, 0]],
    sharpen: [[0, -1, 0], [-1, 5, -1], [0, -1, 0]],
    sharpenSoft: [[-0.2, -0.2, -0.2], [-0.2, 1.9, -0.2], [-0.2, -0.2, -0.2]],
    emboss: [[-2, -1, 0], [-1, 1, 1], [0, 1, 2]],
    edgeDetect: [[-1, -1, -1], [-1, 8, -1], [-1, -1, -1]],
    laplacian: [[0, 1, 0], [1, -4, 1], [0, 1, 0]],
    unsharpMask: [[-1, -1, -1], [-1, 9, -1], [-1, -1, -1]],
    box3: [[1, 1, 1], [1, 1, 1], [1, 1, 1]],
    gaussian3: [[1, 2, 1], [2, 4, 2], [1, 2, 1]],
    gaussian5: [
        [1, 4, 6, 4, 1], [4, 16, 24, 16, 4], [6, 24, 36, 24, 6], [4, 16, 24, 16, 4], [1, 4, 6, 4, 1],
    ],
    sobelX: [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]],
    sobelY: [[-1, -2, -1], [0, 0, 0], [1, 2, 1]],
    scharrX: [[-3, 0, 3], [-10, 0, 10], [-3, 0, 3]],
    scharrY: [[-3, -10, -3], [0, 0, 0], [3, 10, 3]],
    prewittX: [[-1, 0, 1], [-1, 0, 1], [-1, 0, 1]],
    findEdges: [[0, -1, 0], [-1, 4, -1], [0, -1, 0]],
};

// amount 走核中心插值，用户拉 0 时等价原图
export function sharpen(src, amount = 60, soft = false) {
    const a = clamp(toNum(amount, 60) / 100, 0, 3);
    const base = KERNELS.identity, k = soft ? KERNELS.sharpenSoft : KERNELS.sharpen;
    const mixed = k.map((row, j) => row.map((v, i) => base[j][i] + (v - base[j][i]) * a));
    return convolve(src, mixed);
}

export function unsharp(src, { radius = 2, amount = 100, threshold = 0 } = {}) {
    const amt = toNum(amount, 100) / 100;
    const thr = toNum(threshold, 0);
    const blurred = gaussianBlur(src, radius);
    const out = new Uint8ClampedArray(src.data.length);
    const d = src.data, b = blurred.data;
    for (let i = 0; i < d.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            const diff = d[i + c] - b[i + c];
            out[i + c] = Math.abs(diff) >= thr ? d[i + c] + diff * amt : d[i + c];
        }
        out[i + 3] = d[i + 3];
    }
    return mkPx(src.width, src.height, out);
}

export function medianFilter(src, radius = 1, { channels = 'rgb' } = {}) {
    const r = clamp(toInt(radius, 1), 1, 8);
    const { width, height, data } = src;
    const out = clonePx(data === src.data ? mkPx(width, height, new Uint8ClampedArray(data)) : src).data;
    const size = r * 2 + 1;
    const buf = [new Uint8Array(size * size), new Uint8Array(size * size), new Uint8Array(size * size)];
    const chs = channels === 'rgb' ? [0, 1, 2] : [0, 1, 2, 3];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            for (const c of chs) {
                let n = 0;
                for (let j = -r; j <= r; j++) {
                    const sy = clamp(y + j, 0, height - 1);
                    for (let i = -r; i <= r; i++) {
                        buf[c][n++] = data[(sy * width + clamp(x + i, 0, width - 1)) * 4 + c];
                    }
                }
                buf[c].subarray(0, n).sort();
                out[(y * width + x) * 4 + c] = buf[c][Math.floor(n / 2)];
            }
            out[(y * width + x) * 4 + 3] = data[(y * width + x) * 4 + 3];
        }
    }
    return mkPx(width, height, out);
}

export function bilateralFilter(src, { spaceSigma = 6, rangeSigma = 30, radius = 0 } = {}) {
    const r = Math.max(1, toInt(radius, 0) || Math.max(1, Math.round(toNum(spaceSigma, 6))));
    const ss2 = 2 * Math.max(0.5, toNum(spaceSigma, 6)) ** 2;
    const rs2 = 2 * Math.max(1, toNum(rangeSigma, 30)) ** 2;
    const { width, height, data } = src;
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const ci = (y * width + x) * 4;
            let wr = 0, ar = 0, ag = 0, ab = 0, aa = 0;
            for (let j = -r; j <= r; j++) {
                const sy = clamp(y + j, 0, height - 1);
                const dy = j * j;
                for (let i = -r; i <= r; i++) {
                    const sx = clamp(x + i, 0, width - 1);
                    const p = (sy * width + sx) * 4;
                    const spatial = -(dy + i * i) / ss2;
                    const dr = data[p] - data[ci], dg = data[p + 1] - data[ci + 1], db = data[p + 2] - data[ci + 2];
                    const range = -(dr * dr + dg * dg + db * db) / rs2;
                    const wgt = Math.exp(spatial + range);
                    wr += wgt;
                    ar += data[p] * wgt; ag += data[p + 1] * wgt; ab += data[p + 2] * wgt; aa += data[p + 3] * wgt;
                }
            }
            out[ci] = ar / wr; out[ci + 1] = ag / wr; out[ci + 2] = ab / wr; out[ci + 3] = aa / wr;
        }
    }
    return mkPx(width, height, out);
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function addNoise(src, { type = 'gaussian', amount = 12, seed = 1 } = {}) {
    const rnd = mulberry32(toInt(seed, 1) || 1);
    const a = toNum(amount, 12);
    return mapPixels(src, (r, g, b, al, o, i) => {
        if (type === 'saltPepper') {
            const t = rnd();
            const v = t < a / 200 ? 0 : t < a / 100 + a / 200 ? 255 : null;
            if (v === null) { o[i] = r; o[i + 1] = g; o[i + 2] = b; }
            else { o[i] = o[i + 1] = o[i + 2] = v; }
            o[i + 3] = al;
            return;
        }
        if (type === 'speckle') {
            const n1 = (rnd() + rnd() + rnd() - 1.5) * (a / 100);
            o[i] = r + r * n1; o[i + 1] = g + g * n1; o[i + 2] = b + b * n1; o[i + 3] = al;
            return;
        }
        const gauss = () => {
            const u = Math.max(1e-9, rnd()), v = rnd();
            return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * (a / 100) * 60;
        };
        o[i] = r + gauss(); o[i + 1] = g + gauss(); o[i + 2] = b + gauss(); o[i + 3] = al;
    });
}

export function pixelate(src, { size = 12, mode = 'block' } = {}) {
    const n = Math.max(2, toInt(size, 12));
    const { width, height, data } = src;
    const out = new Uint8ClampedArray(data.length);
    for (let y0 = 0; y0 < height; y0 += n) {
        for (let x0 = 0; x0 < width; x0 += n) {
            if (mode === 'sample') {
                const p = (y0 * width + x0) * 4;
                for (let y = y0; y < Math.min(y0 + n, height); y++) {
                    for (let x = x0; x < Math.min(x0 + n, width); x++) {
                        const o = (y * width + x) * 4;
                        out[o] = data[p]; out[o + 1] = data[p + 1]; out[o + 2] = data[p + 2]; out[o + 3] = data[p + 3];
                    }
                }
                continue;
            }
            let r = 0, g = 0, b = 0, a = 0, cnt = 0;
            for (let y = y0; y < Math.min(y0 + n, height); y++) {
                for (let x = x0; x < Math.min(x0 + n, width); x++) {
                    const p = (y * width + x) * 4;
                    r += data[p]; g += data[p + 1]; b += data[p + 2]; a += data[p + 3]; cnt++;
                }
            }
            r /= cnt; g /= cnt; b /= cnt; a /= cnt;
            for (let y = y0; y < Math.min(y0 + n, height); y++) {
                for (let x = x0; x < Math.min(x0 + n, width); x++) {
                    const o = (y * width + x) * 4;
                    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
                }
            }
        }
    }
    return mkPx(width, height, out);
}

export function oilPaint(src, { radius = 3, intensity = 30 } = {}) {
    const r = clamp(toInt(radius, 3), 1, 8);
    const bins = Math.max(4, toInt(intensity, 30));
    const { width, height, data } = src;
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const hist = new Float64Array(bins);
            const accR = new Float64Array(bins), accG = new Float64Array(bins), accB = new Float64Array(bins);
            for (let j = -r; j <= r; j++) {
                const sy = clamp(y + j, 0, height - 1);
                for (let i = -r; i <= r; i++) {
                    const p = (sy * width + clamp(x + i, 0, width - 1)) * 4;
                    const l = luma(data[p], data[p + 1], data[p + 2]);
                    const bin = clamp(Math.round((l / 255) * (bins - 1)), 0, bins - 1);
                    hist[bin]++; accR[bin] += data[p]; accG[bin] += data[p + 1]; accB[bin] += data[p + 2];
                }
            }
            let best = 0;
            for (let b = 1; b < bins; b++) if (hist[b] > hist[best]) best = b;
            const o = (y * width + x) * 4;
            out[o] = accR[best] / hist[best]; out[o + 1] = accG[best] / hist[best]; out[o + 2] = accB[best] / hist[best];
            out[o + 3] = data[o + 3];
        }
    }
    return mkPx(width, height, out);
}

export function vignette(src, { amount = 60, radius = 70, soften = 40, color = '#000000' } = {}) {
    const c = hexToRgb(color);
    const a = clamp(toNum(amount, 60) / 100, -1, 1);
    const inner = clamp(toNum(radius, 70) / 100, 0, 1);
    const soft = clamp(toNum(soften, 40) / 100, 0.01, 1);
    const { width, height } = src;
    const cx = width / 2, cy = height / 2;
    const maxR = Math.hypot(cx, cy);
    return mapPixels(src, (r, g, b, al, o, i) => {
        const px = (i / 4) % width, py = Math.floor((i / 4) / width);
        const d = Math.hypot(px - cx, py - cy) / maxR;
        const t = clamp((d - inner) / soft, 0, 1);
        const f = t * t * Math.abs(a);
        o[i] = r + (c[0] - r) * f; o[i + 1] = g + (c[1] - g) * f; o[i + 2] = b + (c[2] - b) * f; o[i + 3] = al;
    });
}

// 抠色：色距模型可选 RGB 欧氏或 HSV 锥形（对压缩噪点更稳）
export function chromaKey(src, { color = '#00ff00', tolerance = 30, feather = 8, model = 'rgb', invert = false } = {}) {
    const target = hexToRgb(color);
    const tol = Math.max(1, toNum(tolerance, 30));
    const feat = Math.max(0, toNum(feather, 8));
    const tv = rgbToHsv(target[0], target[1], target[2]);
    const out = clonePx(src);
    const d = out.data;
    for (let i = 0; i < d.length; i += 4) {
        let dist;
        if (model === 'hsv') {
            const v = rgbToHsv(d[i], d[i + 1], d[i + 2]);
            const dh = Math.min(Math.abs(v[0] - tv[0]), 1 - Math.abs(v[0] - tv[0])) * 255 * 2;
            dist = Math.hypot(dh, (v[1] - tv[1]) * 255, (v[2] - tv[2]) * 255);
        } else {
            dist = Math.hypot(d[i] - target[0], d[i + 1] - target[1], d[i + 2] - target[2]);
        }
        const lo = tol, hi = tol + feat;
        let alpha = dist <= lo ? 0 : dist >= hi ? 255 : ((dist - lo) / Math.max(1, hi - lo)) * 255;
        if (invert) alpha = 255 - alpha;
        d[i + 3] = Math.min(d[i + 3], alpha);
    }
    return out;
}

export function alphaMask(src, mask, { feather = 0, invert = false } = {}) {
    const out = clonePx(src);
    const d = out.data;
    const md = mask.data;
    const featherPx = Math.max(0, toInt(feather, 0));
    const blurred = featherPx > 0
        ? gaussianBlur(mkPx(mask.width, mask.height, (() => {
            const c = new Uint8ClampedArray(mask.width * mask.height * 4);
            for (let i = 0; i < mask.width * mask.height; i++) {
                const v = invert ? 255 - md[i] : md[i];
                c[i * 4] = c[i * 4 + 1] = c[i * 4 + 2] = c[i * 4 + 3] = v;
            }
            return c;
        })(), featherPx / 2), null) : null;
    for (let i = 0, j = 0; j < md.length; j++, i += 4) {
        const v = blurred ? luma(blurred.data[i], blurred.data[i + 1], blurred.data[i + 2]) : (invert ? 255 - md[j] : md[j]);
        if (mask.width === src.width && mask.height === src.height) d[i + 3] = Math.round((d[i + 3] * v) / 255);
    }
    return out;
}

// 圆角/羽化：只改 alpha，输出仍为 RGBA
export function borderRadius(src, { radius = 24, feather = 0, corners = 'all', background = 'transparent' } = {}) {
    const { width, height, data } = src;
    const base = Math.min(width, height);
    const r = clamp(toNum(radius, 24), 0, base / 2);
    const feat = Math.max(0, toNum(feather, 0));
    const all = corners === 'all';
    const wants = (k) => all || String(corners).includes(k);
    // 每个角一段 1/4 圆弧，圆心在离边 r 处；像素落在角区内才按弧判定
    const cornersDef = [
        { k: 'tl', cx: r, cy: r, in: (x, y) => x < r && y < r },
        { k: 'tr', cx: width - r, cy: r, in: (x, y) => x >= width - r && y < r },
        { k: 'bl', cx: r, cy: height - r, in: (x, y) => x < r && y >= height - r },
        { k: 'br', cx: width - r, cy: height - r, in: (x, y) => x >= width - r && y >= height - r },
    ];
    const out = clonePx(src);
    const o = out.data;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            let inside = 1;
            if (r > 0) {
                for (const c of cornersDef) {
                    if (!c.in(x, y) || !wants(c.k)) continue;
                    const d = Math.hypot(x - c.cx, y - c.cy);
                    inside = feat > 0 ? clamp((r + feat - d) / feat, 0, 1) : (d <= r ? 1 : 0);
                    break;
                }
            }
            o[i + 3] = Math.round(data[i + 3] * inside);
        }
    }
    if (background && background !== 'transparent') {
        const c = hexToRgb(background);
        for (let i = 0; i < o.length; i += 4) {
            const a = o[i + 3] / 255;
            o[i] = o[i] * a + c[0] * (1 - a);
            o[i + 1] = o[i + 1] * a + c[1] * (1 - a);
            o[i + 2] = o[i + 2] * a + c[2] * (1 - a);
            o[i + 3] = 255;
        }
    }
    return out;
}

// 局部处理：对矩形列表分别执行 fn（人脸打码、区域锐化都用它），边缘做羽化过渡
export function applyToRects(src, fn, rects, { feather = 6, blurBefore = 0 } = {}) {
    const processed = fn(src);
    const out = clonePx(src);
    for (const rect of rects || []) {
        const x0 = clamp(Math.round(rect.x - feather), 0, src.width - 1);
        const y0 = clamp(Math.round(rect.y - feather), 0, src.height - 1);
        const x1 = clamp(Math.round(rect.x + rect.width + feather), 0, src.width);
        const y1 = clamp(Math.round(rect.y + rect.height + feather), 0, src.height);
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const dx = Math.max(rect.x - x, x - (rect.x + rect.width), 0);
                const dy = Math.max(rect.y - y, y - (rect.y + rect.height), 0);
                const d = Math.hypot(dx, dy);
                let t = feather > 0 ? clamp(1 - d / feather, 0, 1) : (d === 0 ? 1 : 0);
                if (t <= 0) continue;
                const i = (y * src.width + x) * 4;
                for (let c = 0; c < 3; c++) out.data[i + c] = src.data[i + c] * (1 - t) + processed.data[i + c] * t;
                out.data[i + 3] = Math.round(src.data[i + 3] * (1 - t) + processed.data[i + 3] * t);
            }
        }
    }
    return out;
}

export { convolveHorizontal };
