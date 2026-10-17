// 重采样与几何变换：全部在像素数组上完成，不经 canvas，保证可单测与跨上下文一致。

import { clamp, toNum, toInt, normRect } from '../util.js';

export function mkPx(width, height, data) {
    return { width, height, data: data || new Uint8ClampedArray(width * height * 4) };
}

export function clonePx(src) {
    return mkPx(src.width, src.height, new Uint8ClampedArray(src.data));
}

const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const lanczos = (a) => (x) => (Math.abs(x) >= a ? 0 : sinc(x) * sinc(x / a));

// Keys 三次卷积核：a=-0.5 为 Catmull-Rom（bicubic），a=1 为立方 B 样条
function keysCubic(a) {
    return (x) => {
        const ax = Math.abs(x);
        if (ax <= 1) return ((a + 2) * ax - (a + 3)) * ax * ax + 1;
        if (ax < 2) return ((-a * ax + 5 * a) * ax - 8 * a) * ax + 4 * a;
        return 0;
    };
}

export const RESAMPLE_FILTERS = {
    nearest: { support: 0.5, fn: () => 1 },
    box: { support: 0.5, fn: (x) => (Math.abs(x) <= 0.5 ? 1 : 0) },
    triangle: { support: 1, fn: (x) => (Math.abs(x) >= 1 ? 0 : 1 - Math.abs(x)) },
    bicubic: { support: 2, fn: keysCubic(-0.5) },
    bspline: { support: 2, fn: keysCubic(1) },
    mitchell: { support: 2, fn: keysCubic(1 / 3) },
    lanczos2: { support: 2, fn: lanczos(2) },
    lanczos3: { support: 3, fn: lanczos(3) },
    lanczos4: { support: 4, fn: lanczos(4) },
};
// area 是缩小的别名：等价于按目标像素覆盖的源区域做面积加权平均
RESAMPLE_FILTERS.area = { support: 0.5, fn: RESAMPLE_FILTERS.box.fn };

function buildAxis(inSize, outSize, filterName) {
    const f = RESAMPLE_FILTERS[filterName] || RESAMPLE_FILTERS.lanczos3;
    const ratio = inSize / outSize;
    if (filterName === 'nearest') {
        const taps = new Array(outSize);
        for (let i = 0; i < outSize; i++) {
            taps[i] = { idx: [clamp(Math.round((i + 0.5) * ratio - 0.5), 0, inSize - 1)], sum: [1] };
        }
        return taps;
    }
    const support = f.support * (ratio > 1 ? ratio : 1);
    // 缩小时把核按缩放比拉开，采样偏移同步压缩回核空间，等价面积加权
    const kscale = ratio > 1 ? 1 / ratio : 1;
    const taps = new Array(outSize);
    for (let i = 0; i < outSize; i++) {
        const center = (i + 0.5) * ratio;
        const left = Math.max(0, Math.floor(center - support));
        const right = Math.min(inSize - 1, Math.ceil(center + support));
        const idx = [];
        const sum = [];
        let acc = 0;
        for (let j = left; j <= right; j++) {
            const w = f.fn((j + 0.5 - center) * kscale);
            if (w !== 0) { idx.push(j); sum.push(w); acc += w; }
        }
        if (!idx.length) { idx.push(clamp(Math.round(center - 0.5), 0, inSize - 1)); sum.push(1); acc = 1; }
        for (let k = 0; k < sum.length; k++) sum[k] = acc ? sum[k] / acc : 1;
        taps[i] = { idx, sum };
    }
    return taps;
}

export function resize(src, outW, outH, filter = 'lanczos3') {
    outW = Math.max(1, Math.round(outW));
    outH = Math.max(1, Math.round(outH));
    if (outW === src.width && outH === src.height) return clonePx(src);
    const { width: iw, height: ih, data } = src;
    const axisX = buildAxis(iw, outW, filter);
    const axisY = buildAxis(ih, outH, filter);

    // 横向先出中间图（Byte 精度），避免 Float32 中间缓存在大图上占数百 MB
    const tmp = new Uint8ClampedArray(outW * ih * 4);
    for (let y = 0; y < ih; y++) {
        const rowIn = y * iw * 4;
        const rowOut = y * outW * 4;
        for (let x = 0; x < outW; x++) {
            const t = axisX[x];
            let r = 0, g = 0, b = 0, a = 0;
            for (let k = 0; k < t.idx.length; k++) {
                const p = rowIn + t.idx[k] * 4;
                const w = t.sum[k];
                r += data[p] * w; g += data[p + 1] * w; b += data[p + 2] * w; a += data[p + 3] * w;
            }
            const o = rowOut + x * 4;
            tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
        }
    }
    const out = new Uint8ClampedArray(outW * outH * 4);
    // 垂直方向必须用浮点累加：写进 Uint8Clamped 会把每个部分和先截断取整，
    // 常数图会掉 1 个级、棋盘均值会偏移，Lanczos 的振铃也被抹平
    const rowAcc = new Float32Array(outW * 4);
    for (let y = 0; y < outH; y++) {
        const t = axisY[y];
        rowAcc.fill(0);
        for (let k = 0; k < t.idx.length; k++) {
            const rowIn = t.idx[k] * outW * 4;
            const w = t.sum[k];
            for (let x = 0; x < outW * 4; x++) rowAcc[x] += tmp[rowIn + x] * w;
        }
        out.set(rowAcc, y * outW * 4);
    }
    return mkPx(outW, outH, out);
}

// 目标尺寸解析：percent / longest / width / height / exact，永不放大超过 maxDim 上限
export function resolveSize(src, p) {
    const maxDim = toInt(p.maxDim, 8192) || 8192;
    let w = src.width, h = src.height;
    if (p.mode === 'percent' || p.percent !== undefined) {
        const s = toNum(p.percent, 100) / 100;
        w = src.width * s; h = src.height * s;
    } else if (p.mode === 'longest') {
        const s = toNum(p.value, Math.max(src.width, src.height)) / Math.max(src.width, src.height);
        w = src.width * s; h = src.height * s;
    } else if (p.mode === 'width') {
        const s = toNum(p.value, src.width) / src.width;
        w = src.width * s; h = src.height * s;
    } else if (p.mode === 'height') {
        const s = toNum(p.value, src.height) / src.height;
        h = src.height * s; w = src.width * s;
    } else if (p.mode === 'exact') {
        w = toNum(p.width, src.width); h = toNum(p.height, src.height);
        if (p.keepAspect) {
            const s = Math.min(w / src.width, h / src.height);
            w = src.width * s; h = src.height * s;
        }
    }
    return {
        width: clamp(Math.round(w), 1, maxDim),
        height: clamp(Math.round(h), 1, maxDim),
    };
}

export function flip(src, dir) {
    const { width, height, data } = src;
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const sx = dir === 'h' ? width - 1 - x : x;
            const sy = dir === 'v' ? height - 1 - y : y;
            const i = (y * width + x) * 4, j = (sy * width + sx) * 4;
            out[i] = data[j]; out[i + 1] = data[j + 1]; out[i + 2] = data[j + 2]; out[i + 3] = data[j + 3];
        }
    }
    return mkPx(width, height, out);
}

function rotate90(src, times) {
    const n = ((times % 4) + 4) % 4;
    if (n === 0) return clonePx(src);
    const { width, height, data } = src;
    const isOdd = n === 1 || n === 3;
    const ow = isOdd ? height : width, oh = isOdd ? width : height;
    const out = new Uint8ClampedArray(ow * oh * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let dx, dy;
            if (n === 1) { dx = height - 1 - y; dy = x; }            // 顺时针 90
            else if (n === 2) { dx = width - 1 - x; dy = height - 1 - y; }
            else { dx = y; dy = width - 1 - x; }
            const i = (y * width + x) * 4, j = (dy * ow + dx) * 4;
            out[j] = data[i]; out[j + 1] = data[i + 1]; out[j + 2] = data[i + 2]; out[j + 3] = data[i + 3];
        }
    }
    return mkPx(ow, oh, out);
}

// 任意角度用逆向映射 + 双线性，正向散射会在大角度留下空洞
export function rotate(src, angleDeg, { expand = true, fill = [0, 0, 0, 0], filter = 'bicubic' } = {}) {
    const a = toNum(angleDeg, 0);
    const near90 = Math.abs(((a % 90) + 90) % 90) < 1e-6 && Math.abs(a % 90) < 1e-6;
    const q = Math.round(a / 90);
    if (near90 && Math.abs(a - q * 90) < 1e-6 && Math.abs(a) >= 0) {
        const isRightAngle = Math.abs(a % 180) === 90 || Math.abs(a % 180) === 0;
        if (isRightAngle && Math.abs((a / 90) % 1) < 1e-9) return rotate90(src, -Math.round(a / 90));
    }
    const rad = (a * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const sw = src.width, sh = src.height;
    const halfW = sw / 2, halfH = sh / 2;
    let dw, dh, cx, cy;
    if (expand) {
        const bb = [[-halfW, -halfH], [halfW, -halfH], [-halfW, halfH], [halfW, halfH]]
            .map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
        const xs = bb.map((p) => p[0]), ys = bb.map((p) => p[1]);
        dw = Math.max(1, Math.round(Math.max(...xs) - Math.min(...xs)));
        dh = Math.max(1, Math.round(Math.max(...ys) - Math.min(...ys)));
        cx = dw / 2; cy = dh / 2;
    } else { dw = sw; dh = sh; cx = sw / 2; cy = sh / 2; }

    const out = new Uint8ClampedArray(dw * dh * 4);
    for (let i = 0; i < out.length; i += 4) {
        out[i] = fill[0]; out[i + 1] = fill[1]; out[i + 2] = fill[2]; out[i + 3] = fill[3];
    }
    const sd = src.data;
    const invCos = cos, invSin = sin; // 正向→源向：旋转 -a
    const sample = (fx, fy) => {
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        const acc = [0, 0, 0, 0];
        for (let dy = 0; dy <= 1; dy++) {
            for (let dx = 0; dx <= 1; dx++) {
                const px = x0 + dx, py = y0 + dy;
                if (px < 0 || py < 0 || px >= sw || py >= sh) continue;
                const wgt = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
                const p = (py * sw + px) * 4;
                acc[0] += sd[p] * wgt; acc[1] += sd[p + 1] * wgt; acc[2] += sd[p + 2] * wgt; acc[3] += sd[p + 3] * wgt;
            }
        }
        return acc;
    };
    for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
            const rx = x - cx, ry = y - cy;
            const fx = rx * invCos + ry * invSin + halfW - 0.5;
            const fy = -rx * invSin + ry * invCos + halfH - 0.5;
            if (fx < -0.5 || fy < -0.5 || fx > sw - 0.5 || fy > sh - 0.5) continue;
            const c = filter === 'nearest'
                ? (() => {
                    const px = clamp(Math.round(fx), 0, sw - 1), py = clamp(Math.round(fy), 0, sh - 1);
                    const p = (py * sw + px) * 4;
                    return [sd[p], sd[p + 1], sd[p + 2], sd[p + 3]];
                })()
                : sample(clamp(fx, 0, sw - 1), clamp(fy, 0, sh - 1));
            const o = (y * dw + x) * 4;
            out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = c[3];
        }
    }
    return mkPx(dw, dh, out);
}

export function crop(src, rect) {
    const r = normRect(rect, src.width, src.height);
    if (r.width < 1 || r.height < 1) throw new Error('裁剪区域为空');
    const out = new Uint8ClampedArray(r.width * r.height * 4);
    for (let y = 0; y < r.height; y++) {
        const si = ((r.y + y) * src.width + r.x) * 4;
        out.set(src.data.subarray(si, si + r.width * 4), y * r.width * 4);
    }
    return mkPx(r.width, r.height, out);
}

export function pad(src, { top = 0, right = 0, bottom = 0, left = 0, color = [0, 0, 0, 0] } = {}) {
    const dw = src.width + left + right, dh = src.height + top + bottom;
    const out = new Uint8ClampedArray(dw * dh * 4);
    for (let i = 0; i < out.length; i += 4) {
        out[i] = color[0]; out[i + 1] = color[1]; out[i + 2] = color[2]; out[i + 3] = color[3];
    }
    for (let y = 0; y < src.height; y++) {
        const si = y * src.width * 4;
        out.set(src.data.subarray(si, si + src.width * 4), ((y + top) * dw + left) * 4);
    }
    return mkPx(dw, dh, out);
}

// 把 src 贴到 dst 的 (x,y)，越界裁剪，alpha 混合
export function place(src, dst, x, y, opacity = 1) {
    x = Math.round(x); y = Math.round(y);
    for (let j = 0; j < src.height; j++) {
        const dy = y + j;
        if (dy < 0 || dy >= dst.height) continue;
        for (let i = 0; i < src.width; i++) {
            const dx = x + i;
            if (dx < 0 || dx >= dst.width) continue;
            const s = (j * src.width + i) * 4, d = (dy * dst.width + dx) * 4;
            const sa = (src.data[s + 3] / 255) * opacity;
            if (sa >= 1) {
                dst.data[d] = src.data[s]; dst.data[d + 1] = src.data[s + 1];
                dst.data[d + 2] = src.data[s + 2]; dst.data[d + 3] = src.data[s + 3];
            } else if (sa > 0) {
                const da = dst.data[d + 3] / 255;
                const oa = sa + da * (1 - sa);
                for (let c = 0; c < 3; c++) {
                    dst.data[d + c] = oa > 0 ? (src.data[s + c] * sa + dst.data[d + c] * da * (1 - sa)) / oa : 0;
                }
                dst.data[d + 3] = Math.round(oa * 255);
            }
        }
    }
    return dst;
}

export function createCanvasPx(width, height, color = [0, 0, 0, 0]) {
    const out = mkPx(width, height);
    for (let i = 0; i < out.data.length; i += 4) {
        out.data[i] = color[0]; out.data[i + 1] = color[1]; out.data[i + 2] = color[2]; out.data[i + 3] = color[3];
    }
    return out;
}

// 通用裁边：黑边/白边/纯色边/自动（按四角取样）。沿用三重防误裁：
// 单边上限、裁后最小占比、最小尺寸，避免暗场景被当成黑边吃掉。
export function trimBorder(src, opts = {}) {
    const mode = opts.mode || 'auto';
    const tolerance = toNum(opts.tolerance, 12);
    const contentRatio = toNum(opts.contentRatio, 0.015);
    const maxRatio = toNum(opts.maxTrimRatio, 0.45);
    const minKeepRatio = toNum(opts.minKeepRatio, 0.3);
    const minDim = toInt(opts.minDim, 8);
    const analyze = downscaleForAnalysis(src, toInt(opts.analysisSize, 480));
    const { width: aw, height: ah, data } = analyze;

    let refColor;
    if (mode === 'black') refColor = [0, 0, 0];
    else if (mode === 'white') refColor = [255, 255, 255];
    else if (mode === 'transparent') refColor = null;
    else if (mode === 'color' && opts.color) refColor = opts.color.slice(0, 3);
    else {
        const corners = [[0, 0], [aw - 1, 0], [0, ah - 1], [aw - 1, ah - 1]].map(([x, y]) => {
            const p = (y * aw + x) * 4;
            return [data[p], data[p + 1], data[p + 2], data[p + 3]];
        });
        const opaque = corners.filter((c) => c[3] > 8);
        if (!opaque.length) refColor = null;
        else {
            // 四角色差过大说明不是统一纯色衬底，退化为按亮度判黑
            const spread = Math.max(...opaque.flatMap((c) => c.slice(0, 3))) - Math.min(...opaque.flatMap((c) => c.slice(0, 3)));
            refColor = spread > 40 ? [0, 0, 0] : opaque.reduce((a, c) => [a[0] + c[0] / opaque.length, a[1] + c[1] / opaque.length, a[2] + c[2] / opaque.length], [0, 0, 3]);
        }
    }

    const isBg = (p) => {
        if (mode === 'transparent') return data[p + 3] <= tolerance;
        if (!refColor) return false;
        return Math.abs(data[p] - refColor[0]) <= tolerance
            && Math.abs(data[p + 1] - refColor[1]) <= tolerance
            && Math.abs(data[p + 2] - refColor[2]) <= tolerance
            && (mode === 'transparent' || data[p + 3] > tolerance);
    };

    const rowContent = new Int32Array(ah), colContent = new Int32Array(aw);
    for (let y = 0; y < ah; y++) {
        for (let x = 0; x < aw; x++) {
            if (!isBg((y * aw + x) * 4)) { rowContent[y]++; colContent[x]++; }
        }
    }
    const rowHas = (y) => rowContent[y] > aw * contentRatio;
    const colHas = (x) => colContent[x] > ah * contentRatio;
    const maxT = { y: Math.floor(ah * maxRatio), x: Math.floor(aw * maxRatio) };
    let top = 0, bottom = ah - 1, left = 0, right = aw - 1;
    while (top < maxT.y && !rowHas(top)) top++;
    while (bottom > ah - 1 - maxT.y && !rowHas(bottom)) bottom--;
    while (left < maxT.x && !colHas(left)) left++;
    while (right > aw - 1 - maxT.x && !colHas(right)) right--;

    const scale = analyze.width / src.width;
    const nx = Math.round(left / scale), ny = Math.round(top / scale);
    const nw = clamp(Math.round((right - left + 1) / scale), 1, src.width - nx);
    const nh = clamp(Math.round((bottom - top + 1) / scale), 1, src.height - ny);
    if (nw >= src.width && nh >= src.height) return { image: clonePx(src), trimmed: null };
    if (nw < src.width * minKeepRatio || nh < src.height * minKeepRatio || nw < minDim || nh < minDim) {
        return { image: clonePx(src), trimmed: null };
    }
    return { image: crop(src, { x: nx, y: ny, width: nw, height: nh }), trimmed: { x: nx, y: ny, width: nw, height: nh } };
}

export function downscaleForAnalysis(src, maxSide) {
    const m = Math.max(src.width, src.height);
    if (m <= maxSide) return src;
    const s = maxSide / m;
    return resize(src, Math.max(1, Math.round(src.width * s)), Math.max(1, Math.round(src.height * s)), 'area');
}

export function aspectFit(src, maxW, maxH, filter = 'area') {
    const s = Math.min(maxW / src.width, maxH / src.height, 1);
    if (s >= 1) return clonePx(src);
    return resize(src, Math.round(src.width * s), Math.round(src.height * s), filter);
}

export { rotate90 };
