// 设置页其它面板：输出/视频/ComfyUI、AI 与模型、自定义功能、站点、导入导出。

import { S, toast, markDirty, save } from './options.mjs';
import { DEFAULT_SETTINGS, migrateSettings, TOOL_GROUPS } from '../common/registry.js';
import { uid, formatBytes, escapeHtml as _esc } from '../common/util.js';
import { friendlyText } from '../common/ext-state.js';
import { STEPS } from '../common/steps.js';
import { CONTEXT_API_DOC, BUILTIN_SCRIPTS, BUILTIN_LINKS } from '../common/builtin-scripts.js';
import { normalizeLlm, buildChatRequest, chatEndpoint } from '../common/ai/llm-api.js';
import { SAM_PRESETS, resolveSam } from '../common/ai/sam.js';
import { SR_PRESETS, resolveSr } from '../common/ai/sr.js';
import { FACE_MODEL_PRESETS, FACE_EMBED_PRESETS, resolveFaceModel, resolveEmbedModel, unpackVector, cosineSim } from '../common/ai/face.js';
import { TAG_PRESETS, DEPTH_PRESETS } from '../common/ai/vision.js';

const $ = (s, r = document) => (r || document).querySelector(s);
const $$ = (s, r = document) => Array.from((r || document).querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let ctx = {};
export function initPanels(S_, helpers) {
    ctx = helpers;
    bindIoButtons();
}

function bg(msg) {
    return new Promise((resolve) => {
        try { chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r)); }
        catch (e) { resolve({ ok: false, error: e.message }); }
    });
}

export async function hostCall(type, extra = {}, timeoutMs = 15000) {
    const ready = await bg({ action: 'ensureHost' });
    if (!ready || !ready.ok) throw new Error(ready?.error || '宿主启动失败');
    return new Promise((resolve, reject) => {
        // 装运行时要下载几十 MB，15s 的默认超时不够用
        const timer = setTimeout(() => reject(new Error('宿主响应超时')), timeoutMs);
        chrome.runtime.sendMessage({ action: 'mtbHost', type, ...extra }, (r) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            resolve(r);
        });
    });
}

// ---------------------------------------------------------------- AI 运行时安装
// 运行时（ORT 的 wasm 后端）不再要求用户自己跑 node 脚本：状态、下载、进度、清除都在这里。
// 机制见 src/common/runtime-install.js —— wasm 下进 Cache API，再用 blob: 地址交给 ORT。
const fmtMB = (n) => `${((n || 0) / 1048576).toFixed(1)} MB`;

export function renderRuntimeFiles(status) {
    const box = $('#runtimeFiles'), state = $('#runtimeState');
    if (!box || !state) return;
    if (!status) { state.textContent = '未探测'; box.innerHTML = ''; return; }
    const need = status.files.filter((f) => f.required && !f.ready).reduce((a, f) => a + (f.bytes - f.have), 0);
    state.textContent = status.ready ? `已就绪 · 扩展包内 ${fmtMB(status.packageBytes)} + 已下载 ${fmtMB(status.cachedBytes)}`
        : `缺必需文件 · 还需下载约 ${fmtMB(need)}`;
    box.innerHTML = status.files.map((f) => `<div class="f"><span>${esc(f.label)} <small class="rthint">${esc(f.name)} · ${fmtMB(f.bytes)}${f.required ? ' · 必需' : ''}</small></span>
        <span class="${f.ready ? 'ok' : (f.required ? 'miss' : 'bad')}">${f.ready ? `已就绪（${f.source === 'package' ? '扩展包内' : '已下载'}）` : (f.have ? `不完整 ${fmtMB(f.have)}` : '未安装')}</span></div>`).join('')
        + `<div class="f"><span class="rthint">ORT ${esc(status.ortVersion)}${status.storage ? ` · 存储剩余约 ${fmtMB(Math.max(0, (status.storage.quota || 0) - (status.storage.usage || 0)))}` : ''}</span><span></span></div>`;
}

function runtimeBar(p) {
    const bar = $('#runtimeBar'), speed = $('#runtimeSpeed');
    if (!bar) return;
    if (!p) { bar.style.width = '0%'; return; }
    bar.style.width = (p.size ? Math.min(100, Math.round((p.loaded / p.size) * 100)) : 0) + '%';
    if (speed) {
        speed.textContent = `${p.phase === 'done' ? '完成' : p.phase === 'start' ? '连接中' : '下载中'} ${Number(p.index) + 1}/${p.total} · ${p.label || ''} · ${fmtMB(p.loaded)} / ${fmtMB(p.size)}`
            + (p.speed ? ` · ${fmtMB(p.speed)}/s` : '');
    }
}

async function refreshRuntime() {
    const state = $('#runtimeState');
    if (state) state.textContent = '检测中…';
    try {
        const r = await hostCall('runtimeStatus', {}, 25000);
        renderRuntimeFiles(r.status || (r.result && r.result.status));
    } catch (e) {
        if (state) state.textContent = '检测失败: ' + e.message;
    }
}

export function bindRuntimeCard() {
    const btnI = $('#btnRuntimeInstall');
    if (!btnI) return;
    refreshRuntime();
    if (btnI._bound) return;
    btnI._bound = true;
    $('#btnRuntimeCheck').onclick = refreshRuntime;
    const install = async (onlyRequired) => {
        runtimeBar({ index: 0, total: 1, label: '准备中', loaded: 0, size: 0, phase: 'start' });
        btnI.disabled = true;
        try {
            const r = await hostCall('installRuntime', { onlyRequired }, 15 * 60 * 1000);
            const st = r.status || (r.result && r.result.status);
            renderRuntimeFiles(st);
            const errs = r.errors || (r.result && r.result.errors) || [];
            if (errs.length) $('#runtimeSpeed').textContent = '部分源失败：' + errs.join(' ; ').slice(0, 400);
            toast(st && st.ready ? '运行时已就绪，AI 按钮可以用了' : '仍有文件没装好，看上面的失败原因', !(st && st.ready));
        } catch (e) {
            $('#runtimeSpeed').textContent = '安装失败: ' + (e.message || e);
            toast('运行时安装失败', true);
        } finally { btnI.disabled = false; }
    };
    btnI.onclick = () => install(true);
    $('#btnRuntimeAll').onclick = () => install(false);
    $('#btnRuntimeClear').onclick = async () => {
        if (!confirm('清除已下载的运行时文件？下次用 AI 会重新下载。')) return;
        try {
            await hostCall('clearRuntime', {}, 30000);
            runtimeBar(null);
            refreshRuntime();
            toast('已清除下载的运行时');
        } catch (e) { toast('清除失败: ' + e.message, true); }
    };
    chrome.runtime.onMessage.addListener((m) => {
        if (m?.action === 'mtbHostEvent' && m.target === 'page') return false;   // 发给内容脚本的那份，设置页别接
        if (m?.action === 'mtbHostEvent' && m.type === 'runtimeProgress') runtimeBar({ file: m.file, label: m.label, index: m.index, total: m.total, loaded: m.loaded, size: m.size, phase: m.phase, speed: m.speed });
        return false;
    });
}

// ---------------------------------------------------------------- 输出/视频/ComfyUI
const OUT_BINDS = [
    ['output.format', 'outFormat'], ['output.quality', 'outQuality', 'num'], ['output.filenamePattern', 'filenamePattern'],
    ['video.frameFormat', 'frameFormat'], ['video.frameMaxSide', 'frameMaxSide', 'num'], ['video.fpsFallback', 'fpsFallback', 'num'],
    ['video.sheetColumns', 'sheetColumns', 'num'], ['video.sheetCellWidth', 'sheetCellWidth', 'num'],
    ['comfy.server', 'comfyServer'], ['comfy.mode', 'comfyMode'], ['comfy.targetNodeType', 'comfyNodeType'],
    ['comfy.targetNodeId', 'comfyNodeId'], ['comfy.workflowJson', 'comfyWorkflow'], ['comfy.uploadFolders', 'comfyFolders'],
];
const OUT_CHECKS = [
    ['output.autoDownloadAfterOp', 'autoDownload'], ['output.copyAfterOp', 'copyAfterOp'],
    ['output.showResultOverlay', 'showResult'], ['output.keepOriginalName', 'keepName'],
    ['video.trimLetterbox', 'trimLetterbox'], ['comfy.autoQueue', 'comfyAutoQueue'],
];

export function bindOutputPanel(S_, helpers) {
    ctx = helpers || ctx;
    for (const [path, id, kind] of OUT_BINDS) {
        const el = $('#' + id);
        if (!el) continue;
        el.value = getPath(S_.settings, path) ?? '';
        el.addEventListener('input', () => { setPath(S_.settings, path, kind === 'num' ? (parseFloat(el.value) || 0) : el.value); markDirty(); if (id === 'outQuality') $('#outQualityV').textContent = Math.round(el.value * 100) + '%'; });
    }
    for (const [path, id] of OUT_CHECKS) {
        const el = $('#' + id);
        if (!el) continue;
        el.checked = !!getPath(S_.settings, path);
        el.addEventListener('change', () => { setPath(S_.settings, path, el.checked); markDirty(); });
    }
    $('#outQualityV').textContent = Math.round((S_.settings.output.quality || 0.92) * 100) + '%';
    const test = $('#btnComfyTest');
    test && (test.onclick = async () => {
        const out = $('#comfyTestOut');
        out.textContent = '探测中…';
        const server = (S_.settings.comfy.server || '').replace(/\/$/, '');
        const r = await bg({ action: 'proxyFetch', options: { url: server + '/system_stats', method: 'GET', referer: false, as: 'json' } });
        if (r?.ok && r.data && typeof r.data === 'object' && r.data.system) {
            out.textContent = `OK · ${r.data.system.os} ${r.data.system.python_version || ''} · ComfyUI ${r.data.comfyui?.version || '?'}`;
            out.style.color = 'var(--ok)';
        } else {
            out.textContent = '失败: ' + (r?.error || JSON.stringify(r?.data || {}).slice(0, 120) || '无响应');
            out.style.color = 'var(--danger)';
        }
    });
}

function getPath(o, p) { return p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o); }
function setPath(o, p, v) { const k = p.split('.'); let x = o; for (let i = 0; i < k.length - 1; i++) x = x[k[i]] = x[k[i]] || {}; x[k[k.length - 1]] = v; }

// ---------------------------------------------------------------- AI 面板
let aiTabInited = false;
export function renderAiPanel(S_, helpers) {
    ctx = helpers || ctx;
    const s = S_.settings.ai;
    bindRuntimeCard();   // 打开 AI 面板就顺带刷新运行时安装情况
    const binds = [
        ['ai.enabled', 'aiEnabled', 'chk'], ['ai.device', 'aiDevice'], ['ai.dtype', 'aiDtype'],
        ['ai.maxDim', 'aiMaxDim', 'num'], ['ai.hub', 'aiHub'], ['ai.hubCustom', 'aiHubCustom'],
        ['ai.downloadBudgetMB', 'aiBudget', 'num'], ['ai.autoUnloadAfter', 'aiUnload', 'num'],
        ['ai.describePrompt', 'describePrompt'], ['ai.askPrompt', 'askPrompt'], ['ai.faceConfidence', 'faceConfidence', 'num'],
        ['ai.srTile', 'srTile', 'num'], ['ai.samGrid', 'samGrid', 'num'],
        ['ai.llm.endpoint', 'llmEndpoint'], ['ai.llm.apiKey', 'llmKey'], ['ai.llm.model', 'llmModel'],
        ['ai.llm.temperature', 'llmTemperature', 'num'], ['ai.llm.maxTokens', 'llmMaxTokens', 'num'],
        ['ai.llm.imageMaxDim', 'llmImageDim', 'num'], ['ai.llm.imageQuality', 'llmImageQuality', 'num'],
        ['ai.llm.timeoutSec', 'llmTimeout', 'num'],
    ];
    if (!aiTabInited) {
        aiTabInited = true;
        for (const [path, id, kind] of binds) {
            const el = $('#' + id);
            if (!el) continue;
            if (kind === 'chk') { el.checked = !!getPath(S_.settings, path); el.addEventListener('change', () => { setPath(S_.settings, path, el.checked); markDirty(); }); }
            else {
                el.value = getPath(S_.settings, path) ?? '';
                const h = () => { setPath(S_.settings, path, kind === 'num' ? (parseFloat(el.value) || 0) : el.value); markDirty(); if (id === 'faceConfidence') $('#faceConfV').textContent = Number(el.value).toFixed(2); };
                el.addEventListener('input', h); el.addEventListener('change', h);
            }
        }
        $('#faceConfV').textContent = Number(s.faceConfidence ?? 0.6).toFixed(2);
        $('#btnRuntime').onclick = doRuntimeProbe;
        $('#btnCache').onclick = doCacheSummary;
        $('#btnClearCache').onclick = async () => {
            if (!confirm('清除已下载的模型权重缓存？下次使用会重新下载。')) return;
            const r = await hostCall('ai', { task: 'clearCache', ai: S_.settings.ai });
            toast(r?.ok ? `已清除 ${r.cleared ?? 0} 项` : '清除失败: ' + (r?.error || ''));
            doCacheSummary();
        };
        $('#btnAiSelfTest').onclick = doSelfTest;
        $('#btnLlmTest').onclick = doLlmTest;
    } else {
        for (const [path, id, kind] of binds) {
            const el = $('#' + id);
            if (!el) continue;
            if (kind === 'chk') el.checked = !!getPath(S_.settings, path);
            else el.value = getPath(S_.settings, path) ?? '';
        }
    }
    renderModelSelects(S_);
}

function presetRow(label, presets, current, onChange, extraNote) {
    const wrap = document.createElement('div');
    wrap.style.marginBottom = '10px';
    const l = document.createElement('label');
    l.textContent = label;
    const sel = document.createElement('select');
    for (const p of presets) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.name + (p.bytes ? ` · 约 ${formatBytes(p.bytes)}` : '');
        sel.appendChild(o);
    }
    sel.value = current;
    sel.onchange = () => onChange(sel.value);
    const model = document.createElement('input');
    model.type = 'text';
    model.title = '实际仓库 ID，可留空用预设';
    model.placeholder = '自定义仓库 ID（可覆盖预设）';
    const info = document.createElement('div');
    info.className = 'hint';
    wrap.appendChild(l); wrap.appendChild(sel); wrap.appendChild(model); wrap.appendChild(info);
    const sync = () => {
        const p = presets.find((x) => x.id === sel.value);
        info.innerHTML = (p ? esc(p.note || '') : '') + (extraNote ? ' ' + extraNote : '');
        model.value = (p && p.model) ? '' : '';
    };
    sel.addEventListener('change', sync);
    sync();
    return { wrap, sel, model, info };
}

// ---------------------------------------------------------------- 模型逐个下载
// 每个模型一行，可单独下载；下载进度只写在这里和控制台，不再挤到工具栏按钮旁边。
const MODEL_KINDS = [
    { kind: 'sam', label: 'SAM · 点选抠图', pick: (ai) => resolveSam(ai) },
    { kind: 'face', label: '人脸检测', pick: (ai) => resolveFaceModel(ai) },
    { kind: 'embed', label: '人脸识别（认出是谁）', pick: (ai) => resolveEmbedModel(ai) },
    { kind: 'sr', label: 'AI 超分', pick: (ai) => resolveSr(ai) },
    { kind: 'tags', label: '标签 / 分类', pick: (ai) => ({ model: (TAG_PRESETS.find((p) => p.id === (ai.tagsPreset || 'clip-zero-shot')) || TAG_PRESETS[0]).model }) },
    { kind: 'depth', label: '深度图', pick: (ai) => ({ model: (DEPTH_PRESETS.find((p) => p.id === (ai.depthPreset || 'depth-anything-small')) || DEPTH_PRESETS[0]).model }) },
];

function needleOf(id) {
    let t = String(id || '');
    const proto = t.indexOf('://');
    if (proto >= 0) { const slash = t.indexOf('/', proto + 3); t = slash >= 0 ? t.slice(slash + 1) : ''; }
    const res = t.indexOf('/resolve/');
    if (res >= 0) t = t.slice(0, res);
    return t;
}

function cachedBytes(entries, needle) {
    if (!needle) return 0;
    const tail = needle.split('/').pop();
    let b = 0;
    for (const e of entries || []) {
        const u = String(e.model || e.url || '');
        if (u.includes(needle) || (tail && u.includes(tail))) b += e.bytes || 0;
    }
    return b;
}

let modelProgBound = false;
function bindModelProgress() {
    if (modelProgBound) return;
    modelProgBound = true;
    chrome.runtime.onMessage.addListener((m) => {
        if (m?.action === 'mtbHostEvent' && m.type === 'modelProgress') {
            console.log('[mtb] 模型下载', m.warmFor || m.kind || '', m.text || (m.loaded + '/' + m.total));
            const row = m.warmFor && document.querySelector('#modelList .m[data-kind="' + m.warmFor + '"]');
            if (!row) return false;
            const pct = m.total ? Math.round((m.loaded / m.total) * 100) : 0;
            const bar = row.querySelector('.mbar i');
            if (bar) bar.style.width = Math.max(3, pct) + '%';
            const st = row.querySelector('.st');
            if (st && m.total) st.textContent = '下载中 ' + fmtMB(m.loaded) + ' / ' + fmtMB(m.total);
        }
        return false;
    });
}

async function refreshModelCache(ai) {
    try {
        const r = await hostCall('ai', { task: 'cacheSummary', ai }, 30000);
        const entries = (r.entries || r.result?.entries || []);
        for (const row of $$('#modelList .m')) {
            const k = MODEL_KINDS.find((x) => x.kind === row.dataset.kind);
            if (!k) continue;
            const picked = k.pick(ai) || {};
            const bytes = cachedBytes(entries, needleOf(picked.model || picked.url));
            const st = row.querySelector('.st');
            if (st) st.textContent = bytes > 0 ? '已缓存 ' + fmtMB(bytes) : '未下载';
            const bar = row.querySelector('.mbar i');
            if (bar && bytes > 0) bar.style.width = '100%';
        }
    } catch (e) { /* 宿主没起来就不刷，别把面板写坏 */ }
}

function renderModelDownloads(S_) {
    const box = $('#modelList');
    if (!box) return;
    const ai = S_.settings.ai;
    box.innerHTML = MODEL_KINDS.map((k) => {
        const picked = k.pick(ai) || {};
        const id = picked.model || picked.url || '(未填)';
        return `<div class="m" data-kind="${k.kind}">
          <div><span class="nm">${esc(k.label)}</span> <code class="mid" title="${esc(id)}">${esc(id)}</code></div>
          <div><span class="st">查询中…</span><button class="mini dl">下载</button></div>
          <div class="mbar"><i></i></div>
        </div>`;
    }).join('');
    bindModelProgress();
    for (const row of $$('#modelList .m')) {
        const kind = row.dataset.kind;
        row.querySelector('.dl').onclick = async () => {
            const st = row.querySelector('.st'), bar = row.querySelector('.mbar i');
            st.textContent = '连接宿主…';
            bar.style.width = '2%';
            try {
                const r = await hostCall('ai', { task: 'warm', kind, ai, confirmBudget: true }, 30 * 60 * 1000);
                const res = r.result || r;
                if (res.ok) { st.textContent = (res.ran ? '已下载并加载 ' : '已下载（试跑提示见控制台）') + Math.round((res.ms || 0) / 1000) + 's'; bar.style.width = '100%'; }
                else { st.textContent = '下载失败: ' + friendlyText(res.warn || r.error || '').slice(0, 120); }
                if (res.warn) console.warn('[mtb] 模型预热', kind, res.warn);
            } catch (e) { st.textContent = '失败: ' + (e.message || e); }
        };
    }
    refreshModelCache(ai);
}

function renderFaceGallery(S_) {
    const box = $('#faceGallery');
    if (!box) return;
    const ai = S_.settings.ai;
    const gallery = Array.isArray(S_.settings.faceGallery) ? S_.settings.faceGallery : [];
    const threshold = Number(ai.faceMatchThreshold ?? 0.4);
    box.innerHTML = '';

    const tip = document.createElement('p');
    tip.className = 'note';
    tip.textContent = gallery.length
        ? `本地存了 ${gallery.length} 张人脸特征（只存 512 维向量，不存图、不上传）。「认出是谁」时与这里比对。`
        : '还没有登记过人脸。在网页图片上点工具栏的「登记人脸」，起个名字存进这里；之后「认出是谁」会把名字标在框上。';
    box.appendChild(tip);

    const thr = document.createElement('label');
    thr.className = 'gthr';
    thr.innerHTML = `判定阈值 <input type="number" min="0.05" max="0.95" step="0.05" value="${threshold}"> <span class="hint">相似度高于此值才算同一个人（同人约 0.7+，不同人约 0.1）</span>`;
    const inp = thr.querySelector('input');
    inp.onchange = () => { ai.faceMatchThreshold = Math.max(0.05, Math.min(0.95, Number(inp.value) || 0.4)); markDirty(); renderFaceGallery(S_); };
    box.appendChild(thr);

    if (!gallery.length) return;
    const list = document.createElement('div');
    list.className = 'faces';
    for (const f of gallery) {
        const row = document.createElement('div');
        row.className = 'f';
        row.innerHTML = `<span class="nm">${esc(f.name || '(未命名)')}</span><span class="hint">${f.dim || '?'} 维 · ${new Date(f.createdAt || 0).toLocaleString()}</span>`;
        const del = document.createElement('button');
        del.className = 'mini';
        del.textContent = '删除';
        del.onclick = () => {
            S_.settings.faceGallery = gallery.filter((x) => x.id !== f.id);
            markDirty();
            renderFaceGallery(S_);
        };
        row.appendChild(del);
        list.appendChild(row);
    }
    box.appendChild(list);

    // 库里两个人太像，识别时就会互相认错，提前提示
    let worst = null;
    for (let i = 0; i < gallery.length; i++) {
        for (let j = i + 1; j < gallery.length; j++) {
            const a = gallery[i], b = gallery[j];
            if (!a.vector || !b.vector) continue;
            let sim = 0;
            try { sim = cosineSim(unpackVector(a.vector), unpackVector(b.vector)); } catch (e) { continue; }
            if (!worst || sim > worst.sim) worst = { a: a.name, b: b.name, sim };
        }
    }
    if (worst && worst.sim >= threshold) {
        const warn = document.createElement('p');
        warn.className = 'note';
        warn.textContent = `「${worst.a}」与「${worst.b}」的相似度 ${worst.sim.toFixed(2)} 已达判定阈值，识别时容易互相认错：要么把阈值调高，要么删掉其中一个。`;
        box.appendChild(warn);
    }
}

function renderModelSelects(S_) {
    const box = $('#modelSelects');
    if (!box) return;
    box.innerHTML = '';
    const ai = S_.settings.ai;
    const sam = presetRow('分割模型（抠图）', SAM_PRESETS, ai.samPreset || 'slimsam', (v) => { ai.samPreset = v; markDirty(); });
    sam.model.value = ai.samModel || ''; sam.model.onchange = () => { ai.samModel = sam.model.value.trim() || undefined; markDirty(); };
    box.appendChild(sam.wrap);

    const face = presetRow('人脸检测模型', FACE_MODEL_PRESETS, ai.faceModel || 'scrfd-500m', (v) => { ai.faceModel = v; markDirty(); });
    face.model.placeholder = '覆盖 ONNX URL';
    face.model.value = ai.faceModelUrl || ''; face.model.onchange = () => { ai.faceModelUrl = face.model.value.trim() || ''; markDirty(); };
    box.appendChild(face.wrap);

    const emb = presetRow('人脸识别模型（认出是谁）', FACE_EMBED_PRESETS, ai.faceEmbedModel || 'w600k-mbf', (v) => { ai.faceEmbedModel = v; markDirty(); });
    emb.model.placeholder = '覆盖 ONNX URL';
    emb.model.value = ai.faceEmbedUrl || ''; emb.model.onchange = () => { ai.faceEmbedUrl = emb.model.value.trim() || ''; markDirty(); };
    box.appendChild(emb.wrap);

    const sr = presetRow('超分模型', SR_PRESETS, ai.srPreset || 'swin2sr-x2', (v) => { ai.srPreset = v; markDirty(); });
    sr.model.value = ai.srModelUrl || ''; sr.model.onchange = () => { ai.srModelUrl = sr.model.value.trim() || undefined; markDirty(); };
    box.appendChild(sr.wrap);

    const tag = presetRow('标签/分类模型', TAG_PRESETS, ai.tagsPreset || 'clip-zero-shot', (v) => { ai.tagsPreset = v; markDirty(); });
    box.appendChild(tag.wrap);

    const dep = presetRow('深度模型', DEPTH_PRESETS, ai.depthPreset || 'depth-anything-small', (v) => { ai.depthPreset = v; markDirty(); });
    box.appendChild(dep.wrap);
    renderModelDownloads(S_);
    renderFaceGallery(S_);

    const summary = document.createElement('p');
    summary.className = 'note';
    const llm = normalizeLlm(ai.llm);
    const r2 = resolveSam(ai), r3 = resolveSr(ai);
    summary.innerHTML = `当前生效：<code>${esc(r2.model)}</code> · <code>${esc(r3.model || r3.preset.name)}</code><br>` +
        `本地模型：设备 ${esc(ai.device)}，源 ${esc(ai.hub)}，预算 ${esc(String(ai.downloadBudgetMB))}MB<br>` +
        `看图说话/提问/OCR：<code>${esc(llm.endpoint ? chatEndpoint(llm.endpoint) : '未填端点（这三个按钮现在还不能用）')}</code> · 模型 ${esc(llm.model)}`;
    box.appendChild(summary);
}

/** 测试连接：只发一句文本，验端点/密钥/模型名通不通，不动任何模型 */
async function doLlmTest() {
    const out = $('#llmTestOut'), hint = $('#llmTestHint');
    const llm = normalizeLlm(S.settings.ai.llm);
    if (!llm.endpoint) { out.textContent = '端点是空的：先填一个 OpenAI 兼容地址（如 https://api.deepseek.com/v1）'; hint.textContent = '没填端点'; return; }
    hint.textContent = '请求中…';
    out.textContent = `POST ${chatEndpoint(llm.endpoint)}\n模型 ${llm.model} · ${llm.apiKey ? '带密钥' : '不带密钥'}`;
    const req = buildChatRequest(llm, { system: '', user: '只回答两个字：成功', imageDataUrl: '' });
    req.body.max_tokens = Math.min(req.body.max_tokens, 64);
    const t0 = Date.now();
    const r = await bg({ action: 'llmChat', ...req, maskSecret: llm.apiKey });
    if (r?.ok) {
        hint.textContent = `通了 (${Math.round((Date.now() - t0) / 100) / 10}s)`;
        const u = r.usage || {};
        out.textContent += `\n应答：${r.text}` + (u.total_tokens ? `\n用量 ${u.prompt_tokens || '?'} + ${u.completion_tokens || '?'} = ${u.total_tokens} tokens` : '');
    } else {
        hint.textContent = '失败';
        out.textContent += `\n\n失败：${(r && r.error) || '后台没有响应'}`;
    }
}

async function doRuntimeProbe() {
    const out = $('#runtimeOut');
    out.textContent = '启动宿主并探测 WebGPU…';
    try {
        const ready = await bg({ action: 'ensureHost' });
        if (!ready?.ok) throw new Error(ready?.error || '宿主启动失败');
        const r = await hostCall('runtime', { ai: S.settings.ai });
        const rt = r.runtime || {};
        out.textContent = [
            `宿主模式: ${r.hostMode || ready.mode || '?'}`,
            `transformers.js: 已加载`,
            `WebGPU: ${rt.webgpu ? '可用 ✅' : '不可用 ❌ (' + (rt.reason || '') + ')'}`,
            `实际设备: ${rt.device || '?'}`,
            rt.adapter ? `适配器: ${rt.adapter.vendor || ''} ${rt.adapter.architecture || ''} ${rt.adapter.description || ''}`.trim() : '',
            `模型源: ${rt.hub || S.settings.ai.hub}`,
        ].filter(Boolean).join('\n');
        const badges = $('#aiBadges');
        if (badges) badges.innerHTML = `<span class="badge ${rt.webgpu ? 'gpu' : 'cpu'}">${rt.webgpu ? 'GPU' : 'CPU'}</span>`;
        toast('运行时已就绪');
    } catch (e) {
        out.textContent = '探测失败: ' + e.message + '\n\n若是缺 vendor，请在扩展目录执行 node scripts/setup-vendor.mjs';
        toast('运行时探测失败', true);
    }
}

async function doCacheSummary() {
    const out = $('#runtimeOut');
    try {
        const r = await hostCall('ai', { task: 'cacheSummary', ai: S.settings.ai });
        if (!r?.ok) throw new Error(r?.error || '无响应');
        const res = r.result || r;
        const lines = (res.entries || []).slice(0, 20).map((e) => `${formatBytes(e.bytes).padEnd(10)} ${e.model || e.url.slice(0, 70)}`);
        out.textContent = `缓存 ${res.count} 项，共 ${res.totalText}\n` + lines.join('\n');
    } catch (e) { out.textContent = '缓存统计失败: ' + e.message; }
}

// 自检：画一张带文字的测试图，完整走一遍「宿主取图 → JPEG → LLM API → 应答」这条链路
async function doSelfTest() {
    const out = $('#aiTestOut');
    const llm = normalizeLlm(S.settings.ai.llm);
    if (!llm.endpoint) { out.textContent = '先把端点填上（上面「接 LLM API」那一栏），自检跑的是真接口调用'; toast('还没填端点', true); return; }
    const hint = $('#selfTestHint');
    hint.textContent = '取图并请求模型中…';
    const c = document.createElement('canvas');
    c.width = 320; c.height = 200;
    const g = c.getContext('2d');
    g.fillStyle = '#123'; g.fillRect(0, 0, 320, 200);
    g.fillStyle = '#e8b04b'; g.beginPath(); g.arc(90, 70, 34, 0, 7); g.fill();
    g.fillStyle = '#4ec97e'; g.fillRect(150, 90, 120, 70);
    g.fillStyle = '#fff'; g.font = '16px sans-serif'; g.fillText('MTB SELF TEST', 20, 180);
    const dataUrl = c.toDataURL('image/png');
    const onMsg = (m) => {
        if (m?.action === 'mtbHostEvent' && m.target === 'page') return;
        if (m?.action === 'mtbHostEvent' && m.type === 'aiProgress') {
            hint.textContent = m.text || m.phase || '处理中…';
            out.textContent += '\n' + (m.text || m.phase || '');
        }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    out.textContent = '';
    try {
        // 接口那边可能要几十秒，宿主消息的默认 15s 超时必须跟着设置里的超时一起放宽
        const r = await hostCall('ai', { task: 'describe', dataUrl, ai: S.settings.ai }, Math.round(llm.timeoutSec * 1000) + 30000);
        if (r?.ok === false) throw new Error(r.error + (r.stack ? '\n' + r.stack : ''));
        else {
            out.textContent = '识别结果:\n' + (r.text || JSON.stringify(r).slice(0, 400))
                + `\n\n端点 ${chatEndpoint(llm.endpoint)}\n模型 ${r.model || llm.model}`;
            hint.textContent = `完成 (${Math.round((r.ms || 0) / 100) / 10}s)`;
        }
    } catch (e) {
        const friendly = friendlyText(e && e.message);
        out.textContent = '自检失败: ' + friendly + (friendly === String(e && e.message) ? '\n\n' + (e.stack || '').split('\n').slice(0, 4).join('\n') : '');
        hint.textContent = '失败';
    } finally {
        chrome.runtime.onMessage.removeListener(onMsg);
    }
}

// ---------------------------------------------------------------- 自定义功能
export function renderCustomPanel(S_, helpers) {
    ctx = helpers || ctx;
    const s = S_.settings;
    s.customScripts = s.customScripts || [];
    s.linkTools = s.linkTools || [];
    const list = $('#scriptList');
    list.innerHTML = '';
    for (const c of s.customScripts) {
        const row = document.createElement('div');
        row.className = 'item' + (S.selScript === c.id ? ' sel' : '');
        row.innerHTML = `<input type="checkbox" ${c.enabled ? 'checked' : ''}>
          <span class="icn">${esc(c.icon || '⌨️')}</span>
          <span class="nm">${esc(c.label || c.name)}</span>
          ${c.builtin ? '<span class="badge">内置示例</span>' : ''}
          ${c.collapsed ? '<span class="badge">折叠 ▾</span>' : ''}
          <span class="grp">${(c.media || []).join('/')}</span>
          <span class="flags">${c.id}</span>`;
        row.querySelector('input').onchange = (e) => { c.enabled = e.target.checked; markDirty(); };
        row.onclick = (e) => { if (e.target.tagName === 'INPUT') return; S.selScript = c.id; renderCustomPanel(S_, ctx); };
        list.appendChild(row);
    }
    const ll = $('#linkList');
    ll.innerHTML = '';
    for (const l of s.linkTools) {
        const row = document.createElement('div');
        row.className = 'item' + (S.selLink === l.id ? ' sel' : '');
        row.innerHTML = `<input type="checkbox" ${l.enabled ? 'checked' : ''}>
          <span class="icn">${esc(l.icon || '🔗')}</span><span class="nm">${esc(l.label || l.name)}</span>
          ${l.builtin ? '<span class="badge">内置示例</span>' : ''}${l.collapsed ? '<span class="badge">折叠 ▾</span>' : ''}<span class="grp">${(l.media || []).join('/')}</span>`;
        row.querySelector('input').onchange = (e) => { l.enabled = e.target.checked; markDirty(); };
        row.onclick = (e) => { if (e.target.tagName === 'INPUT') return; S.selLink = l.id; S.selScript = null; renderCustomPanel(S_, ctx); };
        ll.appendChild(row);
    }
    renderScriptEditor();
    const nb = $('#btnNewScript');
    if (!nb._bound) {
        nb._bound = true;
        nb.onclick = () => {
            const id = 'script_' + uid('s');
            s.customScripts.push({ id, name: '新脚本功能', label: '新脚本', icon: '⌨️', media: ['image', 'video'], enabled: true, entry: 'body', params: {}, code: 'return { toast: "hello " + ctx.media.kind };' });
            S.selScript = id; markDirty(); renderCustomPanel(S_, ctx);
        };
        $('#btnDupScript').onclick = () => {
            const c = s.customScripts.find((x) => x.id === S.selScript);
            if (!c) return toast('先选一个脚本', true);
            const copy = JSON.parse(JSON.stringify(c));
            copy.id = 'script_' + uid('s'); copy.name += ' 副本'; copy.label += ' 副本'; copy.builtin = false; copy.enabled = false;
            s.customScripts.push(copy); S.selScript = copy.id; markDirty(); renderCustomPanel(S_, ctx);
        };
        $('#btnDelScript').onclick = () => {
            const i = s.customScripts.findIndex((x) => x.id === S.selScript);
            if (i < 0) return toast('先选一个脚本', true);
            if (s.customScripts[i].builtin && !confirm('这是内置示例，删除后不再自动恢复。确定？')) return;
            s.customScripts.splice(i, 1); S.selScript = null; markDirty(); renderCustomPanel(S_, ctx);
        };
        $('#btnNewLink').onclick = () => {
            const id = 'link_' + uid('l');
            s.linkTools.push({ id, name: '新链接工具', label: '链接', icon: '🔗', media: ['image'], enabled: true, template: 'https://example.com/?u={src}', method: 'GET', openTab: true });
            S.selLink = id; S.selScript = null; markDirty(); renderCustomPanel(S_, ctx);
        };
        $('#btnDelLink').onclick = () => {
            const i = s.linkTools.findIndex((x) => x.id === S.selLink);
            if (i < 0) return toast('先选一个链接工具', true);
            s.linkTools.splice(i, 1); S.selLink = null; markDirty(); renderCustomPanel(S_, ctx);
        };
    }
}

// 「常驻 / 折叠进 ▾ 菜单」的编辑器控件，内置按钮与自定义功能共用同一套 collapsed 字段
function visSelect(parent, obj, onDone) {
    const lab = document.createElement('label');
    lab.textContent = '显示位置';
    const sel = document.createElement('select');
    sel.appendChild(new Option('常驻', 'pin'));
    sel.appendChild(new Option('折叠进 ▾ 菜单', 'menu'));
    sel.value = obj.collapsed ? 'menu' : 'pin';
    sel.onchange = () => { obj.collapsed = sel.value === 'menu'; markDirty(); if (onDone) onDone(); };
    lab.appendChild(sel);
    parent.appendChild(lab);
    return sel;
}

function renderScriptEditor() {
    const box = $('#scriptEditor');
    const s = S.settings;
    const c = s.customScripts.find((x) => x.id === S.selScript);
    const l = s.linkTools.find((x) => x.id === S.selLink);
    box.innerHTML = '';
    if (c) {
        const mk = (label, key, type = 'text', rows = null) => {
            const lab = document.createElement('label');
            lab.textContent = label;
            const el = document.createElement(type === 'area' ? 'textarea' : 'input');
            if (type === 'area') { el.rows = rows || 12; el.spellcheck = false; }
            else el.type = type === 'num' ? 'number' : 'text';
            el.value = c[key] ?? '';
            el.onchange = () => {
                c[key] = type === 'num' ? parseFloat(el.value) || 0 : el.value;
                markDirty();
                if (key === 'label' || key === 'icon') { renderCustomPanel(S, ctx); }
            };
            lab.appendChild(el);
            box.appendChild(lab);
            return el;
        };
        const g = document.createElement('div');
        g.className = 'grid2';
        box.appendChild(g);
        const orig = document.createElement('div');
        g.appendChild(orig);
        const nameEl = mkField(orig, '名称', c.name, (v) => c.name = v);
        mkField(orig, '按钮文字', c.label, (v) => c.label = v);
        mkField(orig, '图标', c.icon, (v) => c.icon = v);
        const media = document.createElement('label');
        media.textContent = '适用';
        const ms = document.createElement('select');
        for (const [v, t] of [['image', '仅图片'], ['video', '仅视频'], 'both', '图片+视频']) if (v) ms.appendChild(new Option(t, v));
        ms.value = (c.media || []).includes('image') && (c.media || []).includes('video') ? 'both' : (c.media || [])[0];
        ms.onchange = () => { c.media = ms.value === 'both' ? ['image', 'video'] : [ms.value]; markDirty(); renderCustomPanel(S, ctx); };
        media.appendChild(ms); g.appendChild(media);
        visSelect(g, c, () => renderCustomPanel(S, ctx));
        mkField(orig, '参数(JSON)', JSON.stringify(c.params || {}), (v) => { try { c.params = JSON.parse(v || '{}'); } catch (e) { toast('参数 JSON 不合法', true); } }, true);
        mkField(box, '功能代码（函数体，可直接 return）', c.code, (v) => c.code = v, true).rows = 16;
        const row = document.createElement('div');
        row.className = 'row';
        const runBtn = document.createElement('button');
        runBtn.textContent = '用示例图试跑';
        runBtn.className = 'primary';
        const valBtn = document.createElement('button');
        valBtn.textContent = '语法检查';
        const out = document.createElement('pre');
        out.className = 'out';
        valBtn.onclick = async () => {
            // 设置页自身也不能 eval，语法检查一律转给宿主里的 QuickJS
            try {
                const r = await hostCall('compile', { code: c.code });
                const cr = (r && r.result) || r || {};   // 宿主把 handler 的返回平铺进响应，两种形状都认
                out.textContent = cr.ok ? '语法通过 ✅' : '语法错误: ' + (cr.error || r?.error || '未知');
            } catch (e) {
                out.textContent = '无法检查（宿主未就绪）: ' + e.message;
            }
        };
        runBtn.onclick = async () => {
            out.textContent = '试跑中…';
            const c2 = document.createElement('canvas');
            c2.width = 240; c2.height = 160;
            const gg = c2.getContext('2d');
            gg.fillStyle = '#243'; gg.fillRect(0, 0, 240, 160);
            gg.fillStyle = '#fc6'; gg.fillRect(40, 40, 80, 60);
            try {
                const r = await hostCall('script', { scriptId: c.id, code: c.code, dataUrl: c2.toDataURL('image/png'), ctx: { media: { kind: 'image', src: '(试跑示例图)', width: 240, height: 160 }, params: c.params || {}, settings: { comfy: S.settings.comfy, output: S.settings.output, video: S.settings.video, ai: { device: S.settings.ai.device } } }, ai: S.settings.ai });
                out.textContent = r?.ok ? '返回: ' + JSON.stringify(r.result, null, 1) : '失败: ' + (r?.error || '') + (r?.stack ? '\n' + r.stack : '');
            } catch (e) { out.textContent = '失败: ' + e.message; }
        };
        row.appendChild(runBtn); row.appendChild(valBtn);
        box.appendChild(row); box.appendChild(out);
        if (c.builtin) {
            const note = document.createElement('p');
            note.className = 'note';
            note.textContent = '这是内置示例，可以改；改坏了可点下方恢复。';
            const rb = document.createElement('button');
            rb.className = 'mini';
            rb.textContent = '恢复此示例原始代码';
            rb.onclick = () => { const o = BUILTIN_SCRIPTS.find((x) => x.id === c.id); if (o) { c.code = o.code; c.label = o.label; c.params = o.params; markDirty(); renderCustomPanel(S, ctx); } };
            box.appendChild(note); box.appendChild(rb);
        }
    } else if (l) {
        mkField(box, '名称', l.name, (v) => l.name = v);
        mkField(box, '按钮文字', l.label, (v) => l.label = v);
        mkField(box, '图标', l.icon, (v) => l.icon = v);
        mkField(box, 'URL 模板（{src} {page} {w} {h} {t} {title} {dataUrl}）', l.template, (v) => l.template = v, true).rows = 3;
        const m = document.createElement('label');
        m.textContent = '方法';
        const sel = document.createElement('select');
        sel.appendChild(new Option('GET（打开/复制）', 'GET'));
        sel.appendChild(new Option('POST（后台提交）', 'POST'));
        sel.value = l.method || 'GET';
        sel.onchange = () => { l.method = sel.value; markDirty(); };
        m.appendChild(sel); box.appendChild(m);
        visSelect(box, l, () => renderCustomPanel(S, ctx));
        mkField(box, 'POST 请求体模板（可空）', l.body || '', (v) => l.body = v, true).rows = 4;
        mkField(box, '请求头 JSON', JSON.stringify(l.headers || {}), (v) => { try { l.headers = JSON.parse(v || '{}'); } catch (e) { toast('headers JSON 不合法', true); } }, true).rows = 3;
        const chk = document.createElement('label');
        chk.className = 'chk';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = l.openTab !== false;
        cb.onchange = () => { l.openTab = cb.checked; markDirty(); };
        chk.appendChild(cb); chk.appendChild(document.createTextNode(' 用新标签打开（不勾选则复制地址）'));
        box.appendChild(chk);
    } else {
        box.innerHTML = '<p class="hint">左侧选一个脚本或链接工具进行编辑；点「＋ 新建」创建。</p>';
    }
}

function mkField(parent, label, value, onchange, multiline) {
    const lab = document.createElement('label');
    lab.textContent = label;
    const el = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) el.type = 'text';
    else { el.rows = 4; el.spellcheck = false; }
    el.value = value ?? '';
    el.onchange = () => onchange(el.value);
    el.addEventListener('input', () => onchange(el.value));
    lab.appendChild(el);
    // 原来只 append 了 label 里的控件、没把 label 挂到 parent 上，整个自定义功能编辑器是空的
    parent.appendChild(lab);
    return el;
}

// ---------------------------------------------------------------- 站点
export function renderSitesPanel(S_, helpers) {
    ctx = helpers || ctx;
    const s = S_.settings;
    s.sites = s.sites || { disabled: [] };
    s.sites.disabled = s.sites.disabled || [];
    const list = $('#siteList');
    list.innerHTML = '';
    if (!s.sites.disabled.length) list.innerHTML = '<div class="item"><span class="nm hint">没有禁用站点（全部启用）</span></div>';
    for (const h of s.sites.disabled) {
        const row = document.createElement('div');
        row.className = 'item';
        row.innerHTML = `<span class="icn">🚫</span><span class="nm">${esc(h)}</span><button class="mini">移除</button>`;
        row.querySelector('button').onclick = () => { s.sites.disabled = s.sites.disabled.filter((x) => x !== h); markDirty(); renderSitesPanel(S_, ctx); };
        list.appendChild(row);
    }
    const add = document.createElement('div');
    add.className = 'row';
    const inp = document.createElement('input');
    inp.type = 'text'; inp.placeholder = 'example.com';
    const btn = document.createElement('button');
    btn.textContent = '添加禁用站点';
    btn.onclick = () => {
        const v = inp.value.trim().toLowerCase();
        if (!v) return;
        if (!s.sites.disabled.includes(v)) s.sites.disabled.push(v);
        inp.value = ''; markDirty(); renderSitesPanel(S_, ctx);
    };
    add.appendChild(inp); add.appendChild(btn);
    list.after(add);
    const fr = $('#includeFrame');
    if (fr) {
        fr.checked = s.sites.includeFrame !== false;
        fr.onchange = () => { s.sites.includeFrame = fr.checked; markDirty(); toast('改 iframe 注入需要重新加载扩展生效'); };
    }
}

// ---------------------------------------------------------------- 导入导出
function bindIoButtons() {
    $('#btnExport').onclick = () => {
        const blob = new Blob([JSON.stringify(S.settings, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `mtb-settings-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        toast('已导出配置');
    };
    $('#fileImport').onchange = async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try {
            const text = await f.text();
            const data = JSON.parse(text);
            if (!confirm('导入会覆盖当前全部设置，继续？')) return;
            S.settings = migrateSettings(data);
            await save();
            location.reload();
        } catch (err) { toast('导入失败: ' + err.message, true); }
    };
    $('#btnReset').onclick = async () => {
        if (!confirm('恢复默认设置？自定义脚本也会被重置为内置示例。')) return;
        S.settings = migrateSettings({});
        const { ensureBuiltins } = await import('../common/builtin-scripts.js');
        ensureBuiltins(S.settings);
        await save();
        location.reload();
    };
}
