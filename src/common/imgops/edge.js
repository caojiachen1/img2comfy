// 梯度/边缘、二值化与形态学。灰度域实现，输出统一回 RGBA 便于流水线串联。

import { clamp, toNum, toInt } from '../util.js';
import { mkPx, clonePx } from './geometry.js';
import { gaussianBlur, convolve, KERNELS } from './filter.js';
import { toGray } from './color.js';

export { toGray };

function grayToPx(g) {
    const out = new Uint8ClampedArray(g.width * g.height * 4);
    for (let i = 0, j = 0; i < out.length; i += 4, j++) {
        out[i] = out[i + 1] = out[i + 2] = g.data[j];
        out[i + 3] = 255;
    }
    return mkPx(g.width, g.height, out);
}

// 保留原图 alpha（透明 PNG 抠色后仍透明）
function keepAlpha(result, src) {
    if (!src || src.width !== result.width || src.height !== result.height) return result;
    for (let i = 3; i < result.data.length; i += 4) result.data[i] = src.data[i];
    return result;
}

export function grayConvolve(g, kernel) {
    const size = kernel.length, half = Math.floor(size / 2);
    let div = kernel.flat().reduce((a, b) => a + b, 0);
    if (!div) div = 1;
    const { width, height, data } = g;
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let acc = 0;
            for (let j = 0; j < size; j++) {
                const sy = clamp(y + j - half, 0, height - 1);
                for (let i = 0; i < size; i++) {
                    const sx = clamp(x + i - half, 0, width - 1);
                    acc += data[sy * width + sx] * kernel[j][i];
                }
            }
            out[y * width + x] = acc / div;
        }
    }
    return { width, height, data: out };
}

export function sobel(src, { mode = 'magnitude', grayscale = true, luma = 'luma709' } = {}) {
    const g = toGray(src, luma);
    const gx = grayConvolve(g, KERNELS.sobelX).data;
    const gy = grayConvolve(g, KERNELS.sobelY).data;
    // 幅值可达 1020+，必须先放 Float32；写进 Uint8Clamped 会被截到 255，
    // 之后按截断值归一化会把所有边缘压成同一个灰级
    const mag = new Float32Array(g.width * g.height);
    let max = 1;
    for (let i = 0; i < mag.length; i++) {
        const v = mode === 'x' ? Math.abs(gx[i]) : mode === 'y' ? Math.abs(gy[i]) : Math.hypot(gx[i], gy[i]);
        mag[i] = v;
        if (v > max) max = v;
    }
    const out = new Uint8ClampedArray(mag.length);
    for (let i = 0; i < out.length; i++) out[i] = clamp(Math.round((mag[i] / max) * 255), 0, 255);
    return keepAlpha(grayToPx({ width: g.width, height: g.height, data: out }), grayscale ? null : src);
}

export function scharr(src, opts = {}) {
    const g = toGray(src, opts.luma || 'luma709');
    const gx = grayConvolve(g, KERNELS.scharrX).data;
    const gy = grayConvolve(g, KERNELS.scharrY).data;
    const mag = new Float32Array(g.width * g.height);
    let max = 1;
    for (let i = 0; i < mag.length; i++) {
        const v = Math.hypot(gx[i], gy[i]);
        mag[i] = v; if (v > max) max = v;
    }
    const out = new Uint8ClampedArray(mag.length);
    for (let i = 0; i < out.length; i++) out[i] = clamp(Math.round((mag[i] / max) * 255), 0, 255);
    return grayToPx({ width: g.width, height: g.height, data: out });
}

export function laplacian(src, { scale = 'auto', kernel = '4' } = {}) {
    const g = toGray(src, 'luma709');
    const k = kernel === '8'
        ? [[1, 1, 1], [1, -8, 1], [1, 1, 1]]
        : KERNELS.laplacian;
    const r = grayConvolve(g, k);
    const out = new Uint8ClampedArray(r.data.length);
    if (scale === 'abs') {
        for (let i = 0; i < out.length; i++) out[i] = clamp(Math.round(Math.abs(r.data[i])), 0, 255);
    } else {
        for (let i = 0; i < out.length; i++) out[i] = clamp(Math.round(r.data[i] + 128), 0, 255);
    }
    return grayToPx({ width: r.width, height: r.height, data: out });
}

// LoG 用高斯差（DoG）近似：省一次二维卷积，效果对阈值分割等价
export function logEdge(src, { sigma = 2, scale = 1.6, normalize = true } = {}) {
    const g = toGray(src, 'luma709');
    const b1 = gaussianBlurPx(g, sigma);
    const b2 = gaussianBlurPx(g, sigma * toNum(scale, 1.6));
    const out = new Uint8ClampedArray(g.data.length);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < out.length; i++) {
        const v = b2.data[i] - b1.data[i];
        out[i] = v;
        if (v < min) min = v; if (v > max) max = v;
    }
    const span = Math.max(1e-6, max - min);
    for (let i = 0; i < out.length; i++) out[i] = clamp(Math.round(((out[i] - min) / span) * 255), 0, 255);
    if (!normalize) for (let i = 0; i < out.length; i++) out[i] = out[i] > 128 ? 255 : 0;
    return grayToPx({ width: g.width, height: g.height, data: out });
}

function gaussianBlurPx(g, sigma) {
    const px = grayToPx(g);
    const blurred = gaussianBlur(px, sigma);
    const data = new Uint8ClampedArray(g.data.length);
    for (let i = 0, j = 0; j < data.length; i += 4, j++) data[j] = blurred.data[i];
    return { width: g.width, height: g.height, data };
}

// Canny：高斯平滑 -> Sobel 梯度与方向 -> 非极大值抑制 -> 双阈值 -> 滞回连通
export function canny(src, { low = 40, high = 120, sigma = 1.4, luma = 'luma709' } = {}) {
    const g0 = toGray(src, luma);
    const g = gaussianBlurPx(g0, toNum(sigma, 1.4));
    const { width, height } = g;
    const gx = new Float32Array(width * height);
    const gy = new Float32Array(width * height);
    const mag = new Float32Array(width * height);
    const dir = new Float32Array(width * height);
    const at = (x, y) => g.data[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            gx[i] = (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
                * -1 + (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
            gy[i] = (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
                * -1 + (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
            mag[i] = Math.hypot(gx[i], gy[i]);
            let d = Math.atan2(gy[i], gx[i]) * 180 / Math.PI;
            if (d < 0) d += 180;
            dir[i] = d;
        }
    }
    const nms = new Float32Array(width * height);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const d = dir[i];
            let a, b;
            if (d < 22.5 || d >= 157.5) { a = mag[i - 1]; b = mag[i + 1]; }
            else if (d < 67.5) { a = mag[i - width + 1]; b = mag[i + width - 1]; }
            else if (d < 112.5) { a = mag[i - width]; b = mag[i + width]; }
            else { a = mag[i - width - 1]; b = mag[i + width + 1]; }
            nms[i] = (mag[i] >= a && mag[i] >= b) ? mag[i] : 0;
        }
    }
    const lo = toNum(low, 40), hi = toNum(high, 120);
    const strong = new Uint8Array(width * height);
    const weak = new Uint8Array(width * height);
    for (let i = 0; i < nms.length; i++) {
        if (nms[i] >= hi) strong[i] = 1;
        else if (nms[i] >= lo) weak[i] = 1;
    }
    const stack = [];
    for (let i = 0; i < strong.length; i++) if (strong[i]) stack.push(i);
    while (stack.length) {
        const i = stack.pop();
        const x = i % width, y = (i / width) | 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                const j = ny * width + nx;
                if (weak[j] && !strong[j]) { strong[j] = 1; stack.push(j); }
            }
        }
    }
    const out = new Uint8ClampedArray(width * height);
    for (let i = 0; i < out.length; i++) out[i] = strong[i] ? 255 : 0;
    return grayToPx({ width, height, data: out });
}

export function otsuThreshold(g) {
    const hist = new Float64Array(256);
    for (let i = 0; i < g.data.length; i++) hist[g.data[i]]++;
    const total = g.data.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, wF = 0, best = -1, thr = 0;
    for (let i = 0; i < 256; i++) {
        wB += hist[i];
        if (!wB) continue;
        wF = total - wB;
        if (!wF) break;
        sumB += i * hist[i];
        const mB = sumB / wB, mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > best) { best = between; thr = i; }
    }
    return thr;
}

function boxSum(src, radius) {
    const { width, height, data } = src;
    const acc = new Float64Array((width + 1) * (height + 1));
    for (let y = 0; y < height; y++) {
        let rowSum = 0;
        for (let x = 0; x < width; x++) {
            rowSum += data[y * width + x];
            acc[(y + 1) * (width + 1) + (x + 1)] = acc[y * (width + 1) + (x + 1)] + rowSum;
        }
    }
    return (x0, y0, x1, y1) => {
        const w = x1 - x0, h = y1 - y0;
        if (w <= 0 || h <= 0) return 0;
        const s = acc[y1 * (width + 1) + x1] - acc[y0 * (width + 1) + x1] - acc[y1 * (width + 1) + x0] + acc[y0 * (width + 1) + x0];
        return s / (w * h);
    };
}

export function threshold(src, { mode = 'otsu', value = 128, blockSize = 21, C = 8, k = 0.2, sigmaLocal = 0.02, invert = false, output = 'binary', luma = 'luma709', color = null } = {}) {
    const g = toGray(src, luma);
    const { width, height, data } = g;
    const out = new Uint8ClampedArray(data.length);
    const thrMap = new Uint8ClampedArray(data.length);

    if (mode === 'fixed') {
        const t = toNum(value, 128);
        for (let i = 0; i < data.length; i++) thrMap[i] = t;
    } else if (mode === 'otsu' || mode === 'trirate') {
        const t = otsuThreshold(g);
        for (let i = 0; i < data.length; i++) thrMap[i] = t;
    } else if (mode === 'mean' || mode === 'gaussian') {
        const r = Math.max(1, Math.round(toNum(blockSize, 21) / 2));
        const sum = boxSum(g, 0);
        const c = toNum(C, 8);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const x0 = clamp(x - r, 0, width), y0 = clamp(y - r, 0, height);
                const x1 = clamp(x + r + 1, 0, width), y1 = clamp(y + r + 1, 0, height);
                // 积分图均值得到邻域平均，再减去常数 C（OpenCV 语义）
                const mean = sum(x0, y0, x1, y1);
                thrMap[y * width + x] = clamp(Math.round(mean - c), 0, 255);
            }
        }
    } else if (mode === 'sauvola') {
        const r = Math.max(1, Math.round(toNum(blockSize, 21) / 2));
        const kk = toNum(k, 0.2);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let s = 0, s2 = 0, n = 0;
                for (let j = -r; j <= r; j++) {
                    const sy = clamp(y + j, 0, height - 1);
                    for (let i = -r; i <= r; i++) {
                        const v = data[sy * width + clamp(x + i, 0, width - 1)];
                        s += v; s2 += v * v; n++;
                    }
                }
                const mean = s / n;
                const std = Math.sqrt(Math.max(0, s2 / n - mean * mean));
                thrMap[y * width + x] = clamp(Math.round(mean * (1 + kk * (std / 128 - 1))), 0, 255);
            }
        }
    } else if (mode === 'localSigma') {
        const r = Math.max(1, Math.round(toNum(blockSize, 31) / 2));
        const sg = toNum(sigmaLocal, 0.02) * 255;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let s = 0, s2 = 0, n = 0;
                for (let j = -r; j <= r; j++) {
                    const sy = clamp(y + j, 0, height - 1);
                    for (let i = -r; i <= r; i++) {
                        const v = data[sy * width + clamp(x + i, 0, width - 1)];
                        s += v; s2 += v * v; n++;
                    }
                }
                const mean = s / n;
                const std = Math.sqrt(Math.max(0, s2 / n - mean * mean));
                thrMap[y * width + x] = clamp(Math.round(mean + sg * std - toNum(C, 0)), 0, 255);
            }
        }
    } else {
        for (let i = 0; i < data.length; i++) thrMap[i] = toNum(value, 128);
    }

    if (mode === 'trirate') {
        const t = thrMap[0];
        const lo = Math.round(t * 0.7), hi = Math.round(Math.min(255, t * 1.3 + 10));
        for (let i = 0; i < data.length; i++) {
            const v = data[i] < lo ? 0 : data[i] > hi ? 255 : (invert ? 0 : 128);
            out[i] = v === 128 ? (invert ? 255 : 128) : v;
        }
    } else {
        for (let i = 0; i < data.length; i++) {
            const on = data[i] >= thrMap[i];
            out[i] = (invert ? !on : on) ? 255 : 0;
        }
    }

    if (output === 'gray') {
        for (let i = 0; i < out.length; i++) out[i] = out[i] > 0 ? data[i] : 0;
    }
    const gray = { width, height, data: out };
    if (output === 'keep-color') {
        const res = clonePx(src);
        for (let i = 0, j = 0; j < out.length; i += 4, j++) {
            if (out[j] === 0) { res.data[i] = res.data[i + 1] = res.data[i + 2] = color ? (typeof color === 'string' ? 0 : color[0]) : 0; }
        }
        return res;
    }
    return grayToPx(gray);
}

function morphWindow(shape, r) {
    const pts = [];
    for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
            if (shape === 'cross' && dx !== 0 && dy !== 0) continue;
            if (shape === 'circle' && Math.hypot(dx, dy) > r + 0.01) continue;
            pts.push([dx, dy]);
        }
    }
    return pts;
}

export function morphology(src, { op = 'erode', radius = 1, shape = 'rect' } = {}) {
    const r = clamp(toInt(radius, 1), 1, 15);
    const pts = morphWindow(shape, r);
    const g = toGray(src, 'average');
    const { width, height, data } = g;
    const mode = op === 'dilate' || op === 'open' || op === 'gradient' || op === 'tophat';
    const out = new Uint8ClampedArray(data.length);

    const single = (input, wantMax) => {
        const o = new Uint8ClampedArray(input.length);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let v = wantMax ? 0 : 255;
                for (const [dx, dy] of pts) {
                    const p = input[clamp(y + dy, 0, height - 1) * width + clamp(x + dx, 0, width - 1)];
                    if (wantMax ? p > v : p < v) v = p;
                }
                o[y * width + x] = v;
            }
        }
        return o;
    };

    let base = data;
    if (op === 'erode' || op === 'open' || op === 'tophat') base = single(data, false);
    if (op === 'dilate' || op === 'close' || op === 'tophat') {
        base = single(op === 'close' ? data : base, true);
    }
    out.set(base);

    if (op === 'gradient') {
        const er = single(data, false), di = single(data, true);
        for (let i = 0; i < out.length; i++) out[i] = clamp(di[i] - er[i], 0, 255);
    } else if (op === 'tophat') {
        const er = single(data, false), di = single(er, true);
        for (let i = 0; i < out.length; i++) out[i] = clamp(data[i] - di[i], 0, 255);
    } else if (op === 'blackhat') {
        const di = single(data, true), er = single(di, false);
        for (let i = 0; i < out.length; i++) out[i] = clamp(er[i] - data[i], 0, 255);
    }
    return grayToPx({ width, height, data: out });
}

export { grayToPx, keepAlpha };
