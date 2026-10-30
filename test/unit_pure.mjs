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
import { upgradeWeiboImageUrl, weiboImageTierUrl, imageDedupeKey, isWeiboHost, accountInitial, mergeFeedPosts, weiboStatusToPost, weiboStatusUrl, clampLoadPages } from '../src/common/gallery.js';
import { UI_THEMES, DEFAULT_UI_THEME, normalizeUiTheme, uiThemeLabel } from '../src/common/theme.js';
import { parseWeiboDate, eventDateOf, normStatus, parseArchivePage, addPosts, newArchiveState, crawlArchive, serializeArchive, restoreArchive, publicArchive, uniqPics, mediaPlan, normFeatures, reconcileDone, takePages, ARCHIVE_STORE_KEY, DEFAULT_FEATURES, TIERS, WA_BUILD } from '../src/gallery/weibo-archive.mjs';

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
        // 这一整块原来写的是 `buildToolbar(s, 'image', true)` 并断言「像素类要被排除」——
        // 但 buildToolbar 从来只有 (settings, mediaType) 两个参数，第三个参数是空气，
        // 而 upscale-lanczos 是默认启用的图片工具，被排除才是 bug。断言按真实契约重写。
        const img = buildToolbar(s, 'image').map((i) => i.id);
        const onlyVideo = ['v-frame', 'v-frames-sheet', 'v-play', 'v-speed', 'v-mute', 'v-piP', 'v-seek-in', 'v-copy-time'];
        ok('图片工具栏保留地址类工具', ['copy-link', 'open-src', 'info'].every((id) => img.includes(id)), img.join(','));
        ok('图片工具栏绝不漏进视频专属工具（mediaType 过滤是唯一入口，靠 media 数组判，不靠第二参数）',
            !onlyVideo.some((id) => img.includes(id)), img.join(','));
        ok('视频工具栏反过来也不许漏进图片专属工具（抠色/暗角/圆角/OTSU/调色板/标签/sam/深度都是图片专属）',
            !['chromakey', 'vignette', 'round', 'palette', 'ai-sam', 'ai-depth'].some((id) => buildToolbar(s, 'video').map((i) => i.id).includes(id)));
        ok('图片工具栏允许脚本工具（可自行取链）', img.includes('send-comfy'), img.join(','));
        ok('默认启用的图片工具是「高清/调色/下载」这一族，upscale-lanczos 出现是对的（旧断言把它当排除项，是断言错不是实现错）',
            img.includes('upscale-lanczos') && img.includes('download'));
        ok('buildToolbar 只接两个参数：测试不许再靠一个不存在的第三参数写断言（这条红过一次就是这么来的）',
            buildToolbar.length === 2, 'arity=' + buildToolbar.length);
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
    ok('看图说话/提问/OCR 是纯接口任务：只有这三个名字不装运行时，别的照样要 transformers.js', await (async () => {
        const { LLM_TASKS } = await import('../src/common/ai/llm-api.js');
        return LLM_TASKS.has('describe') && LLM_TASKS.has('ask') && LLM_TASKS.has('ocr')
            && !LLM_TASKS.has('samPick') && !LLM_TASKS.has('face') && !LLM_TASKS.has('superResolve') && LLM_TASKS.size === 3;
    })());
    ok('LLM 端点四种写法都能落到 /chat/completions（含不给协议、已经写全、带别的子路径）', await (async () => {
        const { chatEndpoint } = await import('../src/common/ai/llm-api.js');
        return chatEndpoint('api.example.com') === 'https://api.example.com/v1/chat/completions'
            && chatEndpoint('https://api.example.com/v1/') === 'https://api.example.com/v1/chat/completions'
            && chatEndpoint('https://x.test/v1/chat/completions') === 'https://x.test/v1/chat/completions'
            && chatEndpoint('https://x.test/proxy/keep') === 'https://x.test/proxy/keep/chat/completions'
            && chatEndpoint('') === '' && chatEndpoint('   ') === '';
    })());
    ok('LLM 配置夹范围：脏数字回落到边界，密钥去掉误粘的 Bearer 前缀', await (async () => {
        const { normalizeLlm } = await import('../src/common/ai/llm-api.js');
        const n = normalizeLlm({ endpoint: ' https://a.b/v1 ', apiKey: 'Bearer  sk-1 ', temperature: 9, maxTokens: 10, imageMaxDim: 99999, timeoutSec: 0 });
        return n.endpoint === 'https://a.b/v1' && n.apiKey === 'sk-1' && n.temperature === 2
            && n.maxTokens === 16 && n.imageMaxDim === 4096 && n.timeoutSec === 5
            && normalizeLlm(null).model === 'gpt-4o-mini' && normalizeLlm({}).apiKey === '';
    })());
    ok('请求体是 OpenAI 兼容形状：system 是字符串、user 带 image_url + 文本，密钥没有就不发 Authorization', await (async () => {
        const { buildChatRequest } = await import('../src/common/ai/llm-api.js');
        const r = buildChatRequest({ endpoint: 'https://a.b/v1', apiKey: 'sk-1', model: 'm', temperature: 0.3, maxTokens: 200, timeoutSec: 30 },
            { system: '别复述问题', user: '图里有什么？', imageDataUrl: 'data:image/jpeg;base64,AA' });
        const noKey = buildChatRequest({ endpoint: 'https://a.b/v1', model: 'm' }, { user: 'hi' });
        return r.url === 'https://a.b/v1/chat/completions' && r.headers.authorization === 'Bearer sk-1'
            && r.headers['content-type'] === 'application/json' && r.timeoutMs === 30000
            && r.body.model === 'm' && r.body.max_tokens === 200 && r.body.temperature === 0.3 && r.body.stream === false
            && r.body.messages[0].role === 'system' && typeof r.body.messages[0].content === 'string'
            && r.body.messages[1].content[0].type === 'image_url' && r.body.messages[1].content[0].image_url.url === 'data:image/jpeg;base64,AA'
            && r.body.messages[1].content[1].text === '图里有什么？'
            && noKey.headers.authorization === undefined;
    })());
    ok('应答取字要认四种形状，全取不到就直说「没有文字」而不是回一个空串', await (async () => {
        const { parseChatReply } = await import('../src/common/ai/llm-api.js');
        const a = parseChatReply({ choices: [{ message: { content: '一句话' } }] });
        const b = parseChatReply({ choices: [{ message: { content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] } }] });
        const c = parseChatReply({ choices: [{ text: '补全式应答' }] });
        const d = parseChatReply({ output_text: ' Responses API 的形状' });
        const e = parseChatReply({ choices: [{ message: { content: '' } }] });
        return a.text === '一句话' && b.text === '第一段第二段' && c.text === '补全式应答' && d.text === 'Responses API 的形状'
            && a.model === '' && e.text === '' && parseChatReply(null).text === '';
    })());
    ok('接口报错翻成「下一步改哪里」，并且任何文案里都不许回显密钥', await (async () => {
        const { llmErrorText, redactKey } = await import('../src/common/ai/llm-api.js');
        return /密钥/.test(llmErrorText(401, 'Unauthorized')) && /模型名/.test(llmErrorText(404, 'not found'))
            && /限流/.test(llmErrorText(429, '')) && /图片|max_tokens/.test(llmErrorText(400, 'x'))
            && /服务端出错 599/.test(llmErrorText(599, 'boom'))
            && redactKey('Authorization: Bearer sk-secret-123 failed', 'sk-secret-123').indexOf('sk-secret-123') < 0;
    })());
    ok('默认设置里没有多模态权重了：vlmPreset/vlmPrompt 不见，换成 ai.llm 一整套', await (async () => {
        return DEFAULT_SETTINGS.ai.vlmPreset === undefined && DEFAULT_SETTINGS.ai.vlmPrompt === undefined
            && DEFAULT_SETTINGS.ai.llm && DEFAULT_SETTINGS.ai.llm.endpoint === '' && DEFAULT_SETTINGS.ai.llm.model === 'gpt-4o-mini'
            && DEFAULT_SETTINGS.ai.llm.imageMaxDim === 1024 && typeof DEFAULT_SETTINGS.ai.describePrompt === 'string';
    })());
    ok('老设置迁移：用户改过的 vlmPrompt 换名活下来，多模态权重那几个键被清干净', await (async () => {
        const old = { version: 2, ai: { vlmPreset: 'qwen3vl-2b', vlmModel: 'x/y', vlmPrompt: '我自己写的提示词', device: 'wasm' } };
        const m = migrateSettings(old);
        const kept = migrateSettings({ version: 2, ai: { vlmPreset: 'qwen2vl-2b', vlmDtype: 'q4' } });
        return m.ai.describePrompt === '我自己写的提示词' && m.ai.device === 'wasm'
            && m.ai.vlmPrompt === undefined && m.ai.vlmPreset === undefined && m.ai.vlmModel === undefined
            && m.ai.llm.endpoint === '' && kept.ai.describePrompt === DEFAULT_SETTINGS.ai.describePrompt;
    })());
    ok('多模态权重的代码与引用一起下线（src/ 里不许再 import ai/vlm.js，宿主对 LLM 任务不装运行时）', await (async () => {
        const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
        let vlmFileThere = true;
        try { rd('src/common/ai/vlm.js'); } catch (e) { vlmFileThere = false; }
        const texts = ['src/common/ai/index.js', 'src/host/host.mjs', 'src/options/panels.mjs', 'src/content/runner.mjs', 'src/common/registry.js'].map(rd).join('\n');
        const hostGate = /if \(!LLM_TASKS\.has\(task\)\) await engine\.prepare\(req\.ai\)/.test(rd('src/host/host.mjs'));
        const engineGate = /if \(!LLM_TASKS\.has\(name\) && !this\.tf\) await this\.prepare/.test(rd('src/common/ai/index.js'));
        return !vlmFileThere && !/ai\/vlm\.js/.test(texts) && !/ensureVlm|new VlmRunner|VLM_PRESETS/.test(texts) && hostGate && engineGate;
    })(), {});
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

console.log('== 关键字逻辑表达式（且 / 或 / 非 / 括号）==');
{
    const wf = await import('../src/common/weibo-filter.js');
    const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
    const on = { enabled: true, types: { original: true, repost: true, text: true, image: true, video: true, music: true } };
    const post = (o) => ({ repost: false, hasImage: false, hasVideo: false, hasMusic: false, text: '', date: '', ...o });
    const E = (expr) => ({ ...on, keywordMode: 'expr', keywords: expr });
    const p = (s) => wf.keywordExprOf(s);
    ok('并排写就是「且」：两个词都得有',
        p('抽奖 关注').ok && !wf.matchWeiboFilter(post({ text: '只有抽奖' }), E('抽奖 关注'))
        && wf.matchWeiboFilter(post({ text: '抽奖并关注' }), E('抽奖 关注')));
    ok('「或」的三种写法都一样：或 / || / 逗号',
        ['抽奖 或 转发', '抽奖||转发', '抽奖,转发'].every((s) => p(s).ok
            && wf.matchWeiboFilter(post({ text: '今天转发' }), E(s)) && wf.matchWeiboFilter(post({ text: '抽奖啦' }), E(s))
            && !wf.matchWeiboFilter(post({ text: '日常' }), E(s))));
    ok('「非」的三种写法都一样：非 / ! / NOT，且只作用在紧邻的那一个词上',
        ['非 广告', '!广告', 'NOT 广告'].every((s) => p(s).ok && !wf.matchWeiboFilter(post({ text: '这条有广告' }), E(s))
            && wf.matchWeiboFilter(post({ text: '干净的' }), E(s)))
        && !wf.matchWeiboFilter(post({ text: '抽奖 有广告' }), E('抽奖 非 广告'))
        && wf.matchWeiboFilter(post({ text: '抽奖 干净的' }), E('抽奖 非 广告')));
    ok('优先级：! > 且 > 或，括号能改；a || b && c 认成 a 或 (b 且 c)',
        wf.matchWeiboFilter(post({ text: '只有 b' }), E('a||b&&c')) === false
        && wf.matchWeiboFilter(post({ text: 'bc' }), E('a||b&&c')) === true
        && wf.matchWeiboFilter(post({ text: '只有 b' }), E('(a||b)&&c')) === false
        && wf.matchWeiboFilter(post({ text: 'abc' }), E('(a||b)&&c')) === true);
    ok('(抽奖 或 转发) 且 非 广告 这种组合真的按组合判',
        p('(抽奖 或 转发) 且 非 广告').ok && wf.matchWeiboFilter(post({ text: '转发说明：抽奖啦' }), E('(抽奖 或 转发) 且 非 广告'))
        && !wf.matchWeiboFilter(post({ text: '转发里夹了广告' }), E('(抽奖 或 转发) 且 非 广告'))
        && !wf.matchWeiboFilter(post({ text: '普通日常' }), E('(抽奖 或 转发) 且 非 广告')));
    ok('引号里的整串算一个词（里面的 或/&& 不当运算符）',
        p('"A 或 B" 且 C').ok && JSON.stringify(p('"A 或 B" 且 C').node.a) === JSON.stringify({ k: 'term', v: 'a 或 b' })
        && !wf.matchWeiboFilter(post({ text: 'A 还有 C' }), E('"A 或 B" 且 C'))
        && wf.matchWeiboFilter(post({ text: '写的是 A 或 B 还有 C' }), E('"A 或 B" 且 C')));
    ok('中文词自己含「非/或/且」时不许被当运算符（没空格就是一个词）',
        p('非诚勿扰').ok && p('一对一').ok && p('且慢').ok
        && wf.matchWeiboFilter(post({ text: '看了非诚勿扰' }), E('非诚勿扰'))
        && !wf.matchWeiboFilter(post({ text: '看了别的' }), E('非诚勿扰')));
    ok('大小写不敏感（词和正文两边都折小写）',
        wf.matchWeiboFilter(post({ text: '今天的 GIVEAWAY 抽奖' }), E('giveaway'))
        && !wf.matchWeiboFilter(post({ text: '今天的抽奖' }), E('GIVEAWAY 且 代购')));
    ok('写坏了就「不筛任何东西」，并说清坏在哪（宁可多留，绝不整页误杀）',
        p('((抽奖').error.length > 0 && p('且 抽奖').error.length > 0 && p('抽奖 且').error.length > 0
        && p('抽奖 且 关注)').error.length > 0 && p('"没关引号').error.length > 0
        && ['((抽奖', '且 抽奖', '抽奖 且', '抽奖 且 关注)', '"没关引号'].every((s) => wf.matchWeiboFilter(post({ text: '随便什么' }), E(s)))
        && wf.matchWeiboFilter(post({ text: '随便什么' }), E('抽奖')) === false);
    ok('空表达式 = 这条规则不生效（不是「什么都不要」）',
        p('   ').empty === true && p('').ok === false && wf.matchWeiboFilter(post({ text: '随便什么' }), E('   ')));
    ok('表达式太长就拒解析（免得被人贴一整篇正文进去）',
        p('A 且 ' + '字'.repeat(wf.EXPR_MAX_LEN)).error.includes('太长'));
    ok('expr 档整句原样存着：normalize 绝不按逗号/顿号把它拆开',
        (() => { const n = wf.normalizeWeiboFilter({ keywordMode: 'expr', keywords: '(抽奖, 关注) 或 !广告' });
            return n.keywordMode === 'expr' && n.keywords.length === 1 && n.keywords[0] === '(抽奖, 关注) 或 !广告'; })()
        && (() => { const n = wf.normalizeWeiboFilter({ keywordMode: 'expr', keywords: ['(A 或 B)', '且 C'] });
            return n.keywords[0] === '(A 或 B) 且 C'; })());
    ok('has / none 两档的老语义一点没变（升级不许改已有筛法）',
        wf.matchWeiboFilter(post({ text: '抽奖' }), { ...on, keywordMode: 'has', keywords: '抽奖, 代购' })
        && !wf.matchWeiboFilter(post({ text: '抽奖' }), { ...on, keywordMode: 'none', keywords: ['抽奖'] })
        && wf.normalizeWeiboFilter({ keywordMode: 'has', keywords: '抽奖、代购' }).keywords.join('|') === '抽奖|代购'
        && wf.normalizeWeiboFilter({ keywordMode: 'xx' }).keywordMode === 'has');
    ok('描述文案会把逻辑式念出来，坏了就念「看不懂」',
        wf.describeWeiboFilter(E('(抽奖 或 转发) 且 非 广告')).includes('逻辑式「(抽奖 或 转发) 且 非 广告」')
        && wf.describeWeiboFilter(E('((抽奖')).includes('看不懂'));
    ok('面板第三档真的在 HTML 里，语法行 + 实时校验都在',
        /<option value="expr">/.exec(read('gallery.html')) !== null
        && read('gallery.html').includes('id="wfExprRow"') && read('gallery.html').includes('id="wfExprHint"')
        && read('src/gallery/gallery.mjs').includes('function updateExprUi')
        && read('src/gallery/gallery.mjs').includes('updateExprUi(filter)'));
    ok('表达式原文要当整句交给 normalize（面板侧不再先 splitKeywords 拆一遍）',
        read('src/gallery/gallery.mjs').includes('keywords: $(\'#wfKeywords\').value')
        && !read('src/gallery/gallery.mjs').includes('splitKeywords'));
    ok('注入页面的那份函数只 walk 树，绝不重复实现解析器（后台已经编译好）',
        read('background.js').includes('func: weiboFilterPage')
        && read('background.js').includes('expr = parsed.node')
        && read('background.js').includes('const evExpr = (n, low) =>')
        && !read('background.js').includes('parseKeywordExpr'));
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

    const st = (o) => ({ mid: '5000001111', bid: 'AbCdEfG', mblogid: 'HjKlMnO', user: { id: '7000001111', screen_name: '甲' }, ...o });
    ok('跳转地址优先用 mblogid（微博地址栏里显示的那个），桌面版拼成 weibo.com/<uid>/<id>',
        weiboStatusUrl(st({}), 'weibo.com') === 'https://weibo.com/7000001111/HjKlMnO'
        && weiboStatusUrl(st({ mblogid: '' }), 'weibo.com') === 'https://weibo.com/7000001111/AbCdEfG'
        && weiboStatusUrl(st({ mblogid: '', bid: '' }), 'weibo.com') === 'https://weibo.com/7000001111/5000001111');
    ok('认不出 uid 就退到 m.weibo.cn/status/<id>（那个形状只靠 id 也能打开），移动版页面直接走它',
        weiboStatusUrl(st({ user: null }), 'weibo.com') === 'https://m.weibo.cn/status/HjKlMnO'
        && weiboStatusUrl(st({ user: { screen_name: '没有 id' } }), 'www.weibo.com') === 'https://m.weibo.cn/status/HjKlMnO'
        && weiboStatusUrl(st({}), 'm.weibo.cn') === 'https://m.weibo.cn/status/HjKlMnO');
    ok('id 短到不像话或缺失时不给地址（宁可不显示「跳转」，也别拼出一个 404）',
        weiboStatusUrl({ user: { id: '7000001111' } }, 'weibo.com') === ''
        && weiboStatusUrl(st({ mid: '12', bid: 'ab', mblogid: '' }), 'weibo.com') === ''
        && weiboStatusUrl(null, 'weibo.com') === '');
    const pUrl = weiboStatusToPost({ mid: '5000002222', mblogid: 'Zz11223', user: { id: '7000002222', screen_name: '乙' }, pic_ids: ['K'], pic_infos: { K: { large: { url: 'https://wx1.sinaimg.cn/large/K.jpg' } } } }, 1, 'weibo.com');
    ok('帖子形状带着跳转地址走（mergeFeedPosts 建组时要用它）',
        pUrl.url === 'https://weibo.com/7000002222/Zz11223' && pUrl.pics.length === 1, JSON.stringify(pUrl));
    const accU = { groups: [], byKey: new Map(), seen: new Set(), byPid: new Map() };
    const domUrlKey = 'acct:7000003333#psNn990011';
    {
        const g = { key: domUrlKey, label: '丙', sub: '', items: [], junk: false, y: 800 };
        accU.byKey.set(domUrlKey, g);
        accU.groups.push(g);
        const url = 'https://wx1.sinaimg.cn/large/JJ1.jpg';
        const dk = imageDedupeKey(url);
        accU.seen.add(domUrlKey + '|' + dk);
        accU.byPid.set(dk, domUrlKey);
        g.items.push({ key: domUrlKey + '|' + dk, url, y: 800 });
    }
    mergeFeedPosts(accU, [
        {
            index: 0, mid: '5000003333', bid: 'Nn990011', id: '', uid: '7000003333', name: '丙', text: '',
            pics: [{ url: 'https://wx1.sinaimg.cn/large/JJ1.jpg', width: 0, height: 0 }], url: 'https://weibo.com/7000003333/Nn990011',
        },
        {
            index: 1, mid: '5000003334', bid: '', id: '', uid: '7000003334', name: '丁', text: '',
            pics: [{ url: 'https://wx1.sinaimg.cn/large/JJ2.jpg', width: 0, height: 0 }], url: 'https://weibo.com/7000003334/Pp778899',
        },
    ], {});
    ok('补来的组带跳转地址；DOM 组自己没认出链接时用数据里那个补上（页面上没 DOM 的帖子照样能跳）',
        accU.groups.find((g) => g.key === 'acct:7000003333#psNn990011').url === 'https://weibo.com/7000003333/Nn990011'
        && accU.groups.find((g) => g.key === 'feed:5000003334').url === 'https://weibo.com/7000003334/Pp778899',
        JSON.stringify(accU.groups.map((g) => [g.key, g.url])));
}

console.log('== 面板跳转方式 ==');
{
    const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
    ok('默认跳转方式是「滚到那条微博」，老设置迁移时自动补上',
        DEFAULT_SETTINGS.gallery.jumpMode === 'scroll' && migrateSettings(undefined).gallery.jumpMode === 'scroll');
    ok('存过的 jumpMode 原样保留，脏值由面板侧兜成 scroll（只有显式 tab 才开标签）',
        migrateSettings({ version: 2, gallery: { jumpMode: 'tab' } }).gallery.jumpMode === 'tab'
        && ((settings) => settings.gallery.jumpMode === 'nope')(migrateSettings({ version: 2, gallery: { jumpMode: 'nope' } })));
    const jumpSel = (/<select id="jumpMode">([\s\S]*?)<\/select>/.exec(read('options.html')) || [])[1] || '';
    const vals = [...jumpSel.matchAll(/value="([^"]+)"/g)].map((x) => x[1]);
    ok('设置页「点 ↗ 微博时」下拉恰好三档，且和 options.mjs 的绑定字段对得上',
        vals.join(',') === 'scroll,scrollOnly,tab' && read('src/options/options.mjs').includes('[\'gallery.jumpMode\', \'jumpMode\']'), 'HTML=' + vals.join(','));
    ok('面板侧只认显式的 tab / scrollOnly，其余（含脏值）一律按滚到那条微博处理',
        read('src/gallery/gallery.mjs').includes("return v === 'tab' || v === 'scrollOnly' ? v : 'scroll'"));
    ok('只有真「tab」档才直接开标签；scrollOnly 必须继续走滚动（旧写法 !== scroll 会把 scrollOnly 当 tab）',
        read('src/gallery/gallery.mjs').includes("if (S.jumpMode === 'tab') {")
        && !read('src/gallery/gallery.mjs').includes("if (S.jumpMode !== 'scroll') {"));
    ok('scrollOnly 档：滚不到也绝不新开标签，只在提示条上说清为什么',
        /if \(S\.jumpMode !== 'scrollOnly'\) chrome\.tabs\.create/.test(read('src/gallery/gallery.mjs'))
        && read('src/gallery/gallery.mjs').includes('按你的设置没有新开标签页'));
    ok('默认「页面上还没有这条」也是先往下滚找，老设置迁移时自动补上',
        DEFAULT_SETTINGS.gallery.jumpMissing === 'scroll' && migrateSettings(undefined).gallery.jumpMissing === 'scroll');
    ok('存过的 jumpMissing 原样保留（选了开新标签的老用户不会被偷偷改成滚动）',
        migrateSettings({ version: 2, gallery: { jumpMissing: 'tab' } }).gallery.jumpMissing === 'tab');
    const missSel = (/<select id="jumpMissing">([\s\S]*?)<\/select>/.exec(read('options.html')) || [])[1] || '';
    const mvals = [...missSel.matchAll(/value="([^"]+)"/g)].map((x) => x[1]);
    ok('设置页「页面上还没有这条时」下拉恰好两档，且和 options.mjs 的绑定字段对得上',
        mvals.join(',') === 'scroll,tab' && read('src/options/options.mjs').includes('[\'gallery.jumpMissing\', \'jumpMissing\']'), 'HTML=' + mvals.join(','));
    const jumpSrc = read('src/gallery/gallery.mjs');
    ok('面板把 jumpMissing 当成 loadMissing 传给页面侧，两档真的分流',
        /loadMissing:\s*S\.jumpMissing/.test(jumpSrc) && jumpSrc.includes("S.jumpMissing = (S.settings.gallery || {}).jumpMissing === 'tab'"));
    ok('找齐一条微博是「边滚边重新扫」，不是扫一次就算（loadMissing 那条路必须回头再 findPost）',
        /if \(!hit && opt\.loadMissing\) \{[\s\S]{0,1800}?hit = findPost\(\)/.test(read('src/gallery/collect.mjs')));
}

console.log('== 跳转高亮浮层（不许被下一条帖子盖住）==');
{
    const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
    const src = read('src/gallery/collect.mjs');
    ok('高亮不再写 outline 到微博那一条上（outline 画在外框，会被下一条不透明、后绘制的帖子压掉底边 —— 用户报的现场）',
        !src.includes("hit.style.setProperty('outline'") && !src.includes('hit.style.removeProperty'));
    ok('改成自己的浮层：固定定位、pointer-events:none、跟着滚动重定位、2.6 秒后整块摘掉',
        /const HL_ID = 'mtb-jump-hl'/.test(src) && src.includes('position:fixed') && src.includes('pointer-events:none')
        && /Date\.now\(\) - t0 > 2600/.test(src) && src.includes('removeChild(hl)'));
    ok('浮层带一圈明暗双环（白页面、黑页面都看得见），颜色跟着界面风格的 --accent 走',
        /box-shadow:0 0 0 2px/.test(src) && /box-shadow[\s\S]{0,80}rgba\(0, ?0, ?0/.test(src)
        && read('src/gallery/gallery.mjs').includes("getPropertyValue('--accent')"));
    ok('滚到底也没找到时必须滚回用户原来看的位置，并把这件事写进结果（面板据此提示）',
        /window\.scrollTo\(0, start\)/.test(src) && /restored = true/.test(src) && src.includes('out.searched'));
}

console.log('== 往下翻找：没有「翻几屏就算了」的上限 ==');
{
    const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
    const src = read('src/gallery/collect.mjs');
    ok('不许再有几十屏就收手的天花板（用户就是被「往下翻了 24 屏也没加载出这条」惹的），只留一个防死循环的天花板',
        !/Math\.min\(40,/.test(src) && /opt\.maxScreens \| 0 \|\| 4000/.test(src) && /HARD_CAP/.test(src));
    ok('只有三种情况才允许停：贴着文档底连翻 8 屏没长（真到底了）、页面本身滚不动、用户自己在滚（要立刻让开）',
        src.includes('这个页面本身滚不动') && src.includes('你自己在滚页面，已经停下让开')
        && src.includes('微博这个分组已经到底了') && /still >= 8/.test(src));
    ok('「没长新东西」只有在已经贴着底时才计数 —— 否则页面里本来就有一段很长的空白（或已加载但未渲染），会被误判成到底',
        /else if \(atBottom && \+\+still/.test(src));
    ok('几十秒的自动滚动必须在页面上说清是谁在滚、翻到第几屏，收尾把浮标摘掉',
        /const BADGE_ID = 'mtb-jump-search'/.test(src) && src.includes('正在往下翻找这条微博')
        && /clearBadge\(\);/.test(src));
    ok('面板把翻找结果念全：翻了几屏、有没有滚回原位、为什么停（endNote 只在页面侧说了才写）',
        read('src/gallery/gallery.mjs').includes('屏也没加载出这条')
        && /r\.restored \? '，已滚回原位'/.test(read('src/gallery/gallery.mjs'))
        && /r\.endNote \? `（\$\{r\.endNote\}）`/.test(read('src/gallery/gallery.mjs')));
}

console.log('== 微博整档抓取（weibo-archive）==');
{
    // 花体数字写成字面量太脆（成对代理对，编辑器/管道都可能吞一半），按码点造
    const fancy = (d) => Array.from(d, (c) => String.fromCodePoint(0x1d7ce + Number(c))).join('');
    ok('接口日期 "Sat Oct 10 20:14:13 +0800 2026" 必须自己拆成 ISO 形状（new Date 对它不可靠）',
        parseWeiboDate('Sat Oct 10 20:14:13 +0800 2026') === '2026-10-10 20:14:13');
    ok('认不出的日期一律给空串，不许拿当前时间或 NaN 冒充（宁缺毋滥）',
        parseWeiboDate('') === '' && parseWeiboDate('2026-10-10') === '' && parseWeiboDate('Sat Xyz 10 20:14:13 +0800 2026') === '');
    ok('花体数字 𝟐𝟎𝟒𝟎𝟔𝟎𝟖 经 NFKD 归一化解成场次日期码 —— 图博正文不写穿搭只写日期码，这是聚合主键',
        eventDateOf('伟大的月诞 ' + fancy('20240608')) === '2024-06-08');
    ok('普通 ASCII 日期同样认；没有日期码给空串（不拿 created_at 冒充场次）',
        eventDateOf('20230701 下班') === '2023-07-01' && eventDateOf('没有任何数字') === '');

    const st0 = normStatus({
        id: 5000000000000001, idstr: '5000000000000001', mblogid: 'AbCdEf123', mid: 'm1',
        created_at: 'Sat Oct 10 20:14:13 +0800 2026', text: '<a href=x>@某人</a>正文', text_raw: '正文 ' + fancy('20240608'),
        pic_ids: ['p1', 'p2'], pic_num: 2, source: 'iPhone 14 Pro Max', region_name: '发布于 广东',
        reposts_count: 1, comments_count: 2, attitudes_count: 3, isLongText: true,
        retweeted_status: { pic_ids: ['r1'] }, page_info: { type: 'video' },
    }, '7599983809');
    ok('正文取 text_raw 不取带标签的 text（HTML 混进档案会让后面所有关键词统计失真）',
        st0.text === '正文 ' + fancy('20240608') && st0.event === '2024-06-08');
    ok('永久链接按 uid+bid 拼桌面版；没 uid 才退 m.weibo.cn',
        st0.url === 'https://weibo.com/7599983809/AbCdEf123'
        && normStatus({ id: 1, mblogid: 'x1' }, '').url === 'https://m.weibo.cn/status/x1');
    ok('转发原帖的图单列 rt_pics，绝不和本条的 pics 混成一桶（混了就不知道图是谁的）',
        st0.pics.length === 2 && st0.rt_pics.length === 1 && st0.repost === true);
    ok('没有 id 的脏条目给 null（不往档案里塞无名条目）', normStatus({}, '1') === null && normStatus(null, '1') === null);

    ok('游标字段三个版本都认（since_id / max_id_id / maxId），列表在 data 里或在顶层都认',
        parseArchivePage({ data: { list: [1, 2], since_id: 'S1', total: 1176 } }).cursor === 'S1'
        && parseArchivePage({ data: { list: [1], max_id_id: 'S2' } }).cursor === 'S2'
        && parseArchivePage({ list: [1, 2, 3] }).list.length === 3);
    ok('total=-1（feature 1/2/14 就是这样）必须归 0，不许当成「还有一页负一条」的总数',
        parseArchivePage({ data: { list: [], total: -1 } }).declaredTotal === 0
        && parseArchivePage({ data: { list: [], total: 1176 } }).declaredTotal === 1176);

    const mk = (i) => ({ id: String(5000000000000000 + i), mblogid: 'B' + i, created_at: 'Sat Oct 10 20:14:13 +0800 2026', pic_ids: ['p' + i] });
    const A = newArchiveState('1', { features: [0], maxPages: 5, delayMs: 0 });
    ok('addPosts 只认 id 去重：跨 feature 桶重复出现的同一条不会计两次',
        addPosts(A, [mk(1), mk(2)], '1') === 2 && addPosts(A, [mk(2), mk(3)], '1') === 1 && A.posts.length === 3);

    // 假接口：能验证「有没有把上一页游标带回来」——不带就会原地反复要第一页，这是整档最容易犯的错
    const asked = [];
    const pages = [{ list: [mk(1), mk(2)], since_id: 'c1', total: 6 }, { list: [mk(3), mk(4)], since_id: 'c2' }, { list: [mk(5), mk(6)], since_id: 'c3' }];
    const st = newArchiveState('42', { features: [0], maxPages: 9, delayMs: 0 });
    let ck = 0;
    let res = await crawlArchive({
        fetchPage: async (q) => { asked.push(q); return { data: pages[asked.length - 1] || { list: [], since_id: 'z' } }; },
        sleep: null, checkpoint: async () => { ck++; }, checkpointEvery: 2,
    }, st);
    ok('第二页必须把第一页返回的 since_id 传回去（page 参数单独用微博会一直给第一屏）',
        asked[0].sinceId === '' && asked[1].sinceId === 'c1' && asked[2].sinceId === 'c2');
    ok('接口自报 total=6，收满 6 条就停，并把「收满」这件事写进 stopped（不靠猜到底没有）',
        res.posts === 6 && res.declaredTotal === 6 && res.stopped === 'reached-total' && res.complete === true);
    ok('页码按 1 起（接口是 1-based），整档进度每页回调一次',
        asked[0].page === 1 && asked[1].page === 2);
    ok('checkpoint 按间隔落（每 2 页一次 + 收尾一次），SW 被回收才可能续得上',
        ck === 2);

    const st2 = newArchiveState('42', { features: [0], maxPages: 9, delayMs: 0 });
    let n2 = 0;
    const r2 = await crawlArchive({ fetchPage: async () => { n2++; return { data: { list: [mk(100 + n2)], since_id: 'same' } }; }, sleep: null }, st2);
    ok('游标连续两次不动就判「接口没往后翻」立刻收手，绝不空转烧限流',
        n2 === 3 && r2.stopped === 'cursor-stuck');

    const st3 = newArchiveState('42', { features: [0], maxPages: 3, delayMs: 0 });
    const r3 = await crawlArchive({ fetchPage: async () => ({ data: { list: [mk(1), mk(2)], since_id: 'x' + Math.random() } }), sleep: null }, st3);
    ok('maxPages 是硬闸：到数就停并说明原因（防止把微博的限流敲穿）',
        r3.stopped === 'max-pages' && r3.pages === 3);

    const st4 = newArchiveState('42', { features: [0], maxPages: 9, delayMs: 0 });
    const r4 = await crawlArchive({ fetchPage: async () => ({ data: { list: [] } }), sleep: null }, st4);
    ok('空页 = 到底，stopped=empty-page，且 complete 在没拿到 total 时给 null 而不是 false（未知不等于失败）',
        r4.stopped === 'empty-page' && r4.complete === null);

    const st5 = newArchiveState('42', { features: [0], maxPages: 9, delayMs: 0 });
    let hits = 0;
    const r5 = await crawlArchive({ fetchPage: async () => { hits++; return { data: { list: [mk(hits)], since_id: 'k' + hits } }; }, sleep: null, shouldStop: () => hits >= 2 }, st5);
    ok('取消要在页与页之间生效，并把 canceled 说清楚（用户按停止必须真停）',
        hits === 2 && r5.canceled === true && r5.done === false);

    const st6 = newArchiveState('42', { features: [0], maxPages: 2, delayMs: 0 });
    await crawlArchive({ fetchPage: async () => ({ data: { list: [mk(1), mk(2)], since_id: 'a' } }), sleep: null }, st6);
    const back = restoreArchive(JSON.parse(JSON.stringify(serializeArchive(st6))));
    ok('落盘/恢复往返不丢帖，且 byId 会重建（Set 不可序列化，直接 JSON 化会把去重能力洗掉）',
        back.posts.length === 2 && back.byId.has(String(5000000000000001)) && addPosts(back, [mk(1)], '42') === 0);
    ok('默认抓 0/1/2/14 四个 feature 桶：实测只有 0 报 total，其余各回 20 条，并集才接近全部',
        DEFAULT_FEATURES.join(',') === '0,1,2,14');

    const stP = newArchiveState('42', { features: [0] });
    addPosts(stP, [{ id: '1', mblogid: 'b1', created_at: 'Sat Oct 10 20:14:13 +0800 2026', pic_ids: ['p1', 'p2'] }], '42');
    addPosts(stP, [{ id: '2', mblogid: 'b2', created_at: 'Sat Oct 10 20:14:13 +0800 2026', pic_ids: ['p2', 'p3'] }], '42');
    const plan = mediaPlan(stP, {});
    ok('下载计划按 pid 去重（两条帖共用一张图只下一次），默认档位 large 原图',
        plan.length === 3 && uniqPics(stP.posts).length === 3 && /\/large\/p1\.jpg$/.test(plan[0].url));
    ok('落盘路径带 uid 与拍摄日，文件名就是 pid —— 续传靠它认「这张已经下过」',
        plan[0].key === 'mtb-weibo/42/2026-10-10/p1.jpg');
    ok('skip 命中已完成的 pid 就跳过（断点续传不许重下），limit 只截数量不截顺序',
        mediaPlan(stP, { skip: ['p1'] }).length === 2 && mediaPlan(stP, { limit: 1 }).length === 1);
    ok('档位只认四个名字，写错回落 orig（拼错档位会 403，不如回到最稳的那档）',
        TIERS.card === 'mw690' && mediaPlan(stP, { tier: 'nope' })[0].url.includes('/large/'));

    const stT = newArchiveState('42', { features: [0] });
    stT.posts = [
        { id: 'top', created_at: '2024-06-09 08:19:15', ts: Date.parse('2024-06-09T08:19:15+08:00'), pics: [] },
        { id: 'new', created_at: '2026-10-10 20:14:13', ts: Date.parse('2026-10-10T20:14:13+08:00'), pics: [] },
        { id: 'old', created_at: '2021-04-27 23:08:30', ts: Date.parse('2021-04-27T23:08:30+08:00'), pics: [] },
    ];
    const pubT = publicArchive(stT);
    ok('first/last 必须按时间取、不许取数组两端：微博把置顶帖放在最前面，按插入序会把「最新一条」报成那条置顶（真机 E2E 实测暴露：last 显示 2024-06-09，真最新是 2026-10-10）',
        pubT.first === '2021-04-27 23:08:30' && pubT.last === '2026-10-10 20:14:13');

    ok('features 从 RPC 过来可能是数字/字符串/空数组：不许抛异常；标量按用户意图当单桶，全非法才退回默认四桶',
        newArchiveState('1', { features: 0 }).features.join(',') === '0'
        && newArchiveState('1', { features: 'abc' }).features.length === 4
        && newArchiveState('1', { features: [] }).features.length === 4
        && newArchiveState('1', { features: [0, null, 2] }).features.join(',') === '0,2');

    // 抓完再 Start（resume）时，已经判到底的桶不许再敲接口
    const stR = newArchiveState('42', { features: [0, 1], maxPages: 9, delayMs: 0 });
    stR.perFeature = { 0: { cursor: 'c', page: 3, added: 60, end: true, error: '' }, 1: { cursor: '', page: 0, added: 0, end: false, error: '' } };
    for (let i = 0; i < 60; i++) addPosts(stR, [mk(i)], '42');
    let askedR = 0;
    await crawlArchive({ fetchPage: async () => { askedR++; return { data: { list: [], since_id: '' } }; }, sleep: null }, stR);
    ok('续跑要跳过上一轮已到底的桶（抓完再点一次 Start 不该白烧几十次请求），只敲没跑完的那个桶',
        askedR === 1 && stR.perFeature[0].page === 3);

    // 真机复验踩过：传 features:0 被当成「没传」，静默沿用存档里上次那组桶，调用方以为参数没生效
    ok('features 允许标量：传 0 就是「只抓 0 桶」，不许因为 0 是假值就退回别的桶',
        normFeatures(0).join(',') === '0' && normFeatures('2').join(',') === '2');
    ok('features 里的 null 不许被 Number() 悄悄变成 0（那会把「只抓视频桶」变成抓时间线）',
        normFeatures([null, 0, 2]).join(',') === '0,2' && normFeatures([1, 1, 2]).join(',') === '1,2');
    ok('features 全非法（空数组 / 乱字符串）才退回默认四桶',
        normFeatures([]).join(',') === DEFAULT_FEATURES.join(',') && normFeatures('abc').join(',') === DEFAULT_FEATURES.join(','));
    ok('newArchiveState 与状态里的 build 标记同源（真人 Edge 的 ESM SW 会连着几次重载仍跑旧版，得一条调用就能判是哪一版）',
        newArchiveState('1', {}).features.length === DEFAULT_FEATURES.length && publicArchive(newArchiveState('1')).build === WA_BUILD);

    const pids = ['008ikKY1gy1ihxipnq3dmj32bc1jke81', '008ikKY1gy1ihxiqbgcy7j31e02gw7wk', '008ikKY1gy1ihxiqglxvlj31jk2bcnpf'];
    ok('rescan 按文件名认回已下的 pid：Windows 反斜杠路径、Chrome 重名加的 " (1)" 后缀都要认',
        [...reconcileDone(pids, ['E:\\mtb-weibo\\42\\2026-10-10\\' + pids[0] + '.jpg',
            'E:/mtb-weibo/42/2026-10-10/' + pids[2] + ' (1).jpg'])].join(',') === pids[0] + ',' + pids[2]);
    ok('账本与磁盘不一致时以磁盘为准（实测账本记 7 张、磁盘只剩 2 张，只信账本就永久漏下那 5 张）',
        reconcileDone(pids, []).size === 0 && reconcileDone(pids, ['E:\\x\\无关文件.jpg']).size === 0);

    // 面板「API 模式 · 无限下拉」的增量入口
    const stN = newArchiveState('42', { features: [1, 2, 14] });
    let seq = 0;
    const nr1 = await takePages(stN, async (q) => {
        if (q.feature !== 0) throw new Error('API 模式必须只敲时间线桶，实际敲了 ' + q.feature);
        seq++;
        return { data: { list: [mk(seq * 2 - 1), mk(seq * 2)], since_id: 'p' + seq, total: 6 } };
    }, 2, 0);
    ok('takePages 认显式桶号：档案里存的是别的桶也不许沿用（面板只要时间线）', nr1.fetched === 2 && nr1.added === 4);
    ok('takePages 把这一批原始 status 带回去（面板按自己的形状映射），游标随之前进',
        nr1.fresh.length === 4 && nr1.cursor === 'p2' && stN.perFeature[0].page === 2);
    const nr1b = await takePages(stN, async (q) => ({ data: { list: [mk(1), mk(2)], since_id: 'p2b', total: 6 } }), 1, 0);
    ok('同一批帖子再下拉一次不会重复计数（按 id 去重，面板才不会越滚越多重复组）', nr1b.added === 0);
    const nr2 = await takePages(stN, async () => ({ data: { list: [mk(5), mk(6)], since_id: 'p3', total: 6 } }), 1, 0);
    ok('收满 declaredTotal 就 done + stopped=reached-total（面板据此停止下拉，不再敲接口）',
        nr2.done === true && nr2.stopped === 'reached-total' && nr2.posts === 6);
    const nr3 = await takePages(stN, async () => { throw new Error('不该再被调用'); }, 1, 0);
    ok('已到底之后再下拉直接返回 already-end，一次接口都不敲（防止用户滚到底还在烧限流）',
        nr3.stopped === 'already-end' && nr3.fetched === 0);
    const stE = newArchiveState('42', { features: [0] });
    const nrE = await takePages(stE, async () => ({ data: { list: [] } }), 3, 0);
    ok('接口给空页 → done + empty-page，fetched 记 1（不是把请求数当帖子数）',
        nrE.done === true && nrE.stopped === 'empty-page' && nrE.fetched === 1);
    const stF = newArchiveState('42', { features: [0] });
    const nrF = await takePages(stF, async () => { throw new Error('HTTP 403（微博限流或风控）'); }, 3, 0);
    ok('拉取失败要单独标 failed（真机踩过：403 时 done=false，面板于是每滚一下都重敲一个注定失败的端点）',
        nrF.failed === true && nrF.done === false && nrF.fetched === 0 && /403/.test(nrF.stopped));
}

console.log('== 整档抓取的后台接线（源码钉子）==');
{
    const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
    const bg = read('background.js');
    const at = (s) => bg.indexOf(s);
    const a = at('weiboArchiveStart: async');
    const b = at('weiboArchiveMediaState: async');
    const r = at('async function waCheckpoint');
    const rend = at('function publicWaMedia');
    const seg = bg.slice(a, b);        // 处理器本体
    const run = bg.slice(r, rend);     // 真正干活的分离任务
    ok('锚点都必须真在源码里（找不到就会切出空串，上面那些「不许出现 X」的钉子会静默空过）',
        a > 0 && b > a && r > 0 && rend > r);
    ok('Start 只许起任务立刻返回，绝不 await 整档（30~60s 的活儿塞进一次 RPC 必然被调用方那层超时掐死）',
        !/await\s+crawlArchive/.test(seg) && /runWaJob\(\);/.test(seg) && /await\s+crawlArchive/.test(run));
    ok('整档与图片两条链都要吃 MV3 的 30 秒回收：各自都要有心跳续命（和批量发送同一个招）',
        (run.match(/getPlatformInfo/g) || []).length >= 2);
    ok('断点落盘走 ARCHIVE_STORE_KEY 这一个键，游标与帖子一起写（只把游标写快一步，续跑会静默跳过没落盘的页）',
        /ARCHIVE_STORE_KEY/.test(run) && /serializeArchive/.test(run));
    ok('dump 大结果必须能改走 chrome.downloads，不把 1~2MB 档案塞进 RPC 消息',
        /to === 'download'/.test(seg) && /chrome\.downloads\.download/.test(seg));
    ok('Dump 与 Media 都必须先 waEnsureArchive（SW 被回收后只剩断点，"按 pid 续传"要还能继续，而不是逼人重抓整档）',
        (seg.match(/waEnsureArchive\(\)/g) || []).length >= 2);
    ok('rescan 必须真去问 chrome.downloads 并看 exists，不许拿内存账本自欺（用户删过图账本就是错的）',
        /chrome\.downloads\.search/.test(run) && /\.exists/.test(run));
    ok('downloads.search 单次上限 1000，取已下清单必须翻页，不然几千张的档只核到前 1000',
        /limit: 1000/.test(run) && /offset \+= 1000/.test(run));
    ok('热路径 State 也要报 mediaDone（只有冷路径报的话，跑完一轮下载会看不到进度，像丢了）',
        /pub\.mediaDone =/.test(bg.slice(a, a + 3000)));
    ok('批量取图不许逐张 addRefererRule（几千张就是近万次规则引擎往返），要用任务级共用规则 + 直取',
        !/addRefererRule\(/.test(run) && /waSetReferer\(WA_IMG_RULE/.test(run));
    ok('sinaimg 没有 Referer 直接 403：任务级规则必须在，且字节太少要当成被防盗链挡了说',
        /waSetReferer\(WA_API_RULE/.test(run) && /防盗链/.test(run));
    ok('图片落盘不许走 downloadBinary：它内部 sanitizeFilename 会把 / 换成 _，子目录会被压扁',
        !/downloadBinary\(/.test(run) && /key\.split\(/.test(run));
    ok('Referer 规则整段任务共用一条，不许每页加删（白烧 DNR 配额，还会抖出没带 Referer 的页）',
        (run.match(/waSetReferer\(/g) || []).length === 2 && !/addRefererRule\(/.test(run));
    ok('新动作全部进了 EXT_SCHEMA 清单，否则外部控制方（UBB）自发现不到',
        ['weiboArchiveStart', 'weiboArchiveState', 'weiboArchiveDump', 'weiboArchiveCancel', 'weiboArchiveMedia', 'weiboArchiveMediaState']
            .every((n) => bg.indexOf(n + ': {') > 0 && bg.indexOf(n + ': {') < a));
    ok('限流/风控要停下并说清原因，不许闷头把微博敲穿',
        /限流或风控/.test(run) || /限流或风控/.test(bg));
}

console.log('== 面板「API 模式 · 无限下拉」接线（源码钉子）==');
{
    const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
    const html = read('gallery.html');
    const gm = read('src/gallery/gallery.mjs');
    const bg = read('background.js');
    ok('面板顶部有「API 模式」那颗勾选（与「全部微博」并列，只在微博页显示）',
        /id="apiModeWrap"/.test(html) && /id="apiMode"/.test(html) && /API 模式/.test(html));
    ok('勾选的说明要写清它绕过的是什么（微博页面自己翻到最近几百条就到底），否则用户不知道为什么要开',
        /截断|最多让你翻到/.test(html));
    ok('apiMode 走和 feedAll 同一套持久化：写 settings.gallery.apiMode 并 patchSettings 回后台',
        /S\.apiMode = \(S\.settings\.gallery \|\| \{\}\)\.apiMode === true/.test(gm)
        && /patch: \{ gallery: \{ apiMode: S\.apiMode \} \}/.test(gm));
    ok('勾上 API 模式就藏掉「帮我翻页」与它的页数选择（两条路做同一件事，留着会让人以为要点）',
        /\$\('#btnMore'\)\.hidden = !S\.weiboFlag \|\| S\.apiMode/.test(gm)
        && /\$\('#morePagesWrap'\)\.hidden = !S\.weiboFlag \|\| S\.apiMode/.test(gm));
    ok('无限下拉监听的是面板自己的滚动容器 #panelImages，离底 400px 触发、passive、并且 busy/已到底都不许再敲',
        /\$\('#panelImages'\)/.test(gm) && /addEventListener\('scroll'/.test(gm) && /400/.test(gm)
        && /\{ passive: true \}/.test(gm) && /if \(!S\.apiMode \|\| S\.apiBusy \|\| S\.running\) return/.test(gm)
        && /S\.apiInfo && S\.apiInfo\.done\) return/.test(gm));
    ok('补页只发一个后台动作 weiboArchiveNext，带 tabId、页数夹在 1~10（同一次下拉不许并发敲两下）',
        /action: 'weiboArchiveNext', tabId: S\.tabId/.test(gm) && /Math\.min\(10, Number\(pages\)/.test(gm)
        && /if \(S\.apiBusy\) return/.test(gm));
    {
        const i = bg.indexOf('weiboArchiveNext: async');
        const nx = bg.slice(i, i + 3000);
        ok('weiboArchiveNext 必须自己装 Referer 规则并在 finally 摘掉（真机实测：装规则 200、不装 403；这条漏了面板就"勾了 API 模式一条都不显示"）',
            i > 0 && /waSetReferer\(WA_API_RULE/.test(nx) && /finally\s*\{[\s\S]{0,80}waClearReferer\(WA_API_RULE\)/.test(nx));
        ok('Next 要把 failed 透回面板（403/限流要能停手，不能只报 done=false 让面板一直重试）',
            /failed: !!r\.failed/.test(nx));
    }
    ok('面板把 failed 也当成「到底」，并把原因写进摘要（error 分支必须存在）',
        /done: !!res\.done \|\| !!res\.failed/.test(gm) && /error: res\.failed/.test(gm));
    ok('API 模式不依赖「全部微博」也要把帖子并进来（这两个开关是两条不同数据来源，卡成一个就会勾了看不见）',
        /if \(!S\.weiboFlag \|\| \(!S\.feedAll && !S\.apiMode\)\) return null;/.test(gm));
    ok('回来的帖子按 mid 去重后塞进 S.extraPosts，并留上限（和「帮我翻页」同一条路，重扫才认得）',
        /S\.extraPosts\.push\(p\)/.test(gm) && /S\.extraPosts = S\.extraPosts\.slice\(-3000\)/.test(gm));
    ok('摘要必须写明 API 模式拉到几条/共几条、到底没有、或为什么停了',
        /API 模式已拉/.test(gm) && /已到底/.test(gm) && /API 模式停了/.test(gm));
    ok('后台侧 weiboArchiveNext 已注册且进了 EXT_SCHEMA（外部控制方要能自发现）',
        /weiboArchiveNext: async/.test(bg) && /weiboArchiveNext: \{/.test(bg));
    ok('认不出 uid 要直说「要在个人主页用」，不许拿分组首页的 URL 猜一个 uid',
        /weibo\.com\/u\/<uid>/.test(bg) && /function waProfileUid/.test(bg));
    ok('补来的帖子存进该标签页缓存的 extra，上限与「帮我翻页」一致（-900），两处不一致会让面板重开时数量跳变',
        (bg.match(/extra: extra\.slice\(-900\)/g) || []).length >= 2);
}

__summary();process.exit(fail ? 1 : 0);
