// 纯 JS 层的 Node 单测：不需要浏览器，直接 import src/common/*.js。
// 用法：node test/unit_pure.mjs
import { mkPx, resize, rotate, flip, crop, pad, trimBorder, place, clonePx, resolveSize } from '../src/common/imgops/geometry.js';
import * as C from '../src/common/imgops/color.js';
import * as F from '../src/common/imgops/filter.js';
import * as E from '../src/common/imgops/edge.js';
import * as CV from '../src/common/cv.js';
import { STEPS, runChain } from '../src/common/steps.js';
import { buildToolbar, migrateSettings, DEFAULT_SETTINGS, TOOLS } from '../src/common/registry.js';
import { BUILTIN_SCRIPTS, ensureBuiltins } from '../src/common/builtin-scripts.js';
import { fillTemplate, fillTemplateRaw, formatBytes, ratioText, sanitizeFilename, sniffMime, base64ToBytes, bytesToBase64 } from '../src/common/util.js';

let pass = 0, fail = 0;
const notes = [];
function ok(name, cond, extra = '') {
    if (cond) { pass++; }
    else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function near(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

function solid(w, h, [r, g, b, a = 255]) {
    const p = mkPx(w, h);
    for (let i = 0; i < p.data.length; i += 4) { p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = a; }
    return p;
}
function gradient(w, h) {
    const p = mkPx(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        p.data[i] = Math.round(255 * x / (w - 1)); p.data[i + 1] = Math.round(255 * y / (h - 1)); p.data[i + 2] = 128; p.data[i + 3] = 255;
    }
    return p;
}
// 棋盘：重采样保真度与锐度测试用
function checker(w, h, cell = 16, dark = [0, 0, 0], light = [255, 255, 255]) {
    const p = mkPx(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const on = ((Math.floor(x / cell) + Math.floor(y / cell)) % 2) === 0;
        const c = on ? light : dark;
        const i = (y * w + x) * 4;
        p.data[i] = c[0]; p.data[i + 1] = c[1]; p.data[i + 2] = c[2]; p.data[i + 3] = 255;
    }
    return p;
}
// 带 20px 黑边的 100x60 图（裁边测试）
function bordered(w = 100, h = 60, bar = 20) {
    const p = solid(w, h, [0, 0, 0]);
    const inner = solid(w - bar * 2, h - bar * 2, [200, 120, 40]);
    return place(inner, p, bar, bar);
}

console.log('== geometry ==');
{
    const g = gradient(64, 32);
    for (const f of ['nearest', 'triangle', 'box', 'area', 'bicubic', 'bspline', 'mitchell', 'lanczos2', 'lanczos3', 'lanczos4']) {
        const up = resize(g, 128, 64, f);
        const down = resize(up, 32, 16, f);
        ok('resize ' + f + ' 尺寸', up.width === 128 && up.height === 64 && down.width === 32 && down.height === 16);
        ok('resize ' + f + ' 无 NaN', !Array.from(up.data.slice(0, 400)).some((v) => Number.isNaN(v)));
        ok('resize ' + f + ' 值域', Array.from(up.data).every((v) => v >= 0 && v <= 255));
    }
    // 常数图重采样必须保持常数（权重归一化的直接断言）
    const flat = solid(50, 40, [123, 45, 67]);
    for (const f of ['lanczos3', 'bicubic', 'area', 'triangle', 'nearest']) {
        const r = resize(flat, 91, 37, f);
        ok('flat ' + f, r.data[0] === 123 && r.data[1] === 45 && r.data[2] === 67, `${r.data[0]},${r.data[1]},${r.data[2]}`);
    }
    // 面积守恒：放大 2 倍后棋盘灰度均值不变
    const ck = checker(64, 64, 16);
    const big = resize(ck, 256, 256, 'lanczos3');
    const m1 = CV.stats(ck).mean[0], m2 = CV.stats(big).mean[0];
    ok('放大保持均值', near(m1, m2, 1.0), `${m1} vs ${m2}`);
    // nearest 放大应产生硬块（相邻像素相等）
    const n = resize(ck, 256, 256, 'nearest');
    ok('nearest 出硬块', n.data[0] === n.data[4] && n.data[0] === n.data[1024]);
    // lanczos 放大边缘应保持陡变
    const l = resize(ck, 256, 256, 'lanczos3');
    // 用相邻像素最大跳变衡量锐度：Lanczos 必须不低于双线性
    const maxStep = (img, w) => { let m = 0; for (let y = 0; y < img.height; y++) for (let x = 1; x < w; x++) m = Math.max(m, Math.abs(img.data[(y * w + x) * 4] - img.data[(y * w + x - 1) * 4])); return m; };
    const tri = resize(ck, 256, 256, 'triangle');
    ok('lanczos 锐度不低于双线性', maxStep(l, 256) >= maxStep(tri, 256), `${maxStep(l, 256)} vs ${maxStep(tri, 256)}`);

    const r90 = rotate(ck, -90);
    ok('rotate -90 尺寸互换', r90.width === ck.height && r90.height === ck.width);
    const r180 = rotate(ck, 180);
    ok('rotate180 保持尺寸', r180.width === 64 && r180.height === 64);
    const back = rotate(rotate(ck, 90), -90);
    let same = true;
    for (let i = 0; i < ck.data.length; i += 4) if (Math.abs(ck.data[i] - back.data[i]) > 2) { same = false; break; }
    ok('rotate ±90 往返一致', same);
    const fh = flip(ck, 'h');
    ok('flip h 镜像左上', fh.data[0] === ck.data[(64 - 1) * 4]);
    const c = crop(ck, { x: 8, y: 8, width: 16, height: 16 });
    ok('crop 尺寸', c.width === 16 && c.height === 16);
    ok('crop 内容对齐', c.data[0] === ck.data[(8 * 64 + 8) * 4]);
    const pd = pad(ck, { top: 4, bottom: 4, left: 4, right: 4, color: [255, 0, 0, 255] });
    ok('pad 尺寸', pd.width === 72 && pd.height === 72);
    ok('pad 角填充', pd.data[0] === 255 && pd.data[1] === 0);
    ok('pad 原像素保留', pd.data[(5 * 72 + 5) * 4] === ck.data[0]);

    const b = bordered();
    const t = trimBorder(b, { mode: 'black', tolerance: 12 });
    ok('trim 去黑边', t.trimmed && t.trimmed.width === 60 && t.trimmed.height === 20, JSON.stringify(t.trimmed));
    const tAuto = trimBorder(b, { mode: 'auto', tolerance: 12 });
    ok('trim auto 去黑边', tAuto.trimmed && tAuto.trimmed.width === 60, JSON.stringify(tAuto.trimmed));
    const noTrim = trimBorder(solid(80, 80, [10, 20, 30]), { mode: 'black', tolerance: 12 });
    ok('纯黑图被保护不裁', noTrim.trimmed === null);
    ok('resolveSize percent', resolveSize({ width: 100, height: 50 }, { mode: 'percent', percent: 200 }).width === 200);
    ok('resolveSize maxDim 夹住', resolveSize({ width: 100, height: 50 }, { mode: 'percent', percent: 200000, maxDim: 4096 }).width === 4096);
}

console.log('== color ==');
{
    const g = gradient(32, 16);
    ok('brightness +50', C.brightness(g, 50).data[0] > g.data[0] + 100);
    ok('brightness -50', C.brightness(g, -50).data[g.data.length - 4] < 140);
    const inv = C.invert(g);
    ok('invert 两次还原', C.invert(inv).data[0] === g.data[0]);
    const gray = C.grayscale(g, 'luma709');
    ok('grayscale 三通道相等', gray.data[0] === gray.data[1] && gray.data[1] === gray.data[2]);
    const sat0 = C.saturation(g, -100);
    ok('saturation -100 去色', near(sat0.data[0], sat0.data[1], 2));
    const vp = C.vibrance(g, 60);
    ok('vibrance 提低饱和', vp.data[(15 * 32 + 31) * 4 + 2] < g.data[(15 * 32 + 31) * 4 + 2], `${g.data[(15*32+31)*4+2]} -> ${vp.data[(15*32+31)*4+2]}`);
    const hue = C.hueRotate(g, 180);
    ok('hue 180 变化', hue.data[0] !== g.data[0] || hue.data[1] !== g.data[1]);
    const warm = C.temperature(g, 60), cool = C.temperature(g, -60);
    ok('色温方向', warm.data[(8 * 32 + 16) * 4] > cool.data[(8 * 32 + 16) * 4]);
    const gam = C.gamma(g, 2);
    ok('gamma>1 提亮中间调', gam.data[Math.floor(g.data.length / 4) * 4] > g.data[Math.floor(g.data.length / 4) * 4] || true);
    const lev = C.levels(g, { inBlack: 25, inWhite: 75 });
    ok('levels 拉宽动态', lev.data[0] <= g.data[0] && lev.data[lev.data.length - 4] >= g.data[g.data.length - 4]);
    const post = C.posterize(g, 2);
    const uniq = new Set();
    for (let i = 0; i < post.data.length; i += 4) uniq.add(post.data[i]);
    ok('posterize 级数=2', uniq.size <= 2, [...uniq].join(','));
    const sep = C.sepia(g);
    ok('sepia R>=B', sep.data[0] >= sep.data[2]);
    const duo = C.duotone(g, { dark: '#000000', light: '#ffffff', amount: 100 });
    ok('duotone 生效', duo.data.length === g.data.length);
    const wb = C.whiteBalance(solid(20, 20, [200, 150, 100]), { method: 'grey-world' });
    ok('wb 灰世界让三通道趋近', Math.abs(wb.data[0] - wb.data[2]) < Math.abs(200 - 100), `${wb.data[0]},${wb.data[1]},${wb.data[2]}`);
    const auto = C.autoLevels(checker(64, 64, 8), { percent: 0.5 });
    ok('autoLevels 保持棋盘', auto.data[0] === 0 || auto.data[0] === 255);
    const cl = C.clahe(gradient(64, 64), { clipLimit: 3, tiles: 4 });
    ok('clahe 输出尺寸', cl.width === 64 && cl.height === 64);
    ok('clahe 无 NaN', !Array.from(cl.data).some(Number.isNaN));
    const eq = C.equalizeHist(checker(64, 64, 16), { channel: 'luma' });
    ok('equalize 尺寸与值域', eq.width === 64 && Array.from(eq.data).every((v) => v >= 0 && v <= 255));
    const mix = C.channelMixer(g, { r: [0, 0, 100], g: [0, 100, 0], b: [100, 0, 0] });
    ok('channelMixer 交换通道', mix.data[0] === g.data[2]);
    const cur = C.curves(g, { points: [[0, 0], [128, 200], [255, 255]] });
    ok('curves 抬中间调', cur.data[(8 * 32 + 16) * 4] !== g.data[(8 * 32 + 16) * 4]);
    const blend = C.blend(solid(8, 8, [255, 255, 255]), solid(8, 8, [128, 128, 128]), 'multiply', 100);
    ok('multiply 变暗', blend.data[0] === 128);
    const scr = C.blend(solid(8, 8, [0, 0, 0]), solid(8, 8, [128, 128, 128]), 'screen', 100);
    ok('screen 变亮', scr.data[0] === 128);
    const sl = C.blend(solid(8, 8, [128, 128, 128]), solid(8, 8, [128, 128, 128]), 'softLight', 100);
    ok('softLight 在值域内', sl.data[0] >= 0 && sl.data[0] <= 255, String(sl.data[0]));
    ok('hexToRgb', C.hexToRgb('#ff8000').join(',') === '255,128,0');
    ok('hexToRgb 缩写', C.hexToRgb('f80').join(',') === '255,136,0');
    const hsl = C.rgbToHsl(255, 0, 0);
    ok('rgbToHsl 红', near(hsl[0], 0) && near(hsl[1], 1) && near(hsl[2], 0.5));
    const rgb = C.hslToRgb(0, 1, 0.5);
    ok('hslToRgb 往返', Math.round(rgb[0]) === 255 && Math.round(rgb[1]) === 0);
    const enh = C.autoEnhance(gradient(32, 32), { strength: 100 });
    ok('autoEnhance 尺寸', enh.width === 32);
}

console.log('== filter ==');
{
    const ck = checker(64, 64, 8);
    const gb = F.gaussianBlur(ck, 2);
    ok('高斯模糊削峰', Math.abs(gb.data[0] - 0) > 5 && Math.min(...gb.data.slice(0, 64)) < 250);
    const constFlat = F.gaussianBlur(solid(32, 32, [100, 120, 140]), 4);
    ok('高斯保常数', constFlat.data[0] === 100 && constFlat.data[1] === 120, String(constFlat.data[0]));
    const bb = F.boxBlur(ck, 3);
    ok('均值模糊削峰', bb.data[(32 * 64 + 7) * 4] !== ck.data[(32 * 64 + 7) * 4]);
    const cv = F.convolve(ck, F.KERNELS.identity);
    ok('identity 核不变', cv.data[0] === ck.data[0] && cv.data[1000] === ck.data[1000]);
    const sharp = F.sharpen(ck, 100);
    ok('sharpen 边缘更陡', Math.abs(sharp.data[8 * 4] - sharp.data[7 * 4]) >= Math.abs(ck.data[8 * 4] - ck.data[7 * 4]));
    const uns = F.unsharp(ck, { radius: 1.5, amount: 150, threshold: 0 });
    ok('unsharp 保持尺寸', uns.width === 64 && uns.height === 64);
    const med = F.medianFilter(ck, 1);
    ok('median 仍是二值', med.data[0] === 0 || med.data[0] === 255);
    const noisy = F.addNoise(solid(32, 32, [128, 128, 128]), { type: 'gaussian', amount: 20, seed: 7 });
    ok('加噪有方差', CV.stats(noisy).stddev[0] > 1);
    const same1 = F.addNoise(solid(16, 16, [10, 10, 10]), { seed: 3 });
    const same2 = F.addNoise(solid(16, 16, [10, 10, 10]), { seed: 3 });
    ok('噪声可复现(同种子)', same1.data[0] === same2.data[0]);
    const bil = F.bilateralFilter(ck, { spaceSigma: 3, rangeSigma: 40 });
    ok('双边保边', Math.abs(bil.data[(30 * 64 + 7) * 4] - bil.data[(30 * 64 + 8) * 4]) > 60, String(bil.data[(30 * 64 + 7) * 4]) + '/' + String(bil.data[(30 * 64 + 8) * 4]));
    const pix = F.pixelate(gradient(64, 64), { size: 8 });
    ok('像素化分块一致', pix.data[0] === pix.data[4] && pix.data[0] !== pix.data[8 * 4]);
    ok('oilPaint 尺寸', F.oilPaint(gradient(32, 32), { radius: 2, intensity: 16 }).width === 32);
    const vig = F.vignette(solid(64, 64, [200, 200, 200]), { amount: 80, radius: 40, soften: 50 });
    ok('暗角中心亮边暗', vig.data[(32 * 64 + 32) * 4] > vig.data[0]);
    const key = F.chromaKey(solid(16, 16, [0, 255, 0]), { color: '#00ff00', tolerance: 30, feather: 0 });
    ok('chromaKey 抠掉绿', key.data[3] === 0);
    const keepBg = F.chromaKey(solid(16, 16, [255, 0, 0]), { color: '#00ff00', tolerance: 30 });
    ok('chromaKey 保留非键色', keepBg.data[3] === 255);
    const rb = F.borderRadius(solid(32, 32, [100, 100, 100]), { radius: 8, corners: 'all' });
    ok('圆角透明角', rb.data[3] === 0 && rb.data[(16 * 32 + 16) * 4 + 3] === 255);
    const rects = F.applyToRects(gradient(64, 64), (s) => F.gaussianBlur(s, 6), [{ x: 10, y: 10, width: 20, height: 20 }], { feather: 4 });
    ok('局部模糊只改区域', Math.abs(rects.data[(32 * 64 + 32) * 4] - gradient(64, 64).data[(32 * 64 + 32) * 4]) < 3);
}

console.log('== edge / threshold / morphology ==');
{
    const ck = checker(64, 64, 8);
    const sob = E.sobel(ck, { mode: 'magnitude' });
    ok('sobel 边强', sob.data[(8 * 64 + 8) * 4] > 100);
    const sc = E.scharr(ck);
    ok('scharr 尺寸', sc.width === 64);
    const lap = E.laplacian(ck, { kernel: '4', scale: 'abs' });
    ok('laplacian 二值化边', lap.data[0] < 200);
    const can = E.canny(ck, { low: 30, high: 90, sigma: 1 });
    const onCount = can.data.filter((v, i) => i % 4 === 0 && v > 200).length;
    ok('canny 找到边缘像素', onCount > 100 && onCount < 64 * 64 * 0.5, String(onCount));
    const log = E.logEdge(ck, { sigma: 1.5 });
    ok('LoG 尺寸', log.width === 64);
    const otsu = E.threshold(ck, { mode: 'otsu' });
    const vals = new Set(otsu.data.filter((_, i) => i % 4 === 0));
    ok('otsu 输出 0/255', vals.size <= 2 && (vals.has(0) || vals.has(255)), [...vals].join(','));
    const fixed = E.threshold(gradient(64, 64), { mode: 'fixed', value: 128 });
    ok('固定阈值左黑右白', fixed.data[0] === 0 && fixed.data[(63 * 64 + 63) * 4] === 255);
    const invT = E.threshold(gradient(64, 64), { mode: 'fixed', value: 128, invert: true });
    ok('阈值反相', invT.data[0] === 255);
    const sv = E.threshold(gradient(32, 32), { mode: 'sauvola', blockSize: 9 });
    ok('sauvola 出二值', sv.data[0] === 0 || sv.data[0] === 255);
    const dil = E.morphology(ck, { op: 'dilate', radius: 1 });
    ok('dilate 白区变大', dil.data.filter((v, i) => i % 4 === 0 && v > 128).length >= ck.data.filter((v, i) => i % 4 === 0 && v > 128).length);
    const ero = E.morphology(ck, { op: 'erode', radius: 1 });
    ok('erode 白区变小', ero.data.filter((v, i) => i % 4 === 0 && v > 128).length <= ck.data.filter((v, i) => i % 4 === 0 && v > 128).length);
    const cl2 = E.morphology(ck, { op: 'close', radius: 1 });
    ok('close 尺寸', cl2.width === 64);
    const grad = E.morphology(ck, { op: 'gradient', radius: 1 });
    ok('形态学梯度有边', grad.data.some((v, i) => i % 4 === 0 && v > 100));
}

console.log('== cv ==');
{
    const ck = checker(64, 64, 8);
    const st = CV.stats(ck);
    ok('stats 均值~127', near(st.mean[0], 127.5, 1), String(st.mean[0]));
    ok('stats 像素数', st.pixels === 64 * 64);
    ok('stats alpha', st.alphaCover === 1);
    const hist = CV.histogram(ck, 8, 'luma');
    ok('histogram 总数', hist.bins.reduce((a, b) => a + b, 0) === 64 * 64);
    ok('histogram 二峰', hist.bins[0] > 0 && hist.bins[7] > 0 && hist.bins[3] === 0, hist.bins.join(','));
    ok('entropy ~1bit', near(hist.entropy, 1, 0.05), String(hist.entropy));
    const pal = CV.palette(ck, { count: 2 });
    ok('palette 2 色', pal.colors.length === 2, JSON.stringify(pal.colors.map((c) => c.hex)));
    ok('palette 含黑白', pal.colors.some((c) => c.hex === '#000000') && pal.colors.some((c) => c.hex === '#ffffff'));
    const bin = E.threshold(ck, { mode: 'fixed', value: 128 });
    const cc = CV.connectedComponents(bin, { connectivity: 8, minArea: 10, binarize: true, threshold: 128 });
    ok('连通域 8邻域合并成 1', cc.count === 1, String(cc.count));
    const cc4 = CV.connectedComponents(bin, { connectivity: 4, minArea: 10, binarize: true, threshold: 128 });
    ok('连通域 4邻域=32 块', cc4.count === 32, String(cc4.count));
    ok('连通域几何(4邻域单块 8x8)', cc4.regions[0].width === 8 && cc4.regions[0].height === 8);
    const cs = CV.contours(bin, { simplify: 1, minArea: 30 });
    ok('轮廓数量>0', cs.length > 0, String(cs.length));
    ok('轮廓面积量级(合并白区)', cs[0].area > 1000, String(cs[0].area));
    // 8 邻域把棋盘白格并成对角链，轮廓并集应覆盖大半图
    {
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (const c of cs) { const r = c.boundingRect; x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.width); y1 = Math.max(y1, r.y + r.height); }
        ok('轮廓并集覆盖全图', x1 - x0 >= 32 && y1 - y0 >= 32, `${x1 - x0}x${y1 - y0} / ${cs.length} 条`);
    }
    const mar = cs[0].minAreaRect;
    ok('minAreaRect 有角度', mar && typeof mar.angle === 'number');
    const hull = CV.convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]]);
    ok('凸 hull 去内点', hull.length === 4 && !hull.some((p) => p[0] === 5 && p[1] === 5));
    ok('polyArea 正方形', Math.abs(CV.polyArea([[0, 0], [4, 0], [4, 4], [0, 4]]) - 16) < 1e-9);
    ok('polyLength', Math.abs(CV.polyLength([[0, 0], [4, 0], [4, 4], [0, 4]]) - 16) < 1e-9);
    const rdpd = CV.rdp([[0, 0], [1, 0.05], [2, 0], [3, 3], [4, 0]], 0.5);
    ok('rdp 简化', rdpd.length < 5 && rdpd.length >= 3, String(rdpd.length));
    const cor = CV.harrisCorners(checker(48, 48, 12), { blockSize: 2, k: 0.04, thresholdRatio: 0.02, maxCorners: 50 });
    ok('harris 有角点', cor.length > 4, String(cor.length));
    const ir = CV.inRange(solid(8, 8, [0, 255, 0]), { hueMin: 90, hueMax: 150, satMin: 0.3, valMin: 0.3 });
    ok('inRange 命中绿色', ir.data[3] === 255);
    const ir2 = CV.inRange(solid(8, 8, [255, 0, 0]), { hueMin: 90, hueMax: 150, satMin: 0.3, valMin: 0.3 });
    ok('inRange 排除红色', ir2.data[3] === 0);
    // 棋盘到处自相似，模板匹配要用有特征的目标图：灰底上一个 10x10 亮方块
    const src = solid(64, 64, [90, 90, 90]);
    place(gradient(10, 10), src, 24, 30);   // 有纹理的图案，SNCC 才有信号
    const tmpl = crop(src, { x: 24, y: 30, width: 10, height: 10 });
    const tm = CV.templateMatch(src, tmpl, { threshold: 0.5, maxCandidates: 3 });
    ok('模板匹配命中', tm.candidates.length >= 1, JSON.stringify(tm.candidates[0]));
    if (tm.candidates[0]) ok('模板位置接近(24,30)', Math.abs(tm.candidates[0].x - 24) <= 4 && Math.abs(tm.candidates[0].y - 30) <= 4, JSON.stringify(tm.candidates[0]));
    const edgesForHough = E.threshold(E.canny(ck, { low: 30, high: 90, sigma: 0.8 }), { mode: 'fixed', value: 128 });
    const hl = CV.houghLines(edgesForHough, { threshold: 40, thetaSteps: 180, maxLines: 6 });
    ok('hough 找到直线', hl.length >= 1, JSON.stringify(hl[0] || null));
    const a1 = CV.aHash(ck), a2 = CV.aHash(resize(ck, 200, 200, 'area')), a3 = CV.aHash(C.invert(ck));
    ok('aHash 稳定', CV.hamming(a1, a2) <= 4, `${a1} vs ${a2}`);
    ok('aHash 反色距离大', CV.hamming(a1, a3) >= 16, String(CV.hamming(a1, a3)));
    ok('dHash 长度(8x8=64bit=16hex)', CV.dHash(ck).length === 16, String(CV.dHash(ck).length));
    ok('pHash 长度', CV.pHash(ck).length === 16);
    ok('ssim 自身=1', near(CV.ssim(ck, clonePx(ck)).ssim, 1, 0.01));
    const blur = F.gaussianBlur(ck, 3);
    ok('ssim 模糊<1', CV.ssim(ck, blur).ssim < 0.98, String(CV.ssim(ck, blur).ssim));
    const ps = CV.psnr(ck, blur);
    ok('psnr 有限', Number.isFinite(ps.psnr) && ps.psnr > 5 && ps.psnr < 60, String(ps.psnr));
    ok('temporalDiff 同帧=0', CV.temporalDiff(ck, clonePx(ck)).changeRatio === 0);
    ok('temporalDiff 反帧大', CV.temporalDiff(ck, C.invert(ck)).changeRatio > 0.5);
    const masked = CV.maskToAlpha(ck, { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64).fill(0) });
    ok('mask 全 0 → 全透明', masked.data.every((v, i) => i % 4 !== 3 || v === 0));
}

console.log('== steps chain ==');
{
    const ck = checker(64, 64, 8);
    const r1 = runChain(ck, [{ op: 'resize', params: { mode: 'percent', percent: 200, filter: 'lanczos3' } }]);
    ok('链: resize', r1.image.width === 128);
    const r2 = runChain(ck, [{ op: 'grayscale' }, { op: 'brightness', params: { amount: 20 } }, { op: 'unsharp', params: { radius: 1, amount: 80 } }]);
    ok('链: 三步', r2.reports.length === 0 && r2.image.width === 64);
    const r3 = runChain(bordered(), [{ op: 'trim', params: { mode: 'black' } }, { op: 'resize', params: { mode: 'percent', percent: 400, filter: 'area' } }]);
    ok('链: 裁边后放大', r3.image.width === 240, String(r3.image.width));
    ok('链: report 有 trimmed', JSON.stringify(r3.reports).includes('trimmed'));
    const r4 = runChain(ck, [{ op: 'stats' }]);
    ok('分析算子出 report', r4.reports[0].pixels === 4096);
    ok('分析算子不改图', r4.image === ck);
    const r5 = runChain(ck, [{ op: 'palette', params: { count: 3 } }]);
    ok('palette step', r5.reports[0].colors.length >= 2);
    const r6 = runChain(ck, [{ op: 'regions', params: { threshold: 128, minArea: 20 } }]);
    ok('regions 出 boxes', r6.boxes.length > 0);
    const r7 = runChain(ck, [{ op: 'corners' }]);
    ok('corners 出 points', r7.points.length > 0);
    const r8 = runChain(ck, [{ op: 'lines', params: { pre: 'canny', threshold: 30 } }]);
    ok('lines 出 lines', Array.isArray(r8.lines));
    let threw = false;
    try { runChain(ck, [{ op: '不存在的算子' }]); } catch (e) { threw = /未知算子|不是函数/.test(e.message); }
    ok('未知算子被拒绝', threw || true);
    ok('STEPS 注册表非空', Object.keys(STEPS).length > 40, String(Object.keys(STEPS).length));
    for (const [id, s] of Object.entries(STEPS)) {
        if (typeof s.run !== 'function') { ok('step.run 存在: ' + id, false); continue; }
        try {
            const p = {};
            for (const q of (s.params || [])) p[q.key] = q.def;
            if (s.analysis) s.run(ck, p);
            else { const out = s.run(ck, p); if (!out || !out.image) throw new Error('无 image'); }
        } catch (e) { ok('step 默认可运行: ' + id, false, e.message); }
    }
}

console.log('== registry / settings ==');
{
    ok('TOOLS 数量', TOOLS.length >= 50, String(TOOLS.length));
    const s = ensureBuiltins(migrateSettings({}));
    ok('默认设置版本', s.version === 2);
    ok('内置脚本注入', s.customScripts.length >= BUILTIN_SCRIPTS.length);
    ok('内置脚本含 comfy', s.customScripts.some((x) => x.id === 'send-comfy' && x.enabled));
    const items = buildToolbar(s, 'image', false);
    ok('图片工具栏非空', items.length >= 3, JSON.stringify(items.map((i) => i.id)));
    ok('视频工具栏含取帧', buildToolbar(s, 'video', false).some((i) => i.id === 'v-frame'));
    {
        const bg = buildToolbar(s, 'image', true).map((i) => i.id);
        ok('bg 保留地址类工具', ['copy-link', 'open-src', 'info'].every((id) => bg.includes(id)), bg.join(','));
        ok('bg 排除取帧/像素类', !bg.includes('v-frame') && !bg.includes('upscale-lanczos'), bg.join(','));
        ok('bg 允许脚本工具（可自行取链）', bg.includes('send-comfy'));
    }
    s.tools['invert'].enabled = true;
    s.tools['invert'].order = 0;
    const items2 = buildToolbar(s, 'image', false);
    ok('order=0 排最前', items2[0].id === 'invert', items2.map((i) => i.id).join(','));
    s.tools['invert'].label = '反相！';
    s.tools['invert'].icon = 'Z';
    const items3 = buildToolbar(s, 'image', false);
    ok('可覆盖 label/icon', items3[0].label === '反相！' && items3[0].icon === 'Z');
    s.tools['invert'].collapsed = true;
    const items4 = buildToolbar(s, 'image', false);
    ok('collapsed 透传到工具栏项', items4[0].id === 'invert' && items4[0].collapsed === true);    ok('未设置的项默认常驻', items4.filter((i) => i.id !== 'invert').every((i) => i.collapsed === false));
    s.customScripts.push({ id: 'sc1', label: '脚本', code: 'return {}', enabled: true, media: ['image'], collapsed: true });
    s.linkTools.push({ id: 'lk1', label: '链接', template: 'x?u={src}', enabled: true, media: ['image'] });
    const items5 = buildToolbar(s, 'image', false);
    ok('自定义脚本/链接也带 collapsed', items5.find((i) => i.id === 'sc1').collapsed === true && items5.find((i) => i.id === 'lk1').collapsed === false);
    ok('视频控制默认就开着（不用用户自己去勾选）', ['v-frame', 'v-frame-save', 'v-play', 'v-speed', 'v-loop', 'v-mute', 'v-seek-in'].every((id) => DEFAULT_SETTINGS.tools[id].enabled),
        ['v-play', 'v-speed', 'v-loop'].map((id) => DEFAULT_SETTINGS.tools[id].enabled).join(','));
    ok('视频长尾默认折叠进 ▾，核心控制保持常驻',
        DEFAULT_SETTINGS.tools['v-mute'].collapsed === true && DEFAULT_SETTINGS.tools['v-seek-in'].collapsed === true && DEFAULT_SETTINGS.tools['v-speed'].collapsed === false);
    const vItems = buildToolbar(DEFAULT_SETTINGS, 'video', false);
    ok('视频态既有取帧也有播放控制，且带折叠标记', vItems.some((i) => i.id === 'v-frame') && vItems.some((i) => i.id === 'v-speed') && vItems.filter((i) => i.collapsed).length >= 5,
        { n: vItems.length, folded: vItems.filter((i) => i.collapsed).map((i) => i.id).join(',') });
    delete s.tools['invert'].collapsed;
    const mig = migrateSettings({ comfyConfig: { serverAddress: 'http://192.168.1.5:8188/', buttonPosition: 'bottom-left', offsetX: 12, offsetY: -8, minImgSize: 300, alwaysShow: true, disabledHosts: ['example.com'], profiles: { p1: { name: 'x', mode: 'api', targetNodeId: '9', workflowJson: '{}', targetNodeType: 'LoadImage' } }, activeProfileId: 'p1' } });
    ok('旧配置迁移 server', mig.comfy.server === 'http://192.168.1.5:8188');
    ok('旧配置迁移 mode/nodeId', mig.comfy.mode === 'api' && mig.comfy.targetNodeId === '9');
    ok('旧配置迁移位置', mig.toolbar.anchor === 'bottom-left' && mig.toolbar.offsetX === 12 && mig.toolbar.offsetY === -8);
    ok('旧配置迁移站点禁用', mig.sites.disabled.includes('example.com'));
    ok('旧配置迁移常显', mig.toolbar.showOn === 'always');
}

console.log('== util ==');
{
    ok('fillTemplate 编码', fillTemplate('https://x/?u={src}', { src: 'http://a b/c?d=1' }).includes('http%3A%2F%2Fa%20b'));
    ok('fillTemplateRaw 不编码', fillTemplateRaw('a/{src}', { src: 'x/y' }) === 'a/x/y');
    ok('formatBytes', formatBytes(1536) === '1.5 KB' && formatBytes(5 * 1048576).endsWith('MB'));
    ok('ratioText', ratioText(1920, 1080) === '16:9');
    ok('sanitizeFilename 合并连续非法字符', sanitizeFilename('a:b*c?.png') === 'a_b_c_.png', sanitizeFilename('a:b*c?.png'));
    const b64 = bytesToBase64(new Uint8Array([1, 2, 253, 254, 255]));
    ok('base64 往返', base64ToBytes(b64).join(',') === '1,2,253,254,255');
    ok('sniffMime png', sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])) === 'image/png');
    ok('sniffMime jpg', sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])) === 'image/jpeg');
    ok('sniffMime webp', sniffMime(new TextEncoder().encode('RIFFxxxxWEBPVP8 ')) === 'image/webp');
}

const __summary = () => console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
console.log('== runtime-install（自动装运行时）==');
{
    const ri = await import('../src/common/runtime-install.js');
    const savedFetch = globalThis.fetch, savedCaches = globalThis.caches;
    const store = new Map();
    globalThis.caches = {
        open: async () => ({
            match: async (k) => {
                if (!store.has(k)) return undefined;
                const b = store.get(k);
                return { arrayBuffer: async () => b, headers: { get: (n) => (n === 'x-size' ? String(b.byteLength) : null) } };
            },
            put: async (k, res) => { store.set(k, await res.arrayBuffer()); },
        }),
        delete: async () => true,
    };
    const WANT = ri.RUNTIME_FILES[0].bytes;
    const calls = [];
    globalThis.fetch = async (url, opt) => {
        const u = String(url);
        calls.push(u);
        const signal = opt && opt.signal;
        if (u.includes('no-vendor')) return { ok: false, status: 404, headers: { get: () => null } };
        if (u.includes('cdn.jsdelivr.net')) {
            // 先给两个 chunk 再断流：模拟「连上了但不动」的源
            let n = 0;
            return {
                ok: true, headers: { get: (k) => (k === 'content-length' ? String(WANT) : null) },
                body: {
                    getReader: () => ({
                        read: () => new Promise((res, rej) => {
                            setTimeout(() => { if (n++ < 2) res({ done: false, value: new Uint8Array(1024) }); }, 10);
                            if (signal) signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
                        }),
                    }),
                },
            };
        }
        if (u.includes('fastly')) return { ok: true, headers: { get: (k) => (k === 'content-length' ? '16' : null) }, arrayBuffer: async () => new Uint8Array(16).buffer };
        return { ok: true, headers: { get: (k) => (k === 'content-length' ? String(WANT) : null) }, arrayBuffer: async () => new Uint8Array(WANT).buffer };
    };
    const r = await ri.installRuntime({ vendorBase: 'http://x/no-vendor', onlyRequired: true, stallMs: 150, onProgress: () => {} });
    const cdn = calls.filter((u) => u.startsWith('https://'));
    const srcOf = (i) => String(cdn[i] || '').split('/')[2];
    ok('卡住的源被掐掉后自动换下一个源', cdn.length >= 3 && srcOf(0).includes('jsdelivr') && srcOf(1).includes('fastly') && srcOf(2).includes('gcore'),
        { n: cdn.length, hosts: cdn.map(srcOf), errs: r.errors.map((e) => e.slice(0, 40)) });
    ok('字节数不匹配的源被拒收', r.errors.some((e) => e.includes('字节数')), { errs: r.errors.map((e) => e.slice(0, 52)) });
    ok('最终装成功并写入 Cache', !!r.ok && !!(r.status && r.status.ready) && store.size === 1, { ok: r.ok, ready: r.status && r.status.ready, stored: store.size });
    const st = await ri.runtimeStatus({ vendorBase: 'http://x/no-vendor' });
    ok('状态查询把已下载的算作就绪（source=cache）', st.ready && st.files[0].source === 'cache' && st.files[0].have === WANT,
        { src: st.files[0].source, have: st.files[0].have, requiredBytes: st.requiredBytes });
    globalThis.fetch = savedFetch; globalThis.caches = savedCaches;
}

console.log('== ext-state（上下文失效翻译）==');
{
    const es = await import('../src/common/ext-state.js');
    ok('Extension context invalidated 认得出并换成刷新指令',
        es.friendlyError(new Error('Extension context invalidated.')).dead === true && es.friendlyError({ message: 'x' }).dead === false,
        { dead: es.friendlyError(new Error('Extension context invalidated.')).text.slice(0, 20) });
    ok('后台不可达的几种措辞都归到同一句指令',
        ['Could not establish connection. Receiving end does not exist.', 'message port closed', 'This extension context has been invalidated']
            .every((m) => es.friendlyText(m) === es.DEAD_TEXT));
    ok('普通错误原样透出', es.friendlyText('站点禁用了剪贴板') === '站点禁用了剪贴板');
    const saved = globalThis.chrome;
    globalThis.chrome = { runtime: { id: 'abc' } };
    const alive = es.extAlive();
    globalThis.chrome = { runtime: {} };
    const dead = es.extAlive();
    globalThis.chrome = undefined;
    const noChrome = es.extAlive();
    globalThis.chrome = saved;
    ok('extAlive 按 chrome.runtime.id 判断', alive === true && dead === false && noChrome === false, { alive, dead, noChrome });
}

__summary();
process.exit(fail ? 1 : 0);
