// 人脸识别两件套：检测（YuNet 或 insightface 的 SCRFD）+ 识别（w600k 系 embedding）。
// YuNet 输出 [1, N, 15]；SCRFD 导出是 9 个数字名输出（3 层 scores/bbox/kps），
// 预处理与解码公式全部照抄 insightface 的 python-package/insightface/model_zoo/scrfd.py。

import { clamp } from '../util.js';
import { resize as resizePx, mkPx } from '../imgops/geometry.js';
import { pxToCanvas } from './input.js';
import { msFile } from './sources.js';

// OpenCV YuNet 的官方预处理：BGR 通道，先减均值再除 255
const MEAN = [104, 117, 123];
const STD = [1, 1, 1];
// insightface：blobFromImage(img, 1/128, size, mean=127.5, swapRB=true) → RGB
const SCRFD_MEAN = 127.5;
const SCRFD_STD = 128.0;
const SCRFD_STRIDES = [8, 16, 32, 64, 128];
// 特征点顺序：右眼、左眼、鼻尖、右嘴角、左嘴角（与 arcface 模板行序一致）
const KP_NAMES = ['rightEye', 'leftEye', 'nose', 'mouthRight', 'mouthLeft'];

// 首选源是自己镜像到 ModelScope 的 mtb-face（实测 5~14 MB/s，且扩展页跨源有 CORS），
// alt 保留原始出处，ModelScope 挂了还能回退。两份都核过 sha256 一致。
export const FACE_MODEL_PRESETS = [
    {
        id: 'yunet-2023mar', name: 'YuNet 2023mar（OpenCV，232KB，最快）',
        url: msFile('mtb-face/resolve/master/face_detection_yunet_2023mar.onnx'),
        alt: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
        bytes: 232589,
    },
    {
        // digiKam 同款路线：SCRFD 检测 + 5 点特征，用来做对齐后的识别
        id: 'scrfd-500m', name: 'SCRFD 500m（insightface buffalo_sc，2.5MB，带 5 点）',
        url: msFile('mtb-face/resolve/master/det_500m.onnx'),
        alt: 'https://hf-mirror.com/WePrompt/buffalo_sc/resolve/main/det_500m.onnx',
        bytes: 2524817,
    },
    {
        id: 'scrfd-10g', name: 'SCRFD det_10g（insightface buffalo_l，16.9MB，更稳）',
        url: msFile('mtb-face/resolve/master/det_10g.onnx'),
        alt: 'https://hf-mirror.com/public-data/insightface/resolve/main/models/buffalo_l/det_10g.onnx',
        bytes: 16923827,
    },
    { id: 'custom', name: '自定义 ONNX URL', url: '', alt: '', bytes: 0, note: '在下面填完整 URL' },
];

export const FACE_EMBED_PRESETS = [
    {
        id: 'w600k-mbf', name: 'w600k_mbf（insightface 识别头，13.6MB，512 维）',
        url: msFile('mtb-face/resolve/master/w600k_mbf.onnx'),
        alt: 'https://hf-mirror.com/WePrompt/buffalo_sc/resolve/main/w600k_mbf.onnx',
        bytes: 13616099, dim: 512,
    },
    { id: 'custom', name: '自定义识别模型 URL', url: '', alt: '', bytes: 0, dim: 512 },
];

export function resolveFaceModel(ai = {}) {
    const preset = FACE_MODEL_PRESETS.find((p) => p.id === (ai.faceModel || 'scrfd-500m')) || FACE_MODEL_PRESETS[1];
    const urls = [];
    if (ai.faceModelUrl) urls.push(ai.faceModelUrl);
    if (preset.url) urls.push(preset.url);
    if (preset.alt) urls.push(preset.alt);
    return { url: urls[0] || '', urls, preset };
}

export function resolveEmbedModel(ai = {}) {
    const preset = FACE_EMBED_PRESETS.find((p) => p.id === (ai.faceEmbedModel || 'w600k-mbf')) || FACE_EMBED_PRESETS[0];
    const urls = [];
    if (ai.faceEmbedUrl) urls.push(ai.faceEmbedUrl);
    if (preset.url) urls.push(preset.url);
    if (preset.alt) urls.push(preset.alt);
    return { url: urls[0] || '', urls, preset };
}

function buildTensor(px) {
    const { width, height, data } = px;
    const n = width * height;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        for (let c = 0; c < 3; c++) {
            arr[c * n + i] = (data[i * 4 + (2 - c)] - MEAN[c]) / STD[c]; // YuNet 吃 BGR
        }
    }
    return { data: arr, dims: [1, 3, height, width] };
}

// SCRFD / 识别头：RGB，(v-127.5)/std
function buildTensorRgb(px, std = SCRFD_STD) {
    const { width, height, data } = px;
    const n = width * height;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        arr[i] = (data[i * 4] - SCRFD_MEAN) / std;
        arr[n + i] = (data[i * 4 + 1] - SCRFD_MEAN) / std;
        arr[2 * n + i] = (data[i * 4 + 2] - SCRFD_MEAN) / std;
    }
    return { data: arr, dims: [1, 3, height, width] };
}

// insightface::_detect_candidates：等比缩放后贴左上，其余补 0；坐标回除 detScale
function letterboxPx(px, tw, th) {
    const imRatio = px.height / px.width, modelRatio = th / tw;
    let nw, nh;
    if (imRatio > modelRatio) { nh = th; nw = Math.max(1, Math.round(th / imRatio)); }
    else { nw = tw; nh = Math.max(1, Math.round(tw * imRatio)); }
    const scaled = (nw === px.width && nh === px.height) ? px : resizePx(px, nw, nh, 'triangle');
    const out = mkPx(tw, th);
    const rowBytes = scaled.width * 4;
    for (let y = 0; y < scaled.height; y++) out.data.set(scaled.data.subarray(y * rowBytes, y * rowBytes + rowBytes), y * tw * 4);
    out.detScale = nh / px.height;
    return out;
}

/**
 * 网络输入尺寸：opencv_zoo 的 YuNet 导出是固定 640x640，
 * 也有动态版本（dims 里是字符串/'s'）。固定尺寸必须照用，否则 OrtRun 直接报
 * "Got invalid dimensions"。动态尺寸按 32 对齐上取整（YuNet 主干要求）。
 */
export function inferInputSpec(session, px) {
    let dims = [];
    try {
        // ORT-web 1.31 的会话把输入维度放在 inputMetadata[0].shape（不是 dimensions）
        const meta = session.inputMetadata && session.inputMetadata[0];
        dims = session.inputDims || (meta && (meta.shape || meta.dimensions)) || [];
    } catch (e) { dims = []; }
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
    const h = num(dims[2]), w = num(dims[3]);
    if (h && w) return { width: w, height: h, fixed: true };
    const align = (v) => Math.max(32, Math.ceil(v / 32) * 32);
    return { width: align(px.width), height: align(px.height), fixed: false };
}

function softmax(arr) {
    const m = Math.max(...arr);
    const ex = Array.from(arr, (v) => Math.exp(v - m));
    const s = ex.reduce((a, b) => a + b, 0);
    return ex.map((v) => v / s);
}

function nms(boxes, overlap = 0.3) {
    const sorted = boxes.slice().sort((a, b) => b.score - a.score);
    const keep = [];
    for (const b of sorted) {
        let ok = true;
        for (const k of keep) {
            const ix = Math.max(0, Math.min(b.x + b.width, k.x + k.width) - Math.max(b.x, k.x));
            const iy = Math.max(0, Math.min(b.y + b.height, k.y + k.height) - Math.max(b.y, k.y));
            const inter = ix * iy;
            if (inter > overlap * (b.width * b.height + k.width * k.height - inter)) { ok = false; break; }
        }
        if (ok) keep.push(b);
    }
    return keep;
}

export async function detectFaces(session, px, { confThreshold = 0.6, nmsThreshold = 0.3, topK = 200, inputSize = 640 } = {}) {
    const spec = inferInputSpec(session, px);
    const ort = globalThis.ort;
    if (isScrfdSession(session)) return detectFacesScrfd(session, px, spec, { confThreshold, nmsThreshold, topK, inputSize });
    // 送进网络前把图缩到网络尺寸，输出坐标再按同样的比例映射回原图
    const resized = (spec.width === px.width && spec.height === px.height) ? px : resizePx(px, spec.width, spec.height, 'triangle');
    const tensor = buildTensor(resized);
    const sx = spec.width / px.width, sy = spec.height / px.height;
    const input = new ort.Tensor('float32', tensor.data, tensor.dims);
    const inputName = session.inputNames[0];
    const results = await session.run({ [inputName]: input });
    const outName = session.outputNames[0];
    const out = results[outName];
    const dims = out.dims;
    const data = out.data;
    const faces = [];
    if (dims.length === 3 && dims[2] >= 15) {
        const n = dims[1];
        for (let i = 0; i < n; i++) {
            const base = i * dims[2];
            const score = data[base + 14];
            if (score < confThreshold) continue;
            const xs = [], ys = [];
            for (let k = 0; k < 5; k++) { xs.push(data[base + 4 + k]); ys.push(data[base + 9 + k]); }
            faces.push({
                x: data[base], y: data[base + 1], width: data[base + 2], height: data[base + 3],
                score,
                landmarks: { leftEye: [xs[0], ys[0]], rightEye: [xs[1], ys[1]], nose: [xs[2], ys[2]], mouthLeft: [xs[3], ys[3]], mouthRight: [xs[4], ys[4]] },
                roll: data[base + 4 + 5] ?? null,
            });
        }
    } else {
        const names = Object.keys(results);
        if (names.some((n) => /^cls_\d+$/.test(n))) {
            // YuNet 多输出：解码出来的坐标已经按网络尺寸/原图尺寸比例映射回原图
            const cand = decodeYunetMultiOutput(results, spec.width, spec.height, px.width, px.height, confThreshold)
                .filter((f) => f.score >= confThreshold);
            const kept = nms(cand, nmsThreshold).slice(0, topK).map((f) => ({
                ...f,
                x: clamp(Math.round(f.x), 0, px.width - 1),
                y: clamp(Math.round(f.y), 0, px.height - 1),
                width: clamp(Math.round(f.width), 1, px.width),
                height: clamp(Math.round(f.height), 1, px.height),
                score: Number(f.score.toFixed(3)),
            }));
            return { faces: kept, backend: 'yunet-multistage', outputShape: names.join(','), netInput: spec.width + 'x' + spec.height, fixedInput: spec.fixed };
        }
        throw new Error('认不出的检测模型输出：' + names.join(','));
    }
    for (const f of faces) {
        f.x /= sx; f.y /= sy; f.width /= sx; f.height /= sy;
        if (f.landmarks) for (const k of Object.keys(f.landmarks)) f.landmarks[k] = [f.landmarks[k][0] / sx, f.landmarks[k][1] / sy];
    }
    const kept = nms(faces, nmsThreshold).slice(0, topK).map((f) => ({
        ...f,
        x: clamp(Math.round(f.x), 0, px.width - 1),
        y: clamp(Math.round(f.y), 0, px.height - 1),
        width: clamp(Math.round(f.width), 1, px.width),
        height: clamp(Math.round(f.height), 1, px.height),
        score: Number(f.score.toFixed(3)),
    }));
    return { faces: kept, backend: 'yunet', outputShape: dims.join('x'), netInput: spec.width + 'x' + spec.height, fixedInput: spec.fixed };
}

// OpenCV Zoo 的 YuNet 导出是**多输出 SSD 原始格式**（cls_8/16/32、obj_*、bbox_*、kps_*），
// 不是官方 browser 版那种单 [1,N,15] detections。张量是 channels-last：cls/obj=[1,N,1]、
// bbox=[1,N,4]、kps=[1,N,10]，N=(netW/stride)*(netH/stride)，每格一个 anchor。
// 解码公式照抄 OpenCV 参考实现（modules/objdetect/src/face_detect.cpp::postProcess）：
//   score = sqrt(clamp(cls) * clamp(obj))            ← 只用 cls 会把背景格也算成 0.4~0.9
//   cx = (col + dx) * stride,  w = exp(dw) * stride  ← 没有 0.1/0.2 缩放，也不含 min_size anchor
//   kps = (kx + col) * stride
// 特征点顺序是 右眼、左眼、鼻尖、嘴角右、嘴角左（OpenCV 注释 re/le/nt/rcm/lcm）。
const STRIDES = [8, 16, 32];

function decodeYunetMultiOutput(results, netW, netH, outW, outH, confThreshold = 0.6) {
    const cand = [];
    // 先用一个较低的先验门槛粗筛，真正的 confThreshold 在 nms 前统一生效
    const confFloor = Math.min(0.3, confThreshold);
    const sx = outW / netW, sy = outH / netH;
    for (const stride of STRIDES) {
        const cls = results[`cls_${stride}`];
        const obj = results[`obj_${stride}`];
        const bbox = results[`bbox_${stride}`];
        const kps = results[`kps_${stride}`];
        if (!cls || !obj || !bbox) continue;
        const cols = Math.max(1, Math.floor(netW / stride));
        const rows = Math.max(1, Math.floor(netH / stride));
        const n = Math.min(rows * cols, cls.data.length);
        const bd = bbox.data, cd = cls.data, od = obj.data, kd = kps ? kps.data : null;
        const hasKps = !!kd && kd.length >= n * 10;
        for (let p = 0; p < n; p++) {
            const col = p % cols, row = Math.floor(p / cols);
            const cs = Math.max(0, Math.min(1, cd[p]));
            const os = Math.max(0, Math.min(1, od[p]));
            const score = Math.sqrt(cs * os);
            if (!(score >= confFloor)) continue;
            const i4 = p * 4;
            const cx = (col + bd[i4]) * stride, cy = (row + bd[i4 + 1]) * stride;
            const w = Math.exp(Math.min(12, bd[i4 + 2])) * stride;
            const h = Math.exp(Math.min(12, bd[i4 + 3])) * stride;
            const box = {
                x: (cx - w / 2) * sx, y: (cy - h / 2) * sy,
                width: w * sx, height: h * sy, score,
            };
            const landmarks = {};
            if (hasKps) {
                for (let m = 0; m < 5; m++) {
                    landmarks[KP_NAMES[m]] = [(kd[p * 10 + 2 * m] + col) * stride * sx, (kd[p * 10 + 2 * m + 1] + row) * stride * sy];
                }
            }
            if (box.x < outW && box.y < outH && box.x + box.width > 0 && box.y + box.height > 0 && box.width > 4 && box.height > 4) {
                cand.push({ ...box, landmarks });
            }
        }
    }
    return cand;
}


// SCRFD（insightface）导出：9 个数字名输出，按层分组排列为
//   [scores×fmc, bbox×fmc, kps×fmc]，每个张量已展平成 (N, C)，N = 格数 × 每格 anchor 数。
// 解码照抄 python-package/insightface/model_zoo/scrfd.py：
//   anchor 中心 = (格列, 格行) × stride（整数格点，不加 0.5），平铺顺序是「格在前、anchor 在后」
//   bbox = 中心 ∓ 预测距离×stride（左上右下），kps = 中心 + 预测偏移×stride
//   预处理 RGB、(v-127.5)/128，等比 letterbox 补黑边，坐标回除 detScale
export function isScrfdSession(session) {
    const names = session.outputNames || [];
    if (names.length < 6 || names.length % 3 !== 0) return false;
    return !names.some((n) => /^(cls|obj|bbox|kps)_\d+$/.test(n));
}

async function detectFacesScrfd(session, px, spec, { confThreshold, nmsThreshold, topK, inputSize = 640 }) {
    const ort = globalThis.ort;
    // 动态尺寸输入也必须按 640×640 送：insightface 的权重就是在这个尺度上训的，
    // 「按图片尺寸向上对齐」会让正脸的置信度从 0.99 掉到 0.6 并漏检小脸。
    const netW = spec.fixed ? spec.width : inputSize;
    const netH = spec.fixed ? spec.height : inputSize;
    const fed = letterboxPx(px, netW, netH);
    const tensor = buildTensorRgb(fed);
    const results = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', tensor.data, tensor.dims) });
    const names = session.outputNames;
    const fmc = names.length / 3;
    const strides = SCRFD_STRIDES.slice(0, fmc);
    const cand = [];
    for (let idx = 0; idx < fmc; idx++) {
        const sc = results[names[idx]], bb = results[names[idx + fmc]], kp = results[names[idx + 2 * fmc]];
        if (!sc || !bb) continue;
        const stride = strides[idx];
        const fw = Math.floor(netW / stride), fh = Math.floor(netH / stride);
        const n = sc.dims[0];
        const anchors = Math.max(1, Math.round(n / (fw * fh)));
        const bc = bb.dims[1] || 4;
        const kc = kp ? (kp.dims[1] || 10) : 0;
        const sd = sc.data, bd = bb.data, kd = kp ? kp.data : null;
        for (let j = 0; j < n; j++) {
            const score = sd[j];
            if (score < confThreshold) continue;
            const cell = anchors === 1 ? j : Math.floor(j / anchors);
            const cx = (cell % fw) * stride, cy = Math.floor(cell / fw) * stride;
            const o = j * bc;
            const left = bd[o] * stride, top = bd[o + 1] * stride, right = bd[o + 2] * stride, bottom = bd[o + 3] * stride;
            const landmarks = {};
            if (kd) {
                const p = j * kc;
                for (let m = 0; m < 5 && 2 * m + 1 < kc; m++) landmarks[KP_NAMES[m]] = [cx + kd[p + 2 * m] * stride, cy + kd[p + 2 * m + 1] * stride];
            }
            cand.push({ x: cx - left, y: cy - top, width: left + right, height: top + bottom, score, landmarks });
        }
    }
    const inv = 1 / (fed.detScale || 1);
    const back = cand.map((f) => rescaleScrfdFace(f, inv, px));
    const kept = nms(back, nmsThreshold).slice(0, topK);
    return { faces: kept, backend: 'scrfd', outputShape: names.length + ' outputs, strides ' + strides.join('/'), netInput: netW + 'x' + netH, fixedInput: spec.fixed };
}

function rescaleScrfdFace(f, k, px) {
    const landmarks = {};
    for (const key of Object.keys(f.landmarks || {})) {
        landmarks[key] = [f.landmarks[key][0] * k, f.landmarks[key][1] * k];
    }
    return {
        x: clamp(Math.round(f.x * k), 0, px.width - 1),
        y: clamp(Math.round(f.y * k), 0, px.height - 1),
        width: clamp(Math.round(f.width * k), 1, px.width),
        height: clamp(Math.round(f.height * k), 1, px.height),
        score: Number(f.score.toFixed(3)),
        landmarks: Object.keys(landmarks).length ? landmarks : null,
    };
}

// 用 5 点估算 roll 角，供"自动摆正人脸"用
export function faceAngle(face) {
    if (!face.landmarks) return 0;
    const [lx, ly] = face.landmarks.leftEye;
    const [rx, ry] = face.landmarks.rightEye;
    return Math.atan2(ry - ly, rx - lx) * 180 / Math.PI;
}

export function faceCropRect(face, { pad = 0.3, square = true } = {}) {
    const w = face.width * (1 + pad * 2), h = face.height * (1 + pad * 2);
    const size = square ? Math.max(w, h) : 0;
    return {
        x: Math.round(face.x - face.width * pad - (square ? (size - w) / 2 : 0)),
        y: Math.round(face.y - face.height * pad - (square ? (size - h) / 2 : 0)),
        width: Math.round(square ? size : w),
        height: Math.round(square ? size : h),
    };
}

export function softmaxHead(arr) { return softmax(arr); }

// ---------------------------------------------------------------- 识别（embedding）
// insightface 的 112×112 对齐模板，行序与 KP_NAMES 一致（右眼、左眼、鼻尖、右嘴角、左嘴角）
export const ARCFACE_TEMPLATE = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

// 无镜像相似变换的最小二乘闭式解（等价 skimage SimilarityTransform.estimate）：w = λ·z + t
export function similarityTransform(src, dst) {
    const n = Math.min(src.length, dst.length);
    let zx = 0, zy = 0, wx = 0, wy = 0;
    for (let i = 0; i < n; i++) { zx += src[i][0]; zy += src[i][1]; wx += dst[i][0]; wy += dst[i][1]; }
    zx /= n; zy /= n; wx /= n; wy /= n;
    let numRe = 0, numIm = 0, den = 0;
    for (let i = 0; i < n; i++) {
        const dx = src[i][0] - zx, dy = src[i][1] - zy;
        const ex = dst[i][0] - wx, ey = dst[i][1] - wy;
        numRe += dx * ex + dy * ey;          // Re(conj(z)·w)
        numIm += dx * ey - dy * ex;          // Im(conj(z)·w)
        den += dx * dx + dy * dy;
    }
    const a = den ? numRe / den : 1, b = den ? numIm / den : 0;
    return { a, b, tx: wx - (a * zx - b * zy), ty: wy - (b * zx + a * zy) };
}

export function hasLandmarks(face) {
    return !!(face && face.landmarks && KP_NAMES.every((k) => face.landmarks[k]));
}

// 按 5 点把人脸摆正裁成 size×size（识别头只认这个姿态）；缺特征点返回 null
export function alignFace(px, landmarks, size = 112) {
    const pts = KP_NAMES.map((k) => (landmarks || {})[k]);
    if (pts.some((p) => !p)) return null;
    const k = size / 112;
    const m = similarityTransform(pts, ARCFACE_TEMPLATE.map(([x, y]) => [x * k, y * k]));
    const Ctor = typeof OffscreenCanvas !== 'undefined' ? OffscreenCanvas : HTMLCanvasElement;
    const cv = new Ctor(size, size);
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.setTransform(m.a, m.b, -m.b, m.a, m.tx, m.ty);
    g.drawImage(pxToCanvas(px), 0, 0);
    const id = g.getImageData(0, 0, size, size);
    const out = mkPx(size, size);
    out.data.set(new Uint8ClampedArray(id.data));
    return out;
}

// 检测框退化用：没有特征点时按框居中裁成正方形
export function alignByBox(px, face, size = 112) {
    const r = faceCropRect(face, { pad: 0.25, square: true });
    const x0 = clamp(r.x, 0, px.width - 1), y0 = clamp(r.y, 0, px.height - 1);
    const w = clamp(r.width, 1, px.width - x0), h = clamp(r.height, 1, px.height - y0);
    const crop = mkPx(w, h);
    for (let y = 0; y < h; y++) {
        const sy = (y0 + y) * px.width * 4 + x0 * 4;
        crop.data.set(px.data.subarray(sy, sy + w * 4), y * w * 4);
    }
    return resizePx(crop, size, size, 'triangle');
}

export async function embedFace(session, alignedPx, { std = 127.5 } = {}) {
    const ort = globalThis.ort;
    const tensor = buildTensorRgb(alignedPx, std);
    const res = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', tensor.data, tensor.dims) });
    const out = res[session.outputNames[0]];
    return l2normalize(Float32Array.from(out.data.subarray(0, out.data.length)));
}

export function l2normalize(v) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    s = Math.sqrt(s);
    if (!s) return v;
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
    return out;
}

// 两个向量都归一化过，点积即余弦
export function cosineSim(a, b) {
    const n = Math.min(a.length, b.length);
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
}

export function matchGallery(vector, gallery = [], threshold = 0.35) {
    let best = null;
    for (const entry of gallery) {
        if (!entry || !entry.vector) continue;
        const sim = cosineSim(vector, typeof entry.vector === 'string' ? unpackVector(entry.vector) : entry.vector);
        if (!best || sim > best.sim) best = { name: entry.name || '(未命名)', sim, id: entry.id };
    }
    return { match: best && best.sim >= threshold ? best : null, best, threshold };
}

// 存进设置需要可序列化的形式：Float32 小端字节 → base64
export function packVector(v) {
    const bytes = new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
    return btoa(bin);
}

export function unpackVector(b64) {
    const bin = atob(String(b64));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Float32Array(u8.buffer, 0, Math.floor(u8.byteLength / 4));
}
