// MV3 后台服务（ESM service worker）：设置存储、DNR 防盗链改写、抓取代理、
// 下载、离屏宿主生命周期、ComfyUI 上传与注入。

import { migrateSettings, DEFAULT_SETTINGS } from './src/common/registry.js';
import { ensureBuiltins } from './src/common/builtin-scripts.js';
import { base64ToBytes, bytesToBase64, sniffMime, sanitizeFilename, filenameFromUrl, extFromMime, bytesFingerprint, uniqueUploadName } from './src/common/util.js';

const HOST_PAGE = 'src/host/host.html';
let hostTabId = null;
let hostMode = null; // 'offscreen' | 'tab'
let galleryBatch = null;
// 按标签页存「已经采到过哪些图」：面板是 action popup，用户一点网页它就关了，
// 下次打开是新文档、内存里的累加全丢 —— 于是「每开一次都少一大堆」。
const galleryCache = new Map();
const GALLERY_CACHE_MAX_ITEMS = 1500;
const GALLERY_CACHE_TTL = 6 * 60 * 60 * 1000;

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(['mtbSettings', 'comfyConfig'], (data) => {
        const s = ensureBuiltins(migrateSettings(data.mtbSettings || data.comfyConfig || DEFAULT_SETTINGS));
        chrome.storage.local.set({ mtbSettings: s });
    });
    chrome.offscreen.hasDocument?.().then?.((has) => { if (!has) return; }).catch?.(() => {});
});

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (!req || !req.action) return false;
    const h = HANDLERS[req.action];
    if (!h) return false;
    Promise.resolve(h(req, sender)).then((r) => sendResponse(r === undefined ? { ok: true } : r))
        .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // 异步通道
});

const HANDLERS = {
    getState: async () => {
        const data = await chrome.storage.local.get(['mtbSettings', 'comfyConfig']);
        const s = ensureBuiltins(migrateSettings(data.mtbSettings || data.comfyConfig || DEFAULT_SETTINGS));
        return { ok: true, settings: s, hostMode, hostTabId };
    },

    patchSettings: async (req) => {
        const data = await chrome.storage.local.get(['mtbSettings']);
        const base = ensureBuiltins(migrateSettings(data.mtbSettings || DEFAULT_SETTINGS));
        const next = deepMerge(base, req.patch || {});
        await chrome.storage.local.set({ mtbSettings: next });
        return { ok: true, settings: next };
    },

    setSettings: async (req) => {
        const next = ensureBuiltins(migrateSettings(req.settings));
        await chrome.storage.local.set({ mtbSettings: next });
        return { ok: true, settings: next };
    },

    openOptions: async () => {
        await chrome.runtime.openOptionsPage();
        return { ok: true };
    },

    openTab: async (req) => {
        const t = await chrome.tabs.create({ url: req.url, active: req.active !== false });
        return { ok: true, id: t.id };
    },

    captureVisibleTab: async (req, sender) => {
        try {
            const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT, { format: 'png' });
            return { success: true, dataUrl };
        } catch (e) {
            return { success: false, error: String(e.message || e) };
        }
    },

    // 图片：伪装 Referer 过防盗链；视频：额外补 CORS 头以便克隆 video 取帧
    allowDirectMediaFetch: async (req) => {
        let origin = '*';
        try { origin = new URL(req.pageUrl || '').origin; } catch (e) { /* 保留 * */ }
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [2],
            addRules: [{
                id: 2, priority: 1,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: [{ header: 'Referer', operation: 'set', value: req.pageUrl || '' }],
                    responseHeaders: [
                        { header: 'Access-Control-Allow-Origin', operation: 'set', value: origin },
                        { header: 'Access-Control-Allow-Credentials', operation: 'set', value: 'true' },
                    ],
                },
                condition: { urlFilter: req.url, resourceTypes: ['xmlhttprequest', 'media', 'image'] },
            }],
        });
        return { ok: true };
    },

    removeDirectMediaFetch: async () => {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [2] });
        return { ok: true };
    },

    fetchMedia: async (req) => bytesResult(await fetchWithReferer(req.url, req.pageUrl, req.filename)),

    proxyFetch: async (req) => {
        const opt = req.options || req || {};
        const url = opt.url;
        if (!url) throw new Error('fetch 缺少 url');
        let headers = opt.headers || undefined;
        const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(url);
        if (opt.referer !== false && !headers && !isLocal) headers = { Referer: opt.pageUrl || '' };
        let rid = null;
        if (opt.referer !== false && !isLocal) rid = await addRefererRule(url, opt.pageUrl || '');
        try {
            const init = { method: opt.method || 'GET', headers, body: opt.body, redirect: 'follow' };
            const res = await fetch(url, init);
            const text = opt.as === 'json' ? await safeJson(res) : await res.text();
            if (opt.as === 'dataUrl') {
                const b = await res.arrayBuffer();
                return { ok: true, status: res.status, dataUrl: bytesToDataUrl(new Uint8Array(b), res.headers.get('content-type') || 'application/octet-stream') };
            }
            return { ok: res.ok, status: res.status, data: text };
        } finally {
            if (rid) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [rid] });
        }
    },

    proxyPost: async (req) => HANDLERS.proxyFetch({ options: { ...req, method: 'POST', as: 'text' } }),

    // 宿主（offscreen / 宿主标签页）→ UI 的事件转发。宿主发的是 action:'mtbEvent'，
    // 这里以前没有对应 handler，消息被静默丢掉，于是模型下载进度、运行时安装进度、
    // 以及 ctx.openUrl / ctx.panel（toolUi）全都不通。
    // 内容脚本与扩展页各自要一条，用 target 标记让接收方过滤，避免同一事件被处理两次。
    mtbEvent: async (req) => {
        const { action, ...rest } = req;
        const toPage = { action: 'mtbHostEvent', target: 'page', ...rest };
        const toExt = { action: 'mtbHostEvent', target: 'ext', ...rest };
        try {
            const tabs = await chrome.tabs.query({});
            for (const t of tabs) if (t.id != null) chrome.tabs.sendMessage(t.id, toPage).catch(() => {});
        } catch (e) { /* 没有标签页 */ }
        chrome.runtime.sendMessage(toExt).catch(() => {});
        return { ok: true, type: req.type };
    },

    downloadUrl: async (req) => {
        const { bytes, mime, filename } = await fetchWithReferer(req.url, req.pageUrl, req.filename);
        return downloadBinary(bytes, mime, filename || filenameFromUrl(req.url));
    },

    downloadDataUrl: async (req) => {
        const dataUrl = String(req.dataUrl || '');
        const comma = dataUrl.indexOf(',');
        if (comma < 0) throw new Error('dataUrl 非法');
        const mime = (/^data:([^;,]+)/.exec(dataUrl) || [, 'image/png'])[1];
        return downloadBinary(base64ToBytes(dataUrl.slice(comma + 1)), mime, sanitizeFilename(req.filename || 'image'));
    },

    videoQualities: async () => ({ ok: true, qualities: null }),

    ensureHost: async () => {
        const alive = await offscreenAlive();
        if (alive === true) {
            hostMode = 'offscreen';
            await waitHostReady(4000).catch(() => null); // 可能还在初始化，消息照常排队
            return { ok: true, mode: 'offscreen' };
        }
        if (hostMode === 'tab' && hostTabId != null) {
            const t = await chrome.tabs.get(hostTabId).catch(() => null);
            if (t) return { ok: true, mode: 'tab' };
            hostTabId = null;
        }
        try {
            await chrome.offscreen.createDocument({
                url: HOST_PAGE,
                reasons: ['WORKERS'],
                justification: '在离屏文档中运行 WebAssembly/WebGPU 图像识别与像素处理',
            });
            hostMode = 'offscreen';
            await waitHostReady();
            return { ok: true, mode: 'offscreen' };
        } catch (e) {
            const err = String(e && e.message || e);
            // 「已存在离屏文档」在各家浏览器里措辞不统一（Only a single offscreen document may be created /
            // document already exists）。它表示离屏可用，绝不能掉进下面的标签页兜底——那样会凭空多一个宿主标签页，
            // 而且等到标签页就绪的几秒里用户手势早已过期，复制图片之类的操作必然失败。
            if (/single offscreen document|document already|only one offscreen|exists/i.test(err)) {
                hostMode = 'offscreen';
                await waitHostReady();
                return { ok: true, mode: 'offscreen' };
            }
            if (!/offscreen/i.test(err)) throw e;
        }
        const t = await chrome.tabs.create({ url: chrome.runtime.getURL(HOST_PAGE), active: false, pinned: true });
        hostTabId = t.id;
        hostMode = 'tab';
        await waitHostReady();
        return { ok: true, mode: 'tab' };
    },

    hostSend: async (req, sender) => {
        const r = await chrome.runtime.sendMessage({ ...req, __relayFrom: sender?.tab?.id || null }).catch((e) => ({ ok: false, error: String(e.message || e) }));
        return r;
    },

    sendImageToComfyUI: async (req, sender) => comfySend(req, sender),

    startGalleryBatch: async (req) => {
        if (galleryBatch && galleryBatch.running) return { ok: false, error: '已有一个批量发送任务在进行' };
        const items = (Array.isArray(req.items) ? req.items : []).slice(0, 500)
            .filter((x) => x && typeof x.url === 'string' && x.url);
        if (!items.length) return { ok: false, error: '没有可发送的图片' };
        galleryBatch = {
            running: true, cancel: false, canceled: false,
            autoQueue: !!req.autoQueue, pageUrl: String(req.pageUrl || ''),
            items, index: 0, ok: 0, fail: 0,
            currentUrl: '', currentLabel: '', error: '', results: [],
            startedAt: Date.now(), finishedAt: 0,
        };
        runGalleryBatch();
        return { ok: true };
    },

    galleryBatchState: async () => ({ ok: true, state: publicGalleryBatch() }),

    cancelGalleryBatch: async () => {
        if (galleryBatch && galleryBatch.running) galleryBatch.cancel = true;
        return { ok: true, state: publicGalleryBatch() };
    },

    galleryCacheGet: async (req) => {
        const id = Number(req && req.tabId);
        const e = galleryCache.get(id);
        if (!e) return { ok: true, entry: null };
        if (Date.now() - e.at > GALLERY_CACHE_TTL) { galleryCache.delete(id); return { ok: true, entry: null }; }
        return { ok: true, entry: e };
    },

    galleryCachePut: async (req) => {
        const id = Number(req && req.tabId);
        const entry = req && req.entry;
        if (!id || !entry || !Array.isArray(entry.groups)) return { ok: false, error: '缺少 tabId 或 groups' };
        const groups = [];
        let n = 0;
        for (const g of entry.groups) {
            const items = (g && Array.isArray(g.items)) ? g.items : [];
            if (!items.length) continue;
            if (n + items.length > GALLERY_CACHE_MAX_ITEMS) {
                const left = GALLERY_CACHE_MAX_ITEMS - n;
                if (left > 0) { groups.push({ ...g, items: items.slice(0, left) }); n += left; }
                break;
            }
            groups.push(g); n += items.length;
        }
        galleryCache.set(id, { at: Date.now(), meta: entry.meta || null, groups });
        return { ok: true, items: n, groups: groups.length };
    },

    galleryCacheClear: async (req) => { galleryCache.delete(Number(req && req.tabId)); return { ok: true }; },

    closeHost: async () => {
        try { if (hostMode === 'offscreen') await chrome.offscreen.closeDocument(); } catch (e) { /* 没有文档 */ }
        if (hostTabId != null) { await chrome.tabs.remove(hostTabId).catch(() => {}); hostTabId = null; }
        hostMode = null;
        return { ok: true };
    },
};

chrome.tabs.onRemoved.addListener((id) => { galleryCache.delete(id); if (id === hostTabId) { hostTabId = null; hostMode = null; } });

// 换页/重新加载就清掉这个标签页的采集缓存，否则会把上一页的图混进当前页
chrome.tabs.onUpdated.addListener((id, changeInfo) => {
    if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') galleryCache.delete(id);
});

// 「本页图片」批量发送：跑在后台，弹窗/页面关掉也不会中断队列。
function publicGalleryBatch() {
    if (!galleryBatch) return null;
    const b = galleryBatch;
    return {
        running: b.running, canceled: b.canceled, autoQueue: b.autoQueue, pageUrl: b.pageUrl,
        total: b.items.length, index: b.index, ok: b.ok, fail: b.fail,
        currentUrl: b.currentUrl, currentLabel: b.currentLabel, error: b.error,
        startedAt: b.startedAt, finishedAt: b.finishedAt,
        results: b.results.slice(-500),
    };
}

function broadcastGallery(payload) {
    try {
        chrome.runtime.sendMessage({ action: 'galleryEvent', ...payload }).catch(() => {});
    } catch (e) { /* 弹窗已经关闭，没有接收方 */ }
}

async function runGalleryBatch() {
    const b = galleryBatch;
    if (!b) return;
    // MV3 SW 空闲 30s 会被回收；批量期间每 20s 调一次扩展 API 续命
    const keepAlive = setInterval(() => { try { chrome.runtime.getPlatformInfo().catch(() => {}); } catch (e) { /* ignore */ } }, 20000);
    try {
        for (let i = 0; i < b.items.length; i++) {
            if (b.cancel) { b.canceled = true; break; }
            const it = b.items[i];
            b.index = i;
            b.currentUrl = it.url;
            b.currentLabel = it.label || '';
            broadcastGallery({ type: 'progress', ...publicGalleryBatch() });
            let res;
            try {
                res = await comfySend({ imgSrc: it.url, pageUrl: it.pageUrl || b.pageUrl, autoQueue: b.autoQueue, filename: it.filename }, null);
            } catch (e) {
                res = { ok: false, error: String((e && e.message) || e) };
            }
            const ok = !!(res && res.ok);
            if (ok) b.ok++; else b.fail++;
            b.results.push({ url: it.url, ok, error: ok ? '' : String((res && res.error) || '发送失败') });
            b.currentUrl = '';
            b.currentLabel = '';
            b.index = i + 1;
            broadcastGallery({ type: 'item', ...publicGalleryBatch() });
            if (!ok && /连不上 ComfyUI|没有找到打开的 ComfyUI 标签页/.test(String((res && res.error) || ''))) {
                b.error = 'ComfyUI 连接失败，已停止';
                break;
            }
        }
    } catch (e) {
        b.error = String((e && e.message) || e);
    } finally {
        clearInterval(keepAlive);
        b.running = false;
        b.finishedAt = Date.now();
        b.currentUrl = '';
        b.currentLabel = '';
        broadcastGallery({ type: 'done', ...publicGalleryBatch() });
    }
}

async function offscreenAlive() {
    // hasDocument 在部分内核上不存在；getContexts 是更可靠的问法。返回 null 表示问不出来。
    try {
        if (chrome.offscreen?.getContexts) {
            const cs = await chrome.offscreen.getContexts({ url: [HOST_PAGE] }).catch(() => null);
            if (Array.isArray(cs)) return cs.length > 0;
        }
        if (chrome.offscreen?.hasDocument) return !!(await chrome.offscreen.hasDocument());
    } catch (e) { /* 老版本没这两个 API */ }
    return null;
}

async function waitHostReady(timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        const r = await chrome.runtime.sendMessage({ action: 'mtbHost', type: 'ping' }).catch(() => null);
        if (r && r.ok) return r;
        await new Promise((res) => setTimeout(res, 250));
    }
    throw new Error('AI 宿主未在 ' + Math.round(timeout / 1000) + ' 秒内就绪（vendor 运行时可能没安装，请先跑 node scripts/setup-vendor.mjs）');
}

async function addRefererRule(url, pageUrl) {
    const rid = 1000 + Math.floor(Math.random() * 9000);
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [rid],
        addRules: [{
            id: rid, priority: 1,
            action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: pageUrl }] },
            condition: { urlFilter: url, resourceTypes: ['xmlhttprequest'] },
        }],
    });
    return rid;
}

async function fetchWithReferer(url, pageUrl, filename) {
    if (!url) throw new Error('缺少地址');
    if (url.startsWith('data:')) {
        const bytes = base64ToBytes(url);
        return { bytes, mime: (/^data:([^;,]+)/.exec(url) || [, 'image/png'])[1], filename: filename || 'image.png' };
    }
    if (url.startsWith('blob:')) throw new Error('blob: 地址需在页面内取帧，不支持后台抓取');
    let rid = null;
    try { rid = await addRefererRule(url, pageUrl || ''); } catch (e) { /* 规则上限时直接试 */ }
    try {
        const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = new Uint8Array(await res.arrayBuffer());
        const mime = res.headers.get('content-type')?.split(';')[0] || sniffMime(buf);
        return { bytes: buf, mime, filename: filename || filenameFromUrl(url, mime.split('/')[1] || 'png'), contentLength: buf.length };
    } finally {
        if (rid) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [rid] }).catch(() => {});
    }
}

function bytesResult({ bytes, mime, filename }) {
    return { ok: true, data: bytesToBase64(bytes), mime, filename, size: bytes.length };
}

function bytesToDataUrl(bytes, mime) {
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

async function safeJson(res) {
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) { return text; }
}

async function downloadSettled(id, ms = 3000) {
    // 只有查回收终态才知道下载到底成没成；否则错误全被 chrome 咽掉，表现就是「点了没反应」
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < ms) {
        const items = await chrome.downloads.search({ id }).catch(() => null);
        last = (items && items[0]) || last;
        if (last && (last.state === 'complete' || last.state === 'interrupted')) return last;
        await new Promise((r) => setTimeout(r, 150));
    }
    return last;
}

const msgOf = (e) => String((e && e.message) || e || 'unknown');

async function downloadBinary(bytes, mime, filename) {
    // MV3 的 service worker 里没有 URL.createObjectURL，blob: 地址这条老路走不通；
    // chrome.downloads 自 111 起直接收 base64 的 data + contentType，这才是正路。
    const name = sanitizeFilename(filename || 'image');
    const b64 = bytesToBase64(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const tries = [];
    for (const spec of [{ data: b64, contentType: mime }, { url: `data:${mime};base64,${b64}` }]) {
        try {
            const id = await chrome.downloads.download({ ...spec, filename: name, saveAs: false, conflictAction: 'uniquify' });
            return settled(id, name);
        } catch (e) { tries.push(msgOf(e)); }
    }
    throw new Error('下载启动失败 → ' + tries.join(' ; '));
}

async function settled(id, name) {
    const st = await downloadSettled(id);
    if (st && st.state === 'interrupted') throw new Error('下载被中断: ' + (st.error || 'unknown'));
    return { ok: true, id, filename: (st && st.filename) || name };
}

function deepMerge(base, patch) {
    if (Array.isArray(patch)) return patch;
    if (!patch || typeof patch !== 'object') return base;
    const out = { ...(base || {}) };
    for (const k of Object.keys(patch)) {
        out[k] = patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) && base && typeof base[k] === 'object' && base[k] && !Array.isArray(base[k])
            ? deepMerge(base[k], patch[k])
            : patch[k];
    }
    return out;
}

// ---------------------------------------------------------- ComfyUI

// 本次后台生命周期内用过的上传名 → 内容指纹，避免同名不同图互相覆盖
const comfyNames = new Map();

async function comfySend(req, sender) {
    const data = await chrome.storage.local.get(['mtbSettings']);
    const settings = migrateSettings(data.mtbSettings || DEFAULT_SETTINGS);
    const cfg = { ...settings.comfy, ...(req.comfy || {}) };
    const server = (cfg.server || 'http://127.0.0.1:8188').replace(/\/$/, '');
    const autoQueue = req.autoQueue ?? cfg.autoQueue ?? false;

    let blob;
    if (req.dataUrl) blob = await (await fetch(req.dataUrl)).blob();
    else if (req.imgSrc) {
        const r = await fetchWithReferer(req.imgSrc, req.pageUrl || '');
        blob = new Blob([r.bytes], { type: r.mime });
    } else throw new Error('既没有 dataUrl 也没有图片地址');

    // 没传 filename 时绝不能用一个固定常量：ComfyUI 那边 overwrite:true 会让后一张盖掉前一张
    const ext = extFromMime(blob.type);
    const wanted = sanitizeFilename(req.filename || `web_${Date.now().toString(36)}.${ext}`);
    const named = /\.(?:png|jpe?g|webp|gif|avif|bmp|tif|svg)$/i.test(wanted) ? wanted : `${wanted}.${ext}`;
    const filename = uniqueUploadName(comfyNames, named, bytesFingerprint(new Uint8Array(await blob.arrayBuffer())));
    let last = null;
    const folders = cfg.uploadFolders || 'both';
    const targets = folders === 'both' ? ['input', 'output'] : [folders];
    for (const folderType of targets) {
        const form = new FormData();
        form.append('image', blob, filename);
        form.append('type', folderType);
        form.append('overwrite', 'true');
        let res;
        try { res = await fetch(`${server}/upload/image`, { method: 'POST', body: form }); }
        catch (e) { throw new Error(`连不上 ComfyUI (${server})：${e.message}`); }
        if (!res.ok) throw new Error(`ComfyUI 上传失败(${folderType})：HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);
        last = await res.json().catch(() => ({}));
    }
    const uploaded = last?.name || filename;
    try { await executeProfile(uploaded, cfg, server, autoQueue); }
    catch (e) { return { ok: false, error: String(e.message || e), uploaded }; }
    return { ok: true, uploaded };
}

async function executeProfile(filename, cfg, server, autoQueue) {
    if (cfg.mode === 'api') {
        if (!cfg.workflowJson) throw new Error('API 模式必须配置工作流 JSON');
        let workflow;
        try { workflow = JSON.parse(cfg.workflowJson); } catch (e) { throw new Error('工作流 JSON 格式错误: ' + e.message); }
        const nodeId = cfg.targetNodeId;
        if (!nodeId || !workflow[nodeId]) throw new Error(`找不到节点 ID: ${nodeId || '空'}`);
        if (workflow[nodeId].inputs) workflow[nodeId].inputs.image = filename;
        const res = await fetch(`${server}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: workflow }) });
        if (!res.ok) throw new Error('API 触发失败: ' + (await res.text()));
        return;
    }
    const tabs = (await chrome.tabs.query({})).filter((t) => t.url && t.url.startsWith(server));
    if (!tabs.length) throw new Error(`没有找到打开的 ComfyUI 标签页 (${server})；要后台静默执行请切到 API 模式`);
    await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        world: 'MAIN',
        func: injectComfy,
        args: [filename, cfg.targetNodeType || '', !!autoQueue],
    });
}

// 与旧版一致：优先选中节点 -> LoadImageOutput -> LoadImage，并刷新预览
function injectComfy(newFilename, targetNodeType, autoQueue) {
    if (!window.app || !window.app.graph) { console.warn('[mtb] 未检测到 ComfyUI app/graph'); return { ok: false, error: 'ComfyUI 页面未就绪' }; }
    let targetNode = null;
    const selected = Object.values(window.app.canvas?.selected_nodes || {});
    if (targetNodeType) {
        targetNode = window.app.graph._nodes.find((n) => n.title === targetNodeType || n.type === targetNodeType || n.comfyClass === targetNodeType);
    } else {
        targetNode = selected.find((n) => n.widgets && n.widgets.some((w) => w.name === 'image'));
        if (!targetNode) {
            targetNode = window.app.graph._nodes.find((n) => n.type === 'LoadImageOutput' || n.comfyClass === 'LoadImageOutput')
                || window.app.graph._nodes.find((n) => n.type === 'LoadImage' || n.comfyClass === 'LoadImage');
        }
    }
    if (!targetNode) return { ok: false, error: '画布里找不到图像加载节点' };
    const imgWidget = targetNode.widgets?.find((w) => w.name === 'image' && w.type !== 'button');
    if (!imgWidget) return { ok: false, error: '节点缺少 image 输入框' };
    const isOutput = targetNode.type === 'LoadImageOutput' || targetNode.comfyClass === 'LoadImageOutput';
    const value = isOutput ? newFilename + ' [output]' : newFilename;
    if (imgWidget.options && Array.isArray(imgWidget.options.values) && !imgWidget.options.values.includes(value)) imgWidget.options.values.push(value);
    imgWidget.value = value;
    try { imgWidget.callback?.(value); } catch (e) { /* 部分节点无 callback */ }
    targetNode.setDirtyCanvas(true, true);
    window.app.graph?.setDirtyCanvas(true, true);
    window.app.api?.dispatchEvent?.(new CustomEvent('b_preview', { detail: { image: newFilename, type: isOutput ? 'output' : 'input' } }));
    if (autoQueue) {
        try {
            if (window.app.queuePrompt) window.app.queuePrompt(0);
            else (document.getElementById('queue-button') || document.querySelector('button.p-button-primary'))?.click();
        } catch (e) { console.warn('[mtb] 排队失败', e); }
    }
    return { ok: true, value };
}
