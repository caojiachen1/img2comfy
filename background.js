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
// 勾选状态也要跨 popup 存活：面板一点网页就销毁，重开后用户要看到的是「我刚才勾的那几张还勾着」
const gallerySel = new Map();
const GALLERY_CACHE_MAX_ITEMS = 1500;
const GALLERY_SEL_MAX_KEYS = 3000;
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


// 实验模式：直接改微博页面里的信息流数组（在 MAIN world 跑，能碰到 Vue 的内部 state）。
// 必须完全自包含：这个函数会被 chrome.scripting.executeScript 序列化注入。
// 只做两件事：把微博自己那份 list 里不该显示的条目拿掉 / 放回去。列表组件会自己重排，所以不留空位。
function weiboFilterPage(arg) {
    try {
        const KEY = '__mtbWeiboFilterPage';
        const st = window[KEY] || (window[KEY] = { orig: [] });
        const pad = (x) => String(x).padStart(2, '0');
        const strip = (h) => String(h || '').replace(/<[^>]+>/g, '');
        const day = (v) => {
            if (v === undefined || v === null || v === '') return '';
            const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
            return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        };
        const normDay = (v) => {
            const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(v || '').trim());
            return m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : '';
        };
        const splitKeywords = (t) => {
            const out = [];
            const seen = new Set();
            for (const raw of String(t || '').split(/[\n\r,，;；、]+/)) {
                const k = raw.trim();
                if (!k) continue;
                const low = k.toLowerCase();
                if (seen.has(low)) continue;
                seen.add(low);
                out.push(k);
            }
            return out;
        };
        const norm = (f) => {
            const src = f && typeof f === 'object' ? f : {};
            const t = src.types && typeof src.types === 'object' ? src.types : {};
            const types = {};
            for (const k of ['original', 'repost', 'text', 'image', 'video', 'music']) types[k] = t[k] !== false;
            return {
                enabled: !!src.enabled,
                types,
                keywordMode: src.keywordMode === 'none' ? 'none' : 'has',
                keywords: splitKeywords(Array.isArray(src.keywords) ? src.keywords.join('\n') : src.keywords),
                dateFrom: normDay(src.dateFrom),
                dateTo: normDay(src.dateTo),
            };
        };
        const match = (it, f) => {
            const page = it.page_info || {};
            const pageType = String(page.object_type || page.type || '').toLowerCase();
            const text = strip(it.text || it.longText || '');
            const hasImage = !!(it.pic_ids && it.pic_ids.length) || !!it.pic_infos;
            const hasVideo = pageType.indexOf('video') >= 0;
            const hasMusic = pageType.indexOf('music') >= 0 || /分享歌曲|网易云音乐|QQ音乐/.test(text);
            const repost = !!it.retweeted_status;
            if (repost ? !f.types.repost : !f.types.original) return false;
            const textOnly = !hasImage && !hasVideo && !hasMusic;
            const passMedia = (f.types.text && textOnly) || (f.types.image && hasImage) || (f.types.video && hasVideo) || (f.types.music && hasMusic);
            if (!passMedia) return false;
            if (f.keywords.length) {
                const low = text.toLowerCase();
                const hit = f.keywords.some((k) => low.indexOf(String(k).toLowerCase()) >= 0);
                if (f.keywordMode === 'has' && !hit) return false;
                if (f.keywordMode === 'none' && hit) return false;
            }
            if (f.dateFrom || f.dateTo) {
                const d = day(it.created_at);
                if (d) {
                    if (f.dateFrom && d < f.dateFrom) return false;
                    if (f.dateTo && d > f.dateTo) return false;
                }
            }
            return true;
        };
        const keyOf = (it) => String(it.mid || it.idstr || it.id || '');

        // 找信息流那份数组：从根组件往下走，挑元素带 mid/text/pic_ids/user 且最长的那个
        const findList = () => {
            const appEl = document.querySelector('#app');
            const root = appEl && appEl._vnode && appEl._vnode.component;
            if (!root) return null;
            // 当前信息流是「屏幕上真正渲染出来的那一份」：拿页面上已有帖子的正文当指纹，
            // 哪个候选数组的条目能在里面找到，哪个才是当前列表（切页后旧组件仍挂在 Vue 树里）
            let rendered = '';
            try {
                rendered = [...document.querySelectorAll('article')].map((a) => String(a.textContent || '').replace(/\s+/g, '')).join('|').slice(0, 30000);
            } catch (e) { rendered = ''; }
            const seen = new Set();
            let best = null;
            // 单页应用切页后，上一个信息流的组件还挂在 Vue 树里；只按「数组最长」挑会挑到上一页那份。
            // 所以优先挑「组件根节点在文档里、且可见」的列表；都不可见时再退回最长的那份。
            const consider = (arr, inst) => {
                if (!Array.isArray(arr) || !arr.length) return;
                const first = arr[0];
                if (!first || typeof first !== 'object') return;
                const looks = ('mid' in first || 'idstr' in first) && ('text' in first || 'pic_ids' in first || 'user' in first);
                if (!looks) return;
                let visible = 0;
                try {
                    const el = inst && inst.subTree && inst.subTree.el;
                    if (el && el.nodeType === 1) {
                        const r = el.getBoundingClientRect();
                        const cs = getComputedStyle(el);
                        visible = (el.isConnected && cs.display !== 'none' && cs.visibility !== 'hidden' && (r.width > 0 || r.height > 0)) ? 1 : 0;
                    }
                } catch (e) { visible = 0; }
                let hits = 0;
                try {
                    for (const it of arr.slice(0, 12)) {
                        const t = strip(it.text || '').replace(/\s+/g, '').slice(0, 10);
                        if (t && rendered.indexOf(t) >= 0) hits++;
                    }
                } catch (e) { hits = 0; }
                if (!best || hits > best.hits) { best = { arr, hits, visible, length: arr.length }; return; }
                if (hits === best.hits && (visible > best.visible || (visible === best.visible && arr.length > best.length))) {
                    best = { arr, hits, visible, length: arr.length };
                }
            };
            const visit = (vn, depth) => {
                if (!vn || depth > 40) return;
                if (vn.component) walk(vn.component, depth + 1);
                if (Array.isArray(vn.children)) for (const c of vn.children) visit(c, depth + 1);
            };
            const walk = (inst, depth) => {
                if (!inst || seen.has(inst) || depth > 40) return;
                seen.add(inst);
                for (const src of [inst.data, inst.setupState, inst.props]) {
                    if (!src || typeof src !== 'object') continue;
                    let keys = [];
                    try { keys = Object.keys(src); } catch (e) { keys = []; }
                    for (const k of keys) {
                        let v;
                        try { v = src[k]; } catch (e) { continue; }
                        consider(v, inst);
                    }
                }
                visit(inst.subTree, 0);
            };
            walk(root, 0);
            return best ? best.arr : null;
        };

        // —— 换页必须先清空快照 ——
        // 微博是单页应用：点「主页/分组」不会刷新页面，window 上的 st.orig 还留着上一个信息流的条目；
        // 如果直接并进新列表再重建，新页面会被整段覆盖成「旧页面的帖子 + 新页面的帖子」（用户报的 bug）。
        const href = location.href;
        const navigated = st.href !== href;
        if (navigated) {
            st.orig = [];
            st.arr = null;
            st.href = href;
        }
        const f = norm(arg && arg.filter);
        const active = !!(arg && arg.enabled) && f.enabled;
        let list = findList();
        // 全部被筛掉时数组是空的，findList 认不出来；只要还是同一个页面，就用上次记下的那个数组
        if (!list && Array.isArray(st.arr) && st.href === href) list = st.arr;
        if (!list) return { ok: false, error: '没找到微博信息流数组' };
        if (navigated && !active) {
            // 换页后的第一次调用恰好是「关掉筛选」：新页面本来就没被筛过，
            // 绝不能拿刚清空的快照去 splice 它（那样会把新页面清空），直接以它为新基线
            st.arr = list;
            st.orig = list.slice();
            return { ok: true, total: st.orig.length, live: list.length, hidden: 0 };
        }
        // 同一地址下信息流被重建（换了数组）：新列表的第一条如果不在旧快照里，说明是另一个信息流，也要清空。
        // 用「第一条是否属于旧快照」而不是「有没有任意一条重合」：分页追加时第一条不变；
        // 我们筛掉条目后新列表的第一条仍然属于旧快照；而换到别的信息流时第一条是全新的。
        const firstLive = list.length ? keyOf(list[0]) : '';
        const sameFeed = !!firstLive && st.orig.some((it) => keyOf(it) === firstLive);
        if (st.arr && st.arr !== list && !sameFeed) st.orig = [];
        const known = new Set(st.orig.map(keyOf));
        for (const it of list) {
            const k = keyOf(it);
            if (k && !known.has(k)) { st.orig.push(it); known.add(k); }
        }
        const keep = (it) => { try { return match(it, f); } catch (e) { return true; } };
        const desired = active ? st.orig.filter(keep) : st.orig.slice();
        const cur = list.map(keyOf).join('|');
        const want = desired.map(keyOf).join('|');
        if (cur !== want) list.splice(0, list.length, ...desired);
        st.arr = list;
        st.href = href;
        // 给右下角的下拉列表用：被挡住的帖子摘要（最多 200 条，避免一次塞太多）
        let items = [];
        if (active) {
            try {
                items = st.orig.filter((it) => !keep(it)).slice(0, 200).map((it) => {
                    const u = it.user || {};
                    const uid = String(u.id || u.idstr || '');
                    return {
                        mid: keyOf(it),
                        uid,
                        name: String(u.screen_name || u.name || ''),
                        date: day(it.created_at),
                        text: strip(it.text || it.longText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
                        url: (uid && it.mblogid) ? `https://weibo.com/${uid}/${it.mblogid}` : (uid && it.mid ? `https://weibo.com/${uid}/${it.mid}` : ''),
                    };
                });
            } catch (e) { items = []; }
        }
        return { ok: true, total: st.orig.length, live: list.length, hidden: st.orig.length - desired.length, items };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

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

    galleryCacheClear: async (req) => { galleryCache.delete(Number(req && req.tabId)); gallerySel.delete(Number(req && req.tabId)); return { ok: true }; },

    gallerySelGet: async (req) => {
        const id = Number(req && req.tabId);
        const e = gallerySel.get(id);
        if (!e) return { ok: true, keys: [], pageUrl: '' };
        if (Date.now() - e.at > GALLERY_CACHE_TTL) { gallerySel.delete(id); return { ok: true, keys: [], pageUrl: '' }; }
        return { ok: true, keys: e.keys, pageUrl: e.pageUrl };
    },

    gallerySelPut: async (req) => {
        const id = Number(req && req.tabId);
        if (!id || !Array.isArray(req.keys)) return { ok: false, error: '缺少 tabId 或 keys' };
        if (!req.keys.length) { gallerySel.delete(id); return { ok: true, n: 0 }; }
        gallerySel.set(id, { at: Date.now(), pageUrl: String(req.pageUrl || ''), keys: req.keys.slice(0, GALLERY_SEL_MAX_KEYS) });
        return { ok: true, n: Math.min(req.keys.length, GALLERY_SEL_MAX_KEYS) };
    },

    applyWeiboFilterPage: async (req, sender) => {
        const tabId = Number((req && req.tabId) || (sender && sender.tab && sender.tab.id));
        if (!tabId) return { ok: false, error: '缺少 tabId' };
        try {
            const r = await chrome.scripting.executeScript({
                target: { tabId, allFrames: false },
                world: 'MAIN',
                func: weiboFilterPage,
                args: [{ filter: (req && req.filter) || null, enabled: !!(req && req.enabled) }],
            });
            return (r && r[0] && r[0].result) || { ok: false, error: '页面没有返回结果' };
        } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
        }
    },

    closeHost: async () => {
        try { if (hostMode === 'offscreen') await chrome.offscreen.closeDocument(); } catch (e) { /* 没有文档 */ }
        if (hostTabId != null) { await chrome.tabs.remove(hostTabId).catch(() => {}); hostTabId = null; }
        hostMode = null;
        return { ok: true };
    },
};

chrome.tabs.onRemoved.addListener((id) => { galleryCache.delete(id); gallerySel.delete(id); if (id === hostTabId) { hostTabId = null; hostMode = null; } });

// 换页/重新加载就清掉这个标签页的采集缓存，否则会把上一页的图混进当前页
chrome.tabs.onUpdated.addListener((id, changeInfo) => {
    if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') { galleryCache.delete(id); gallerySel.delete(id); }
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
