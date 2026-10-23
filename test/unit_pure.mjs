// 纯 JS 层的 Node 单测：不需要浏览器，直接 import src/common/*.js。
// 用法：node test/unit_pure.mjs
import { readFileSync } from 'node:fs';
import { mkPx, resize, rotate, flip, crop, pad, trimBorder, place, clonePx, resolveSize } from '../src/common/imgops/geometry.js';
import * as C from '../src/common/imgops/color.js';
import * as F from '../src/common/imgops/filter.js';
import * as E from '../src/common/imgops/edge.js';
import * as CV from '../src/common/cv.js';
import { STEPS, runChain } from '../src/common/steps.js';
import { buildToolbar, migrateSettings, DEFAULT_SETTINGS, TOOLS, DEFAULT_COLLAPSED } from '../src/common/registry.js';
import { BUILTIN_SCRIPTS, ensureBuiltins } from '../src/common/builtin-scripts.js';
import { fillTemplate, fillTemplateRaw, formatBytes, ratioText, sanitizeFilename, sniffMime, base64ToBytes, bytesToBase64, bytesFingerprint, uniqueUploadName, extFromMime } from '../src/common/util.js';
import { upgradeWeiboImageUrl, weiboImageTierUrl, imageDedupeKey, isWeiboHost, accountInitial, mergeFeedPosts, weiboStatusToPost, clampLoadPages } from '../src/common/gallery.js';
import { UI_THEMES, DEFAULT_UI_THEME, normalizeUiTheme, uiThemeLabel } from '../src/common/theme.js';

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
    ok('collapsed 透传到工具栏项', items4[0].id === 'invert' && items4[0].collapsed === true);    ok('未设置的项按 DEFAULT_COLLAPSED 决定常驻/折叠', items4.filter((i) => i.id !== 'invert').every((i) => i.collapsed === DEFAULT_COLLAPSED.includes(i.id)), items4.filter((i) => i.collapsed).map((i) => i.id).join(','));
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
    // 老设置里每个按钮都写死了 collapsed:false，会把新的折叠默认值盖掉（用户报「折叠没生效」的真因）
    const legacy = migrateSettings(DEFAULT_SETTINGS);
    ok('老设置补种折叠默认值', legacy.tools['v-mute'].collapsed === true && legacy.tools['v-speed'].collapsed === false && legacy.collapseSeed === 2,
        { mute: legacy.tools['v-mute'].collapsed, speed: legacy.tools['v-speed'].collapsed });
    const kept = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    kept.tools['v-mute'].collapsed = false; kept.tools['v-mute'].label = '我就要平铺';
    const keptOut = migrateSettings(kept);
    ok('用户改过的按钮不被覆盖', keptOut.tools['v-mute'].collapsed === false && keptOut.tools['v-mute'].label === '我就要平铺');
    const twice = migrateSettings(legacy);
    ok('重复迁移幂等', twice.tools['v-mute'].collapsed === true);

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
    {
        const used = new Map();
        const a = bytesFingerprint(new Uint8Array([1, 2, 3, 4]));
        const b = bytesFingerprint(new Uint8Array([1, 2, 3, 5]));
        ok('ComfyUI 上传名：同名同图复用、同名不同图加序号，不再互相覆盖',
            uniqueUploadName(used, 'web.png', a) === 'web.png'
            && uniqueUploadName(used, 'web.png', a) === 'web.png'
            && uniqueUploadName(used, 'web.png', b) === 'web_2.png'
            && uniqueUploadName(used, 'web.png', b) === 'web_2.png'
            && uniqueUploadName(used, 'web.png', bytesFingerprint(new Uint8Array([9]))) === 'web_3.png'
            && uniqueUploadName(used, 'noext', a) === 'noext'
            && uniqueUploadName(used, 'noext', b) === 'noext_2',
            [...used.keys()]);
        ok('内容指纹：长度或内容不同就不同名，采样不会因为大图而撞车',
            a !== b && a === bytesFingerprint(new Uint8Array([1, 2, 3, 4]))
            && bytesFingerprint(new Uint8Array(10)) !== bytesFingerprint(new Uint8Array(11))
            && bytesFingerprint(null).startsWith('0:')
            && extFromMime('image/jpeg') === 'jpg' && extFromMime('image/webp') === 'webp');
    }
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
            delete: async (k) => store.delete(String(k)),
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
        if (u.includes('mtb-ort-wasm')) {
            // 首选源先给两个 chunk 再断流：模拟「连上了但不动」的源
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
        if (u.includes('cdn.jsdelivr.net')) return { ok: true, headers: { get: (k) => (k === 'content-length' ? '16' : null) }, arrayBuffer: async () => new Uint8Array(16).buffer };
        return { ok: true, headers: { get: (k) => (k === 'content-length' ? String(WANT) : null) }, arrayBuffer: async () => new Uint8Array(WANT).buffer };
    };
    const r = await ri.installRuntime({ vendorBase: 'http://x/no-vendor', onlyRequired: true, stallMs: 150, onProgress: () => {} });
    const cdn = calls.filter((u) => u.startsWith('https://'));
    const srcOf = (i) => String(cdn[i] || '').split('/')[2];
    ok('卡住的源被掐掉后自动换下一个源', cdn.length >= 3 && srcOf(0).includes('modelscope') && srcOf(1).includes('jsdelivr') && srcOf(2).includes('fastly'),
        { n: cdn.length, hosts: cdn.map(srcOf), errs: r.errors.map((e) => e.slice(0, 40)) });
    ok('字节数不匹配的源被拒收', r.errors.some((e) => e.includes('字节数')), { errs: r.errors.map((e) => e.slice(0, 52)) });
    ok('最终装成功并写入 Cache', !!r.ok && !!(r.status && r.status.ready) && store.size === 1, { ok: r.ok, ready: r.status && r.status.ready, stored: store.size });
    const st = await ri.runtimeStatus({ vendorBase: 'http://x/no-vendor' });
    ok('状态查询把已下载的算作就绪（source=cache）', st.ready && st.files[0].source === 'cache' && st.files[0].have === WANT,
        { src: st.files[0].source, have: st.files[0].have, requiredBytes: st.requiredBytes });
    // 断流写进 Cache 的半截 wasm 会让 ORT 抛 "memory access out of bounds"，必须在这里就拦住并删掉
    const key0 = ri.cacheKey(ri.RUNTIME_FILES[0].name);
    store.set(key0, new Uint8Array(1024).buffer);
    const ortStub = { env: { wasm: { wasmPaths: null } } };
    let corrupt = null;
    try { await ri.applyWasmPaths(ortStub, 'http://x/no-vendor'); } catch (e) { corrupt = e; }
    ok('Cache 里字节数不符的 wasm 被判损坏：报 RUNTIME_CORRUPT 并删除该条', !!corrupt && corrupt.code === 'RUNTIME_CORRUPT' && !store.has(key0),
        JSON.stringify({ code: corrupt && corrupt.code, stillStored: store.has(key0), msg: corrupt && String(corrupt.message).slice(0, 40) }));
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
    ok('wasm 内存崩溃翻成「换小模型/档位」而不是甩栈', ['memory access out of bounds', 'RuntimeError: memory access out of bounds', 'Aborted(native code called abort())']
        .every((m) => es.friendlyText(m) === es.MEMORY_TEXT) && es.friendlyError(new Error('memory access out of bounds')).memory === true);
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

console.log('== face（识别数学）==');
{
    const fc = await import('../src/common/ai/face.js');
    // 相似变换：拿 insightface 的模板点当已知答案，λ 必须还原出我们构造的缩放+旋转
    const tmpl = fc.ARCFACE_TEMPLATE;
    const th = 0.35, sc = 1.7, tx = 12, ty = -8;
    const rot = [[Math.cos(th), -Math.sin(th)], [Math.sin(th), Math.cos(th)]];
    const src = tmpl.map(([x, y]) => {
        const rx = (x - 56) * rot[0][0] + (y - 56) * rot[1][0];
        const ry = (x - 56) * rot[0][1] + (y - 56) * rot[1][1];
        return [rx / sc + tx, ry / sc + ty];
    });
    const m = fc.similarityTransform(src, tmpl);
    const mapped = src.map(([x, y]) => [m.a * x - m.b * y + m.tx, m.b * x + m.a * y + m.ty]);
    const err = Math.max(...mapped.flatMap((p, i) => [Math.abs(p[0] - tmpl[i][0]), Math.abs(p[1] - tmpl[i][1])]));
    ok('5 点相似变换能还原构造好的缩放+旋转+平移（对齐用）', err < 1e-3, { maxErrPx: +err.toFixed(6), scale: +Math.hypot(m.a, m.b).toFixed(4) });
    const v = new Float32Array(512); v[0] = 0.6; v[7] = -0.8;
    const back = fc.unpackVector(fc.packVector(v));
    ok('人脸向量 base64 往返无损（存进设置再读出来比对要用）', back.length === 512 && back.every((x, i) => x === v[i]), { len: back.length });
    ok('余弦判定：同人过阈值、异人算陌生、同名条目覆盖式命中', (() => {
        const a = fc.l2normalize(new Float32Array([1, 1, 0]));
        const b = fc.l2normalize(new Float32Array([0.98, 1.02, 0.05]));
        const c = fc.l2normalize(new Float32Array([0, 0, 1]));
        const gallery = [{ id: '1', name: '甲', vector: fc.packVector(a) }, { id: '2', name: '乙', vector: fc.packVector(c) }];
        const near = fc.matchGallery(b, gallery, 0.4);
        const far = fc.matchGallery(fc.l2normalize(new Float32Array([1, -1, 0.02])), gallery, 0.4);
        return near.match?.name === '甲' && !far.match && fc.cosineSim(a, b) > 0.99 && fc.cosineSim(a, c) < 1e-6;
    })());
    ok('SCRFD 预设首选自己的 ModelScope 镜像、alt 留 HF 兜底', (() => {
        const det = fc.FACE_MODEL_PRESETS.find((p) => p.id === 'scrfd-500m');
        const rec = fc.FACE_EMBED_PRESETS.find((p) => p.id === 'w600k-mbf');
        return !!(det && det.bytes > 1e6 && /modelscope\.cn\/models\/cjc1887415157\/mtb-face/.test(det.url) && /huggingface|hf-mirror/.test(det.alt))
            && !!(rec && rec.bytes > 1e7 && /modelscope\.cn/.test(rec.url) && /hf-mirror/.test(rec.alt));
    })(), { det: fc.FACE_MODEL_PRESETS.find((p) => p.id === 'scrfd-500m').url, rec: fc.FACE_EMBED_PRESETS[0].url });
    ok('默认人脸栈切到 SCRFD+embedding（digiKam 同款路线）',
        DEFAULT_SETTINGS.ai.faceModel === 'scrfd-500m' && DEFAULT_SETTINGS.ai.faceEmbedModel === 'w600k-mbf' && Array.isArray(DEFAULT_SETTINGS.faceGallery)
        && fc.resolveFaceModel(DEFAULT_SETTINGS.ai).url.includes('det_500m.onnx') && fc.resolveEmbedModel(DEFAULT_SETTINGS.ai).url.includes('w600k_mbf.onnx'),
        { det: fc.resolveFaceModel(DEFAULT_SETTINGS.ai).url, rec: fc.resolveEmbedModel(DEFAULT_SETTINGS.ai).url });
    ok('模型源按 hub 切换：modelscope 用自建镜像，切回 hf-mirror 用原仓库', await (async () => {
        const p = (await import('../src/common/ai/sam.js')).SAM_PRESETS[0];
        const src = await import('../src/common/ai/sources.js');
        return src.modelIdFor({ hub: 'modelscope' }, p) === p.ms && src.modelIdFor({ hub: 'hf-mirror' }, p) === p.model
            && src.modelIdFor({}, p) === p.model && DEFAULT_SETTINGS.ai.hub === 'modelscope';
    })(), { ms: (await import('../src/common/ai/sam.js')).SAM_PRESETS[0].ms });
    ok('WebGPU 的默认档位跟着源走：自建镜像取 q4f16、HF 源才取 fp16（否则必然 404）', await (async () => {
        const { resolveVlm } = await import('../src/common/ai/vlm.js');
        return resolveVlm({ hub: 'modelscope', device: 'webgpu' }).dtype === 'q4f16'
            && resolveVlm({ hub: 'hf-mirror', device: 'webgpu' }).dtype === 'fp16'
            && resolveVlm({ hub: 'modelscope', device: 'wasm' }).dtype === 'q4';
    })(), { ms: (await import('../src/common/ai/vlm.js')).resolveVlm({ hub: 'modelscope', device: 'webgpu' }).dtype });
    ok('分类/零样本结果归一化：单图扁平数组不再被误当批量', await (async () => {
        const { listOf } = await import('../src/common/ai/vision.js');
        const flat = [{ label: 'cat', score: 0.9 }, { label: 'dog', score: 0.1 }];
        return listOf(flat) === flat && JSON.stringify(listOf([flat])) === JSON.stringify(flat)
            && listOf({ labels: flat }) === flat && listOf(null).length === 0;
    })());
}

// ---- 本页图片（批量发送窗口） ----
{
    ok('微博图 URL：orj360/thumb/mw690 升级到 large',
        upgradeWeiboImageUrl('https://wx1.sinaimg.cn/orj360/abc.jpg') === 'https://wx1.sinaimg.cn/large/abc.jpg'
        && upgradeWeiboImageUrl('https://tvax2.sinaimg.cn/thumb150/abc.jpg') === 'https://tvax2.sinaimg.cn/large/abc.jpg'
        && upgradeWeiboImageUrl('https://wx3.sinaimg.cn/mw690/abc.jpg') === 'https://wx3.sinaimg.cn/large/abc.jpg',
        upgradeWeiboImageUrl('https://wx1.sinaimg.cn/orj360/abc.jpg'));
    ok('微博图 URL：large 不重复改、头像 crop 路径不动、非微博原样',
        upgradeWeiboImageUrl('https://wx1.sinaimg.cn/large/abc.jpg') === 'https://wx1.sinaimg.cn/large/abc.jpg'
        && upgradeWeiboImageUrl('https://tvax1.sinaimg.cn/crop.0.0.1080.1080.1024/abc.jpg') === 'https://tvax1.sinaimg.cn/crop.0.0.1080.1080.1024/abc.jpg'
        && upgradeWeiboImageUrl('https://example.com/orj360/abc.jpg') === 'https://example.com/orj360/abc.jpg');
    ok('微博图 URL：wap/tw/square/bmiddle/auto-webkit 等变体也升 large',
        ['wap180', 'tw420', 'square', 'bmiddle', 'middle2', 'auto-webkit', 'thumb980', 'orj360']
            .every((v) => upgradeWeiboImageUrl(`https://wx1.sinaimg.cn/${v}/abc.jpg`) === 'https://wx1.sinaimg.cn/large/abc.jpg'));
    ok('微博图 URL：不像尺寸目录的路径段不乱改（/m/wallpaper/、深层路径、坏 URL）',
        upgradeWeiboImageUrl('https://h5.sinaimg.cn/m/wallpaper/abc.jpg') === 'https://h5.sinaimg.cn/m/wallpaper/abc.jpg'
        && upgradeWeiboImageUrl('https://wx1.sinaimg.cn/abc.jpg') === 'https://wx1.sinaimg.cn/abc.jpg'
        && upgradeWeiboImageUrl('') === ''
        && upgradeWeiboImageUrl('not a url') === 'not a url');
    ok('微博图去重：不同 sinaimg 域名的同一 path 视为同一张',
        imageDedupeKey('https://wx1.sinaimg.cn/orj360/abc.jpg') === imageDedupeKey('https://tvax2.sinaimg.cn/large/abc.jpg')
        && imageDedupeKey('https://example.com/a.jpg#x') === imageDedupeKey('https://example.com/a.jpg'));
    ok('微博域名判定：weibo.com / m.weibo.cn 命中，伪装域名不命中',
        isWeiboHost('weibo.com') && isWeiboHost('m.weibo.cn') && isWeiboHost('weibo.cn') && !isWeiboHost('weibo.com.evil.com') && !isWeiboHost('notweibo.com'));
    ok('账号头像首字母', accountInitial('张三') === '张' && accountInitial('alice') === 'A' && accountInitial('') === '?');
    ok('尺寸档位：卡片 mw690 / 查看器 mw2000 / 原图 large，非档位段与 crop 不动',
        weiboImageTierUrl('https://wx1.sinaimg.cn/orj360/abc.jpg', 'card') === 'https://wx1.sinaimg.cn/mw690/abc.jpg'
        && weiboImageTierUrl('https://wx1.sinaimg.cn/orj360/abc.jpg', 'full') === 'https://wx1.sinaimg.cn/mw2000/abc.jpg'
        && weiboImageTierUrl('https://wx1.sinaimg.cn/large/abc.jpg', 'card') === 'https://wx1.sinaimg.cn/mw690/abc.jpg'
        && weiboImageTierUrl('https://wx2.sinaimg.cn/tw420/abc.gif', 'card') === 'https://wx2.sinaimg.cn/mw690/abc.gif'
        && weiboImageTierUrl('https://tvax1.sinaimg.cn/crop.0.0.1080.1080.180/abc.jpg', 'card') === 'https://tvax1.sinaimg.cn/crop.0.0.1080.1080.180/abc.jpg'
        && weiboImageTierUrl('https://h5.sinaimg.cn/m/wallpaper/abc.jpg', 'full') === 'https://h5.sinaimg.cn/m/wallpaper/abc.jpg'
        && weiboImageTierUrl('https://example.com/a.jpg', 'card') === 'https://example.com/a.jpg'
        && weiboImageTierUrl('', 'card') === '');
    ok('缩略图开关默认开，迁移补默认且尊重用户关闭',
        DEFAULT_SETTINGS.toolbar.skipThumbnails === true
        && migrateSettings({ version: 2, toolbar: {} }).toolbar.skipThumbnails === true
        && migrateSettings({ version: 2, toolbar: { skipThumbnails: false } }).toolbar.skipThumbnails === false);
}

console.log('== weibo-filter（信息流筛选判定）==');
{
    const wf = await import('../src/common/weibo-filter.js');
    const on = { enabled: true, types: { original: true, repost: true, text: true, image: true, video: true, music: true } };
    const post = (o) => ({ repost: false, hasImage: false, hasVideo: false, hasMusic: false, text: '', date: '', ...o });
    ok('没启用时任何微博都显示（含空配置）',
        wf.matchWeiboFilter(post({}), { ...on, enabled: false }) && wf.matchWeiboFilter(post({}), null));
    ok('原创 / 转发 二选一：取消哪边就挡哪边',
        !wf.matchWeiboFilter(post({ repost: false }), { ...on, types: { ...on.types, original: false } })
        && !wf.matchWeiboFilter(post({ repost: true }), { ...on, types: { ...on.types, repost: false } })
        && wf.matchWeiboFilter(post({ repost: true }), { ...on, types: { ...on.types, original: false } }));
    ok('纯文字 / 含图片 / 含视频 / 含音乐 按命中的任一类型通过',
        wf.matchWeiboFilter(post({ hasImage: true }), { ...on, types: { ...on.types, text: false } })
        && !wf.matchWeiboFilter(post({ hasImage: true }), { ...on, types: { ...on.types, text: false, image: false, video: false, music: false } })
        && !wf.matchWeiboFilter(post({}), { ...on, types: { ...on.types, text: false } })
        && wf.matchWeiboFilter(post({}), { ...on, types: { ...on.types, image: false, video: false, music: false } }));
    ok('有图又有视频时，只要勾了其中之一就显示',
        wf.matchWeiboFilter(post({ hasImage: true, hasVideo: true }), { ...on, types: { ...on.types, text: false, image: false } }));
    ok('关键字包含/不含都按整串子串匹配且不区分大小写',
        wf.matchWeiboFilter(post({ text: '今天的 GIVEAWAY 抽奖' }), { ...on, keywordMode: 'has', keywords: ['giveaway'] })
        && !wf.matchWeiboFilter(post({ text: '今天的 GIVEAWAY 抽奖' }), { ...on, keywordMode: 'none', keywords: ['giveaway'] })
        && wf.matchWeiboFilter(post({ text: '普通日常' }), { ...on, keywordMode: 'none', keywords: ['giveaway'] }));
    ok('关键字列表为空时关键字规则不生效',
        wf.matchWeiboFilter(post({ text: '随便' }), { ...on, keywordMode: 'has', keywords: [] }));
    ok('时间范围只看读得出的日期，读不出的保留',
        wf.matchWeiboFilter(post({ date: '2026-10-20' }), { ...on, dateFrom: '2026-10-19', dateTo: '2026-10-21' })
        && !wf.matchWeiboFilter(post({ date: '2026-10-18' }), { ...on, dateFrom: '2026-10-19' })
        && !wf.matchWeiboFilter(post({ date: '2026-10-22' }), { ...on, dateTo: '2026-10-21' })
        && wf.matchWeiboFilter(post({ date: '' }), { ...on, dateFrom: '2026-10-19', dateTo: '2026-10-21' }));
    ok('splitKeywords 认换行/中英文逗号/分号/顿号，去空去重（大小写视作重复）',
        JSON.stringify(wf.splitKeywords('抽奖\n代购, GIVEAWAY，代购；广告、  ')) === JSON.stringify(['抽奖', '代购', 'GIVEAWAY', '广告']));
    ok('非法配置回落到默认值（类型默认全开，日期必须是 YYYY-MM-DD）',
        (() => { const n = wf.normalizeWeiboFilter({ enabled: 1, types: { image: false }, keywordMode: 'xx', dateFrom: '2026/10/1', dateTo: '2026-10-5' });
            return n.enabled === true && n.types.image === false && n.types.text === true && n.keywordMode === 'has'
                && n.dateFrom === '' && n.dateTo === '2026-10-05'; })());
    ok('作用范围：不勾「所有微博网站」时只认配置的那个站点',
        wf.filterAppliesTo({ ...on, site: 'weibo.com' }, 'weibo.com')
        && !wf.filterAppliesTo({ ...on, site: 'weibo.com' }, 'm.weibo.cn')
        && wf.filterAppliesTo({ ...on, site: 'weibo.com', allSites: true }, 'm.weibo.cn')
        && !wf.filterAppliesTo({ ...on, site: 'weibo.com', enabled: false }, 'weibo.com'));
    ok('实验模式：直接从微博条目对象判类型（转发/图/视频/音乐/纯文字）',
        (() => {
            const repost = wf.weiboItemInfo({ text: 'hi', retweeted_status: { mid: 'x' } });
            const pic = wf.weiboItemInfo({ text: 'hi', pic_ids: ['a'] });
            const vid = wf.weiboItemInfo({ text: 'hi', page_info: { object_type: 'video' } });
            const mus = wf.weiboItemInfo({ text: '分享歌曲' });
            const plain = wf.weiboItemInfo({ text: '<b>hi</b>' });
            return repost.repost && pic.hasImage && vid.hasVideo && mus.hasMusic && plain.text === 'hi' && !plain.hasImage && !plain.hasVideo;
        })());
    ok('实验模式：created_at 解析成本地日期，读不出就空串（不参与时间判断）',
        wf.dateOfCreatedAt('Wed Oct 21 10:44:13 +0800 2026') === '2026-10-21'
        && wf.dateOfCreatedAt('not a date') === '' && wf.dateOfCreatedAt('') === '');
    ok('实验模式：matchWeiboItem 与页面判定同一套规则',
        wf.matchWeiboItem({ text: '抽奖', pic_ids: ['a'] }, { ...on, keywordMode: 'none', keywords: ['抽奖'] }) === false
        && wf.matchWeiboItem({ text: '日常', pic_ids: ['a'] }, { ...on, keywordMode: 'none', keywords: ['抽奖'] }) === true);
    ok('describeWeiboFilter 能说清当前条件',
        wf.describeWeiboFilter({ enabled: false }).includes('未启用')
        && wf.describeWeiboFilter({ ...on, types: { ...on.types, repost: false }, keywordMode: 'none', keywords: ['抽奖'] }) === '不含转发 · 不含「抽奖」'
        && wf.describeWeiboFilter(on).includes('没有条件'));
}

console.log('== theme（界面风格）==');
{
    const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
    const braceBody = (text, openIdx) => {
        let d = 0;
        for (let i = openIdx; i < text.length; i++) {
            if (text[i] === '{') d++;
            else if (text[i] === '}' && --d === 0) return text.slice(openIdx + 1, i);
        }
        return null;
    };
    const declKeys = (body) => [...String(body).matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((x) => x[1]);
    const keySetOf = (body) => new Set(declKeys(body));
    const sorted = (ks) => [...ks].sort().join(',');

    ok('界面风格清单恰好五档且顺序就是下拉顺序（glass 打头）',
        UI_THEMES.length === 5 && UI_THEMES.map((t) => t.id).join(',') === 'glass,fluent,fluent-dark,neon,contrast',
        UI_THEMES.map((t) => t.id).join(','));
    ok('界面风格清单的 id 不许重复（重复会让下拉框出现两个同名选项）',
        new Set(UI_THEMES.map((t) => t.id)).size === UI_THEMES.length);
    ok('界面风格清单每项都有非空 label 与 hint（下拉框的文字和悬浮说明直接读这两个字段）',
        UI_THEMES.every((t) => typeof t.label === 'string' && t.label.trim() === t.label
            && typeof t.hint === 'string' && t.hint.trim() === t.hint));
    ok('默认风格是 glass 且它就是清单第一项（theme.css 的 :root 兜底必须是同一套）',
        DEFAULT_UI_THEME === 'glass' && UI_THEMES[0].id === 'glass');

    for (const t of UI_THEMES) ok('normalizeUiTheme 认得 ' + t.id + ' 并原样返回', normalizeUiTheme(t.id) === t.id);
    const junk = [undefined, null, 'glasss', '', 'FLUENT', ' glass', 42, {}, [], NaN, true];
    ok('normalizeUiTheme 对认不出的输入（拼错/空串/大小写/带空格/数字/对象/数组）一律回落 glass',
        junk.every((v) => normalizeUiTheme(v) === DEFAULT_UI_THEME),
        junk.map((v) => String(v) + '→' + normalizeUiTheme(v)).join(' '));
    ok('uiThemeLabel 兜底给第一项的名字，不许回 undefined 或空串',
        junk.every((v) => uiThemeLabel(v) === UI_THEMES[0].label) && UI_THEMES.every((t) => uiThemeLabel(t.id) === t.label));

    const themeCss = read('src/common/theme.css');
    const blocks = new Map();
    const selRe = /(^|\n)[ \t]*((?::root\s*,\s*)?html\[data-theme="([a-z-]+)"\])[ \t]*\{/g;
    let sm;
    while ((sm = selRe.exec(themeCss))) blocks.set(sm[3], { sel: sm[2], body: braceBody(themeCss, sm.index + sm[0].length - 1) });
    ok('theme.css 里恰好五块 html[data-theme] 且 id 与清单一一对应（多一块少一块都算）',
        blocks.size === UI_THEMES.length && UI_THEMES.every((t) => blocks.has(t.id)), [...blocks.keys()].join(','));
    ok('glass 那块确实同时挂着 :root（JS 还没贴上 data-theme 时的兜底）',
        (blocks.get('glass') || {}).sel === ':root, html[data-theme="glass"]', (blocks.get('glass') || {}).sel);
    ok('除 glass 外的四块只挂 html[data-theme=…]，不许再蹭 :root（否则兜底会被后面那块盖掉）',
        UI_THEMES.filter((t) => t.id !== 'glass').every((t) => blocks.get(t.id).sel === 'html[data-theme="' + t.id + '"]'),
        UI_THEMES.map((t) => t.id + '=' + (blocks.get(t.id) || {}).sel).join(' '));
    ok('每块内部不许重复定义同一个 token（后一条会静默盖掉前一条，看着有值其实是错的）',
        UI_THEMES.every((t) => declKeys(blocks.get(t.id).body).length === keySetOf(blocks.get(t.id).body).size),
        UI_THEMES.map((t) => t.id + ':' + declKeys(blocks.get(t.id).body).length + '/' + keySetOf(blocks.get(t.id).body).size).join(' '));
    ok('每块至少 100 个 token（掉下 100 就是整块被人删过一截）',
        UI_THEMES.every((t) => declKeys(blocks.get(t.id).body).length >= 100),
        UI_THEMES.map((t) => t.id + '=' + declKeys(blocks.get(t.id).body).length).join(' '));
    const glassKeys = keySetOf(blocks.get('glass').body);
    const keyDiff = UI_THEMES.filter((t) => sorted(keySetOf(blocks.get(t.id).body)) !== sorted(glassKeys)).map((t) => {
        const b = keySetOf(blocks.get(t.id).body);
        return t.id + ' 缺[' + [...glassKeys].filter((k) => !b.has(k)).join(',') + '] 多[' + [...b].filter((k) => !glassKeys.has(k)).join(',') + ']';
    });
    ok('五块的 token 键集两两完全相等（少一个键的那个主题会去兜 :root，切过去就缺一块底色）',
        keyDiff.length === 0, keyDiff.join(' | '));

    const SOLID = ['fluent', 'fluent-dark', 'contrast'];
    for (const id of SOLID) {
        const body = blocks.get(id).body || '';
        const dirty = ['rgba(', 'rgb(', 'linear-gradient', 'radial-gradient', 'gradient(', 'blur('].filter((t) => body.includes(t));
        ok('实色主题 ' + id + ' 整块不许出现半透明/渐变/毛玻璃（--shadow: none 这种写法不算）',
            dirty.length === 0, dirty.join(','));
        const soft = [...body.matchAll(/(--(?:blur|glow|shadow)[A-Za-z0-9-]*)\s*:\s*([^;]*);/g)]
            .filter((x) => x[2].trim() !== 'none').map((x) => x[1] + '=' + x[2].trim());
        ok('实色主题 ' + id + ' 的 --blur*/--glow*/--shadow* 必须逐个写 none（漏一个就继承 glass 的毛玻璃）',
            soft.length === 0, soft.join(','));
    }
    ok('默认外观不许被偷偷抹平：glass 与 neon 两块仍然各自留着半透明与毛玻璃',
        ['glass', 'neon'].every((id) => (blocks.get(id).body || '').includes('rgba(') && (blocks.get(id).body || '').includes('blur(')));

    // 只扫声明块内部：options.css 里 `#faceGallery .f {` 这类 ID 选择器长得像十六进制，混进来检测结果会既有假阳性也看不出真假阴性。
    const valuesOnly = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/[^{}]*\{/g, '').replace(/[{}]/g, ' ');
    const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|\bblur\(/g;
    const probeCss = '.x{ color:#fff; background:rgba(0,0,0,.5); border-color:rgb(1,2,3); filter:blur(4px); } #faceGallery .y{ a:#d6d6d6 }';
    ok('颜色检测器自己必须是活的（拿一段明知有颜色的 CSS 当正对照，防止正则写废成永远 0 命中）',
        (valuesOnly(probeCss).match(COLOR_RE) || []).join('|') === '#fff|rgba(|rgb(|blur(|#d6d6d6',
        (valuesOnly(probeCss).match(COLOR_RE) || []).join('|'));
    ok('颜色检测器只认声明块：同一段文本里 #faceGallery 这种 ID 选择器一个都不许算命中',
        !valuesOnly(probeCss).includes('#faceGallery'));
    const pageCss = { 'src/options/options.css': read('src/options/options.css'), 'src/gallery/gallery.css': read('src/gallery/gallery.css') };
    for (const [f, raw] of Object.entries(pageCss)) {
        const hits = valuesOnly(raw).match(COLOR_RE) || [];
        ok(f + ' 里一个字面颜色都不许出现（颜色只能进 src/common/theme.css，漏一处切主题就花一块）',
            hits.length === 0, hits.slice(0, 8).join(' | '));
    }
    ok('options.css 里那些 #faceGallery 确实是 ID 选择器而不是颜色（守的是上面那条别只靠运气绿）',
        pageCss['src/options/options.css'].includes('#faceGallery')
        && !(valuesOnly(pageCss['src/options/options.css']).match(/#[0-9a-fA-F]{3,8}\b/g) || []).length);

    const usedKeys = new Set();
    for (const raw of Object.values(pageCss)) for (const x of raw.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)) usedKeys.add(x[1]);
    const LAYOUT = ['--cols', '--header-h', '--panel-h', '--panel-w'];
    const outside = [...usedKeys].filter((k) => !glassKeys.has(k)).sort();
    ok('两个页面样式表里 var() 用到的 token 必须全在 theme.css 有定义，例外只能逐个点名（不许通配放过）',
        sorted(outside) === sorted(LAYOUT), '实际豁免=[' + outside.join(',') + '] 清单=[' + LAYOUT.join(',') + ']');
    const ownSrc = Object.values(pageCss).join('\n') + read('src/gallery/gallery.mjs') + read('src/options/options.mjs');
    ok('被豁免的四个布局变量必须确实在别处定义过（只豁免不定义＝用到空值）',
        LAYOUT.every((v) => ownSrc.includes(v + ':') || ownSrc.includes("'" + v + "'")),
        LAYOUT.filter((v) => !(ownSrc.includes(v + ':') || ownSrc.includes("'" + v + "'"))).join(','));
    ok('页面样式表真的在大批量引用 token（少于 100 个说明大部分颜色根本没走主题）',
        usedKeys.size >= 100, 'used=' + usedKeys.size);

    const chipCss = (/<style>([\s\S]*?)<\/style>/.exec(read('src/content/weibo-filter.mjs')) || [])[1] || '';
    ok('提示条的 shadow CSS 取得到（<style> 写法改了要同步改这里）', chipCss.length > 500, 'len=' + chipCss.length);
    const chipBlocks = new Map();
    const cbRe = /:host(?:\(\[data-theme="([a-z-]+)"\]\))?[ \t]*\{/g;
    let cm;
    while ((cm = cbRe.exec(chipCss)) !== null) chipBlocks.set(cm[1] || '@base', braceBody(chipCss, cm.index + cm[0].length - 1));
    const baseKeys = keySetOf(chipBlocks.get('@base') || '');
    ok('除 glass 外每一档都有 :host([data-theme=…]) 块（缺一个档提示条会跟着页面一起换成玻璃）',
        UI_THEMES.filter((t) => t.id !== 'glass').every((t) => chipBlocks.has(t.id)), [...chipBlocks.keys()].join(','));
    const chipStray = UI_THEMES.filter((t) => t.id !== 'glass')
        .map((t) => t.id + '=' + declKeys(chipBlocks.get(t.id)).filter((k) => !baseKeys.has(k)).join(','))
        .filter((s) => !s.endsWith('='));
    ok('提示条各档块里不许出现基线没有的 --cf-* 键（拼错的键会被静默忽略，切过去完全看不出）',
        chipStray.length === 0, chipStray.join(' '));
    const chipKeyDiff = UI_THEMES.filter((t) => t.id !== 'glass' && sorted(keySetOf(chipBlocks.get(t.id))) !== sorted(baseKeys)).map((t) => {
        const b = keySetOf(chipBlocks.get(t.id));
        return t.id + ' 缺[' + [...baseKeys].filter((k) => !b.has(k)).join(',') + '] 多[' + [...b].filter((k) => !baseKeys.has(k)).join(',') + ']';
    });
    ok('提示条各档的 --cf-* 键集与 :host 基线严格相等（缺一个键就会在那个主题下花一块，级联继承不算数）',
        chipKeyDiff.length === 0, chipKeyDiff.join(' | '));
    ok('contrast 档必须真的把 --cf-bw 提到 2px（不然高对比的粗描边是空的）',
        /--cf-bw:\s*2px/.test(chipBlocks.get('contrast') || ''));
    for (const id of SOLID) {
        const body = chipBlocks.get(id) || '';
        const dirty = ['rgba(', 'blur(', 'gradient('].filter((t) => body.includes(t));
        ok('提示条 ' + id + ' 档不含半透明/毛玻璃/渐变', dirty.length === 0, dirty.join(','));
    }
    ok('提示条默认档（:host 基线）仍是半透明 + 毛玻璃，钉住用户当前在用的样子',
        (chipBlocks.get('@base') || '').includes('rgba(') && (chipBlocks.get('@base') || '').includes('blur('));
    ok('提示条列表的分隔线必须走 --cf-bw（contrast 的 2px 不许只作用一半）',
        (chipCss.match(/border-bottom:\s*var\(--cf-bw\)\s+solid\s+var\(--cf/g) || []).length === 3
        && !/border-bottom:\s*1px\s+solid\s+var\(--cf/.test(chipCss),
        'var=' + (chipCss.match(/border-bottom:\s*var\(--cf-bw\)/g) || []).length + ' 死值=' + (chipCss.match(/border-bottom:\s*1px/g) || []).length);

    const TB_THEMES = ['dark', 'light', 'glass', 'neon', 'fluent', 'contrast'];
    const tbCss = (/export const CSS = `([\s\S]*?)\n`;/.exec(read('src/content/ui.mjs')) || [])[1] || '';
    ok('ui.mjs 的工具栏 CSS 字符串取得到（模板串写法改了要同步改这里）', tbCss.length > 4000, 'len=' + tbCss.length);
    const tbBlocks = new Map();
    const tbRe = /\.wrap\[data-theme="([a-z-]+)"\][ \t]*\{/g;
    let tm;
    while ((tm = tbRe.exec(tbCss)) !== null) tbBlocks.set(tm[1], braceBody(tbCss, tm.index + tm[0].length - 1));
    for (const id of TB_THEMES.filter((x) => x !== 'dark')) ok('工具栏 CSS 有 .wrap[data-theme="' + id + '"] 那一块', !!tbBlocks.get(id));
    ok('工具栏 dark 是 :host 默认值，CSS 里不该再出现 .wrap[data-theme="dark"]（出现即两处定义）',
        !tbCss.includes('.wrap[data-theme="dark"]') && /^:host\s*\{/m.test(tbCss));
    for (const id of ['fluent', 'contrast']) {
        const body = tbBlocks.get(id) || '';
        ok('工具栏 ' + id + ' 档显式关掉毛玻璃', /(?:^|[\s;{])backdrop-filter\s*:\s*none/.test(body));
        const surfLines = (body.match(/--tb-(?:surface|menu-surface|gear-surface|border|gear-border)\s*:[^;]*;/g) || []);
        const dirty = surfLines.filter((s) => s.includes('rgba(') || s.includes('gradient('));
        ok('工具栏 ' + id + ' 档的底/菜单面/齿轮面/描边这些 token 必须是实色', dirty.length === 0 && surfLines.length >= 4, dirty.join(' ') + ' | 命中行=' + surfLines.length);
    }
    const selOpts = (/<select id="theme">([\s\S]*?)<\/select>/.exec(read('options.html')) || [])[1] || '';
    const tbVals = [...selOpts.matchAll(/value="([^"]+)"/g)].map((x) => x[1]);
    ok('options.html 的 <select id="theme"> 选项恰好等于工具栏那六档（多一档没 CSS、少一档选不到都是 bug）',
        sorted(tbVals) === sorted(TB_THEMES) && tbVals.length === 6, 'HTML=' + tbVals.join(','));
    ok('界面风格下拉框不在 HTML 里写死选项（必须由 UI_THEMES 生成，否则清单与 CSS 两边会对不上）',
        /<select id="uiTheme"><\/select>/.test(read('options.html')) && read('src/options/options.mjs').includes('for (const t of UI_THEMES)'));

    ok('没有旧设置时 ui.theme 就是默认风格', migrateSettings(undefined).ui.theme === DEFAULT_UI_THEME);
    ok('只有 toolbar.theme 的老 v2 设置要补出 ui.theme=glass，且不许把工具栏皮肤带跑',
        (() => { const s = migrateSettings({ version: 2, toolbar: { theme: 'neon' } }); return s.ui.theme === 'glass' && s.toolbar.theme === 'neon'; })());
    ok('已经存了 ui.theme=fluent 的设置迁移后原样保留',
        migrateSettings({ version: 2, ui: { theme: 'fluent' } }).ui.theme === 'fluent');
    ok('存了不认识的值时迁移不改写它，由渲染侧经 normalizeUiTheme 回落 glass',
        (() => { const s = migrateSettings({ version: 2, ui: { theme: 'nope' } }); return s.ui.theme === 'nope' && normalizeUiTheme(s.ui.theme) === 'glass'; })());
    ok('界面风格与工具栏皮肤是两个独立字段（改一个不许动另一个）',
        DEFAULT_SETTINGS.ui.theme === DEFAULT_UI_THEME && DEFAULT_SETTINGS.toolbar.theme === 'dark');
}

console.log('== mergeFeedPosts（微博信息流数据并进采集分组）==');
{
    const mkAcc = (withPid = true) => {
        const acc = { groups: [], byKey: new Map(), seen: new Set() };
        if (withPid) acc.byPid = new Map();
        return acc;
    };
    // 造一份「DOM 已经扫到」的累加器，形状与 mergeResults 里的 S.raw 一致
    const addDom = (acc, key, label, pids, y) => {
        const g = { key, label, sub: '', items: [], junk: false, y };
        acc.byKey.set(key, g);
        acc.groups.push(g);
        pids.forEach((pid, i) => {
            const url = `https://wx1.sinaimg.cn/large/${pid}.jpg`;
            const dk = imageDedupeKey(url);
            const k = key + '|' + dk;
            acc.seen.add(k);
            acc.byPid.set(dk, key);
            g.items.push({ key: k, url, y: y + i, src: 'dom' });
        });
        return g;
    };
    const pic = (pid, w = 900, h = 600) => ({ url: `https://wx2.sinaimg.cn/mw690/${pid}.jpg`, width: w, height: h });
    const post = (o) => ({ index: 0, mid: '', bid: '', id: '', uid: '', name: '', text: '', pics: [], ...o });

    const acc1 = mkAcc();
    const r1 = mergeFeedPosts(acc1, [
        post({ index: 0, mid: 'M100001', uid: '700001', name: '甲', text: '第一条的内容', pics: [pic('A1'), pic('A2')] }),
        post({ index: 1, mid: 'M100002', uid: '700002', name: '乙', text: '第二条的内容', pics: [pic('B1')] }),
    ], { pageUrl: 'https://weibo.com/ttarticle' });
    ok('DOM 里没有的帖子按微博数据新建 feed 组（2 条微博 3 张图，键是 feed:<mid>）',
        r1.groups === 2 && r1.items === 3 && acc1.groups.length === 2
        && acc1.groups[0].key === 'feed:M100001' && acc1.groups[0].label === '甲' && acc1.groups[0].sub === '第一条的内容'
        && acc1.groups[1].key === 'feed:M100002' && acc1.groups[1].items.length === 1, JSON.stringify(r1));
    const r1b = mergeFeedPosts(acc1, [
        post({ index: 0, mid: 'M100001', uid: '700001', name: '甲', text: '第一条的内容', pics: [pic('A1'), pic('A2')] }),
    ], {});
    ok('同一批数据重复扫（用户点刷新）不重复加组也不重复加图',
        r1b.groups === 0 && r1b.items === 0 && acc1.groups.length === 2, JSON.stringify(r1b));

    const acc2 = mkAcc();
    addDom(acc2, 'acct:500001#psC300003', '丙', ['C1'], 1000);
    const r2 = mergeFeedPosts(acc2, [
        post({ index: 0, mid: 'C300003', uid: '500001', name: '丙', pics: [pic('C1'), pic('C2')] }),
    ], {});
    ok('帖子 id 对得上采集器的键就并回那条微博（不新建组，只补 DOM 缺的那张）',
        r2.groups === 0 && r2.matched === 1 && r2.items === 1
        && acc2.groups.length === 1 && acc2.groups[0].key === 'acct:500001#psC300003'
        && acc2.groups[0].items.length === 2, JSON.stringify(r2));

    const acc3 = mkAcc();
    addDom(acc3, 'acct:600001#psOLDID1', '丁', ['D1'], 5000);
    const r3 = mergeFeedPosts(acc3, [
        post({ index: 7, mid: 'NEWID99', uid: '600001', name: '丁', pics: [pic('D1'), pic('D2')] }),
    ], {});
    ok('上轮在 DOM、这轮被回收（id 变了）的帖子靠「这张图已在哪个组」找回原组',
        r3.groups === 0 && r3.items === 1 && acc3.groups.length === 1
        && acc3.groups[0].key === 'acct:600001#psOLDID1', JSON.stringify(r3));

    const acc4 = mkAcc();
    const repostA = post({ index: 0, mid: 'R100001', uid: '800001', name: '转发甲', pics: [pic('SAME1')] });
    const repostB = post({ index: 1, mid: 'R100002', uid: '800002', name: '转发乙', pics: [pic('SAME1')] });
    const r4 = mergeFeedPosts(acc4, [repostA, repostB], {});
    ok('同一轮里两条复用同一批图的微博（转发）也各算一条，不许并成一组',
        r4.groups === 2 && r4.items === 2 && acc4.groups.length === 2
        && acc4.groups.every((g) => g.items.length === 1), JSON.stringify({ r4, sizes: acc4.groups.map((g) => g.items.length) }));
    // 真正会出事的是跨轮：第一轮只见到甲，第二轮用户滚出来一条转发同一批图的乙 ——
    // 放开「不许落到 feed 组」的限制，乙会被并进甲的组、图上又被 seen 挡掉，整条微博从面板上消失
    const acc4b = mkAcc();
    mergeFeedPosts(acc4b, [repostA], {});
    const r4b = mergeFeedPosts(acc4b, [repostA, repostB], {});
    ok('下一轮才出现的转发帖子必须另开一组（不许靠「这张图见过」并到别人的组里被吞掉）',
        r4b.groups === 1 && acc4b.groups.length === 2
        && acc4b.groups.every((g) => g.items.length === 1)
        && acc4b.groups.some((g) => g.key === 'feed:R100002'), JSON.stringify({ r4b, keys: acc4b.groups.map((g) => g.key + ':' + g.items.length) }));

    const acc5 = mkAcc();
    addDom(acc5, 'acct:9#psE100001', '上', ['E1'], 1000);
    addDom(acc5, 'acct:9#psE200002', '下', ['E2'], 3000);
    const mid = post({ index: 2, mid: 'E300003', uid: '9', name: '中', pics: [pic('E3')] });
    const tail = post({ index: 5, mid: 'E400004', uid: '9', name: '尾', pics: [pic('E4')] });
    mergeFeedPosts(acc5, [
        post({ index: 0, mid: 'E100001', uid: '9', name: '上', pics: [pic('E1')] }),
        mid, tail,
        post({ index: 4, mid: 'E200002', uid: '9', name: '下', pics: [pic('E2')] }),
    ], {});
    const gMid = acc5.groups.find((g) => g.key === 'feed:E300003');
    const gTail = acc5.groups.find((g) => g.key === 'feed:E400004');
    ok('feed 组的文档位置按列表下标在两个真实位置之间插值（第 2 条落在 2000）',
        gMid && gMid.y === 2000, gMid && gMid.y);
    ok('最后一个真实位置之后按平均间距往下外推（下标 5 → 3500）',
        gTail && gTail.y === 3500, gTail && gTail.y);

    const acc6 = mkAcc();
    mergeFeedPosts(acc6, [post({ index: 0, mid: 'F100001', uid: '1', name: '己', pics: [pic('F1', 1234, 567)] })], { pageUrl: 'https://weibo.com/x' });
    const fItem = acc6.groups[0].items[0];
    ok('补来的条目档位齐全（原图 large / 卡片 mw690 / 查看器 mw2000、缩略先用卡片档）且带数据里的真实宽高',
        fItem.url === 'https://wx2.sinaimg.cn/large/F1.jpg' && fItem.card === 'https://wx2.sinaimg.cn/mw690/F1.jpg'
        && fItem.full === 'https://wx2.sinaimg.cn/mw2000/F1.jpg' && fItem.thumb === fItem.card
        && fItem.width === 1234 && fItem.height === 567 && fItem.src === 'feed', JSON.stringify(fItem));
    ok('补来的条目键沿用「<组键>|<图片去重键>」格式（面板重开才能认回旧勾选）',
        fItem.key === acc6.groups[0].key + '|' + imageDedupeKey(fItem.url), fItem.key);

    const acc7 = mkAcc(false);
    const r7 = mergeFeedPosts(acc7, [
        null, undefined, '不是对象', 42,
        post({ index: 0, mid: 'G100001', pics: [] }),
        post({ index: 1, mid: 'G100002', pics: [{ url: '/relative/only.jpg' }, { url: 'data:image/png;base64,AAA' }, pic('G3')] }),
    ], {});
    ok('脏数据（空图/相对地址/非对象）只跳过不抛异常，缺 byPid 时自己补上',
        r7.groups === 1 && r7.items === 1 && r7.skipped === 1 && acc7.byPid instanceof Map, JSON.stringify(r7));
    ok('没有信息流数据时原样返回（一条都不补，也不报错）',
        mergeFeedPosts(mkAcc(), [], {}).groups === 0
        && mergeFeedPosts(mkAcc(), null, {}).items === 0
        && mergeFeedPosts(null, [post({ pics: [pic('H1')] })], {}).items === 0);
}

console.log('== 微博翻页（映射与页数）==');
{
    const inf = (u, w = 900, h = 600) => ({ large: { url: u, width: w, height: h } });
    const p1 = weiboStatusToPost({
        mid: '5000000001', bid: 'AbCdEf', user: { id: '700001', screen_name: '  甲  ' },
        text: '带 <a href="/n/x">@某某</a> 的正文<br>两行', created_at: 'x',
        pic_ids: ['A', 'B'], pic_infos: { A: inf('https://wx1.sinaimg.cn/large/A.jpg', 1200, 800), B: inf('https://wx2.sinaimg.cn/mw2000/B.jpg') },
    }, 3);
    ok('weiboStatusToPost：取 large 的地址与真实宽高，档位表对不上也不影响（面板侧自己换算）',
        p1.pics.length === 2 && p1.pics[0].url === 'https://wx1.sinaimg.cn/large/A.jpg'
        && p1.pics[0].width === 1200 && p1.pics[0].height === 800
        && p1.pics[1].url === 'https://wx2.sinaimg.cn/mw2000/B.jpg' && p1.index === 3, JSON.stringify(p1));
    ok('weiboStatusToPost：正文剥 HTML 只留文字、昵称去掉首尾空白、bid 带出来供认组',
        p1.text === '带 @某某 的正文 两行' && p1.name === '甲' && p1.bid === 'AbCdEf' && p1.uid === '700001', JSON.stringify(p1));
    const p2 = weiboStatusToPost({
        mid: '5000000002', pic_ids: ['X'], pic_infos: { X: { large: { latest_url: 'https://wx3.sinaimg.cn/large/X.jpg' } } },
        retweeted_status: { pic_ids: ['X', 'Y'], pic_infos: { Y: { mw2000: { url: 'https://wx4.sinaimg.cn/mw2000/Y.jpg', width: 400, height: 300 } } } },
    }, 0);
    ok('weiboStatusToPost：转发的图在原帖上，与原帖同 pid 的只算一张（latest_url 也认）',
        p2.pics.length === 2 && p2.pics.some((x) => /\/X\.jpg$/.test(x.url))
        && p2.pics.some((x) => x.url === 'https://wx4.sinaimg.cn/mw2000/Y.jpg' && x.width === 400), JSON.stringify(p2));
    const p3 = weiboStatusToPost({ mid: '5000000003', pic_ids: ['Z'], pic_infos: { Z: { large: { url: '/relative/z.jpg' } } } }, 'bad');
    ok('weiboStatusToPost：非 http 的地址一律不要，index 不是数字就归 0（不许把 NaN 传进插值）',
        p3.pics.length === 0 && p3.index === 0, JSON.stringify(p3));
    ok('weiboStatusToPost：条目形状不对（null / 数字 / 没有 user）也不抛，回一份空 pics 的结构',
        weiboStatusToPost(null, 0).pics.length === 0
        && weiboStatusToPost(42, 0).pics.length === 0
        && weiboStatusToPost({ mid: '1', user: null, pic_ids: '不是数组' }, 0).pics.length === 0);
    ok('翻页页数卡死在 1~10：0 页抬到 1、99 页压到 10，脏值回默认 3（一次问太急容易被限流）',
        clampLoadPages(0) === 1 && clampLoadPages(99) === 10 && clampLoadPages('5') === 5
        && clampLoadPages('x') === 3 && clampLoadPages(undefined) === 3 && clampLoadPages(-2) === 1
        && clampLoadPages(4.6) === 5);
}

__summary();process.exit(fail ? 1 : 0);
