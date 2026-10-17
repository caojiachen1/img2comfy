// YuNet 人脸检测（OpenCV Zoo 的 330KB ONNX，纯 ORT 推理，不需要 transformers.js）。
// 输入尺寸可变，按 8 对齐上取整；输出 [1, N, 15]：每行
// [x, y, w, h, 5 个点 x(5), 5 个点 y(5), score]

import { clamp } from '../util.js';
import { resize as resizePx } from '../imgops/geometry.js';

// OpenCV YuNet 的官方预处理：BGR 通道，先减均值再除 255
const MEAN = [104, 117, 123];
const STD = [1, 1, 1];

export const FACE_MODEL_PRESETS = [
    {
        // 已核实：HTTP 200、232589 字节，含 5 个特征点与 roll/yaw/pitch
        id: 'yunet-2023mar', name: 'YuNet 2023mar（推荐，含 5 点，约 232KB）',
        url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
        alt: '',
        bytes: 232589,
    },
    { id: 'custom', name: '自定义 ONNX URL（SCRFD 等，需自带 URL）', url: '', alt: '', bytes: 0, note: '在下面填完整 URL' },
];

export function resolveFaceModel(ai = {}) {
    const preset = FACE_MODEL_PRESETS.find((p) => p.id === (ai.faceModel || 'yunet-2023mar')) || FACE_MODEL_PRESETS[0];
    const urls = [];
    if (ai.faceModelUrl) urls.push(ai.faceModelUrl);
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

export async function detectFaces(session, px, { confThreshold = 0.6, nmsThreshold = 0.3, topK = 200 } = {}) {
    const spec = inferInputSpec(session, px);
    const ort = globalThis.ort;
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
        return detectFacesSsd(results, px, confThreshold, nmsThreshold, topK);
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
const KP_NAMES = ['rightEye', 'leftEye', 'nose', 'mouthRight', 'mouthLeft'];

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


// SCRFD: scores_1/2/3 + landmarks_1/2/3 + distance_1/2/3，stride 8/16/32，2 anchors/格
function detectFacesSsd(results, px, confThreshold, nmsThreshold, topK) {
    const faces = [];
    for (const stride of [8, 16, 32]) {
        const sKey = Object.keys(results).find((k) => k.startsWith('scores') && k.endsWith(String(stride / 8)));
        const dKey = Object.keys(results).find((k) => k.startsWith('distance') && k.endsWith(String(stride / 8)));
        if (!sKey || !dKey) continue;
        const sc = results[sKey], di = results[dKey];
        const [, , fh, fw] = sc.dims;
        const fdi = di.dims;
        const h = fdi[2], w = fdi[3];
        for (let y = 0; y < fh; y++) {
            for (let x = 0; x < fw; x++) {
                for (let a = 0; a < 2; a++) {
                    const score = sc.data[((0 * 2 + a) * fh + y) * fw + x];
                    if (score < confThreshold) continue;
                    const dx = di.data[((0 * 4 + 0) * h + y) * w + x] * stride;
                    const dy = di.data[((0 * 4 + 1) * h + y) * w + x] * stride;
                    const dw = di.data[((0 * 4 + 2) * h + y) * w + x] * stride;
                    const dh = di.data[((0 * 4 + 3) * h + y) * w + x] * stride;
                    const cx = (x + 0.5) * stride, cy = (y + 0.5) * stride;
                    faces.push({ x: cx - dx, y: cy - dy, width: dw + dx, height: dh + dy, score, landmarks: null });
                }
            }
        }
    }
    return { faces: nms(faces, nmsThreshold).slice(0, topK), backend: 'scrfd', outputShape: 'ssd-multi' };
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
