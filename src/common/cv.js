// 分析与测量类算子：统计、直方图、主色板、连通域、轮廓、角点、霍夫、模板匹配、
// 感知哈希与相似度。全部返回可 JSON 化的结果，方便跨上下文消息传递。

import { clamp, toNum, toInt } from './util.js';
import { mkPx, clonePx, resize } from './imgops/geometry.js';
import { luma, rgbToHsv, rgbToHex, toGray } from './imgops/color.js';

export function stats(src) {
    const d = src.data;
    const n = d.length / 4;
    let sr = 0, sg = 0, sb = 0, sa = 0, s2r = 0, s2g = 0, s2b = 0;
    let min = 255, max = 0, opaque = 0, transparent = 0;
    for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
        sr += r; sg += g; sb += b; sa += a;
        s2r += r * r; s2g += g * g; s2b += b * b;
        const l = luma(r, g, b);
        if (l < min) min = l;
        if (l > max) max = l;
        if (a > 8) opaque++; else transparent++;
    }
    const std = (s2, s) => Math.sqrt(Math.max(0, s2 / n - (s / n) * (s / n)));
    return {
        width: src.width, height: src.height, pixels: n,
        mean: [sr / n, sg / n, sb / n],
        stddev: [std(s2r, sr), std(s2g, sg), std(s2b, sb)],
        lumaMin: min, lumaMax: max,
        alphaCover: n ? opaque / n : 0,
        transparentPixels: transparent,
    };
}

export function histogram(src, bins = 256, channel = 'luma') {
    const h = new Array(bins).fill(0);
    const d = src.data;
    for (let i = 0; i < d.length; i += 4) {
        const v = channel === 'luma' ? luma(d[i], d[i + 1], d[i + 2])
            : channel === 'r' ? d[i] : channel === 'g' ? d[i + 1] : channel === 'b' ? d[i + 2]
                : channel === 'alpha' ? d[i + 3] : d[i] * 0.33 + d[i + 1] * 0.34 + d[i + 2] * 0.33;
        h[clamp(Math.round((v / 255) * (bins - 1)), 0, bins - 1)]++;
    }
    const total = d.length / 4;
    let entropy = 0;
    for (const c of h) if (c) { const p = c / total; entropy -= p * Math.log2(p); }
    return { bins: h, binCount: bins, channel, entropy, total };
}

// 中位切割取主色：按色域最长轴分裂，返回按面积排序的颜色与占比
export function palette(src, { count = 6, ignoreTransparent = true } = {}) {
    const k = Math.max(1, toInt(count, 6));
    const pixels = [];
    const d = src.data;
    const step = Math.max(1, Math.floor(Math.sqrt((src.width * src.height) / 20000)));
    for (let y = 0; y < src.height; y += step) {
        for (let x = 0; x < src.width; x += step) {
            const i = (y * src.width + x) * 4;
            if (ignoreTransparent && d[i + 3] < 16) continue;
            pixels.push([d[i], d[i + 1], d[i + 2]]);
        }
    }
    if (!pixels.length) return { colors: [], sampleCount: 0 };
    const boxes = [pixels];
    while (boxes.length < k) {
        let best = -1, bestSpan = -1, bestAxis = 0;
        boxes.forEach((box, idx) => {
            if (box.length < 2) return;
            for (let ax = 0; ax < 3; ax++) {
                let lo = 255, hi = 0;
                for (const p of box) { if (p[ax] < lo) lo = p[ax]; if (p[ax] > hi) hi = p[ax]; }
                const span = hi - lo;
                if (span > bestSpan) { bestSpan = span; best = idx; bestAxis = ax; }
            }
        });
        if (best < 0) break;
        const box = boxes[best].slice().sort((a, b) => a[bestAxis] - b[bestAxis]);
        const mid = box.length >> 1;
        boxes.splice(best, 1, box.slice(0, mid), box.slice(mid));
    }
    const total = src.width * src.height;
    const colors = boxes.filter((b) => b.length).map((box) => {
        let r = 0, g = 0, b2 = 0;
        for (const p of box) { r += p[0]; g += p[1]; b2 += p[2]; }
        const n = box.length;
        const rgb = [Math.round(r / n), Math.round(g / n), Math.round(b2 / n)];
        return { rgb, hex: rgbToHex(rgb[0], rgb[1], rgb[2]), share: n / (boxes.reduce((a, b) => a + b.length, 0) || 1), samples: n, total };
    }).sort((a, b) => b.share - a.share);
    return { colors, sampleCount: pixels.length };
}

// 8/4 连通域标记（两遍扫描 + union-find），返回标签图与每域几何
export function connectedComponents(binary, { connectivity = 8, minArea = 0, binarize = true, threshold = 128 } = {}) {
    const g = binary.data.length === binary.width * binary.height
        ? binary
        : toGray({ width: binary.width, height: binary.height, data: binary.data }, 'average');
    const { width, height, data } = g;
    const isOn = (i) => (binarize ? data[i] >= threshold : data[i] > 0);
    const parent = new Int32Array(width * height);
    const labels = new Int32Array(width * height);
    let next = 1;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const neigh4 = [[-1, 0], [0, -1]];
    const neigh8 = [[-1, -1], [0, -1], [1, -1], [-1, 0]];
    const nb = connectivity === 4 ? neigh4 : neigh8;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            if (!isOn(i)) { labels[i] = 0; continue; }
            let best = 0;
            for (const [dx, dy] of nb) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                const j = ny * width + nx;
                if (!isOn(j)) continue;
                if (labels[j] && (!best || find(labels[j]) < find(best))) best = labels[j];
            }
            if (!best) { labels[i] = next; parent[next] = next; next++; }
            else {
                labels[i] = best;
                for (const [dx, dy] of nb) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                    const j = ny * width + nx;
                    if (labels[j]) union(labels[j], best);
                }
            }
        }
    }
    const remap = new Int32Array(next);
    let count = 0;
    const areas = [], boxes = [];
    for (let i = 0; i < labels.length; i++) {
        if (!labels[i]) continue;
        const root = find(labels[i]);
        if (!remap[root]) remap[root] = ++count;
        labels[i] = remap[root];
        const idx = labels[i] - 1;
        if (!areas[idx]) { areas[idx] = 0; boxes[idx] = { x0: width, y0: height, x1: 0, y1: 0 }; }
        areas[idx]++;
        const x = i % width, y = (i / width) | 0;
        const b = boxes[idx];
        if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x;
        if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
    }
    const regions = [];
    for (let l = 0; l < count; l++) {
        if (areas[l] < minArea) continue;
        const b = boxes[l];
        regions.push({
            label: l + 1, area: areas[l],
            x: b.x0, y: b.y0, width: b.x1 - b.x0 + 1, height: b.y1 - b.y0 + 1,
            fillRatio: areas[l] / Math.max(1, (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1)),
        });
    }
    regions.sort((a, b) => b.area - a.area);
    return { labels, count: regions.length, regions, width, height };
}

// Moore 邻域边界追踪 + RDP 简化；hole 检测靠奇偶嵌套（外层轮廓优先）
export function contours(binary, { threshold = 128, simplify = 1.5, minArea = 24, connectivity = 8 } = {}) {
    const cc = connectedComponents(binary, { connectivity, threshold, minArea });
    const { labels, width, height } = cc;
    const on = (x, y) => (x >= 0 && y >= 0 && x < width && y < height && labels[y * width + x] > 0);
    const visited = new Uint8Array(width * height);
    const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const out = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            if (!labels[i] || visited[i]) continue;
            if (on(x - 1, y) && on(x, y - 1) && on(x + 1, y) && on(x, y + 1)) continue;
            const start = [x, y];
            let px = x, py = y, prevDir = 6;
            const pts = [];
            let guard = 0;
            do {
                pts.push([px, py]);
                visited[py * width + px] = 1;
                let found = false;
                for (let k = 1; k <= 8; k++) {
                    const d = (prevDir + k) % 8;
                    const nx = px + dirs[d][0], ny = py + dirs[d][1];
                    if (on(nx, ny)) { px = nx; py = ny; prevDir = d; found = true; break; }
                }
                if (!found) break;
            } while ((px !== start[0] || py !== start[1]) && guard++ < width * height * 2);
            const poly = simplify > 0 ? rdp(pts, simplify) : pts;
            if (poly.length < 3) continue;
            const area = polyArea(poly);
            if (Math.abs(area) < minArea) continue;
            out.push({
                points: poly,
                area: Math.abs(area),
                perimeter: polyLength(poly),
                boundingRect: polyBBox(poly),
                convexHull: convexHull(poly),
                minAreaRect: minAreaRect(poly),
                circularity: (4 * Math.PI * Math.abs(area)) / Math.max(1, polyLength(poly) ** 2),
            });
        }
    }
    out.sort((a, b) => b.area - a.area);
    return out;
}

export function polyArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        a += x1 * y2 - x2 * y1;
    }
    return a / 2;
}

export function polyLength(pts) {
    let l = 0;
    for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        l += Math.hypot(x2 - x1, y2 - y1);
    }
    return l;
}

export function polyBBox(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0 + 1), height: Math.round(y1 - y0 + 1) };
}

export function convexHull(pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const pt of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop(); lower.push(pt); }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) { const pt = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop(); upper.push(pt); }
    lower.pop(); upper.pop();
    return lower.concat(upper);
}

// 旋转最小外接矩：凸包 + 卡尺（边对）
export function minAreaRect(pts) {
    const hull = pts.length > 3 ? convexHull(pts) : pts;
    let best = null;
    for (let i = 0; i < hull.length; i++) {
        const [x1, y1] = hull[i], [x2, y2] = hull[(i + 1) % hull.length];
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        let minP = Infinity, maxP = -Infinity, minQ = Infinity, maxQ = -Infinity;
        for (const [px, py] of hull) {
            const p = px * ux + py * uy;
            const q = -px * uy + py * ux;
            if (p < minP) minP = p; if (p > maxP) maxP = p;
            if (q < minQ) minQ = q; if (q > maxQ) maxQ = q;
        }
        const area = (maxP - minP) * (maxQ - minQ);
        if (!best || area < best.area) {
            best = {
                area,
                width: maxP - minP,
                height: maxQ - minQ,
                angle: Math.atan2(uy, ux) * 180 / Math.PI,
                corners: [
                    [minP * ux - minQ * uy, minP * uy + minQ * ux],
                    [maxP * ux - minQ * uy, maxP * uy + minQ * ux],
                    [maxP * ux - maxQ * uy, maxP * uy + maxQ * ux],
                    [minP * ux - maxQ * uy, minP * uy + maxQ * ux],
                ].map((c) => [Math.round(c[0] * 10) / 10, Math.round(c[1] * 10) / 10]),
            };
        }
    }
    if (!best) return null;
    return { width: Math.round(best.width), height: Math.round(best.height), angle: Math.round(best.angle * 10) / 10, area: Math.round(best.area), corners: best.corners };
}

export function rdp(pts, eps) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length);
    keep[0] = 1; keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        if (b <= a + 1) continue;
        const [ax, ay] = pts[a], [bx, by] = pts[b];
        const dx = bx - ax, dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        let maxD = -1, idx = -1;
        for (let i = a + 1; i < b; i++) {
            const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
            if (d > maxD) { maxD = d; idx = i; }
        }
        if (maxD > eps && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    return pts.filter((_, i) => keep[i]);
}

export function harrisCorners(src, { blockSize = 3, k = 0.04, thresholdRatio = 0.01, maxCorners = 200, nonMaxRadius = 6 } = {}) {
    const g = toGray(src, 'luma709');
    const gx = [], gy = [];
    const { width, height, data } = g;
    const at = (x, y) => data[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
    const Ix = new Float32Array(width * height), Iy = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            Ix[i] = (at(x + 1, y - 1) - at(x - 1, y - 1) + 2 * (at(x + 1, y) - at(x - 1, y)) + at(x + 1, y + 1) - at(x - 1, y + 1)) / 8;
            Iy[i] = (at(x - 1, y + 1) - at(x - 1, y - 1) + 2 * (at(x, y + 1) - at(x, y - 1)) + at(x + 1, y + 1) - at(x + 1, y - 1)) / 8;
        }
    }
    const r = Math.max(1, toInt(blockSize, 3));
    const R = new Float32Array(width * height);
    let maxR = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sxx = 0, syy = 0, sxy = 0;
            for (let j = -r; j <= r; j++) {
                for (let i = -r; i <= r; i++) {
                    const p = clamp(y + j, 0, height - 1) * width + clamp(x + i, 0, width - 1);
                    sxx += Ix[p] * Ix[p]; syy += Iy[p] * Iy[p]; sxy += Ix[p] * Iy[p];
                }
            }
            const det = sxx * syy - sxy * sxy;
            const tr = sxx + syy;
            R[y * width + x] = det - toNum(k, 0.04) * tr * tr;
            if (R[y * width + x] > maxR) maxR = R[y * width + x];
        }
    }
    const thr = maxR * toNum(thresholdRatio, 0.01);
    const cand = [];
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            if (R[i] < thr) continue;
            let isMax = true;
            for (let j = -1; j <= 1 && isMax; j++) {
                for (let k2 = -1; k2 <= 1; k2++) {
                    if (!k2 && !j) continue;
                    if (R[i + j * width + k2] > R[i]) { isMax = false; break; }
                }
            }
            if (isMax) cand.push({ x, y, score: R[i] });
        }
    }
    cand.sort((a, b) => b.score - a.score);
    const kept = [];
    const rad = toInt(nonMaxRadius, 6);
    for (const c of cand) {
        if (kept.every((o) => Math.hypot(o.x - c.x, o.y - c.y) > rad)) kept.push(c);
        if (kept.length >= toInt(maxCorners, 200)) break;
    }
    return kept;
}

// HSV 范围分割：用于按颜色抠图/统计（支持色相跨越 0 度）
export function inRange(src, { hueMin = 0, hueMax = 60, satMin = 0.3, satMax = 1, valMin = 0.2, valMax = 1, invert = false } = {}) {
    const d = src.data;
    const mask = new Uint8ClampedArray(src.width * src.height);
    let hueWrap = toNum(hueMin, 0) > toNum(hueMax, 60);
    const hx = (h) => {
        if (!hueWrap) return h >= hueMin / 360 && h <= hueMax / 360;
        return h >= hueMin / 360 || h <= hueMax / 360;
    };
    for (let i = 0, j = 0; j < mask.length; i += 4, j++) {
        const [h, s, v] = rgbToHsv(d[i], d[i + 1], d[i + 2]);
        const hit = hx(h) && s >= satMin && s <= satMax && v >= valMin && v <= valMax;
        mask[j] = (hit !== invert) ? 255 : 0;
    }
    return mkPx(src.width, src.height, (() => {
        const o = new Uint8ClampedArray(mask.length * 4);
        for (let i = 0; i < mask.length; i++) { o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = o[i * 4 + 3] = mask[i]; }
        return o;
    })());
}

// 归一化互相关模板匹配：小步长 + 降采样保护耗时
export function templateMatch(src, tmpl, { method = 'sncc', stride = 1, maxCandidates = 5, threshold = 0.6 } = {}) {
    const cap = 2_000_000;
    let a = src, b = tmpl;
    const totalOps = (src.width - tmpl.width) * (src.height - tmpl.height) * tmpl.width * tmpl.height;
    if (totalOps > cap) {
        const s = Math.sqrt(cap / Math.max(1, totalOps));
        a = resize(src, Math.round(src.width * s), Math.round(src.height * s), 'area');
        b = resize(tmpl, Math.max(2, Math.round(tmpl.width * s)), Math.max(2, Math.round(tmpl.height * s)), 'area');
    }
    const ga = toGray(a, 'average'), gb = toGray(b, 'average');
    const W = ga.width, H = ga.height, tw = gb.width, th = gb.height;
    if (tw > W || th > H) return { candidates: [], scale: s_report(a, src), method };
    let meanB = 0;
    for (const v of gb.data) meanB += v;
    meanB /= gb.data.length;
    let varB = 0;
    for (const v of gb.data) varB += (v - meanB) ** 2;
    const normB = Math.sqrt(varB) || 1;
    const out = [];
    for (let y = 0; y <= H - th; y += Math.max(1, toInt(stride, 1))) {
        for (let x = 0; x <= W - tw; x += Math.max(1, toInt(stride, 1))) {
            let m = 0;
            for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) m += ga.data[(y + j) * W + x + i];
            m /= tw * th;
            let num = 0, varA = 0;
            for (let j = 0; j < th; j++) {
                for (let i = 0; i < tw; i++) {
                    const da = ga.data[(y + j) * W + x + i] - m;
                    const db = gb.data[j * tw + i] - meanB;
                    num += da * db; varA += da * da;
                }
            }
            // 标准 NCC：num / sqrt(varA * varB)，两项都是同一窗口内的离差平方和
            const score = num / (Math.sqrt(varA) * normB + 1e-6);
            if (score >= toNum(threshold, 0.6)) out.push({ x: Math.round(x / s_scale(a, src)), y: Math.round(y / s_scale(a, src)), w: Math.round(tw / s_scale(a, src)), h: Math.round(th / s_scale(a, src)), score: Number(score.toFixed(4)) });
        }
    }
    out.sort((p, q) => q.score - p.score);
    const kept = [];
    for (const c of out) {
        if (kept.every((o) => !(c.x < o.x + o.w * 0.5 && c.x + c.w * 0.5 > o.x && c.y < o.y + o.h * 0.5 && c.y + c.h * 0.5 > o.y))) kept.push(c);
        if (kept.length >= toInt(maxCandidates, 5)) break;
    }
    return { candidates: kept, scale: s_scale(a, src), method };
}
function s_scale(a, src) { return a.width / src.width || 1; }
function s_report(a, src) { return a.width / src.width || 1; }

// 霍夫直线（概率式提前分箱，避免超大 rho 数组）
export function houghLines(edgeSrc, { threshold = 90, thetaSteps = 180, minLength = 0, maxLines = 10 } = {}) {
    const g = toGray(edgeSrc, 'average');
    const { width, height, data } = g;
    const maxRho = Math.ceil(Math.hypot(width, height));
    const thetas = new Float32Array(thetaSteps);
    const sinT = new Float32Array(thetaSteps), cosT = new Float32Array(thetaSteps);
    for (let t = 0; t < thetaSteps; t++) {
        thetas[t] = (t / thetaSteps) * Math.PI;
        sinT[t] = Math.sin(thetas[t]); cosT[t] = Math.cos(thetas[t]);
    }
    const acc = new Int32Array((maxRho * 2 + 1) * thetaSteps);
    const pts = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[y * width + x] > 127) pts.push([x, y]);
    for (const [x, y] of pts) {
        for (let t = 0; t < thetaSteps; t++) {
            const rho = Math.round(x * cosT[t] + y * sinT[t]) + maxRho;
            if (rho >= 0 && rho <= maxRho * 2) acc[rho * thetaSteps + t]++;
        }
    }
    const thr = toInt(threshold, 90);
    const peaks = [];
    for (let rho = 0; rho <= maxRho * 2; rho++) {
        for (let t = 0; t < thetaSteps; t++) {
            const v = acc[rho * thetaSteps + t];
            if (v < thr) continue;
            if (v >= (acc[(rho - 1) * thetaSteps + t] || 0) && v > (acc[(rho + 1) * thetaSteps + t] || 0)
                && v >= (acc[rho * thetaSteps + (t - 1)] || 0) && v > (acc[rho * thetaSteps + (t + 1)] || 0)) {
                peaks.push({ rho: rho - maxRho, theta: thetas[t], votes: v });
            }
        }
    }
    peaks.sort((a, b) => b.votes - a.votes);
    const lines = [];
    for (const p of peaks) {
        if (lines.length >= toInt(maxLines, 10)) break;
        if (lines.some((o) => Math.abs(o.rho - p.rho) < 8 && Math.abs(o.theta - p.theta) < 0.1)) continue;
        const a2 = Math.cos(p.theta), b2 = Math.sin(p.theta);
        const x0 = a2 * p.rho, y0 = b2 * p.rho;
        let x1 = x0 + -b2 * maxRho, y1 = y0 + a2 * maxRho;
        let x2 = x0 - -b2 * maxRho, y2 = y0 - a2 * maxRho;
        const clipped = clipSegment(x1, y1, x2, y2, width, height);
        if (!clipped) continue;
        const len = Math.hypot(clipped[2] - clipped[0], clipped[3] - clipped[1]);
        if (len < minLength) continue;
        lines.push({ x1: clipped[0], y1: clipped[1], x2: clipped[2], y2: clipped[3], rho: p.rho, theta: p.theta, length: len, votes: p.votes });
    }
    return lines;
}

function clipSegment(x1, y1, x2, y2, w, h) {
    let t0 = 0, t1 = 1;
    const dx = x2 - x1, dy = y2 - y1;
    const p = [-dx, dx, -dy, dy];
    const q = [x1, w - x1, y1, h - y1];
    for (let i = 0; i < 4; i++) {
        if (p[i] === 0) { if (q[i] < 0) return null; continue; }
        const r = q[i] / p[i];
        if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
        else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

export function aHash(src, size = 8) {
    const s = resize(src, size, size, 'box');
    const g = toGray(s, 'average');
    let bits = '', avg = 0;
    for (const v of g.data) avg += v;
    avg /= g.data.length;
    for (const v of g.data) bits += v >= avg ? '1' : '0';
    return bitsToHex(bits);
}

export function dHash(src, size = 9) {
    const s = resize(src, size, size - 1, 'box');
    const g = toGray(s, 'average');
    let bits = '';
    for (let y = 0; y < g.height; y++) {
        for (let x = 0; x < g.width - 1; x++) {
            bits += g.data[y * g.width + x] < g.data[y * g.width + x + 1] ? '1' : '0';
        }
    }
    return bitsToHex(bits);
}

export function pHash(src, size = 32) {
    const s = resize(src, size, size, 'area');
    const g = toGray(s, 'average');
    const m = dctLowFreq(g, 8);
    let sum = 0;
    for (const v of m) sum += v;
    const avg = sum / m.length;
    let bits = '';
    for (const v of m) bits += v > avg ? '1' : '0';
    return bitsToHex(bits);
}

// 只取 8x8 低频：直接按 DCT-II 基逐点投影，避免整图 FFT
function dctLowFreq(g, keep) {
    const out = new Float32Array(keep * keep);
    const N = g.width;
    for (let v = 0; v < keep; v++) {
        for (let u = 0; u < keep; u++) {
            let acc = 0;
            for (let y = 0; y < keep; y++) {
                for (let x = 0; x < keep; x++) {
                    acc += g.data[y * N + x] * Math.cos((2 * x + 1) * u * Math.PI / (2 * keep))
                        * Math.cos((2 * y + 1) * v * Math.PI / (2 * keep));
                }
            }
            out[v * keep + u] = acc;
        }
    }
    return out;
}

function bitsToHex(bits) {
    let hex = '';
    for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4) || '0', 2).toString(16);
    return hex;
}

export function hamming(a, b) {
    const s = String(a || ''), t = String(b || '');
    let d = 0;
    const n = Math.max(s.length, t.length);
    for (let i = 0; i < n; i++) {
        const x = parseInt(s[i] || '0', 16), y = parseInt(t[i] || '0', 16);
        let v = (x ^ y) & 0xf;
        while (v) { d += v & 1; v >>= 1; }
    }
    return d;
}

export function mse(a, b) {
    const g1 = toGray(resize(a, Math.min(a.width, 512), Math.round(Math.min(a.width, 512) * b.height / b.width), 'area'), 'average');
    const g2 = toGray(resize(b, g1.width, g1.height, 'area'), 'average');
    let s = 0;
    for (let i = 0; i < g1.data.length; i++) { const d = g1.data[i] - g2.data[i]; s += d * d; }
    return { mse: s / g1.data.length, rmse: Math.sqrt(s / g1.data.length) };
}

export function psnr(a, b) {
    const { mse: m } = mse(a, b);
    return { mse: m, psnr: m > 0 ? 10 * Math.log10((255 * 255) / m) : Infinity };
}

// 11x11 高斯窗 SSIM（亮度/对比度/结构三项），降采样到 512 内保时间
export function ssim(a, b) {
    const w = Math.min(512, Math.min(a.width, b.width));
    const h = Math.round(w * Math.min(a.height, b.height) / Math.min(a.width, b.width));
    const g1 = toGray(resize(a, w, h, 'area'), 'average');
    const g2 = toGray(resize(b, w, h, 'area'), 'average');
    const R = 5;
    const k1 = 0.01, k2 = 0.03, L = 255;
    const c1 = (k1 * L) ** 2, c2 = (k2 * L) ** 2;
    let total = 0, n = 0;
    const at = (g, x, y) => g.data[clamp(y, 0, g.height - 1) * g.width + clamp(x, 0, g.width - 1)];
    for (let y = R; y < g1.height - R; y += 2) {
        for (let x = R; x < g1.width - R; x += 2) {
            let m1 = 0, m2 = 0;
            for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) { m1 += at(g1, x + i, y + j); m2 += at(g2, x + i, y + j); }
            const cnt = (2 * R + 1) ** 2;
            m1 /= cnt; m2 /= cnt;
            let v1 = 0, v2 = 0, cv = 0;
            for (let j = -R; j <= R; j++) {
                for (let i = -R; i <= R; i++) {
                    const d1 = at(g1, x + i, y + j) - m1, d2 = at(g2, x + i, y + j) - m2;
                    v1 += d1 * d1; v2 += d2 * d2; cv += d1 * d2;
                }
            }
            v1 /= cnt - 1; v2 /= cnt - 1; cv /= cnt - 1;
            const s1 = Math.sqrt(v1), s2 = Math.sqrt(v2);
            const score = ((2 * m1 * m2 + c1) * (2 * cv + c2)) / ((m1 * m1 + m2 * m2 + c1) * (v1 + v2 + c2));
            total += score; n++;
        }
    }
    return { ssim: n ? total / n : 1, size: { width: w, height: h } };
}

// 帧间差（视频去重/运动检测）
export function temporalDiff(a, b, { threshold = 18, scale = 256 } = {}) {
    const w = Math.min(scale, a.width);
    const h = Math.round(w * a.height / a.width);
    const g1 = toGray(resize(a, w, h, 'area'), 'average');
    const g2 = toGray(resize(b, w, h, 'area'), 'average');
    let changed = 0, sum = 0;
    for (let i = 0; i < g1.data.length; i++) {
        const d = Math.abs(g1.data[i] - g2.data[i]);
        sum += d;
        if (d > threshold) changed++;
    }
    return { changeRatio: changed / g1.data.length, meanDiff: sum / g1.data.length };
}

export function maskToAlpha(src, mask, { color = null, invert = false, opacity = 100 } = {}) {
    const out = clonePx(src);
    const mw = mask.width, mh = mask.height;
    const sx = src.width / mw, sy = src.height / mh;
    for (let i = 0; i < out.data.length; i += 4) {
        const px = (i / 4) % src.width, py = Math.floor((i / 4) / src.width);
        const mx = clamp(Math.floor(px / sx), 0, mw - 1), my = clamp(Math.floor(py / sy), 0, mh - 1);
        const p = (my * mw + mx) * 4;
        let v = mask.data[p];
        if (invert) v = 255 - v;
        out.data[i + 3] = Math.round(out.data[i + 3] * (v / 255) * (opacity / 100));
        if (color) { out.data[i] = color[0]; out.data[i + 1] = color[1]; out.data[i + 2] = color[2]; }
    }
    return out;
}
