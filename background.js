// MV3 后台服务（ESM service worker）：设置存储、DNR 防盗链改写、抓取代理、
// 下载、离屏宿主生命周期、ComfyUI 上传与注入。

import { migrateSettings, DEFAULT_SETTINGS } from './src/common/registry.js';
import { keywordExprOf } from './src/common/weibo-filter.js';
import { llmErrorText, parseChatReply, redactKey } from './src/common/ai/llm-api.js';
import { ensureBuiltins } from './src/common/builtin-scripts.js';
import { base64ToBytes, bytesToBase64, sniffMime, sanitizeFilename, filenameFromUrl, extFromMime, bytesFingerprint, uniqueUploadName } from './src/common/util.js';
import { collectPageImages, weiboFeedPage, weiboLoadMorePages, scrollToPost } from './src/gallery/collect.mjs';
import { upgradeWeiboImageUrl, imageDedupeKey, weiboImageTierUrl, weiboStatusToPost, mergeFeedPosts, isWeiboHost, clampLoadPages } from './src/common/gallery.js';
import { MYMBLOG_API, ARCHIVE_STORE_KEY, newArchiveState, restoreArchive, serializeArchive, publicArchive, crawlArchive, mediaPlan, uniqPics, normFeatures, reconcileDone, takePages, WA_BUILD } from './src/gallery/weibo-archive.mjs';
import { parseSsrState, listedNotes, undertakeCard, xhsNoteToPost, noteDetailUrl, profileUrl, profileUid } from './src/gallery/xhs-archive.mjs';

const HOST_PAGE = 'src/host/host.html';
let hostTabId = null;
let hostMode = null; // 'offscreen' | 'tab'
let galleryBatch = null;
// 微博整档（接口路线）的两个长任务：抓档案、抓图片。都按「起任务 → 轮询」形状做，
// 理由见下面 runWaJob 上方的注释。
let waJob = null;
let waMedia = null;
// 小红书「把每条笔记的全部图取回来」任务
let xhsJob = null;
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


// ── 外部扩展 RPC 桥（UBB 等）──────────────────────────────────────────────
// manifest 的 externally_connectable.ids 决定谁能发消息进来；这里再校验一次
// sender.id，然后按 {action, ...params} 转发给内部 HANDLERS。
// 受控方能力自发现：发 {action:'__schema__'} 返回可调用清单。
const EXTERNAL_SENDER_IDS = new Set([
    'elhkfoiapjdaglefijfgapbffflphgim', // UBB — Universal Browser Bridge (D:\Codebase\ubb)
]);

const EXT_SCHEMA = {
    ok: true,
    extension: 'Media Hover Toolbar (img2comfy)',
    protocol: 1,
    note: 'send {action, ...params}; long jobs are task-based (start + poll state)',
    actions: {
        collectImages: {
            desc: '采集指定标签页全部图片（含 iframe）：垃圾过滤、去重、按博主分组；每个条目并存三档位（url=large 原图 / full=mw2000 / card=mw690）',
            params: {
                tabId: 'number 必填（chrome.tabs 的 tabId）',
                max: '最多采集数，默认 400',
                weibo: 'bool，强制按微博规则',
                feed: 'bool，微博页再读信息流数据，补回被虚拟列表回收的帖子（配 weiboLoadMore 使用）',
                accumulate: 'bool，跨调用累加（与面板共用缓存，滚过的内容不清零）',
                debug: 'bool，带回丢弃样本',
            },
            returns: '{ total, junk, groups[{key,label,url,y,items[{url,thumb,card,full,width,height,kind,alt,y}]}], dropHist, feed, pageUrl, pageTitle, weibo, accumulated }',
        },
        weiboLoadMore: {
            desc: '「帮我翻页」：不滚动页面，调微博组件自己的 loadMoreData，拿不到就带 max_id 游标直接向后端要后 1~10 页；翻完用 collectImages {feed:true} 合并',
            params: { tabId: 'number 必填', pages: '1~10，默认 1' },
            returns: '{ ok, route(component|fetch), pages, added, addedPosts, detail }',
        },
        weiboArchiveStart: {
            desc: '「整档」：走 /ajax/statuses/mymblog 接口把一个人主页的历史微博全部抓下来（不碰 DOM）。'
                + '实测页面翻页最多 ~300 条就到底，接口路线能翻到全量且响应 data.total 自报总数可当场校验。'
                + '整档要 30~60s，比调用方那层 RPC 超时更长，所以本动作立刻返回、用 weiboArchiveState 轮询',
            params: {
                uid: '数字必填（weibo.com/u/<uid>）', features: '[0,1,2,14] 默认，接口分桶取并集（只有 0 报 total）',
                maxPages: '每个桶最多翻多少页，默认 400（防敲穿限流）', delayMs: '页间隔，默认 600',
                checkpointEvery: '每多少页落一次断点，默认 10', resume: 'bool 默认 true：从 storage 断点续跑',
            },
            returns: '{ ok, started, resumed, state{pages,posts,declaredTotal,complete,withPics,picTotal,stopped,…}, note }',
        },
        weiboArchiveState: { desc: '轮询整档进度；内存里没任务时回上次落盘的断点（SW 被回收也看得到）' },
        weiboArchiveDump: {
            desc: '取档案。默认按 offset/limit 分页返回（单次上限 500 条）；to:"download" 直接把整份 JSON 落盘只回文件大小',
            params: { offset: 'int', limit: 'int ≤500', to: '"download" 走 chrome.downloads' },
            returns: '{ ok, total, offset, taken, items[] } 或 { ok, bytes, posts, filename }',
        },
        weiboArchiveMedia: {
            desc: '把档案里的图按 pid 批量落盘到 下载目录/mtb-weibo/<uid>/<拍摄日>/<pid>.jpg。'
                + '按 pid 记断点，重复调用只补没下的；orig 档单张可达 4MB，先带 limit 试一批',
            params: { tier: 'orig(large 原图)|full(mw2000)|card(mw690)|thumb(orj360)，默认 orig', limit: 'int，0=全部', subdir: '下载目录下的子目录名', concurrency: '1~4，默认 3',
                rescan: 'bool：用 chrome.downloads 的 exists 按磁盘现状重算账本（用户删过图就必须带，否则那几张永久漏下）', force: 'bool：无视账本全部重下' },
            returns: '{ ok, started, total, alreadyDone, tier, recounted, note }',
        },
        weiboArchiveMediaState: { desc: '轮询图片落盘进度（ok/fail/bytes/currentKey/errors）' },
        weiboArchiveNext: {
            desc: '面板「API 模式 · 无限下拉」的增量入口：只推进时间线游标 1~10 页就返回（同步等得起），'
                + '顺手把新帖存进该标签页采集缓存的 extra，面板下一次 collectImages {feed:true} 自然并进来',
            params: { tabId: 'number 必填（必须停在个人主页 weibo.com/u/<uid>，uid 从地址取）', pages: '1~10，默认 1' },
            returns: '{ ok, uid, fetched, added, posts[面板帖子形状], done, stopped, total, declaredTotal, cursor }',
        },
        weiboArchiveCancel: { desc: '停整档与图片两个任务（在页与页、图与图之间生效）' },
        xhsExpand: {
            desc: '小红书「把每条笔记的全部图片解析出来」：主页列表每条只有 1 张 cover，全部图在每条笔记内页的 SSR 里'
                + '（详情接口带 x-s 签名、replay 不了，实测 406）。逐条取内页 → 攒成帖子 → 落进该标签页采集缓存的 extra，'
                + '之后 collectImages {feed:true} 就会把它们并成一条笔记一组九宫格。30 条要 15~30 秒，所以起任务立刻返回',
            params: { tabId: 'number 必填（必须停在个人主页 xiaohongshu.com/user/profile/<uid>）', limit: '最多展开几条笔记，默认全部（上限 200）', delayMs: '条间隔，默认 250' },
            returns: '{ ok, started, uid, total, note } 或 { ok:false, error }',
        },
        xhsExpandState: { desc: '轮询小红书展开进度 { running, total, done, parsed, images, failed, errors, current }' },
        scrollToPost: {
            desc: '跳到某条微博：被虚拟列表回收的会自动往下翻屏挂出来并高亮，不新开标签',
            params: { tabId: 'number 必填', ids: '[mid]', key: '组 key（#ps<id> 后缀自动提取）', url: '微博地址（mid 段自动提取）', loadMissing: 'bool 默认 true' },
            returns: '{ ok, found, how, centerDelta, searched, … }',
        },
        downloadUrl: {
            desc: '高清下载：伪装 Referer（DNR 动态规则）抓字节后走 chrome.downloads 落盘',
            params: { url: '图片地址（建议用采集结果的 full/large 档）', pageUrl: '来源页地址，用于 Referer 伪装', filename: '可选文件名' },
            returns: '{ ok, downloadId, filename }',
        },
        downloadDataUrl: { desc: '下载 base64 dataURL 字节', params: { dataUrl: '', filename: '' } },
        fetchMedia: { desc: '带 Referer 伪装抓取图片字节，返回 base64（注意消息体积）', params: { url: '', pageUrl: '', filename: '' } },
        startGalleryBatch: { desc: '批量任务：下载/发送 ComfyUI 一组图片；用 galleryBatchState 轮询', params: '见 gallery 面板' },
        galleryBatchState: { desc: '轮询批量任务进度' },
        cancelGalleryBatch: { desc: '取消批量任务' },
        getState: { desc: '读取当前设置' },
        __schema__: { desc: '本清单' },
    },
    passthrough: '其余内部 HANDLERS 动作（llmChat / proxyFetch / sendImageToComfyUI …）同样可调',
};

chrome.runtime.onMessageExternal.addListener((req, sender, sendResponse) => {
    if (!EXTERNAL_SENDER_IDS.has(sender.id)) {
        sendResponse({ ok: false, error: 'sender not allowed: ' + (sender.id || '(none)') });
        return false;
    }
    if (!req || typeof req.action !== 'string') {
        sendResponse({ ok: false, error: 'missing action' });
        return false;
    }
    if (req.action === '__schema__') { sendResponse(EXT_SCHEMA); return false; }
    const h = HANDLERS[req.action];
    if (!h) { sendResponse({ ok: false, error: 'unknown action: ' + req.action }); return false; }
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
            const keywordMode = src.keywordMode === 'none' ? 'none' : src.keywordMode === 'expr' ? 'expr' : 'has';
            const rawKw = Array.isArray(src.keywords) ? src.keywords.join(keywordMode === 'expr' ? ' ' : '\n') : src.keywords;
            return {
                enabled: !!src.enabled,
                types,
                keywordMode,
                keywords: keywordMode === 'expr' ? [String(rawKw || '').trim()].filter(Boolean) : splitKeywords(rawKw),
                dateFrom: normDay(src.dateFrom),
                dateTo: normDay(src.dateTo),
            };
        };
        // 逻辑表达式在后台就解析好了（这段函数会被序列化注入，带不走解析器），这里只 walk 那棵树。
        // 节点为空（表达式看不懂）就等于「这条规则不筛」，绝不因为语法写错把整页微博藏掉。
        const exprNode = (arg && arg.expr) || null;
        const evExpr = (n, low) => {
            if (!n) return true;
            if (n.k === 'term') return !n.v || low.indexOf(n.v) >= 0;
            if (n.k === 'not') return !evExpr(n.a, low);
            if (n.k === 'and') return evExpr(n.a, low) && evExpr(n.b, low);
            if (n.k === 'or') return evExpr(n.a, low) || evExpr(n.b, low);
            return true;
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
            if (f.keywordMode === 'expr') {
                if (exprNode && !evExpr(exprNode, text.toLowerCase())) return false;
            } else if (f.keywords.length) {
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
            // 把「原帖长什么样」尽量带出来：头像、正文（保留换行）、最多 4 张图、视频封面、转发内容
            const clean = (h) => String(h || '')
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/p>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            try {
                items = st.orig.filter((it) => !keep(it)).slice(0, 200).map((it) => {
                    const u = it.user || {};
                    const uid = String(u.id || u.idstr || '');
                    const pics = [];
                    try {
                        const infos = it.pic_infos || {};
                        for (const pid of (it.pic_ids || []).slice(0, 4)) {
                            const info = infos[pid] || {};
                            const pic = (info.thumbnail && info.thumbnail.url) || (info.bmiddle && info.bmiddle.url) || (info.large && info.large.url) || '';
                            if (pic) pics.push(pic);
                        }
                    } catch (e) { /* 图片字段缺了就只显示文字 */ }
                    const page = it.page_info || {};
                    const cover = (page.page_pic && page.page_pic.url)
                        || (page.media_info && page.media_info.big_pic_info && page.media_info.big_pic_info.pic_big && page.media_info.big_pic_info.pic_big.url)
                        || '';
                    const rt = it.retweeted_status || null;
                    return {
                        mid: keyOf(it),
                        uid,
                        name: String(u.screen_name || u.name || ''),
                        avatar: String(u.profile_image_url || u.avatar_large || ''),
                        date: day(it.created_at),
                        timeText: String(it.created_at || ''),
                        text: clean(it.text || it.longText || '').slice(0, 600),
                        pics,
                        cover: String(cover || ''),
                        rtName: rt ? String((rt.user && (rt.user.screen_name || rt.user.name)) || '') : '',
                        rtText: rt ? clean(rt.text || '').slice(0, 240) : '',
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

// ── 采集合并核心（与面板 mergeResults 同构，供 RPC 复用）──────────────────
// acc 与面板的 S.raw 结构一致：{ groups, byKey, seen, byPid }，
// 这样 mergeFeedPosts（信息流补全）和 galleryCache（跨调用累加）都能直接吃。
function newCollectAcc() {
    return { groups: [], byKey: new Map(), seen: new Set(), byPid: new Map() };
}

// 把一帧（或缓存里旧的一批）采集结果并进 acc；返回首帧 meta 与本次丢弃统计。
// 注意档位策略与面板一致：url 是 large（原图/发送用），card=mw690（卡片），
// full=mw2000（查看器）——三档并存，不做统一升级。
function mergeCollectInto(acc, results) {
    let meta = null;
    const dropHist = {};
    let view = null;
    for (const r of results || []) {
        const res = r && r.result;
        if (!res || !Array.isArray(res.groups)) continue;
        if (!meta) meta = res;
        if (!view && res.view) view = res.view;
        if (res.dropHist) for (const k in res.dropHist) dropHist[k] = (dropHist[k] || 0) + res.dropHist[k];
        for (const g of res.groups) {
            let t = acc.byKey.get(g.key);
            if (!t) {
                t = { key: g.key, label: g.label || '本页图片', sub: g.sub || '', url: g.url || '', items: [], junk: !!g.junk };
                acc.byKey.set(g.key, t);
                acc.groups.push(t);
            } else if (!t.url && g.url) t.url = g.url;
            for (const raw of g.items || []) {
                const url = upgradeWeiboImageUrl(raw.url || '');
                if (!/^https?:/i.test(url) && !/^data:image\//i.test(url)) continue;
                // 同一张图出现在两条微博（转发）里按组各算一项，与面板逻辑一致
                const dkey = imageDedupeKey(url);
                const key = t.key + '|' + dkey;
                if (acc.seen.has(key)) continue;
                acc.seen.add(key);
                // 记「这张图属于哪个组」：信息流数据里的帖子要靠 pid 认亲
                if (!acc.byPid.has(dkey)) acc.byPid.set(dkey, t.key);
                const y = Math.round(raw.y) || 0;
                if (typeof t.y !== 'number' || y < t.y) t.y = y;
                t.items.push({
                    key, url,
                    thumb: raw.thumb && !/^blob:/i.test(raw.thumb) ? raw.thumb : url,
                    card: raw.card || weiboImageTierUrl(url, 'card'),
                    full: raw.full || weiboImageTierUrl(url, 'full'),
                    y,
                    width: raw.width | 0, height: raw.height | 0,
                    kind: raw.kind || 'image', alt: raw.alt || '',
                    pageUrl: raw.pageUrl || (meta && meta.pageUrl) || '',
                    groupKey: t.key,
                });
            }
        }
    }
    return { meta, dropHist, view };
}

// 从 galleryCache 的旧条目恢复 acc（面板 seedFromCache 的 RPC 版：
// 缓存里的 groups 是纯 JSON，重建 byKey/seen/byPid 三个索引）。
function seedAccFromCache(entry) {
    const acc = newCollectAcc();
    if (!entry) return { acc, meta: null };
    for (const g of (Array.isArray(entry.groups) ? entry.groups : [])) {
        if (!g || !Array.isArray(g.items) || !g.items.length) continue;
        const t = { ...g };
        acc.byKey.set(t.key, t);
        acc.groups.push(t);
        for (const it of t.items) {
            if (it && it.key) acc.seen.add(it.key);
            const dkey = it && it.url ? imageDedupeKey(it.url) : '';
            if (dkey && !acc.byPid.has(dkey)) acc.byPid.set(dkey, t.key);
        }
    }
    return { acc, meta: entry.meta || null };
}

// acc → 响应视图：组按页面位置排序（面板顺序=信息流顺序），「无用图片」垫底。
function accView(acc, dropHist, view) {
    const groups = acc.groups
        .filter((g) => g.items.length)
        .sort((a, b) => (a.junk ? 1 : 0) - (b.junk ? 1 : 0) || (a.y ?? 0) - (b.y ?? 0))
        .map((g) => { for (const it of g.items) it.groupLabel = g.label; return g; });
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    const junk = groups.filter((g) => g.junk).reduce((n, g) => n + g.items.length, 0);
    return { total, junk, groups, dropHist, view };
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

    // 外部桥入口：对指定标签页做图片采集。与 gallery 面板同一套合并核心：
    //   feed:true       微博页再读信息流数据（虚拟列表回收的帖子在这里补回）
    //   accumulate:true 跨调用累加（与面板共用 galleryCache，滚过的内容不清零）
    collectImages: async (req) => {
        const tabId = Number(req.tabId) || 0;
        if (!tabId) throw new Error('tabId required (chrome.tabs id)');
        let tab;
        try { tab = await chrome.tabs.get(tabId); }
        catch (e) { throw new Error('tab not found: ' + tabId); }
        let host = '';
        try { host = new URL(tab.url || '').hostname; } catch (e) { /* 非 http(s) 页 */ }
        const weiboFlag = req.weibo === true || isWeiboHost(host);
        const accumulate = req.accumulate === true;
        const wantFeed = req.feed === true && weiboFlag;

        // 1) 种子：累加模式下先并入这个标签页的缓存（面板与 RPC 共用一份）
        let acc, seedMeta = null, extraPosts = [];
        if (accumulate) {
            const e = galleryCache.get(tabId);
            const fresh = e && Date.now() - e.at <= GALLERY_CACHE_TTL ? e : null;
            const seeded = seedAccFromCache(fresh);
            acc = seeded.acc;
            seedMeta = seeded.meta;
            if (fresh && Array.isArray(fresh.extra)) {
                extraPosts = fresh.extra.filter((p) => p && Array.isArray(p.pics) && p.pics.length);
            }
        } else {
            acc = newCollectAcc();
        }

        // 2) DOM 扫描（allFrames，受限页面降级单帧）
        const args = [{
            max: Math.max(1, Math.min(1000, Number(req.max) || 400)),
            weibo: weiboFlag,
            debug: req.debug === true,
        }];
        let results;
        try {
            results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: collectPageImages, args });
        } catch (e) {
            results = await chrome.scripting.executeScript({ target: { tabId }, func: collectPageImages, args });
        }
        const { meta, dropHist, view } = mergeCollectInto(acc, results);

        // 3) 信息流数据补全：MAIN world 读微博自己的 feed 数组 + 「帮我翻页」攒下的 extra
        let feedStats = null;
        if (wantFeed) {
            const r = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: weiboFeedPage, args: [{ max: 300 }] }).catch(() => null);
            const res = r && r[0] && r[0].result;
            const posts = [];
            if (res && res.ok && Array.isArray(res.posts)) {
                const seenMid = new Set();
                for (const [i, it] of res.posts.entries()) {
                    const p = weiboStatusToPost(it, Number(it.index) || i, host);
                    if (!p.pics.length) continue;
                    if (p.mid) { if (seenMid.has(p.mid)) continue; seenMid.add(p.mid); }
                    posts.push(p);
                }
            }
            const allPosts = posts.concat(extraPosts);
            if (allPosts.length) feedStats = mergeFeedPosts(acc, allPosts, { pageUrl: tab.url });
        }

        const out = accView(acc, dropHist, view || (seedMeta && seedMeta.view) || null);

        // 4) 写回缓存（与面板同格式；信息流补来的条目每次都能重取，不进缓存）
        if (accumulate && acc.groups.length) {
            const groupsOut = acc.groups
                .map((g) => {
                    const items = (g.items || []).filter((it) => it.src !== 'feed');
                    return items.length ? { ...g, items, y: items.reduce((m, it) => Math.min(m, it.y || 0), Infinity) } : null;
                })
                .filter(Boolean);
            if (groupsOut.length || extraPosts.length) {
                await HANDLERS.galleryCachePut({
                    tabId,
                    entry: {
                        meta: { pageUrl: tab.url, pageTitle: tab.title, host, weibo: weiboFlag, view: out.view },
                        groups: groupsOut,
                        extra: extraPosts,
                    },
                });
            }
        }
        return { ok: true, tabId, pageUrl: tab.url, pageTitle: tab.title, weibo: weiboFlag, accumulated: accumulate, feed: feedStats, ...out };
    },

    // 外部桥入口：「帮我翻页」。不滚动页面，直接调微博组件自己的 loadMoreData，
    // 拿不到就克隆读流请求带 max_id 游标向后端要后几页（1~10 页，太多容易被限流）。
    // fetch 路由要来的帖子不在页面列表里，转成帖子存进该标签页缓存 的 extra，
    // 之后的 collectImages {feed:true} 会把它们并进来。
    weiboLoadMore: async (req) => {
        const tabId = Number(req.tabId) || 0;
        if (!tabId) throw new Error('tabId required');
        let tab;
        try { tab = await chrome.tabs.get(tabId); }
        catch (e) { throw new Error('tab not found: ' + tabId); }
        const pages = clampLoadPages(Number(req.pages) || 1);
        let res;
        try {
            const r = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: weiboLoadMorePages, args: [{ pages }] });
            res = r && r[0] && r[0].result;
        } catch (e) {
            res = { ok: false, error: String((e && e.message) || e) };
        }
        if (!res) return { ok: false, error: '页面无响应（可能刚更新，刷新页面后重试）' };
        let addedPosts = 0;
        if (res.route === 'fetch' && Array.isArray(res.statuses)) {
            let fhost = '';
            try { fhost = new URL(tab.url || '').hostname; } catch (e) { /* ignore */ }
            const e = galleryCache.get(tabId) || {};
            const extra = Array.isArray(e.extra) ? e.extra : [];
            const seen = new Set(extra.map((p) => p && p.mid).filter(Boolean));
            for (const s of res.statuses) {
                const p = weiboStatusToPost(s, 0, fhost);
                if (!p.pics.length || (p.mid && seen.has(p.mid))) continue;
                if (p.mid) seen.add(p.mid);
                extra.push(p);
                addedPosts++;
            }
            galleryCache.set(tabId, {
                at: Date.now(),
                meta: e.meta || null,
                groups: Array.isArray(e.groups) ? e.groups : [],
                extra: extra.slice(-900),
            });
        }
        return {
            ok: !!res.ok,
            route: res.route || '',
            pages: res.pages | 0,
            added: res.added | 0,
            addedPosts,
            detail: res.detail || res.stopped || res.error || '',
            note: '翻完后用 collectImages {feed:true, accumulate:true} 合并结果',
        };
    },

    // 外部桥入口：跳到某条微博（含被虚拟列表回收的：自动往下翻屏挂出来高亮）。
    // ids 或 url/key 至少给一个；key/url 里的 mid 段会自动提取（与面板 groupIdsOf 一致）。
    // ── 微博整档：抓档案 / 抓图片，都是长任务，只起不对等 ──────────────────
    weiboArchiveStart: async (req) => {
        const uid = String(req.uid || '').trim();
        if (!/^\d{5,}$/.test(uid)) throw new Error('uid 必须是数字（个人主页 weibo.com/u/<uid> 里那个）');
        if (waJob && waJob.running) {
            return { ok: true, started: false, note: '整档已经在跑，这是当前进度', state: publicArchive(waJob.st) };
        }
        let st;
        let resumed = false;
        if (req.resume !== false) {
            const rec = (await chrome.storage.local.get(ARCHIVE_STORE_KEY))[ARCHIVE_STORE_KEY];
            if (rec && String(rec.uid) === uid && Array.isArray(rec.posts) && rec.posts.length) {
                st = restoreArchive(rec);
                // 显式传了 features 就要听，包括传单个数字 0；沿用存档的桶会让调用方以为参数没生效
                if (req.features !== undefined && req.features !== null && req.features !== '') st.features = normFeatures(req.features);
                st.maxPages = Number(req.maxPages) || st.maxPages;
                st.delayMs = Number(req.delayMs) || st.delayMs;
                st.done = false; st.error = ''; st.stopped = '';
                resumed = true;
            }
        }
        if (!st) st = newArchiveState(uid, req);
        waJob = {
            st, running: true, cancel: false, pub: publicArchive(st),
            checkpointEvery: Math.max(1, Number(req.checkpointEvery) || 10),
            mediaDone: new Set(Array.isArray(st.mediaDone) ? st.mediaDone : []),
        };
        runWaJob();
        return {
            ok: true, started: true, resumed, state: publicArchive(st),
            note: resumed ? `从断点续跑（已存 ${st.posts.length} 条）` : '任务已起，用 weiboArchiveState 轮询进度',
        };
    },

    weiboArchiveState: async () => {
        // build 必须在**每一条**返回路径上（包括还没有档案时）：它是「浏览器到底加载了哪一版」的
        // 唯一探针，真人 Edge 的 ESM SW 会连着几次重载仍跑旧版，读不到版本就没法判断该不该继续测
        if (waJob) {
            const pub = publicArchive(waJob.st);
            pub.running = !!waJob.running;
            // 图片进度只在内存任务上，不补这一笔的话跑完一轮 Media 后 State 会「看不到进度」
            pub.mediaDone = waJob.mediaDone ? waJob.mediaDone.size : ((waJob.st.mediaDone || []).length);
            return { ok: true, build: WA_BUILD, state: pub, media: publicWaMedia() };
        }
        const stored = await waStoredState();
        return stored ? { ok: true, build: WA_BUILD, state: stored, media: publicWaMedia(), note: '内存里没有任务，这是上次落盘的断点' }
            : { ok: true, build: WA_BUILD, state: null, media: null, note: '还没有整档记录' };
    },

    // 档案动辄 1~2MB，塞进一次 RPC 消息会把调用方撑爆（扩展消息通道也不是为大数据设计的），
    // 所以 to:'download' 直接落盘，只回文件大小；要内容就按 offset/limit 分页取。
    weiboArchiveDump: async (req) => {
        const job = await waEnsureArchive();
        const posts = job.st.posts;
        if (req.to === 'download') {
            const json = JSON.stringify({
                uid: job.st.uid, generated: new Date().toISOString(),
                total: posts.length, declaredTotal: job.st.declaredTotal || 0,
                perFeature: job.st.perFeature, posts,
            });
            const b64 = bytesToBase64(new TextEncoder().encode(json));
            const id = await chrome.downloads.download({
                url: `data:application/json;base64,${b64}`, filename: `mtb-weibo/${job.st.uid}_archive.json`,
                saveAs: false, conflictAction: 'overwrite',
            });
            const st = await downloadSettled(id);
            return { ok: true, bytes: json.length, posts: posts.length, filename: (st && st.filename) || `${job.st.uid}_archive.json` };
        }
        const off = Math.max(0, Number(req.offset) || 0);
        const lim = Math.max(1, Math.min(Number(req.limit) || 200, 500));
        return { ok: true, total: posts.length, offset: off, taken: Math.min(lim, posts.length - off), items: posts.slice(off, off + lim), state: publicArchive(job.st) };
    },

    weiboArchiveCancel: async () => {
        if (waJob && waJob.running) waJob.cancel = true;
        if (waMedia && waMedia.running) waMedia.cancel = true;
        return { ok: true, state: waJob ? publicArchive(waJob.st) : null, media: publicWaMedia() };
    },

    weiboArchiveMedia: async (req) => {
        await waEnsureArchive();          // 断点里取回的档案同样能继续下（SW 重启不必重抓整档）
        if (waMedia && waMedia.running) return { ok: true, started: false, note: '图片任务已在跑', media: publicWaMedia() };
        let before = waJob.mediaDone.size;
        if (req.force) waJob.mediaDone = new Set();                      // 全部重下
        else if (req.rescan) {                                           // 按磁盘现状重算账本
            waJob.mediaDone = reconcileDone(uniqPics(waJob.st.posts), await waExistingFiles(waJob.st.uid));
        }
        const done = waJob.mediaDone;
        const plan = mediaPlan(waJob.st, { tier: req.tier, subdir: req.subdir, limit: Number(req.limit) || 0, skip: done });
        waMedia = {
            running: true, cancel: false, canceled: false, plan, done, index: 0, ok: 0, fail: 0,
            bytes: 0, skipped: done.size, tier: plan.length ? plan[0].tier : String(req.tier || 'orig'),
            errors: [], sample: [], currentKey: '', concurrency: Number(req.concurrency) || 3, startedAt: Date.now(), finishedAt: 0,
        };
        runWaMedia();
        return {
            ok: true, started: true, total: plan.length, alreadyDone: done.size, tier: waMedia.tier,
            // 账本被磁盘现状改了多少（负数=发现文件其实没了，这些会重新下）
            recounted: req.force ? -before : (req.rescan ? done.size - before : 0),
            note: 'orig 档单张可达 4MB，整档几千张建议先带 limit 试一批；断点按 pid 记，重复调用只补没下的；'
                + '删过下载目录的话带 rescan:true 按磁盘重算账本',
        };
    },

    weiboArchiveMediaState: async () => ({ ok: true, media: publicWaMedia() }),

    // 面板「API 模式 · 无限下拉」的增量入口：一次只推进 1~10 页就返回（约 0.5~5 秒，同步等得起），
    // 转成帖子顺手存进该标签页采集缓存的 extra —— 和「帮我翻页」的 fetch 路由同一个落点，
    // 所以面板随后的 collectImages {feed:true} 会自然把它们并进来，不用另写一套合并。
    weiboArchiveNext: async (req) => {
        const tabId = Number(req.tabId) || 0;
        if (!tabId) throw new Error('tabId required');
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) throw new Error('tab not found: ' + tabId);
        const uid = waProfileUid(tab.url || '');
        if (!uid) return { ok: false, needUid: true, error: 'API 模式要在个人主页上用（地址形如 weibo.com/u/<uid>），这个页面认不出 uid' };
        const job = await waJobFor(uid);
        // 必须在这里也装 Referer 规则：weibo 的 mymblog 没有 Referer 直接 403（实测：装规则 200、
        // 不装 403）。整档与图片各自装过，唯独这条漏了 —— 面板勾了 API 模式就是一条都不显示。
        let r;
        try {
            await waSetReferer(WA_API_RULE, 'weibo.com/ajax/statuses/mymblog');
            r = await takePages(job.st, waFetchPage, req.pages || 1, 0);
        } finally {
            await waClearReferer(WA_API_RULE);
        }
        let host = '';
        try { host = new URL(tab.url || '').hostname; } catch (e) { /* ignore */ }
        const e = galleryCache.get(tabId) || {};
        const extra = Array.isArray(e.extra) ? e.extra : [];
        const seen = new Set(extra.map((p) => p && p.mid).filter(Boolean));
        const posts = [];
        for (const s of r.fresh) {
            const p = weiboStatusToPost(s, 0, host);
            if (!p.pics.length || (p.mid && seen.has(p.mid))) continue;
            if (p.mid) seen.add(p.mid);
            extra.push(p);
            posts.push(p);
        }
        if (posts.length) {
            galleryCache.set(tabId, { at: Date.now(), meta: e.meta || null, groups: Array.isArray(e.groups) ? e.groups : [], extra: extra.slice(-900) });
        }
        await waCheckpoint().catch(() => {});
        return {
            ok: true, uid, fetched: r.fetched, added: r.added, posts, done: !!r.done, failed: !!r.failed,
            stopped: r.stopped || '', total: job.st.posts.length, declaredTotal: job.st.declaredTotal || 0,
            cursor: r.cursor,
        };
    },

    // ── 小红书：列表每条笔记只有封面，这里把每条笔记的全部图片解析出来 ──────────
    xhsExpand: async (req) => {
        const tabId = Number(req.tabId) || 0;
        if (!tabId) throw new Error('tabId required');
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) throw new Error('tab not found: ' + tabId);
        const uid = profileUid(tab.url || '');
        if (!uid) return { ok: false, error: '小红书要在个人主页上用（地址形如 xiaohongshu.com/user/profile/<uid>），这个页面认不出 uid' };
        if (xhsJob && xhsJob.running) return { ok: true, started: false, note: '展开任务已在跑，这是当前进度', state: publicXhs() };
        const prof = profileUrl(uid);
        const notes = listedNotes(parseSsrState(await xhsFetchHtml(prof, prof)));
        if (!notes.length) return { ok: false, error: '主页 SSR 里没解析出笔记列表（没登录、被风控、或小红书改了页面结构）' };
        const lim = Math.max(1, Math.min(Number(req.limit) || notes.length, 200));
        xhsJob = {
            uid, tabId, notes: notes.slice(0, lim), index: 0, parsed: 0, images: 0,
            failed: [], errors: [], current: '', running: true, cancel: false, canceled: false,
            delayMs: Math.max(0, Number(req.delayMs) || 250), startedAt: Date.now(), finishedAt: 0,
        };
        runXhsJob();
        return {
            ok: true, started: true, uid, total: xhsJob.notes.length,
            note: '逐条取内页 SSR（列表只有封面）；用 xhsExpandState 轮询，每解析出一条就落进该标签页采集缓存，面板刷新即可见',
        };
    },

    xhsExpandState: async () => ({ ok: true, state: publicXhs() }),

    scrollToPost: async (req) => {
        const tabId = Number(req.tabId) || 0;
        if (!tabId) throw new Error('tabId required');
        const ids = [];
        for (const v of (Array.isArray(req.ids) ? req.ids : [])) {
            const s = String(v || '');
            if (s.length >= 5 && ids.indexOf(s) < 0) ids.push(s);
        }
        for (const s of [String(req.key || ''), String(req.url || '')]) {
            let m = /#ps(.+)$/.exec(s);
            if (m && ids.indexOf(m[1]) < 0) ids.push(m[1]);
            m = /weibo\.(?:com|cn)\/(?:\d{5,}\/)?([\w]{5,})(?:[?#]|$)/.exec(s);
            if (m && ids.indexOf(m[1]) < 0) ids.push(m[1]);
        }
        if (!ids.length && !req.url) return { ok: false, error: '需要 ids / key / url 至少一个' };
        let res;
        try {
            const r = await chrome.scripting.executeScript({
                target: { tabId },
                func: scrollToPost,
                args: [{ ids, url: String(req.url || ''), loadMissing: req.loadMissing !== false, color: String(req.color || '#6ea8fe') }],
            });
            res = r && r[0] && r[0].result;
        } catch (e) {
            res = { ok: false, error: String((e && e.message) || e) };
        }
        return res || { ok: false, error: '页面无响应' };
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

    // 看图说话/提问/OCR 的模型调用统一走这里：扩展页 fetch 有 <all_urls> 主机权限，不受 CORS 限制，
    // 密钥也只停在后台这一次请求里（错误文案一律过一遍 redact，别把密钥回显到设置页/工具栏）。
    llmChat: async (req) => {
        const url = String(req.url || '');
        if (!/^https?:\/\//i.test(url)) throw new Error('LLM 端点必须是 http(s) 地址');
        const timeoutMs = Math.min(Math.max(Number(req.timeoutMs) || 90000, 5000), 600000);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const headers = { ...(req.headers || {}) };
        let bodyText = '';
        try {
            bodyText = JSON.stringify(req.body || {});
            const res = await fetch(url, { method: 'POST', headers, body: bodyText, redirect: 'follow', signal: ctrl.signal });
            const text = await res.text();
            if (!res.ok) return { ok: false, status: res.status, error: redactKey(llmErrorText(res.status, text), req.maskSecret) };
            let json = null;
            try { json = JSON.parse(text); } catch (e) {
                return { ok: false, status: res.status, error: redactKey('应答不是 JSON（端点填错、或这个地址不是 chat/completions）：' + clipText(text), req.maskSecret) };
            }
            const r = parseChatReply(json);
            if (!r.text) return { ok: false, status: res.status, error: redactKey('应答里没有文字内容' + (r.finish ? '（finish_reason=' + r.finish + '，多半被 max_tokens 截断或模型不支持图片）' : ''), req.maskSecret) };
            return { ok: true, status: res.status, text: r.text, model: r.model || '', usage: r.usage || null };
        } catch (e) {
            const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || e)));
            const msg = aborted ? `请求超过 ${Math.round(timeoutMs / 1000)} 秒已中断（端点太慢或图片太大）`
                : '连不上这个端点：' + redactKey(String((e && e.message) || e), req.maskSecret);
            return { ok: false, error: msg };
        } finally {
            clearTimeout(timer);
        }
    },

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
        // 「帮我翻页」直接要来的帖子（不在页面列表里，重扫也拿不到）跟着标签页一起存
        const extra = Array.isArray(entry.extra) ? entry.extra.slice(0, 900).filter((p) => p && Array.isArray(p.pics)) : [];
        galleryCache.set(id, { at: Date.now(), meta: entry.meta || null, groups, extra });
        return { ok: true, items: n, groups: groups.length, extra: extra.length };
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
        const f = (req && req.filter) || null;
        // 表达式在这里解析成树再注入：注入的那段函数是序列化的，带不走解析器，只会 walk 树
        let expr = null;
        try {
            if (f && f.keywordMode === 'expr') {
                const src = Array.isArray(f.keywords) ? f.keywords.join(' ') : String((f && f.keywords) || '');
                const parsed = keywordExprOf(src);
                if (parsed.ok) expr = parsed.node;
            }
        } catch (e) { expr = null; }
        try {
            const r = await chrome.scripting.executeScript({
                target: { tabId, allFrames: false },
                world: 'MAIN',
                func: weiboFilterPage,
                args: [{ filter: f, enabled: !!(req && req.enabled), expr }],
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
// ── 微博整档（接口路线，不碰 DOM）───────────────────────────────────
// 为什么要单独一条链：页面侧「帮我翻页」实测最多翻到 ~300 条就被微博截断（2023 年以前的内容
// 根本翻不出来），而 /ajax/statuses/mymblog 实测 60 页 / 1176 条全量，响应里的 data.total 还会
// 自报总数，能当场校验有没有漏。
// 为什么是「起任务 + 轮询」而不是一个同步动作：整档要 30~60 秒，比调用方那层的 RPC 硬顶
// （ubb CLI 60s、ext.call 内层默认 45s）更长 —— 同步返回必然被掐死，而且扩展这边其实跑完了，
// 只是响应丢了。所以 Start 立刻返回，进度靠 State 轮询。
const WA_API_RULE = 4242;
const WA_IMG_RULE = 4243;
const WA_PAGE_URL = 'https://weibo.com/';

/* Referer 是浏览器的 forbidden header，fetch 里写不动，只能靠 DNR 改写。
   整档要发几十次请求，逐条加删规则是白烧 DNR 配额（而且每次 updateDynamicRules 都是异步的，
   加删顺序一乱就会出现某几页没带上 Referer 而 403），所以整段任务共用一条规则。 */
async function waSetReferer(id, urlFilter) {
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [id],
        addRules: [{
            id, priority: 1,
            action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: WA_PAGE_URL }] },
            condition: { urlFilter, resourceTypes: ['xmlhttprequest', 'image', 'other'] },
        }],
    });
}

async function waClearReferer(id) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [id] }).catch(() => {});
}

async function waFetchPage(q) {
    const url = `${MYMBLOG_API}?uid=${encodeURIComponent(q.uid)}&page=${q.page}&feature=${q.feature}`
        + (q.sinceId ? `&since_id=${encodeURIComponent(q.sinceId)}` : '');
    const res = await fetch(url, {
        credentials: 'include', redirect: 'follow',
        headers: { 'x-requested-with': 'XMLHttpRequest', accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}` + (res.status === 403 || res.status === 418 || res.status === 429
            ? '（微博限流或风控，整档已停止；把 delayMs 调大再续跑）' : ''));
    }
    try { return JSON.parse(text); }
    catch (e) { throw new Error('应答不是 JSON —— 多半是登录态掉了被重定向到 passport 页'); }
}

// 游标和帖子必须同进同退：只把游标写快一步，SW 被回收后续跑就会跳过没落盘的那几页（静默少一批）。
// 所以 checkpoint 只在整档状态一起落盘时发生，代价是最多重跑 checkpointEvery 页。
async function waCheckpoint() {
    if (!waJob) return;
    const rec = serializeArchive(waJob.st);
    rec.mediaDone = Array.from(waJob.mediaDone || []);
    rec.savedAt = Date.now();
    await chrome.storage.local.set({ [ARCHIVE_STORE_KEY]: rec });
}

function broadcastWa(payload) {
    try { chrome.runtime.sendMessage({ action: 'weiboArchiveEvent', ...payload }).catch(() => {}); }
    catch (e) { /* 面板没开，没有接收方 */ }
}

async function runWaJob() {
    const j = waJob;
    if (!j) return;
    // MV3 的 SW 空闲 30s 回收；整档动辄一分钟，必须持续有一次扩展 API 调用给它续命
    const keep = setInterval(() => { try { chrome.runtime.getPlatformInfo().catch(() => {}); } catch (e) { /* ignore */ } }, 20000);
    try {
        await waSetReferer(WA_API_RULE, 'weibo.com/ajax/statuses/mymblog');
        await crawlArchive({
            fetchPage: waFetchPage,
            checkpoint: waCheckpoint,
            checkpointEvery: j.checkpointEvery,
            shouldStop: () => j.cancel,
            onProgress: (pub) => { j.pub = pub; broadcastWa(pub); },
        }, j.st);
    } catch (e) {
        j.st.error = String((e && e.message) || e);
        j.st.running = false;
    } finally {
        clearInterval(keep);
        await waClearReferer(WA_API_RULE);
        j.running = false;
        await waCheckpoint().catch(() => {});
        broadcastWa(publicArchive(j.st));
    }
}

/* 图片落盘不走 downloadBinary：它内部 sanitizeFilename 会把 '/' 换成 '_'，
   子目录 mtb-weibo/<uid>/<日期>/ 会被压成一个扁平文件名。这里按段清洗、自己拼相对路径。
   也不走 fetchWithReferer：它每张图都 addRefererRule + removeRuleIds 一次，几千张就是近万次
   规则引擎往返（downloadUrl 单张用没问题，批量不行），换成上面那条任务级共用规则 + 直取。
   Referer 是 forbidden header，fetch 里写不动，只能由 WA_IMG_RULE 改写。 */
async function waDownload(item) {
    const res = await fetch(item.url, { credentials: 'include', redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 1000) throw new Error('字节太少（' + bytes.length + '），多半是被防盗链挡了');
    const mime = (res.headers.get('content-type') || '').split(';')[0] || sniffMime(bytes);
    const name = item.key.split('/').map((seg) => sanitizeFilename(seg, 80)).join('/');
    const b64 = bytesToBase64(bytes);
    const id = await chrome.downloads.download({
        url: `data:${mime || 'image/jpeg'};base64,${b64}`, filename: name,
        saveAs: false, conflictAction: 'overwrite',
    });
    const st = await downloadSettled(id);
    if (st && st.state === 'interrupted') throw new Error('下载被中断: ' + (st.error || 'unknown'));
    return { filename: (st && st.filename) || name, bytes: bytes.length };
}

async function runWaMedia() {
    const j = waMedia;
    if (!j) return;
    const keep = setInterval(() => { try { chrome.runtime.getPlatformInfo().catch(() => {}); } catch (e) { /* ignore */ } }, 20000);
    const pool = Math.max(1, Math.min(4, Number(j.concurrency) || 3));
    try {
        await waSetReferer(WA_IMG_RULE, 'sinaimg.cn');
        let i = 0;
        const worker = async () => {
            while (i < j.plan.length) {
                if (j.cancel) { j.canceled = true; return; }
                const item = j.plan[i++];
                j.index = i;
                j.currentKey = item.key;
                try {
                    const r = await waDownload(item);
                    j.ok++;
                    j.bytes += r.bytes;
                    j.done.add(item.pid);
                    if (!j.sample.length) j.sample.push(r.filename);
                } catch (e) {
                    j.fail++;
                    if (j.errors.length < 20) j.errors.push(`${item.pid}: ${String((e && e.message) || e)}`);
                }
                if (j.ok % 25 === 0) { await waMediaCheckpoint(); broadcastWa({ type: 'media', ...publicWaMedia() }); }
            }
        };
        await Promise.all(Array.from({ length: pool }, worker));
    } finally {
        clearInterval(keep);
        await waClearReferer(WA_IMG_RULE);
        j.running = false;
        j.currentKey = '';
        j.finishedAt = Date.now();
        await waMediaCheckpoint().catch(() => {});
        broadcastWa({ type: 'media', ...publicWaMedia() });
    }
}

async function waMediaCheckpoint() {
    if (!waJob) return;
    waJob.st.mediaDone = Array.from(waJob.mediaDone || []);
    await waCheckpoint();
}

// Dump 与 Media 都要能在「SW 已被回收、只剩断点」时继续工作：先把断点装回 waJob（不重新抓）
async function waEnsureArchive() {
    if (waJob && waJob.st && waJob.st.posts.length) return waJob;
    const r = await waRestored();
    if (!r) throw new Error('还没有整档结果：先 weiboArchiveStart 抓完档案');
    waJob = {
        st: r.st, running: false, cancel: false, pub: publicArchive(r.st),
        checkpointEvery: 10, mediaDone: new Set(r.st.mediaDone || []),
    };
    return waJob;
}

/* mediaDone 只是记账：用户从下载目录里删掉图之后，只信账本就会永久漏下那几张
   （实测账本记 7 张、磁盘只剩 2 张）。rescan 用 chrome.downloads 的 exists 字段按磁盘现状重算。
   search 单次上限 1000 条，所以要翻页取完。 */
async function waExistingFiles(uid) {
    const names = [];
    for (let offset = 0; ; offset += 1000) {
        const rows = await chrome.downloads.search({ query: 'mtb-weibo/' + uid, offset, limit: 1000 });
        for (const it of rows || []) if (it && it.exists && it.filename) names.push(it.filename);
        if (!rows || rows.length < 1000) break;
    }
    return names;
}

/* 个人主页地址里的 uid：weibo.com/u/<uid>（桌面版主页）与 weibo.com/profile/<uid>（带名字的那版）。
   不是主页（分组首页 /my/groups、搜索结果、m 站等）就拿不到 uid，API 模式必须明确拒绝而不是猜。 */
function waProfileUid(url) {
    const m = /weibo\.com\/(?:u|profile)\/(\d{5,})/i.exec(String(url || ''));
    return m ? m[1] : '';
}

// 面板下拉与整档共用一份游标：同一个 uid 就复用现有任务，换 uid 才新建（断点只有一个槽位）
async function waJobFor(uid) {
    if (waJob && waJob.running) throw new Error('整档任务正在跑，先等它结束或用 weiboArchiveCancel');
    if (waJob && String(waJob.st.uid) === String(uid)) return waJob;
    const r = await waRestored();
    const st = (r && String(r.st.uid) === String(uid)) ? r.st : newArchiveState(uid, { features: [0] });
    waJob = { st, running: false, cancel: false, pub: publicArchive(st), checkpointEvery: 10, mediaDone: new Set(st.mediaDone || []) };
    return waJob;
}

function publicWaMedia() {
    if (!waMedia) return null;
    const j = waMedia;
    return {
        running: !!j.running, canceled: !!j.canceled, tier: j.tier, total: j.plan.length,
        index: j.index, ok: j.ok, fail: j.fail, bytes: j.bytes, skipped: j.skipped,
        currentKey: j.currentKey, errors: j.errors.slice(0, 20), sample: j.sample,
        startedAt: j.startedAt, finishedAt: j.finishedAt,
    };
}

/* 从断点里取回可用的档案状态。SW 被回收后 waJob 就没了，但档案与图片进度还在 storage 里 ——
   Dump 与 Media 必须还能继续用，否则「按 pid 断点续传」等于白做（重启一次就得重抓整档）。 */
async function waRestored() {
    const rec = (await chrome.storage.local.get(ARCHIVE_STORE_KEY))[ARCHIVE_STORE_KEY];
    if (!rec || !Array.isArray(rec.posts) || !rec.posts.length) return null;
    const st = restoreArchive(rec);
    st.mediaDone = Array.isArray(rec.mediaDone) ? rec.mediaDone : [];
    return { st, savedAt: rec.savedAt || 0 };
}

async function waStoredState() {
    const r = await waRestored();
    if (!r) return null;
    return { ...publicArchive(r.st), storedAt: r.savedAt, mediaDone: r.st.mediaDone.length, resumed: true };
}

/* 小红书：列表页每条笔记只带 1 张 cover，**全部图片在每条笔记内页的 SSR 里**；
   而它的详情/翻页接口 edith.xiaohongshu.com 不带 x-s 签名直接 406（实测），签名是前端 JS 算的、replay 不了。
   所以这条链只能是「取主页 SSR → 逐条取内页 SSR → 攒成帖子」。30 条要 15~30 秒，
   和微博整档同理：必须「起任务 + 轮询」，同步返回一定被调用方那层超时掐死。 */
const XHS_PAGE_RULE = 4244;

async function xhsFetchHtml(url, pageUrl) {
    const res = await fetch(url, { credentials: 'include', redirect: 'follow', headers: { accept: 'text/html,*/*' } });
    const text = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status);
    // 风控时会回一个很小的校验页，不是 403 —— 只按状态码判会把它当成功，然后一条都解析不出来
    if (text.length < 3000) throw new Error('页面只有 ' + text.length + ' 字节，多半被风控拦成校验页（歇一会儿再试）');
    return text;
}

function publicXhs() {
    if (!xhsJob) return null;
    const j = xhsJob;
    return {
        running: !!j.running, canceled: !!j.canceled, uid: j.uid, total: j.notes.length,
        done: j.index, parsed: j.parsed, images: j.images, failed: j.failed.length,
        errors: j.errors.slice(0, 10), current: j.current, startedAt: j.startedAt, finishedAt: j.finishedAt,
    };
}

async function xhsPushToCache(tabId, posts) {
    const e = galleryCache.get(tabId) || {};
    const extra = Array.isArray(e.extra) ? e.extra : [];
    const seen = new Set(extra.map((p) => p && p.mid).filter(Boolean));
    let added = 0;
    for (const p of posts) {
        if (!p.pics.length || (p.mid && seen.has(p.mid))) continue;
        if (p.mid) seen.add(p.mid);
        extra.push(p);
        added++;
    }
    galleryCache.set(tabId, { at: Date.now(), meta: e.meta || null, groups: Array.isArray(e.groups) ? e.groups : [], extra: extra.slice(-900) });
    return added;
}

async function runXhsJob() {
    const j = xhsJob;
    if (!j) return;
    const keep = setInterval(() => { try { chrome.runtime.getPlatformInfo().catch(() => {}); } catch (e) { /* ignore */ } }, 20000);
    try {
        await waSetReferer(XHS_PAGE_RULE, 'xiaohongshu.com');
        for (const n of j.notes) {
            if (j.cancel) { j.canceled = true; break; }
            j.index++;
            j.current = n.id;
            try {
                const html = await xhsFetchHtml(noteDetailUrl(n.id, n.token), profileUrl(j.uid));
                const nc = undertakeCard(parseSsrState(html), n.id);
                const imgs = (nc && nc.imageList) || [];
                if (!imgs.length) { j.failed.push(n.id + ':没解析出图片'); continue; }
                const post = xhsNoteToPost({ ...nc, noteId: n.id }, 'www.xiaohongshu.com');
                j.parsed++;
                j.images += imgs.length;
                // 一条一落缓存：面板可以在任务跑完之前就刷新看到已解析的部分，
                // 中途 SW 被回收也不至于白跑
                await xhsPushToCache(j.tabId, [post]);
            } catch (e) {
                j.failed.push(n.id + ':' + String((e && e.message) || e).slice(0, 60));
                if (e && /校验页|HTTP 4/.test(String(e.message || e))) { j.canceled = true; break; }
            }
            broadcastWa({ type: 'xhs', ...publicXhs() });
            await new Promise((r) => setTimeout(r, j.delayMs));
        }
    } finally {
        clearInterval(keep);
        await waClearReferer(XHS_PAGE_RULE);
        j.running = false;
        j.current = '';
        j.finishedAt = Date.now();
        broadcastWa({ type: 'xhs', ...publicXhs() });
    }
}

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

// 报错文案里带回的应答只留一行、截个短，别把整包 HTML 甩进工具栏
function clipText(t, n = 160) {
    return String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
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
