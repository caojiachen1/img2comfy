// 算子注册表：把 imgops/cv 的实现包成可被工具栏按钮引用的"步骤"（step）。
// 一个按钮可以串多个 step（例如 去黑边 -> 放大 2x -> 锐化），host 顺序执行。
// 参数元信息同时驱动设置页的参数编辑器，避免两处定义漂移。

import { clamp, toNum, toInt } from './util.js';
import * as G from './imgops/geometry.js';
import * as C from './imgops/color.js';
import * as F from './imgops/filter.js';
import * as E from './imgops/edge.js';
import * as CV from './cv.js';

export const P = {
    number: (key, label, def, { min = 0, max = 100, step = 1, unit = '', hint = '' } = {}) =>
        ({ key, label, type: 'number', def, min, max, step, unit, hint }),
    select: (key, label, def, options, { hint = '' } = {}) =>
        ({ key, label, type: 'select', def, options, hint }),
    color: (key, label, def = '#000000', hint = '') => ({ key, label, type: 'color', def, hint }),
    bool: (key, label, def = false) => ({ key, label, type: 'bool', def }),
    text: (key, label, def = '', hint = '') => ({ key, label, type: 'text', def, hint }),
    size: (key, label, def = '50%', hint = '') => ({ key, label, type: 'text', def, hint }),
};

function resolveParams(spec, given = {}) {
    const out = {};
    for (const p of spec) out[p.key] = given && given[p.key] !== undefined ? given[p.key] : p.def;
    return out;
}

export const STEPS = {
    resize: {
        label: '缩放',
        group: '尺寸',
        params: [
            P.select('filter', '重采样', 'lanczos3', [
                { value: 'lanczos3', label: 'Lanczos3（通用最锐）' }, { value: 'lanczos4', label: 'Lanczos4' },
                { value: 'bicubic', label: 'Bicubic(Catmull-Rom)' }, { value: 'mitchell', label: 'Mitchell-Netraval' },
                { value: 'bspline', label: 'Cubic B-spline(平滑)' }, { value: 'triangle', label: 'Bilinear' },
                { value: 'area', label: 'Area(缩小最优)' }, { value: 'box', label: 'Box' }, { value: 'nearest', label: 'Nearest(像素画)' },
            ]),
            P.select('mode', '目标', 'percent', [
                { value: 'percent', label: '百分比' }, { value: 'width', label: '按宽' },
                { value: 'height', label: '按需高' }, { value: 'longest', label: '最长边' }, { value: 'exact', label: '指定宽高' },
            ]),
            P.number('percent', '百分比', 200, { min: 1, max: 1600, step: 10, unit: '%' }),
            P.number('value', '边长', 1600, { min: 1, max: 16384, step: 10, unit: 'px' }),
            P.number('width', '宽', 0, { min: 0, max: 16384 }),
            P.number('height', '高', 0, { min: 0, max: 16384 }),
            P.bool('keepAspect', '锁定比例', true),
            P.number('maxDim', '上限边长', 8192, { min: 256, max: 16384, step: 256, unit: 'px', hint: '超过则等比夹住，防止生成超大画布拖垮页面' }),
        ],
        run(px, p) {
            const t = G.resolveSize(px, p);
            return { image: G.resize(px, t.width, t.height, p.filter), report: { from: `${px.width}x${px.height}`, to: `${t.width}x${t.height}`, filter: p.filter } };
        },
    },
    rotate: {
        label: '旋转', group: '尺寸',
        params: [
            P.number('angle', '角度', 90, { min: -360, max: 360, step: 5, unit: '°' }),
            P.bool('expand', '扩大画布', true),
            P.color('fill', '填充色', '#000000'),
            P.select('filter', '插值', 'bicubic', [{ value: 'bicubic', label: 'Bicubic' }, { value: 'lanczos3', label: 'Lanczos3' }, { value: 'nearest', label: 'Nearest' }]),
        ],
        run(px, p) {
            const f = C.hexToRgb(p.fill);
            const img = G.rotate(px, p.angle, { expand: p.expand, fill: [f[0], f[1], f[2], 255] });
            if (p.angle % 90 !== 0 && p.filter !== 'bicubic') {
                return { image: img, report: { angle: p.angle } };
            }
            return { image: img, report: { angle: p.angle } };
        },
    },
    flip: {
        label: '翻转', group: '尺寸',
        params: [P.select('dir', '方向', 'h', [{ value: 'h', label: '水平镜像' }, { value: 'v', label: '垂直翻转' }])],
        run(px, p) { return { image: G.flip(px, p.dir), report: { dir: p.dir } }; },
    },
    crop: {
        label: '裁剪', group: '尺寸',
        params: [
            P.select('mode', '方式', 'ratio', [
                { value: 'ratio', label: '比例居中裁' }, { value: 'rect', label: '绝对矩形' },
                { value: 'center', label: '按百分比保留中心' },
            ]),
            P.text('ratio', '比例', '1:1', '如 16:9 / 4:3 / 1.91:1'),
            P.number('x', 'X', 0, { min: 0, max: 16384 }), P.number('y', 'Y', 0, { min: 0, max: 16384 }),
            P.number('width', '宽', 512, { min: 1, max: 16384 }), P.number('height', '高', 512, { min: 1, max: 16384 }),
            P.number('keepPercent', '保留比例', 80, { min: 5, max: 100, unit: '%' }),
        ],
        run(px, p) {
            let rect;
            if (p.mode === 'rect') rect = { x: p.x, y: p.y, width: p.width, height: p.height };
            else if (p.mode === 'center') {
                const k = toNum(p.keepPercent, 80) / 100;
                const w = Math.round(px.width * k), h = Math.round(px.height * k);
                rect = { x: (px.width - w) / 2, y: (px.height - h) / 2, width: w, height: h };
            } else {
                const [rw, rh] = String(p.ratio).split(/[:\/x]/).map((v) => parseFloat(v));
                if (!rw || !rh) throw new Error('比例格式不正确：' + p.ratio);
                const target = rw / rh, cur = px.width / px.height;
                let w = px.width, h = px.height;
                if (cur > target) w = Math.round(px.height * target); else h = Math.round(px.width / target);
                rect = { x: (px.width - w) / 2, y: (px.height - h) / 2, width: w, height: h };
            }
            const r = G.crop(px, rect);
            return { image: r, report: { rect: { x: rect.x | 0, y: rect.y | 0, width: r.width, height: r.height } } };
        },
    },
    pad: {
        label: '补边', group: '尺寸',
        params: [
            P.number('size', '边宽', 32, { min: 0, max: 4096, unit: 'px' }),
            P.number('top', '上', -1, { min: -1, max: 4096, hint: '-1 表示用边宽' }),
            P.number('bottom', '下', -1, { min: -1, max: 4096 }),
            P.number('left', '左', -1, { min: -1, max: 4096 }),
            P.number('right', '右', -1, { min: -1, max: 4096 }),
            P.color('color', '颜色', '#ffffff'),
            P.bool('transparent', '透明填充', false),
        ],
        run(px, p) {
            const c = C.hexToRgb(p.color);
            const s = toInt(p.size, 32);
            const v = (x) => (toInt(x, -1) >= 0 ? toInt(x, 0) : s);
            return {
                image: G.pad(px, { top: v(p.top), bottom: v(p.bottom), left: v(p.left), right: v(p.right), color: p.transparent ? [0, 0, 0, 0] : [c[0], c[1], c[2], 255] }),
                report: { pad: s },
            };
        },
    },
    trim: {
        label: '裁掉边框黑边', group: '尺寸',
        params: [
            P.select('mode', '衬底', 'auto', [
                { value: 'auto', label: '自动（按四角）' }, { value: 'black', label: '纯黑' },
                { value: 'white', label: '纯白' }, { value: 'transparent', label: '透明' },
            ]),
            P.number('tolerance', '容差', 12, { min: 1, max: 120 }),
            P.number('contentRatio', '内容占比阈值', 1.5, { min: 0.1, max: 30, step: 0.1, unit: '%' }),
            P.number('maxTrimRatio', '单边裁切上限', 45, { min: 1, max: 90, unit: '%' }),
        ],
        run(px, p) {
            const r = G.trimBorder(px, {
                mode: p.mode, tolerance: p.tolerance,
                contentRatio: toNum(p.contentRatio, 1.5) / 100,
                maxTrimRatio: toNum(p.maxTrimRatio, 45) / 100,
            });
            return { image: r.image, report: r.trimmed ? { trimmed: r.trimmed } : { trimmed: null, note: '未裁切（保护阈值内）' } };
        },
    },
    border: {
        label: '圆角', group: '尺寸',
        params: [P.number('radius', '半径', 24, { min: 0, max: 2048, unit: 'px' }), P.number('feather', '羽化', 0, { min: 0, max: 64 }), P.select('corners', '角', 'all', [{ value: 'all', label: '四角' }, { value: 'tl,tr', label: '仅上' }, { value: 'bl,br', label: '仅下' }]), P.select('background', '背景', 'transparent', [{ value: 'transparent', label: '透明' }, { value: '#ffffff', label: '白' }, { value: '#000000', label: '黑' }])],
        run(px, p) { return { image: F.borderRadius(px, { radius: p.radius, feather: p.feather, corners: p.corners, background: p.background }) }; },
    },

    adjust: {
        label: '综合调色', group: '色彩',
        params: [
            P.number('brightness', '亮度', 0, { min: -100, max: 100 }),
            P.number('contrast', '对比度', 0, { min: -100, max: 100 }),
            P.number('saturation', '饱和度', 0, { min: -100, max: 100 }),
            P.number('vibrance', '自然饱和', 0, { min: -100, max: 100 }),
            P.number('hue', '色相', 0, { min: -180, max: 180, unit: '°' }),
            P.number('temperature', '色温', 0, { min: -100, max: 100 }),
            P.number('tint', '色调(绿-品)', 0, { min: -100, max: 100 }),
            P.number('gamma', 'Gamma', 1, { min: 0.2, max: 3, step: 0.05 }),
            P.number('exposure', '曝光', 0, { min: -100, max: 100, hint: '线性乘性，与亮度加性不同' }),
        ],
        run(px, p) {
            let img = px;
            const exp = toNum(p.exposure, 0);
            if (exp) img = C.mapPixels(img, (r, g, b, a, o, i) => {
                const k = Math.pow(2, exp / 50);
                o[i] = r * k; o[i + 1] = g * k; o[i + 2] = b * k; o[i + 3] = a;
            });
            if (toNum(p.brightness, 0)) img = C.brightness(img, p.brightness);
            if (toNum(p.contrast, 0)) img = C.contrast(img, p.contrast);
            if (toNum(p.gamma, 1) !== 1) img = C.gamma(img, p.gamma);
            if (toNum(p.temperature, 0)) img = C.temperature(img, p.temperature);
            if (toNum(p.tint, 0)) img = C.tint(img, p.tint);
            if (toNum(p.hue, 0)) img = C.hueRotate(img, p.hue);
            if (toNum(p.saturation, 0)) img = C.saturation(img, p.saturation);
            if (toNum(p.vibrance, 0)) img = C.vibrance(img, p.vibrance);
            return { image: img, report: { touched: Object.entries(p).filter(([k, v]) => toNum(v, 0) !== 0 && toNum(v, 1) !== 1 && k !== 'brightness').map(([k]) => k) } };
        },
    },
    brightness: { label: '亮度', group: '色彩', params: [P.number('amount', '亮度', 10, { min: -100, max: 100 })], run: (px, p) => ({ image: C.brightness(px, p.amount) }) },
    contrast: { label: '对比度', group: '色彩', params: [P.number('amount', '对比度', 10, { min: -100, max: 100 })], run: (px, p) => ({ image: C.contrast(px, p.amount) }) },
    saturation: { label: '饱和度', group: '色彩', params: [P.number('amount', '饱和度', 20, { min: -100, max: 100 })], run: (px, p) => ({ image: C.saturation(px, p.amount) }) },
    vibrance: { label: '自然饱和', group: '色彩', params: [P.number('amount', '强度', 30, { min: -100, max: 100 })], run: (px, p) => ({ image: C.vibrance(px, p.amount) }) },
    hue: { label: '色相旋转', group: '色彩', params: [P.number('degrees', '角度', 30, { min: -180, max: 180, unit: '°' })], run: (px, p) => ({ image: C.hueRotate(px, p.degrees) }) },
    gammaStep: { label: 'Gamma', group: '色彩', params: [P.number('value', 'Gamma', 1.2, { min: 0.2, max: 3, step: 0.05 })], run: (px, p) => ({ image: C.gamma(px, p.value) }) },
    grayscale: { label: '去色', group: '色彩', params: [P.select('mode', '权重', 'luma709', [{ value: 'luma709', label: 'Rec.709' }, { value: 'ccir601', label: 'Rec.601' }, { value: 'average', label: '平均' }, { value: 'lightness', label: '明度' }, { value: 'max', label: '最大通道' }])], run: (px, p) => ({ image: C.grayscale(px, p.mode) }) },
    invert: { label: '反色', group: '色彩', params: [P.bool('alpha', '同时反变换 alpha', false)], run: (px, p) => ({ image: C.invert(px, { alpha: p.alpha }) }) },
    sepia: { label: '怀旧色调', group: '色彩', params: [P.number('amount', '强度', 100, { max: 100 })], run: (px, p) => ({ image: C.sepia(px, p.amount) }) },
    duotone: { label: '双色调', group: '色彩', params: [P.color('dark', '暗部', '#1b2a4a'), P.color('light', '亮部', '#f4e9d8'), P.number('amount', '强度', 100, { max: 100 })], run: (px, p) => ({ image: C.duotone(px, p) }) },
    colorOverlay: { label: '纯色叠加', group: '色彩', params: [P.color('color', '颜色', '#000000'), P.number('opacity', '不透明度', 25, { max: 100 }), P.select('blend', '混合', 'normal', ['normal', 'multiply', 'screen', 'overlay', 'softLight', 'hardLight', 'difference', 'exclusion', 'lighten', 'darken', 'add'].map((v) => ({ value: v, label: v })))] },
    whiteBalance: { label: '白平衡', group: '色彩', params: [P.select('method', '算法', 'grey-world', [{ value: 'grey-world', label: '灰世界' }, { value: 'percentile', label: '百分位灰世界' }, { value: 'manual', label: '手动增益' }]), P.number('strength', '强度', 100, { max: 100 }), P.number('rGain', 'R 增益', 1, { min: 0.2, max: 3, step: 0.05 }), P.number('gGain', 'G 增益', 1, { min: 0.2, max: 3, step: 0.05 }), P.number('bGain', 'B 增益', 1, { min: 0.2, max: 3, step: 0.05 })], run: (px, p) => ({ image: C.whiteBalance(px, p) }) },
    levels: { label: '色阶', group: '色彩', params: [P.number('inBlack', '黑场', 0, { max: 100 }), P.number('inWhite', '白场', 100, { max: 100 }), P.number('gammaValue', '中间调', 1, { min: 0.2, max: 3, step: 0.05 }), P.number('outBlack', '输出黑', 0, { max: 100 }), P.number('outWhite', '输出白', 100, { max: 100 }), P.select('channel', '通道', 'rgb', [{ value: 'rgb', label: 'RGB' }, { value: 'luma', label: '仅亮度' }, { value: 'r', label: 'R' }, { value: 'g', label: 'G' }, { value: 'b', label: 'B' }])], run: (px, p) => ({ image: C.levels(px, p) }) },
    posterize: { label: '色阶分离', group: '色彩', params: [P.number('levelsCount', '级数', 4, { min: 2, max: 32 })], run: (px, p) => ({ image: C.posterize(px, p.levelsCount) }) },
    autoLevels: { label: '自动色阶', group: '色彩', params: [P.number('percent', '裁切', 0.5, { min: 0, max: 10, step: 0.1, unit: '%' }), P.select('channel', '通道', 'luma', [{ value: 'luma', label: '亮度' }, { value: 'r', label: 'R' }, { value: 'g', label: 'G' }, { value: 'b', label: 'B' }])], run: (px, p) => ({ image: C.autoLevels(px, p) }) },
    autoEnhance: { label: '一键增强', group: '色彩', params: [P.number('strength', '强度', 100, { max: 150 })], run: (px, p) => ({ image: C.autoEnhance(px, p) }) },
    equalize: { label: '直方图均衡', group: '色彩', params: [P.select('channel', '通道', 'luma', [{ value: 'luma', label: '亮度(保色)' }, { value: 'rgb', label: '逐通道' }])], run: (px, p) => ({ image: C.equalizeHist(px, p) }) },
    clahe: { label: '局部均衡 CLAHE', group: '色彩', params: [P.number('clipLimit', '限幅', 3, { min: 1, max: 20, step: 0.5 }), P.number('tiles', '分块', 8, { min: 2, max: 24 })], run: (px, p) => ({ image: C.clahe(px, p) }) },
    channelMixer: { label: '通道混合器', group: '色彩', params: [P.text('r', 'R 输出', '100,0,0'), P.text('g', 'G 输出', '0,100,0'), P.text('b', 'B 输出', '0,0,100')], run(px, p) { return { image: C.channelMixer(px, { r: parseTriple(p.r), g: parseTriple(p.g), b: parseTriple(p.b) }) }; } },

    gaussianBlur: { label: '高斯模糊', group: '滤镜', params: [P.number('sigma', 'Sigma', 3, { min: 0.2, max: 40, step: 0.2, unit: 'px' })], run: (px, p) => ({ image: F.gaussianBlur(px, p.sigma) }) },
    boxBlur: { label: '均值模糊', group: '滤镜', params: [P.number('radius', '半径', 4, { min: 1, max: 60, unit: 'px' })], run: (px, p) => ({ image: F.boxBlur(px, p.radius) }) },
    median: { label: '中值滤波', group: '滤镜', params: [P.number('radius', '半径', 1, { min: 1, max: 6, unit: 'px' })], run: (px, p) => ({ image: F.medianFilter(px, p.radius) }) },
    bilateral: { label: '双边降噪(保边)', group: '滤镜', params: [P.number('spaceSigma', '空间', 8, { min: 1, max: 30 }), P.number('rangeSigma', '色域', 35, { min: 1, max: 150 })], run: (px, p) => ({ image: F.bilateralFilter(px, p) }) },
    noise: { label: '加噪', group: '滤镜', params: [P.select('type', '类型', 'gaussian', [{ value: 'gaussian', label: '高斯' }, { value: 'speckle', label: '乘性斑点' }, { value: 'saltPepper', label: '椒盐' }]), P.number('amount', '强度', 12, { max: 100 }), P.number('seed', '种子', 1, { min: 1, max: 99999 })], run: (px, p) => ({ image: F.addNoise(px, p) }) },
    pixelate: { label: '像素化', group: '滤镜', params: [P.number('size', '块大小', 12, { min: 2, max: 200, unit: 'px' }), P.select('mode', '方式', 'avg', [{ value: 'avg', label: '块平均' }, { value: 'sample', label: '取左上' }])], run: (px, p) => ({ image: F.pixelate(px, { size: p.size, mode: p.mode === 'avg' ? 'block' : 'sample' }) }) },
    oilPaint: { label: '油画', group: '滤镜', params: [P.number('radius', '半径', 3, { min: 1, max: 8 }), P.number('intensity', '色阶数', 30, { min: 4, max: 128 })], run: (px, p) => ({ image: F.oilPaint(px, p) }) },
    vignette: { label: '暗角', group: '滤镜', params: [P.number('amount', '强度', 60, { min: -100, max: 100 }), P.number('radius', '内圈', 70, { max: 100, unit: '%' }), P.number('soften', '过渡', 40, { max: 100 }), P.color('color', '颜色', '#000000')], run: (px, p) => ({ image: F.vignette(px, p) }) },
    chromaKey: { label: '抠色(去背景)', group: '滤镜', params: [P.color('color', '键控色', '#00ff00'), P.number('tolerance', '容差', 40, { min: 1, max: 200 }), P.number('feather', '羽化', 10, { min: 0, max: 60 }), P.select('model', '模型', 'rgb', [{ value: 'rgb', label: 'RGB 距离' }, { value: 'hsv', label: 'HSV 锥' }]), P.bool('invert', '反转', false)], run: (px, p) => ({ image: F.chromaKey(px, p) }) },

    unsharp: { label: 'USM 锐化', group: '锐化/边缘', params: [P.number('radius', '半径', 2, { min: 0.3, max: 30, step: 0.1, unit: 'px' }), P.number('amount', '数量', 120, { min: 0, max: 400, unit: '%' }), P.number('threshold', '阈值', 2, { min: 0, max: 60 })], run: (px, p) => ({ image: F.unsharp(px, p) }) },
    sharpen: { label: '锐化核', group: '锐化/边缘', params: [P.number('amount', '强度', 60, { min: 0, max: 200 }), P.bool('soft', '柔和核', false)], run: (px, p) => ({ image: F.sharpen(px, p.amount, p.soft) }) },
    sobel: { label: 'Sobel 边缘', group: '锐化/边缘', params: [P.select('mode', '方向', 'magnitude', [{ value: 'magnitude', label: '梯度幅值' }, { value: 'x', label: 'X' }, { value: 'y', label: 'Y' }])], run: (px, p) => ({ image: E.sobel(px, p) }) },
    scharr: { label: 'Scharr 边缘', group: '锐化/边缘', params: [], run: (px) => ({ image: E.scharr(px) }) },
    laplacian: { label: 'Laplacian', group: '锐化/边缘', params: [P.select('kernel', '核', '4', [{ value: '4', label: '4 邻域' }, { value: '8', label: '8 邻域' }]), P.select('scale', '输出', 'abs', [{ value: 'abs', label: '绝对值' }, { value: 'offset', label: '叠加灰底' }])], run: (px, p) => ({ image: E.laplacian(px, p) }) },
    canny: { label: 'Canny 边缘', group: '锐化/边缘', params: [P.number('low', '低阈值', 40, { max: 255 }), P.number('high', '高阈值', 120, { max: 255 }), P.number('sigma', '预模糊', 1.4, { min: 0, max: 10, step: 0.1 })], run: (px, p) => ({ image: E.canny(px, p) }) },
    log: { label: 'LoG 边缘', group: '锐化/边缘', params: [P.number('sigma', 'Sigma', 2, { min: 0.5, max: 20, step: 0.5 }), P.number('scale', 'DoG 比', 1.6, { min: 1.1, max: 4, step: 0.1 })], run: (px, p) => ({ image: E.logEdge(px, p) }) },
    threshold: { label: '二值化', group: '锐化/边缘', params: [P.select('mode', '算法', 'otsu', [{ value: 'otsu', label: 'Otsu' }, { value: 'fixed', label: '固定阈值' }, { value: 'mean', label: '自适应均值' }, { value: 'sauvola', label: 'Sauvola' }, { value: 'localSigma', label: '局部 std 加权' }]), P.number('value', '固定阈值', 128, { max: 255 }), P.number('blockSize', '窗口', 31, { min: 3, max: 201, step: 2 }), P.number('C', '常数 C', 8, { min: -50, max: 50 }), P.number('k', 'k (Sauvola)', 0.2, { min: 0, max: 1, step: 0.05 }), P.bool('invert', '反相', false)], run: (px, p) => ({ image: E.threshold(px, p) }) },
    morphology: { label: '形态学', group: '锐化/边缘', params: [P.select('op', '操作', 'close', ['erode', 'dilate', 'open', 'close', 'gradient', 'tophat', 'blackhat'].map((v) => ({ value: v, label: v }))), P.number('radius', '半径', 1, { min: 1, max: 12 }), P.select('shape', '结构元', 'rect', [{ value: 'rect', label: '方形' }, { value: 'cross', label: '十字' }, { value: 'circle', label: '圆' }])], run: (px, p) => ({ image: E.morphology(px, p) }) },

    stats: { label: '图像统计', group: '分析', analysis: true, params: [], run: (px) => ({ report: CV.stats(px) }) },
    histogram: { label: '直方图', group: '分析', analysis: true, params: [P.number('bins', '分箱', 64, { min: 8, max: 256, step: 8 }), P.select('channel', '通道', 'luma', ['luma', 'r', 'g', 'b', 'alpha'].map((v) => ({ value: v, label: v })))], run(px, p) { const h = CV.histogram(px, p.bins, p.channel); return { report: { entropy: h.entropy, bins: h.bins } }; } },
    palette: { label: '主色板', group: '分析', analysis: true, params: [P.number('count', '颜色数', 6, { min: 2, max: 16 })], run: (px, p) => ({ report: CV.palette(px, p) }) },
    regions: { label: '连通域统计', group: '分析', analysis: true, params: [P.number('threshold', '二值化阈值', 128, { max: 255 }), P.number('minArea', '最小面积', 50, { max: 100000 }), P.number('connectivity', '连通', 8, { min: 4, max: 8, step: 4 })], run(px, p) { const bin = E.threshold(px, { mode: 'fixed', value: p.threshold }); const r = CV.connectedComponents(bin, { connectivity: p.connectivity, minArea: p.minArea, binarize: false }); return { report: { count: r.count, top: r.regions.slice(0, 12).map((x) => ({ area: x.area, ...x.x !== undefined ? { x: x.x, y: x.y, width: x.width, height: x.height } : {} })) }, boxes: r.regions.slice(0, 40).map((x) => ({ x: x.x, y: x.y, width: x.width, height: x.height, label: String(x.area) })) }; } },
    contours: { label: '轮廓检测', group: '分析', analysis: true, params: [P.number('threshold', '二值化', 128, { max: 255 }), P.number('simplify', '简化 eps', 1.5, { min: 0, max: 10, step: 0.5 }), P.number('minArea', '最小面积', 60, { max: 100000 })], run(px, p) { const bin = E.threshold(px, { mode: 'fixed', value: p.threshold }); const cs = CV.contours(bin, { binarize: false, threshold: 0, simplify: p.simplify, minArea: p.minArea }); return { report: { count: cs.length, areas: cs.slice(0, 10).map((c) => Math.round(c.area)) }, boxes: cs.slice(0, 40).map((c) => ({ ...c.boundingRect, label: String(Math.round(c.area)) })) }; } },
    corners: { label: 'Harris 角点', group: '分析', analysis: true, params: [P.number('blockSize', '窗口', 3, { min: 1, max: 9 }), P.number('k', 'k', 0.04, { min: 0, max: 0.5, step: 0.01 }), P.number('thresholdRatio', '响应阈值', 1, { min: 0.1, max: 30, step: 0.1, unit: '%' }), P.number('maxCorners', '最多', 120, { min: 1, max: 1000 })], run(px, p) { const c = CV.harrisCorners(px, { ...p, thresholdRatio: toNum(p.thresholdRatio, 1) / 100 }); return { report: { count: c.length }, points: c.map((o) => ({ x: o.x, y: o.y })) }; } },
    lines: { label: '霍夫直线', group: '分析', analysis: true, params: [P.number('threshold', '投票数', 120, { min: 10, max: 5000 }), P.number('thetaSteps', '角度分辨率', 180, { min: 36, max: 720, step: 36 }), P.number('maxLines', '最多线数', 12, { min: 1, max: 100 }), P.select('pre', '预处理', 'canny', [{ value: 'none', label: '输入已二值' }, { value: 'canny', label: 'Canny' }, { value: 'sobel', label: 'Sobel' }])], run(px, p) { const edge = p.pre === 'canny' ? E.canny(px, {}) : p.pre === 'sobel' ? E.sobel(px, { mode: 'magnitude' }) : px; const bin = E.threshold(edge, { mode: 'fixed', value: 60 }); const l = CV.houghLines(bin, { threshold: p.threshold, thetaSteps: p.thetaSteps, maxLines: p.maxLines }); return { report: { count: l.length }, lines: l } } },
    hashes: { label: '感知哈希', group: '分析', analysis: true, params: [], run: (px) => ({ report: { aHash: CV.aHash(px), dHash: CV.dHash(px), pHash: CV.pHash(px) } }) },
    detectSize: {
        label: '内容区测量', group: '分析', analysis: true,
        params: [P.select('mode', '衬底', 'auto', [{ value: 'auto', label: '自动' }, { value: 'black', label: '黑' }, { value: 'white', label: '白' }])],
        run(px, p) {
            const t = G.trimBorder(px, { mode: p.mode, tolerance: 20 });
            return {
                report: {
                    original: px.width + 'x' + px.height,
                    content: t.trimmed ? `${t.trimmed.width}x${t.trimmed.height} @${t.trimmed.x},${t.trimmed.y}` : '整幅',
                    aspect: (px.width / px.height).toFixed(3),
                },
            };
        },
    },
};

STEPS.colorOverlay.run = (px, p) => ({ image: C.colorOverlay(px, p) });

function parseTriple(s) {
    return String(s || '').split(/[,;\s]+/).map((v) => parseFloat(v)).filter((v) => Number.isFinite(v));
}

export function normalizeChain(steps) {
    return (steps || []).filter((x) => x && STEPS[x.op]).map((x) => ({ op: x.op, params: x.params || {} }));
}

export function runChain(px, chain, ctx = {}) {
    let cur = px;
    const reports = [];
    const boxes = [];
    const points = [];
    const lines = [];
    for (const step of chain) {
        const spec = STEPS[step.op];
        if (!spec) throw new Error('未知算子: ' + step.op);
        const params = resolveParams(spec.params, step.params);
        const res = spec.run(cur, params, ctx);
        if (res.image) cur = res.image;
        if (res.report) reports.push({ op: step.op, ...res.report });
        if (res.boxes) boxes.push(...res.boxes);
        if (res.points) points.push(...res.points);
        if (res.lines) lines.push(...res.lines);
    }
    return { image: cur, reports, boxes, points, lines };
}

export function stepParamDefaults(opId) {
    const spec = STEPS[opId];
    return spec ? resolveParams(spec.params, {}) : {};
}

export function stepLabel(opId) {
    return STEPS[opId]?.label || opId;
}

export function stepGroups() {
    const g = {};
    for (const [id, s] of Object.entries(STEPS)) (g[s.group] = g[s.group] || []).push(id);
    return g;
}

export { clamp };
