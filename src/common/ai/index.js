// AI 任务调度：把 host 收到的任务名映射到各 runner，统一处理进度、尺寸归一、卸载。

import { clamp, toNum, toInt, formatBytes } from '../util.js';
import { mkPx, resize, clonePx } from '../imgops/geometry.js';
import { gaussianBlur, applyToRects } from '../imgops/filter.js';
import { STEPS, runChain } from '../steps.js';
import { installTransformers, describeRuntime, hubBase } from '../ai-env.js';
import { VlmRunner, resolveVlm } from './vlm.js';
import { SamRunner, resolveSam } from './sam.js';
import { SrRunner, resolveSr } from './sr.js';
import { VisionRunner, TAG_PRESETS, DEPTH_PRESETS } from './vision.js';
import { modelIdFor } from './sources.js';
import { detectFaces, resolveFaceModel, resolveEmbedModel, faceCropRect, hasLandmarks, alignFace, alignByBox, embedFace, matchGallery, packVector } from './face.js';
import { loadOrtSession, ensureOrt, fetchModelBytes } from './ort-load.js';
import { cacheSummary, clearCache, makeProgressFetch, guardBudget } from '../ai-io.js';

export class AiEngine {
    constructor({ vendorBase, onEvent, onProgress }) {
        this.vendorBase = vendorBase;
        this.onEvent = onEvent || (() => {});
        this.onProgress = onProgress || (() => {});
        this.ai = null;
        this.tf = null;
        this.vlm = null; this.sam = null; this.sr = null; this.vision = null;
        this.faceSession = null;
        this.embedSession = null;
        this.busy = null;
        this.taskKind = null;
        this.warmFor = null;   // 进度事件要能归到具体模型，设置页才知道刷哪一行
        this.lastUse = 0;
    }

    async prepare(ai) {
        this.ai = ai;
        const rt = await installTransformers({ ai, vendorBase: this.vendorBase, onProgress: this.onProgress });
        this.tf = rt.tf;
        this.device = rt.device;
        this.dtype = ai.dtype;
        this.runtime = describeRuntime();
        this.onEvent('runtime', this.runtime);
        return this.runtime;
    }

    progress(phase, loaded = 0, total = 0, extra = '') {
        // 模型下载进度只进设置页和控制台；其它阶段（推理中/完成）才显示在工具栏旁边。
        const download = phase === 'download' || /^下载/.test(String(phase));
        this.onProgress({ phase, download, loaded, total, kind: this.taskKind, warmFor: this.warmFor, extra, text: total ? `${phase} ${formatBytes(loaded)}/${formatBytes(total)}` : phase });
    }

    // 只为「把模型下下来并加载一次」而跑的任务：用一张极小的假图触发下载与建会话。
    // 假图当然认不出东西，所以只有「下载类」错误算失败，推理跑挂只当警告。
    async warm(payload = {}) {
        const kind = payload.kind || 'face';
        const map = { vlm: 'describe', sam: 'samPick', sr: 'superResolve', face: 'face', embed: 'recognize', tags: 'tags', depth: 'depth' };
        const task = map[kind] || kind;
        const side = 64;
        const px = mkPx(side, side);
        const t0 = Date.now();
        this.warmFor = kind;
        try {
            await this.task(task, { ...payload, px, points: [[side / 2, side / 2]], labels: [1], question: 'ok' });
            return { ok: true, kind, task, ms: Date.now() - t0, ran: true };
        } catch (e) {
            const msg = String((e && e.message) || e);
            const downloadFailed = /HTTP|Failed to fetch|fetch|network|预算|budget|404|下载/i.test(msg);
            return { ok: !downloadFailed, kind, task, ms: Date.now() - t0, ran: false, warn: msg.slice(0, 200) };
        } finally {
            this.warmFor = null;
        }
    }

    // 大图先夹到 ai.maxDim 再进模型，回来后按原比例还原遮罩尺寸
    normalizeForModel(px) {
        const max = toInt(this.ai?.maxDim || 1024, 1024);
        const m = Math.max(px.width, px.height);
        if (m <= max) return { px, scale: 1 };
        const s = max / m;
        return { px: resize(px, Math.round(px.width * s), Math.round(px.height * s), 'lanczos3'), scale: s };
    }

    async task(name, payload = {}) {
        if (!this.tf) await this.prepare(this.ai || payload.ai || {});
        this.lastUse = Date.now();
        this.taskKind = name;
        const px = payload.px;
        switch (name) {
            case 'runtime': return this.runtime || await this.prepare(payload.ai || {});
            case 'warm': return this.warm(payload);
            case 'describe': return this.runDescribe(px, payload);
            case 'ask': return this.runAsk(px, payload);
            case 'ocr': return this.runOcr(px, payload);
            case 'tags': return this.runTags(px, payload);
            case 'classify': return this.runClassify(px, payload);
            case 'samPick': return this.runSam(px, payload.points || [], payload.labels || [], payload);
            case 'samBox': return this.runSamBox(px, payload.rect, payload);
            case 'samAuto': return this.runSamAuto(px, payload);
            case 'face': return this.runFace(px, payload);
            case 'faceBlur': return this.runFaceBlur(px, payload);
            case 'recognize': return this.runRecognize(px, payload);
            case 'faceRegister': return this.runFaceRegister(px, payload);
            case 'superResolve': return this.runSr(px, payload);
            case 'depth': return this.runDepth(px, payload);
            case 'cacheSummary': return cacheSummary();
            case 'clearCache': return clearCache(payload.prefix || '');
            case 'unload': return this.unload(payload.keep || []);
            default: throw new Error('未知 AI 任务: ' + name);
        }
    }

    async ensureVlm() {
        const r = resolveVlm(this.ai);
        const budget = await this.checkBudget(r.preset.bytes, r.model);
        if (!budget.ok) return { blocked: budget };
        if (!this.vlm || this.vlm.modelId !== r.model) {
            this.vlm = new VlmRunner({ tf: this.tf, device: this.device, dtype: r.dtype || this.dtype, modelId: r.model, vendorBase: this.vendorBase, progress: (p) => this.progress('下载 ' + short(r.model), p?.loaded || 0, p?.total || 0, p?.url || ''), onEvent: this.onEvent });
        }
        return { runner: this.vlm, resolved: r };
    }

    async checkBudget(bytes, modelId) {
        const budgetMB = toInt(this.ai?.downloadBudgetMB || 0, 0);
        const g = await guardBudget(bytes, budgetMB, this.confirmedAll || this.confirmed?.[modelId]);
        if (!g.ok) this.onEvent('budget-blocked', { modelId, bytes, ...g });
        return g;
    }

    // confirmBudget(true) = 用户在设置页点了「下载」，视为对全部模型的预算确认
    confirmBudget(modelId) {
        if (modelId === true) { this.confirmedAll = true; return; }
        this.confirmed = this.confirmed || {};
        this.confirmed[modelId] = true;
    }

    async runDescribe(px, payload) {
        const e = await this.ensureVlm();
        if (e.blocked) return { text: '', blocked: e.blocked };
        const { px: mpx } = this.normalizeForModel(px);
        this.progress('推理中');
        const t0 = Date.now();
        const r = await e.runner.describe(mpx, { prompt: payload.prompt || this.ai?.vlmPrompt, maxNewTokens: toInt(payload.maxNewTokens || 200, 200) });
        this.progress('完成');
        return { text: r.text, ms: Date.now() - t0, engine: r.engine, model: e.resolved.model };
    }

    async runAsk(px, payload) {
        const e = await this.ensureVlm();
        if (e.blocked) return { text: '', blocked: e.blocked };
        const q = String(payload.question || '').trim();
        if (!q) throw new Error('问题是空的');
        const { px: mpx } = this.normalizeForModel(px);
        this.progress('推理中');
        const r = await e.runner.ask(mpx, (this.ai?.askPrompt || '{question}').replace('{question}', q), { maxNewTokens: toInt(payload.maxNewTokens || 128, 128) });
        return { text: r.text, ms: r.ms, model: e.resolved.model };
    }

    async runOcr(px, payload) {
        const e = await this.ensureVlm();
        if (e.blocked) return { text: '', blocked: e.blocked };
        const { px: mpx } = this.normalizeForModel(px);
        const r = await e.runner.ocr(mpx, { maxNewTokens: toInt(payload.maxNewTokens || 220, 220) });
        return { text: r.text, ms: r.ms, model: e.resolved.model };
    }

    async runTags(px, payload) {
        const presetId = payload.preset || this.ai?.tagsPreset || 'clip-zero-shot';
        const preset = TAG_PRESETS.find((t) => t.id === presetId) || TAG_PRESETS[0];
        if (!this.vision) this.vision = new VisionRunner({ tf: this.tf, device: this.device, dtype: this.ai?.tagsDtype || preset.dtype, vendorBase: this.vendorBase, progress: (p) => this.progress('下载标签模型', p?.loaded, p?.total, p?.url) });
        const { px: mpx } = this.normalizeForModel(px);
        this.progress('标签推理');
        const tagModel = modelIdFor(this.ai, preset);
        if (preset.id === 'clip-zero-shot') {
            const labels = (payload.candidateLabels || DEFAULT_CANDIDATES).slice(0, 60);
            const r = await this.vision.zeroShot(mpx, { model: tagModel, candidateLabels: labels });
            return { labels: r.labels, preset: preset.id };
        }
        const r = await this.vision.classify(mpx, { model: tagModel, topK: toInt(payload.topK || 8, 8) });
        return { ...r, preset: preset.id };
    }

    async runClassify(px, payload) {
        return this.runTags(px, { ...payload, preset: payload.preset || 'mobilenetv4' });
    }

    async ensureSam() {
        const r = resolveSam(this.ai);
        if (!this.sam || this.sam.modelId !== r.model) {
            this.sam = new SamRunner({ tf: this.tf, device: this.device, dtype: r.dtype || this.dtype, modelId: r.model, vendorBase: this.vendorBase, progress: (p) => this.progress('下载分割模型', p?.loaded, p?.total, p?.url) });
        }
        await this.sam.load();
        return { runner: this.sam, resolved: r };
    }

    async runSam(px, points, labels, payload) {
        const e = await this.ensureSam();
        const { px: mpx, scale } = this.normalizeForModel(px);
        this.progress('分割中');
        // 坐标换算到送进模型的尺寸，processor 内部按 original_sizes 再映射回原图
        const pts = (points && points.length ? points : [[px.width / 2, px.height / 2]]).map(([x, y]) => [x * scale, y * scale]);
        const labs = labels && labels.length === pts.length ? labels.map((v) => (v ? 1 : 0)) : pts.map(() => 1);
        const r = await e.runner.segmentPoints(mpx, pts, labs, { multiple: payload?.multiple });
        const masks = r.masks.map((m) => resizeMask(m, px.width, px.height));
        return { masks, scores: r.scores, model: e.resolved.model, overlay: masksToOverlay(masks) };
    }

    async runSamBox(px, rect, payload) {
        const e = await this.ensureSam();
        const { px: mpx, scale } = this.normalizeForModel(px);
        const r = await e.runner.box(mpx, { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale });
        const masks = r.masks.map((m) => resizeMask(m, px.width, px.height));
        return { masks, model: e.resolved.model, overlay: masksToOverlay(masks) };
    }

    async runSamAuto(px, payload) {
        const e = await this.ensureSam();
        const { px: mpx, scale } = this.normalizeForModel(px);
        this.progress('自动分割中');
        const grid = toInt(payload.grid || this.ai?.samGrid || 2, 2);
        const r = await e.runner.auto(mpx, { grid: clamp(grid, 1, 4) });
        const masks = r.map((x) => resizeMask(x.mask, px.width, px.height));
        return { masks: masks.filter(Boolean), model: e.resolved.model, overlay: masksToOverlay(masks), count: masks.length };
    }

    async ensureFace() {
        if (this.faceSession) return this.faceSession;
        this.faceSession = await this.loadFirstWorking(resolveFaceModel(this.ai).urls, '下载人脸模型');
        return this.faceSession;
    }

    // 逐个试 URL：首选自己的 ModelScope 镜像，失败再退到原始出处
    async loadFirstWorking(urls, label) {
        const tried = [];
        for (const url of urls.filter(Boolean)) {
            try {
                return await loadOrtSession({ url, ai: this.ai, progress: (p, l, t) => this.progress(label, l, t, p), device: this.device, vendorBase: this.vendorBase });
            } catch (e) { tried.push(String((e && e.message) || e).slice(0, 120)); }
        }
        throw new Error('人脸模型所有源都取不到：' + (tried.join(' ; ') || '没有可用 URL'));
    }

    async runFace(px, payload) {
        const session = await this.ensureFace();
        const { px: mpx, scale } = this.normalizeForModel(px);
        this.progress('人脸检测中');
        const r = await detectFaces(session, mpx, { confThreshold: toNum(this.ai?.faceConfidence || 0.6, 0.6), topK: toInt(payload.topK || 60, 60) });
        const faces = r.faces.map((f) => rescaleFace(f, 1 / scale));
        return { faces, count: faces.length, backend: r.backend, overlay: faces.map((f) => ({ type: 'box', ...faceBoxToOverlay(f) })) };
    }

    async runFaceBlur(px, payload) {
        const f = await this.runFace(px, payload);
        const mode = payload.mode || 'gaussian';
        const strength = toNum(payload.strength || 12, 12);
        const rects = f.faces.map((x) => faceCropRect(x, { pad: 0.35, square: true }));
        const image = applyToRects(px, (src) => (mode === 'mosaic' ? tileMosaic(src, strength) : gaussianBlur(src, strength)), rects, { feather: 6 });
        return { image, faces: f.faces, count: f.count, overlay: f.overlay };
    }

    async ensureEmbed() {
        if (this.embedSession) return this.embedSession;
        this.embedSession = await this.loadFirstWorking(resolveEmbedModel(this.ai).urls, '下载识别模型');
        return this.embedSession;
    }

    // 每张脸：5 点对齐成 112×112 → 识别向量 → 与本地人脸库比余弦
    async runRecognize(px, payload) {
        const session = await this.ensureFace();
        const embed = await this.ensureEmbed();
        const { px: mpx, scale } = this.normalizeForModel(px);
        this.progress('识别中');
        const r = await detectFaces(session, mpx, { confThreshold: toNum(this.ai?.faceConfidence || 0.6, 0.6), topK: toInt(payload.topK || 30, 30) });
        const gallery = payload.gallery || [];
        const threshold = toNum(this.ai?.faceMatchThreshold ?? 0.4, 0.4);
        const faces = [];
        for (const f of r.faces) {
            const out = { ...rescaleFace(f, 1 / scale), name: null, sim: null };
            try {
                const aligned = hasLandmarks(f) ? alignFace(mpx, f.landmarks) : alignByBox(mpx, f);
                const vector = await embedFace(embed, aligned, { std: 127.5 });
                const m = matchGallery(vector, gallery, threshold);
                if (m.best) out.sim = +m.best.sim.toFixed(3);
                if (m.match) out.name = m.match.name;
            } catch (e) { out.error = String(e && e.message || e).slice(0, 80); }
            faces.push(out);
        }
        return {
            faces,
            count: faces.length,
            named: faces.filter((f) => f.name).length,
            gallery: gallery.length,
            threshold,
            backend: r.backend,
            overlay: faces.map((f) => ({ type: 'box', ...faceBoxToOverlay(f), label: f.name || (f.sim != null ? '陌生 ' + Math.round(f.sim * 100) + '%' : '人脸') })),
        };
    }

    async runFaceRegister(px, payload) {
        const session = await this.ensureFace();
        const embed = await this.ensureEmbed();
        const { px: mpx, scale } = this.normalizeForModel(px);
        this.progress('提取人脸特征');
        const r = await detectFaces(session, mpx, { confThreshold: toNum(this.ai?.faceConfidence || 0.6, 0.6), topK: 30 });
        if (!r.faces.length) throw new Error('这张图里没检出人脸，换一张正脸清晰点的');
        const f = r.faces.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0];
        const aligned = hasLandmarks(f) ? alignFace(mpx, f.landmarks) : alignByBox(mpx, f);
        const vector = await embedFace(embed, aligned, { std: 127.5 });
        return {
            dim: vector.length,
            vector: packVector(vector),
            box: rescaleFace(f, 1 / scale),
            faces: r.faces.length,
            aligned: payload.wantAligned ? { width: aligned.width, height: aligned.height, data: Array.from(aligned.data) } : undefined,
        };
    }

    async runSr(px, payload) {
        const r = resolveSr(this.ai);
        if (!this.sr) this.sr = new SrRunner({ tf: this.tf, device: this.device, dtype: this.dtype, vendorBase: this.vendorBase, progress: (p) => this.progress('下载超分模型', p?.loaded, p?.total, p?.url) });
        const cap = toInt(this.ai?.maxDim || 1400, 1400);
        let input = px;
        if (Math.max(px.width, px.height) > cap) {
            const s = cap / Math.max(px.width, px.height);
            input = resize(px, Math.round(px.width * s), Math.round(px.height * s), 'lanczos3');
        }
        this.progress('超分推理');
        let out;
        if (r.via === 'tj') out = await this.sr.runTj(input, r.model);
        else out = await this.sr.runOrt(input, this.ai?.srModelUrl || r.model, { tile: toInt(this.ai?.srTile || 0, 0) });
        if (input !== px) out.image = resize(out.image, Math.round(out.image.width * (px.width / input.width)), Math.round(out.image.height * (px.height / input.height)), 'lanczos3');
        return { image: out.image, scale: out.scale, via: out.via, tiles: out.tiles };
    }

    async runDepth(px, payload) {
        const preset = DEPTH_PRESETS.find((d) => d.id === (payload.preset || this.ai?.depthPreset)) || DEPTH_PRESETS[0];
        if (!this.vision) this.vision = new VisionRunner({ tf: this.tf, device: this.device, dtype: this.ai?.depthDtype || preset.dtype, vendorBase: this.vendorBase, progress: (p) => this.progress('下载深度模型', p?.loaded, p?.total, p?.url) });
        const { px: mpx } = this.normalizeForModel(px);
        this.progress('深度推理');
        const r = await this.vision.depth(mpx, { model: modelIdFor(this.ai, preset), colormap: payload.colormap || 'viridis' });
        return { image: pxFromGray(r.color), depthGray: r.gray, model: preset.model };
    }

    unload(keep = []) {
        if (!keep.includes('vlm')) this.vlm = null;
        if (!keep.includes('sam')) this.sam = null;
        if (!keep.includes('sr')) this.sr = null;
        if (!keep.includes('vision')) this.vision = null;
        if (!keep.includes('face')) this.faceSession = null;
        if (!keep.includes('embed')) this.embedSession = null;
        this.onEvent('unload', { keep });
        return { ok: true };
    }
}

function short(id) { return String(id).split('/').pop(); }

const DEFAULT_CANDIDATES = ['人像 selfie', '风景 landscape', '食物 food', '动物 animal', '建筑 building', '城市 street', '汽车 car', '电子产品 device', '截图 screenshot', '插画 illustration', '文档 document', '动漫 anime', '图表 chart', '商品 product', '运动 sports', '艺术 artwork'];

function resizeMask(mask, w, h) {
    if (mask.width === w && mask.height === h) return mask;
    const out = new Uint8ClampedArray(w * h);
    const sx = mask.width / w, sy = mask.height / h;
    for (let y = 0; y < h; y++) {
        const my = clamp(Math.floor(y * sy), 0, mask.height - 1);
        for (let x = 0; x < w; x++) {
            out[y * w + x] = mask.data[my * mask.width + clamp(Math.floor(x * sx), 0, mask.width - 1)];
        }
    }
    return { width: w, height: h, data: out };
}

function masksToOverlay(masks) {
    return masks.map((m, i) => ({ type: 'mask', mask: m, color: PALETTE[i % PALETTE.length], id: 'm' + i }));
}

const PALETTE = [[80, 200, 120], [240, 90, 90], [90, 140, 255], [255, 200, 60], [200, 100, 255], [80, 220, 220]];

function pxFromGray(img) {
    if (img.data instanceof Uint8ClampedArray && img.data.length === img.width * img.height * 4) return mkPx(img.width, img.height, img.data);
    return clonePx(img);
}

function tileMosaic(px, size) {
    const n = Math.max(2, toInt(size, 12));
    const out = clonePx(px);
    const d = px.data, o = out.data;
    for (let y0 = 0; y0 < px.height; y0 += n) {
        for (let x0 = 0; x0 < px.width; x0 += n) {
            const p = (y0 * px.width + x0) * 4;
            for (let y = y0; y < Math.min(y0 + n, px.height); y++) {
                for (let x = x0; x < Math.min(x0 + n, px.width); x++) {
                    const i = (y * px.width + x) * 4;
                    o[i] = d[p]; o[i + 1] = d[p + 1]; o[i + 2] = d[p + 2]; o[i + 3] = d[p + 3];
                }
            }
        }
    }
    return out;
}

function rescaleFace(f, k) {
    const s = (v) => Math.round(v * k);
    const out = { ...f, x: s(f.x), y: s(f.y), width: s(f.width), height: s(f.height) };
    if (f.landmarks) {
        const lm = {};
        for (const [key, [x, y]] of Object.entries(f.landmarks)) lm[key] = [s(x), s(y)];
        out.landmarks = lm;
    }
    return out;
}

function faceBoxToOverlay(f) {
    const pts = f.landmarks ? Object.values(f.landmarks).map(([x, y]) => ({ x, y })) : [];
    return { x: f.x, y: f.y, width: f.width, height: f.height, label: `${Math.round(f.score * 100)}%`, points: pts };
}

export { STEPS, runChain, hubBase };
