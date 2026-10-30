// 本页图片下拉面板：扫描当前标签页的图片，按账户分组，勾选后串行发到 ComfyUI。
// 页面本身不注入内容脚本：用 chrome.scripting.executeScript 把 collectPageImages 投进去。
// 批量发送由后台执行，面板关掉也不会中断。

import { collectPageImages, weiboFeedPage, weiboLoadMorePages, scrollToPost } from './collect.mjs';
import { upgradeWeiboImageUrl, weiboImageTierUrl, imageDedupeKey, isWeiboHost, accountInitial, mergeFeedPosts, weiboStatusToPost, clampLoadPages } from '../common/gallery.js';
import { baseNameFromUrl, sanitizeFilename } from '../common/util.js';
import { normalizeWeiboFilter, describeWeiboFilter, keywordExprOf, exprSource } from '../common/weibo-filter.js';
import { normalizeUiTheme } from '../common/theme.js';

const $ = (sel, root = document) => root.querySelector(sel);
const truncate = (s, n = 90) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));

const S = {
    tabId: null,
    tab: null,
    onlyView: false,
    junkOpen: false,
    groupsRO: null,
    settled: false,
    jumped: false,
    full: null,
    cachedCount: 0,
    settings: {},
    data: null,
    groups: [],
    flat: [],
    selected: new Set(),
    cardEls: new Map(),
    byUrl: new Map(),
    groupEls: new Map(),
    batchState: new Map(),
    selSaved: '',
    filterSite: '',
    siteHost: '',
    running: false,
    lbIndex: -1,
    lbList: [],
    lbToken: 0,
    cardItems: new Map(),
    thumbObserver: null,
    thumbCache: new Map(),
    thumbData: new Map(),
    thumbQueue: [],
    thumbActive: 0,
    wide: false,
    raw: null,
    weiboFlag: false,
    feedAll: true,
    // API 模式：不靠「帮我翻页」，滚到底就向读流接口要下一页（能翻过微博页面自己的截断）
    apiMode: false,
    apiBusy: false,
    apiInfo: null,
    feedStats: null,
    feedError: '',
    feedTotal: 0,
    extraPosts: [],
    moreBusy: false,
    moreDetail: '',
    jumpMode: 'scroll',
    jumpMissing: 'scroll',
};

// 下拉面板被 Chromium 锁在 800×600，想要更大的浏览面就另开一个普通扩展窗口
function openWideWindow() {
    const q = new URLSearchParams({ wide: '1' });
    if (S.tabId) q.set('tabId', String(S.tabId));
    const win = window.screen || {};
    const w = Math.max(900, Math.round((win.availWidth || 1280) * 0.9));
    const h = Math.max(600, Math.round((win.availHeight || 800) * 0.9));
    chrome.windows.create({
        url: `gallery.html?${q}`,
        type: 'popup',
        width: w,
        height: h,
        left: Math.max(0, Math.round(((win.availWidth || 1280) - w) / 2)),
        top: Math.max(0, Math.round(((win.availHeight || 800) - h) / 2)),
    });
}

function bindEvents() {
    $('#btnSettings').onclick = () => chrome.runtime.openOptionsPage();
    $('#btnWide').onclick = () => openWideWindow();
    $('#btnRefresh').onclick = async () => { await collect(true); await syncBatchState(); };
    // tab 必须一开始就能点：面板刚打开、采集还没回来时点「筛选微博」不能白点
    for (const b of document.querySelectorAll('#gTabs button')) b.onclick = () => { if (!b.disabled) switchTab(b.dataset.panel); };
    // 表单要等 initFilterTab 把当前设置填进去再解锁，否则「全没勾」会被当成条件立刻把页面筛空
    const pf = $('#panelFilter');
    if (pf) pf.classList.add('loading');
    $('#onlyView').onchange = () => {
        S.onlyView = $('#onlyView').checked;
        if (S.full) applyData(S.full, true);
    };
    $('#siteOff').onchange = () => { void setSiteOff($('#siteOff').checked); };
    // 「全部微博」要重扫（得多问一次页面自己那份信息流数据），不像「只看屏幕附近」只是换个筛法
    $('#feedAll').onchange = () => {
        if (S.running) return;
        S.feedAll = $('#feedAll').checked;
        S.settings.gallery = { ...(S.settings.gallery || {}), feedAll: S.feedAll };
        chrome.runtime.sendMessage({ action: 'patchSettings', patch: { gallery: { feedAll: S.feedAll } } }).catch(() => {});
        if (!S.feedAll) {
            // 关掉就把手上这份带数据补来的结果丢掉，否则用户看到的是「关了还在」
            S.raw = null;
            S.cachedCount = 0;
            S.extraPosts = [];
            S.feedTotal = 0;
        }
        void (async () => { await collect(true); await syncBatchState(); })();
    };
    $('#apiMode').onchange = () => {
        if (S.running) return;
        S.apiMode = $('#apiMode').checked;
        S.settings.gallery = { ...(S.settings.gallery || {}), apiMode: S.apiMode };
        chrome.runtime.sendMessage({ action: 'patchSettings', patch: { gallery: { apiMode: S.apiMode } } }).catch(() => {});
        S.apiInfo = null;
        void (async () => {
            await collect(true);
            await syncBatchState();
            // 勾上就先要几页，别逼用户先滚一趟才知道有没有生效；滚到底会自动接着要
            if (S.apiMode) await apiMore(3);
        })();
    };
    // 无限下拉：滚到离底 400px 内就补下一页。用 passive 监听，不抢用户自己的滚动
    {
        const main = $('#panelImages');
        if (main) main.addEventListener('scroll', () => {
            if (!S.apiMode || S.apiBusy || S.running) return;
            if (S.apiInfo && S.apiInfo.done) return;
            if (main.scrollHeight - main.scrollTop - main.clientHeight > 400) return;
            void apiMore(2);
        }, { passive: true });
    }
    $('#selAll').onchange = () => {
        if (S.running) return;
        const on = $('#selAll').checked;
        S.selected.clear();
        if (on) for (const it of S.flat) if (!it.junk) S.selected.add(it.key);
        refreshSelectionUI();
    };
    $('#btnInvert').onclick = () => {
        if (S.running) return;
        for (const it of S.flat) {
            if (S.selected.has(it.key)) S.selected.delete(it.key);
            else S.selected.add(it.key);
        }
        refreshSelectionUI();
    };
    $('#btnClear').onclick = () => {
        if (S.running) return;
        S.selected.clear();
        refreshSelectionUI();
    };
    $('#sendTier').onchange = () => {
        const v = $('#sendTier').value;
        S.settings.gallery = { ...(S.settings.gallery || {}), sendTier: v };
        chrome.runtime.sendMessage({ action: 'patchSettings', patch: { gallery: { sendTier: v } } }).catch(() => {});
        toast(`发送档位：${TierLabel(v)}`);
    };
    $('#btnMore').onclick = () => { void loadMorePages(); };
    $('#morePages').onchange = () => {
        const v = clampLoadPages($('#morePages').value);
        S.settings.gallery = { ...(S.settings.gallery || {}), loadPages: v };
        chrome.runtime.sendMessage({ action: 'patchSettings', patch: { gallery: { loadPages: v } } }).catch(() => {});
        toast(`一次翻 ${v} 页`);
    };
    $('#btnSend').onclick = () => runBatch(false);
    $('#btnSendRun').onclick = () => runBatch(true);
    $('#btnCancel').onclick = async () => {
        if (!S.running) return;
        $('#status').textContent = '将在当前这张发送完后停止…';
        try { await chrome.runtime.sendMessage({ action: 'cancelGalleryBatch' }); } catch (e) { /* 后台已停 */ }
    };
    chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || msg.action !== 'galleryEvent') return;
        if (msg.type === 'done') applyBatchState(msg, { announce: true });
        else applyBatchState(msg);
    });
    $('#lbClose').onclick = closeLightbox;
    $('#lbPrev').onclick = () => stepLightbox(-1);
    $('#lbNext').onclick = () => stepLightbox(1);
    $('#lightbox').onclick = (e) => { if (e.target === $('#lightbox')) closeLightbox(); };
    $('#lbImg').onclick = (e) => e.stopPropagation();
    document.addEventListener('keydown', (e) => {
        if (!$('#lightbox').hidden) {
            if (e.key === 'Escape') closeLightbox();
            else if (e.key === 'ArrowLeft') stepLightbox(-1);
            else if (e.key === 'ArrowRight') stepLightbox(1);
            return;
        }
            const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '') || e.target?.isContentEditable;
        if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
            e.preventDefault();
            S.selected.clear();
            for (const it of S.flat) S.selected.add(it.key);
            refreshSelectionUI();
        }
    });
    window.addEventListener('resize', settlePanelSize);
    // 设置页改了界面风格或跳转方式，已经开着的面板立刻跟着改，不用等下次重开
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.mtbSettings) return;
        applyUiTheme(changes.mtbSettings.newValue);
        const nextSites = (changes.mtbSettings.newValue || {}).sites;
        if (nextSites) { S.settings.sites = nextSites; syncSiteOff(); }
        const g = (changes.mtbSettings.newValue || {}).gallery || {};
        S.jumpMode = normJumpMode(g.jumpMode);
        S.jumpMissing = g.jumpMissing === 'tab' ? 'tab' : 'scroll';
    });
}

/** 点「↗ 微博」的三档：滚到那条 / 直接开新标签 / 只滚且绝不新开标签。脏值一律按默认的滚 */
function normJumpMode(v) {
    return v === 'tab' || v === 'scrollOnly' ? v : 'scroll';
}

async function loadSettings() {
    try {
        const d = await chrome.storage.local.get(['mtbSettings']);
        S.settings = d.mtbSettings || {};
    } catch (e) { S.settings = {}; }
    applyUiTheme(S.settings);
    renderComfyInfo();
    $('#sendTier').value = ((S.settings.gallery || {}).sendTier) || 'card';
    S.feedAll = (S.settings.gallery || {}).feedAll !== false;
    $('#feedAll').checked = S.feedAll;
    S.apiMode = (S.settings.gallery || {}).apiMode === true;
    $('#apiMode').checked = S.apiMode;
    S.jumpMode = normJumpMode((S.settings.gallery || {}).jumpMode);
    S.jumpMissing = (S.settings.gallery || {}).jumpMissing === 'tab' ? 'tab' : 'scroll';
    $('#morePages').value = String(clampLoadPages((S.settings.gallery || {}).loadPages));
}

// 主题必须赶在揭开 #bootMask 之前贴好，否则用户看得见面板从默认皮肤换成自己那套的闪一下
function applyUiTheme(settings) {
    document.documentElement.dataset.theme = normalizeUiTheme(((settings || {}).ui || {}).theme);
}

function TierLabel(v) {
    return v === 'orig' ? '原图 large（很大）' : v === 'full' ? '高清 mw2000' : '卡片 mw690';
}

function renderComfyInfo() {
    const cfg = S.settings.comfy || {};
    const server = cfg.server || 'http://127.0.0.1:8188';
    $('#comfyInfo').textContent = `${cfg.mode === 'api' ? 'API' : '前端'} · ${server}`;
    $('#comfyInfo').title = cfg.mode === 'api'
        ? 'API 模式：后台直接把工作流提交给 ComfyUI，不必开着它的界面'
        : '前端注入模式：发送时需要保持 ComfyUI 标签页打开';
}

async function findTabId() {
    const galleryUrl = chrome.runtime.getURL('gallery.html');
    const pick = (tabs) => {
        const valid = (tabs || []).filter((t) => t.id != null && /^https?:/i.test(t.url || '') && !t.url.startsWith(galleryUrl));
        valid.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
        return valid[0] ? valid[0].id : null;
    };
    // 扩展 popup 里 currentWindow 指向弹出它的浏览器窗口；直接用当前活动页。
    try {
        const cur = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = cur && cur[0];
        if (tab && tab.id != null) {
            if (/^https?:/i.test(tab.url || '')) return tab.id;
            // 只有“当前活动页就是 gallery 自己”（测试/手动开标签页）或拿不到 URL 时才跨窗口找
            if ((tab.url || '').startsWith(galleryUrl)) return pick(await chrome.tabs.query({}));
            return null;   // chrome:// / edge:// / file:// 等不可读取页，别悄悄换成别的标签页
        }
    } catch (e) { /* 换下一种问法 */ }
    try {
        const id = pick(await chrome.tabs.query({ active: true }));
        if (id) return id;
    } catch (e) { /* 继续 */ }
    try { return pick(await chrome.tabs.query({})); } catch (e) { return null; }
}

function setLoading(on, text) {
    $('#loading').hidden = !on;
    if (on) $('#loadingText').textContent = text || '正在扫描图片…';
}

function showEmpty(title, text) {
    setLoading(false);
    revealBoot();
    $('#groups').textContent = '';
    $('#summary').textContent = '';
    $('#emptyTitle').textContent = title;
    $('#emptyText').textContent = text;
    $('#empty').hidden = false;
    S.groups = []; S.flat = []; S.selected.clear();
    S.cardEls.clear(); S.groupEls.clear();
    refreshSelectionUI();
}

async function collect(keepSelection) {
    if (S.running) return;
    setLoading(true, '正在扫描图片…');
    $('#empty').hidden = true;
    $('#status').textContent = '';
    $('#status').title = '';
    $('#progress').hidden = true;
    setProgress(0);
    try {
        const tab = await chrome.tabs.get(S.tabId);
        S.tab = tab;
        if (!/^https?:/i.test(tab.url || '')) throw new Error('当前页面不是普通网页（' + (tab.url || '未知地址') + '）');
        $('#pageTitle').textContent = tab.title || tab.url || '';
        const host = (() => { try { return new URL(tab.url).hostname; } catch (e) { return ''; } })();
        $('#siteInfo').textContent = host;
        S.siteHost = host;
        syncSiteOff();
        S.weiboFlag = isWeiboHost(host);
        $('#feedAllWrap').hidden = !S.weiboFlag;
        $('#apiModeWrap').hidden = !S.weiboFlag;
        // 勾了 API 模式，「帮我翻页」和它的页数选择就是多余的：滚到底会自动要下一页
        $('#btnMore').hidden = !S.weiboFlag || S.apiMode;
        $('#morePagesWrap').hidden = !S.weiboFlag || S.apiMode;
        $('#btnMore').disabled = !(S.weiboFlag && S.feedAll) || S.moreBusy || S.apiMode;
    } catch (e) {
        showEmpty('读取当前页面失败', truncate(e.message || e, 180) + '。刷新网页或重新加载扩展后再试。');
        return;
    }
    if (!keepSelection) { S.raw = null; S.cachedCount = 0; await seedFromCache(); }
    const data = await scanOnce();
    if (!data) {
        showEmpty('读取当前页面失败', '脚本没能注入这个页面（浏览器内部页不允许注入）。');
        return;
    }
    applyData(data, keepSelection);
    if (!keepSelection) await restoreSelection();
    saveToCache();
}

// 面板是 popup，一点网页就关；重开后把后台记住的这份先并入，滚过的内容不会清零
async function seedFromCache() {
    try {
        const res = await chrome.runtime.sendMessage({ action: 'galleryCacheGet', tabId: S.tabId });
        const e = res && res.entry;
        const groups = e && Array.isArray(e.groups) ? e.groups : [];
        // 「帮我翻页」直接问后端要来的帖子也按标签页存着：关掉面板再开不至于白翻一次
        if (e && Array.isArray(e.extra)) S.extraPosts = e.extra.filter((p) => p && Array.isArray(p.pics) && p.pics.length);
        if (!groups.length) return;
        S.cachedCount = groups.reduce((n, g) => n + ((g && g.items) || []).length, 0);
        mergeResults([{ result: { ...(e.meta || {}), groups } }], S.tab);
    } catch (e) { /* 后台没答上就只扫当前的 */ }
}

function saveToCache() {
    if (!S.raw || !S.raw.groups.length) return;
    const meta = {
        pageUrl: S.data.pageUrl, pageTitle: S.data.pageTitle,
        host: S.data.host, weibo: S.data.weibo, view: S.data.view || null,
    };
    // 按信息流数据补来的条目不进缓存：那种图每次都能重新从页面数据里拿到，
    // 留在缓存里会变成「关掉全部微博还是看得到」
    const groups = S.raw.groups
        .map((g) => {
            const items = (g.items || []).filter((it) => it.src !== 'feed');
            return items.length ? { ...g, items, y: items.reduce((m, it) => Math.min(m, it.y || 0), Infinity) } : null;
        })
        .filter(Boolean);
    // 「帮我翻页」直接问微博要来的那些帖子必须单独留着：它们不在页面列表里，重扫也扫不出来
    if (!groups.length && !S.extraPosts.length) return;
    chrome.runtime.sendMessage({ action: 'galleryCachePut', tabId: S.tabId, entry: { meta, groups, extra: S.extraPosts } })
        .catch(() => {});
}

/* 勾选状态按标签页存在后台：popup 一点网页就销毁，重开必须是「我勾的还勾着」。
   条目键（<组键>|<图片去重键>）跨扫描稳定，所以按 key 恢复即可，不依赖第几张卡片 */
const selSnapshot = () => [...S.selected].sort().join('\n');

function saveSelectionToBg() {
    if (!S.tabId || S.running) return;
    const snap = selSnapshot();
    if (snap === S.selSaved) return;
    // 不发定时器：用户点完就可能立刻去点网页把 popup 收掉，定时器会被一起销毁、这一下就丢
    S.selSaved = snap;
    chrome.runtime.sendMessage({
        action: 'gallerySelPut', tabId: S.tabId,
        pageUrl: (S.data && S.data.pageUrl) || '',
        keys: snap ? snap.split('\n') : [],
    }).catch(() => {});
}

async function restoreSelection() {
    if (!S.tabId) return;
    let res = null;
    try { res = await chrome.runtime.sendMessage({ action: 'gallerySelGet', tabId: S.tabId }); } catch (e) { return; }
    const keys = res && Array.isArray(res.keys) ? res.keys : [];
    if (!keys.length) return;
    // 换过页面就不许把上一页的勾选搬过来（后台也会清，这里再挡一道）
    if (res.pageUrl && S.data && S.data.pageUrl && res.pageUrl !== S.data.pageUrl) return;
    const want = new Set(keys);
    S.selected = new Set(S.flat.filter((it) => want.has(it.key)).map((it) => it.key));
    S.selSaved = selSnapshot();
    refreshSelectionUI();
}

// 拼这条微博的固定地址要用当前站点域名（桌面版 weibo.com/<uid>/<bid>，移动版 m.weibo.cn/status/<id>）
function pageHost() {
    try { return new URL((S.tab && S.tab.url) || (S.data && S.data.pageUrl) || '').hostname; } catch (e) { return ''; }
}

// 认页面里那条微博用得到的 id：分组键里那个（采集器从属性或永久链接取的）+ 地址最后一段
function groupIdsOf(g) {
    const ids = [];
    const m = /#ps(.+)$/.exec(String(g.key || ''));
    if (m) ids.push(m[1]);
    const seg = /weibo\.(?:com|cn)\/(?:\d{5,}\/)?([\w]{5,})(?:[?#]|$)/.exec(String(g.url || ''));
    if (seg) ids.push(seg[1]);
    const tail = String(g.url || '').split('/').pop() || '';
    if (tail.length >= 5) ids.push(tail);
    return [...new Set(ids.filter((x) => x && x.length >= 5))];
}

async function jumpToGroup(g) {
    if (S.jumpMode === 'tab') {
        chrome.tabs.create({ url: g.url, active: true });
        return;
    }
    // scrollOnly = 只滚页面、**任何情况下都不新开标签**：滚不到就只说清为什么，不背着用户开标签
    const tail = S.jumpMode === 'scrollOnly' ? '，按你的设置没有新开标签页' : '，改成新标签打开';
    let r = null;
    try {
        const res = await chrome.scripting.executeScript({
            target: { tabId: S.tabId, allFrames: false }, func: scrollToPost,
            args: [{
                ids: groupIdsOf(g), url: g.url, loadMissing: S.jumpMissing !== 'tab',
                color: (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim() || '#6ea8fe',
            }],
        });
        r = res && res[0] && res[0].result;
    } catch (e) { r = null; }
    if (r && r.ok) {
        toast(`已经滚到那条微博（${r.centerDelta <= 24 ? '居中' : '尽量对齐了'}，高亮 2.6 秒`
            + ((r.searched | 0) > 0 ? `，往下翻了 ${r.searched} 屏才挂出来` : '') + '）');
        return;
    }
    toast(((r && r.found ? '这条微博找到了，但页面没能滚过去'
        : (S.jumpMissing !== 'tab' && (r && r.searched | 0) > 0
            ? `往下翻了 ${(r && r.searched) | 0} 屏也没加载出这条` + (r && r.restored ? '，已滚回原位' : '')
                + (r && r.endNote ? `（${r.endNote}）` : '')
            : '页面上没有这条微博（多半被虚拟列表回收了）')) + tail));
    if (S.jumpMode !== 'scrollOnly') chrome.tabs.create({ url: g.url, active: true });
}

// 问页面自己那份信息流数据要图（只在主世界读，不碰页面数据）：虚拟列表把滚过去的帖子整条摘掉，
// 光扫 DOM 拿不到，而列表里每条都带 pic_ids/pic_infos。读不到就算了，不影响正常扫描。
async function readFeedPosts() {
    S.feedError = '';
    // API 模式自己就会往 S.extraPosts 里塞帖子，所以「全部微博」没勾也要让它并进来，
    // 否则勾了 API 模式却一条都看不见 —— 这两个开关是两条不同的数据来源，不是一个的开关
    if (!S.weiboFlag || (!S.feedAll && !S.apiMode)) return null;
    try {
        const res = await chrome.scripting.executeScript({
            target: { tabId: S.tabId, allFrames: false }, world: 'MAIN', func: weiboFeedPage, args: [{ max: 300 }],
        });
        const r = res && res[0] && res[0].result;
        if (!r || !r.ok) {
            S.feedError = (r && r.error) || '页面里没有微博的信息流数据';
            return null;
        }
        S.feedTotal = r.total | 0;
        // 「一条微博有哪些图」只在 src/common/gallery.js 的 weiboStatusToPost 里映射一次；
        // 之前按「帮我翻页」直接问后端要来的那些帖子接在列表末尾，插值才会排在正确的位置上
        const seen = new Set();
        const list = [];
        const host = pageHost();
        for (const [i, it] of (Array.isArray(r.posts) ? r.posts : []).entries()) {
            const p = weiboStatusToPost(it, Number(it.index) || i, host);
            if (!p.pics.length) continue;
            if (p.mid) seen.add(p.mid);
            list.push(p);
        }
        const extra = [];
        for (const [i, p] of S.extraPosts.entries()) {
            if (p.mid && seen.has(p.mid)) continue;
            extra.push({ ...p, index: Math.max(list.length, S.feedTotal) + i });
        }
        S.extraPosts = extra;
        return { posts: list.concat(extra), total: S.feedTotal };
    } catch (e) {
        S.feedError = truncate(String((e && e.message) || e || ''), 90);
        return null;
    }
}

// 「帮我翻页」：先调微博组件自己的 loadMoreData（它正常加载下一页走的就是这个，视口一动不动），
// 那个方法拿不到就退回克隆页面已经发过的那条读流请求 + max_id 游标，直接向微博要后面几页。
// 两条都只读、都不滚动页面；页数由底部「翻页页数」定，产品侧卡到 1~10（一次问太急容易被限流）。
async function loadMorePages() {
    if (S.moreBusy || S.running) return;
    S.moreBusy = true;
    const btn = $('#btnMore');
    btn.disabled = true;
    const pages = clampLoadPages($('#morePages').value);
    setLoading(true, '正在替微博翻页（不滚动页面）…');
    let res = null;
    try {
        const r = await chrome.scripting.executeScript({
            target: { tabId: S.tabId, allFrames: false }, world: 'MAIN', func: weiboLoadMorePages, args: [{ pages }],
        });
        res = r && r[0] && r[0].result;
    } catch (e) {
        res = { ok: false, error: truncate(String((e && e.message) || e || ''), 90) };
    }
    S.moreBusy = false;
    if (res && res.route === 'fetch' && Array.isArray(res.statuses) && res.statuses.length) {
        const seen = new Set(S.extraPosts.map((p) => p.mid).filter(Boolean));
        for (const s of res.statuses) {
            const p = weiboStatusToPost(s, 0, pageHost());
            if (!p.pics.length || (p.mid && seen.has(p.mid))) continue;
            if (p.mid) seen.add(p.mid);
            S.extraPosts.push(p);
        }
        S.extraPosts = S.extraPosts.slice(-900);
    }
    await collect(true);
    await syncBatchState();
    btn.disabled = !(S.weiboFlag && S.feedAll);
    const added = (res && res.added) | 0;
    S.moreDetail = (res && (res.detail || res.stopped || res.error)) || '';
    if (added > 0) {
        toast(res.route === 'component'
            ? `微博自己又加载了 ${added} 条微博（翻了 ${res.pages} 页）`
            : `直接向微博要了 ${res.pages} 页 · ${added} 条有图的微博`
                + (res.fallback ? '（微博自己的翻页没走通，已改用这条）' : ''));
    } else {
        toast('没加载到更多' + (res && (res.stopped || res.error) ? '：' + (res.stopped || res.error) : ''), true);
    }
}

/* 「API 模式」的补页：让后台按 since_id 游标向微博的读流接口要接下来 1~N 页（不碰页面、不滚动）。
   回来的已经是面板要的帖子形状（和「帮我翻页」fetch 路由同一套 weiboStatusToPost），
   所以照同一套按 mid 去重塞进 S.extraPosts，再重扫一次就能渲染。
   和「帮我翻页」的关键差别：这条绕过了微博页面自己那个「最近几百条到底」的截断。 */
async function apiMore(pages) {
    if (S.apiBusy) return;
    S.apiBusy = true;
    let res = null;
    try {
        res = await chrome.runtime.sendMessage({ action: 'weiboArchiveNext', tabId: S.tabId, pages: Math.max(1, Math.min(10, Number(pages) || 2)) });
    } catch (e) {
        res = { ok: false, error: truncate(String((e && e.message) || e || ''), 90) };
    }
    S.apiBusy = false;
    if (!res || res.ok !== true) {
        // 认不出 uid（不在个人主页）与限流都要停下并说清，不能每滚一下又敲一次
        S.apiInfo = { done: true, error: (res && res.error) || '后台没有应答' };
        toast('API 模式没拿到更多' + (S.apiInfo.error ? '：' + S.apiInfo.error : ''), true);
        await collect(true);
        return;
    }
    const seen = new Set(S.extraPosts.map((p) => p && p.mid).filter(Boolean));
    for (const p of res.posts || []) {
        if (!p.pics.length || (p.mid && seen.has(p.mid))) continue;
        if (p.mid) seen.add(p.mid);
        S.extraPosts.push(p);
    }
    S.extraPosts = S.extraPosts.slice(-3000);
    S.apiInfo = {
        total: res.total || 0, declaredTotal: res.declaredTotal || 0, added: res.added || 0,
        // 失败（403/限流/掉登录）也算「别再下拉了」：否则用户每滚一下都去重敲一个注定 403 的端点
        done: !!res.done || !!res.failed, stopped: res.stopped || '',
        error: res.failed ? (res.stopped || '拉取失败') : '',
    };
    await collect(true);
    await syncBatchState();
    if (res.done) toast(res.stopped === 'reached-total' ? 'API 模式：已经拉到这个账号的最后一条' : 'API 模式：微博说没有更多了（' + (res.stopped || 'end') + '）');
}

async function scanOnce() {
    const args = [{ max: 400, weibo: !!S.weiboFlag }];
    const feed = await readFeedPosts();
    let results;
    try {
        try {
            results = await chrome.scripting.executeScript({ target: { tabId: S.tabId, allFrames: true }, func: collectPageImages, args });
        } catch (e) {
            results = await chrome.scripting.executeScript({ target: { tabId: S.tabId }, func: collectPageImages, args });
        }
    } catch (e) { return null; }
    return mergeResults(results, S.tab, feed);
}

/* 「只看屏幕附近」：只保留扫描那一刻视口上下各一屏范围内的图。
   微博把看过的帖子整条搬到画布外（实测 top:-10088）复用，那种已经被采集器挡掉；
   这条开关管的是「在文档流里但还没滚到/已经滚过去」的那些。 */
function visibleSlice(data) {
    if (!S.onlyView || !data.view || !data.view.h) return data;
    const lo = data.view.y - data.view.h;
    const hi = data.view.y + data.view.h * 2;
    const groups = data.groups.map((g) => {
        const items = g.items.filter((it) => (it.y || 0) >= lo && (it.y || 0) <= hi);
        return items.length ? { ...g, items } : null;
    }).filter(Boolean);
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    return { ...data, groups, total, hidden: data.total - total };
}

// 打开面板时直接滚到「用户正在看的那条微博」：采集结果里带了扫描那一刻的视口位置，
// 每组又带着它在页面里的文档 Y，取「起始位置不超过视口上沿（略往下让一点）」的最后一条即可
function jumpToViewportGroup() {
    const view = S.data && S.data.view;
    const main = $('.g-main');
    const box = $('#groups');
    if (!view || !main || !box || !S.groups.length) return;
    const groups = S.groups.filter((g) => !g.junk);
    if (!groups.length) return;
    const line = view.y + (view.h || 0) * 0.15;
    let target = groups[0];
    for (const g of groups) if ((g.y || 0) <= line) target = g;
    const sec = box.children[S.groups.indexOf(target)];
    if (!sec) return;
    const top = sec.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
    main.scrollTop = Math.max(0, top - 6);
    sec.classList.add('g-current');
}

function applyData(data, keepSelection) {
    const prevSelected = new Set(S.selected);
    const prevStates = new Map(S.batchState);
    S.full = data;
    const shown = visibleSlice(data);
    S.data = shown;
    S.groups = shown.groups;
    S.flat = shown.groups.flatMap((g) => g.items);
    // 卡片状态是按条目回写的，条目 id 带组前缀后就不能再用图片去重键反查（批量结果只带 url）；
    // 同一个 url 可能同时属于两条微博（转发），所以一个 url 对应多个条目 id
    S.byUrl = new Map();
    for (const it of S.flat) {
        const k = batchUrlKey(it.url);
        if (!S.byUrl.has(k)) S.byUrl.set(k, []);
        S.byUrl.get(k).push(it.key);
    }
    S.selected = keepSelection ? prevSelected : new Set();
    S.batchState = keepSelection ? prevStates : new Map();
    S.cardEls.clear(); S.groupEls.clear();
    setLoading(false);
    $('#summary').textContent = buildSummary(shown);
    $('#summary').title = [dropNote(shown), S.feedError ? `读不到微博信息流数据：${S.feedError}` : '', S.moreDetail ? `翻页细节：${S.moreDetail}` : ''].filter(Boolean).join('；');
    $('#pageTitle').textContent = data.pageTitle || S.tab?.title || '';
    document.title = '本页图片' + (data.pageTitle ? ' · ' + truncate(data.pageTitle, 40) : '');
    renderGroups();
    refreshSelectionUI();
    if (!keepSelection && !S.jumped) {
        S.jumped = true;
        // 等 popup 撑开、列数稳定后再跳，跳早了会按旧布局算位置
        requestAnimationFrame(() => setTimeout(jumpToViewportGroup, 120));
    }
    if (!S.flat.length) {
        showEmpty(S.onlyView ? '屏幕附近没有图片' : '这个页面没有找到可用的图片',
            S.onlyView ? '关掉「只看屏幕附近」就能看到整条信息流里已加载的图。'
                : '图片可能还没加载完；滚一下页面再点“刷新”。');
    }
}

function mergeResults(results, tab, feed) {
    if (!S.raw) S.raw = { groups: [], byKey: new Map(), seen: new Set(), byPid: new Map() };
    if (!S.raw.byPid) S.raw.byPid = new Map();
    const groups = S.raw.groups;
    const byKey = S.raw.byKey;
    const seen = S.raw.seen;
    let meta = null;
    const dropHist = {};
    let enriched = 0;
    for (const r of results || []) {
        const res = r && r.result;
        if (!res || !Array.isArray(res.groups)) continue;
        if (!meta) meta = res;
        // 每一帧各自统计被丢掉的图；后台缓存那条合成结果没有 dropHist，不会重复计数
        if (res.dropHist) for (const k in res.dropHist) dropHist[k] = (dropHist[k] || 0) + res.dropHist[k];
        if (res.enriched) enriched += res.enriched;
        for (const g of res.groups) {
            let target = byKey.get(g.key);
            if (!target) {
                target = { key: g.key, label: g.label || '本页图片', sub: g.sub || '', url: g.url || '', items: [], junk: !!g.junk };
                byKey.set(g.key, target);
                groups.push(target);
            } else if (!target.url && g.url) target.url = g.url;
            for (const raw of g.items || []) {
                const url = upgradeWeiboImageUrl(raw.url || '');
                if (!url) continue;
                if (!/^https?:/i.test(url) && !/^data:image\//i.test(url)) continue;
                const dkey = imageDedupeKey(url);
                // 同一张图出现在两条微博里（转发）要各算一项，所以去重键和条目 id 都按组加前缀
                const key = target.key + '|' + dkey;
                if (seen.has(key)) continue;
                seen.add(key);
                // 记「这张图属于哪个组」：信息流数据里的帖子只能靠图认出是同一条微博（键格式两边不一样）
                S.raw.byPid.set(dkey, target.key);
                const thumbRaw = String(raw.thumb || '');
                const thumb = thumbRaw && !/^blob:/i.test(thumbRaw) ? thumbRaw : url;
                const y = Math.round(raw.y) || 0;
                if (typeof target.y !== 'number' || y < target.y) target.y = y;
                target.items.push({
                    key, url, thumb,
                    // 卡片和查看器各用自己的档位，别为了 250px 的卡片去拉 4MB 原图
                    card: raw.card || weiboImageTierUrl(url, 'card'),
                    full: raw.full || weiboImageTierUrl(url, 'full'),
                    y,
                    width: raw.width | 0, height: raw.height | 0,
                    kind: raw.kind || 'image', alt: raw.alt || '',
                    pageUrl: raw.pageUrl || res.pageUrl || '',
                    groupKey: target.key,
                });
            }
        }
    }
    // 微博自己那份信息流数据：DOM 里没有的帖子（被虚拟列表回收了）在这里补成组
    if (feed === null) S.feedStats = null;
    else if (feed && Array.isArray(feed.posts) && feed.posts.length) {
        S.feedStats = mergeFeedPosts(S.raw, feed.posts, { pageUrl: (meta && meta.pageUrl) || tab?.url || '' });
    }
    const host = (() => { try { return new URL(tab?.url || meta?.pageUrl || '').hostname; } catch (e) { return ''; } })();
    const weibo = isWeiboHost(host) || !!(meta && meta.weibo);    const pageTitle = (tab && tab.title) || (meta && meta.pageTitle) || host || '本页图片';
    const finalGroups = groups.filter((g) => g.items.length)
        // 累加过多轮扫描后顺序是乱的，按这条微博在页面里的位置排，面板顺序=信息流顺序；
        // 「无用图片」永远排最后
        .sort((a, b) => (a.junk ? 1 : 0) - (b.junk ? 1 : 0) || (a.y || 0) - (b.y || 0))
        .map((g) => {
        const label = g.key === '__page' ? pageTitle : g.label;
        for (const it of g.items) { it.groupLabel = label; it.junk = !!g.junk; }
        return { ...g, label, display: groupDisplay({ ...g, label }, weibo) };
    });
    const junkCount = finalGroups.reduce((n, g) => n + (g.junk ? g.items.length : 0), 0);
    return {
        pageUrl: tab?.url || meta?.pageUrl || '',
        pageTitle, host, weibo,
        view: (meta && meta.view) || null,
        dropped: Object.keys(dropHist).reduce((n, k) => n + dropHist[k], 0),
        dropHist,
        enriched,
        junk: junkCount,
        total: finalGroups.reduce((n, g) => n + (g.junk ? 0 : g.items.length), 0),
        truncated: !!(meta && meta.truncated),
        groups: finalGroups,
    };
}

function groupDisplay(g, weibo = S.data?.weibo) {
    if (!g) return '本页图片';
    if (g.key === '__junk') return '无用图片';
    if (g.key === '__page') return g.label || '本页图片';
    if (g.key === '__weibo_unknown') return '未识别账号';
    return (weibo ? '@' : '') + (g.label || '未识别账号');
}

const DROP_LABEL = {
    'off-canvas-stash': '画布外的回收帖（现在屏幕上没有）',
    'display-small': '头像/图标/表情这类小图',
    'dupe': '同一条内容里重复的图',
    'display-none': '在没展开的容器里',
    'visibility-hidden': '被隐藏了',
    'opacity-0': '完全透明',
    'no-size': '没有尺寸',
    'no-url': '没有图片地址',
    'junk-url': '装饰图/占位图地址',
    'source-small': '源图本身就小',
    'banner-ratio': '又扁又长的分隔条',
    'placeholder-data': '1 像素占位图',
    'cap': '超出单次 400 张上限',
};

function dropNote(data) {
    if (!data || !data.dropped) return '';
    const parts = Object.keys(data.dropHist || {})
        .sort((a, b) => data.dropHist[b] - data.dropHist[a])
        .map((k) => `${DROP_LABEL[k] || k} ${data.dropHist[k]}`);
    return parts.join('、');
}

function buildSummary(data) {
    const groups = data.groups.filter((g) => !g.junk).length;
    const kind = data.weibo ? `${groups} 条微博` : `${groups} 组`;
    const truncated = data.truncated ? ' · 已截取前 400 张' : '';
    const off = data.hidden ? ` · 另有 ${data.hidden} 张在屏幕外` : '';
    const kept = S.cachedCount ? ` · 含之前滚过的位置` : '';
    const fixed = data.enriched ? ` · 补齐折叠 ${data.enriched} 张` : '';
    const st = S.feedStats;
    const fromFeed = st && (st.groups || st.items) ? ` · 按微博数据补出 ${st.groups} 条 / ${st.items} 张` : '';
    // API 模式必须把「拉到哪了 / 共多少条 / 到底没有」写在摘要里，否则用户不知道下拉还有没有用
    const ai = S.apiInfo;
    const api = !S.apiMode ? '' : (ai && ai.error ? ` · API 模式停了：${ai.error}`
        : ` · API 模式已拉 ${ai ? ai.total : 0}${ai && ai.declaredTotal ? '/' + ai.declaredTotal : ''} 条${ai && ai.done ? '（已到底）' : '，往下滚自动接着拉'}`);
    const feedErr = (S.feedAll && S.weiboFlag && S.feedError && !st) ? ` · 信息流数据没读到` : '';
    // 无用图片不再算「被忽略」：它们收在最后一个折叠组里，想看的可以展开
    const junk = data.junk ? ` · 无用图片 ${data.junk} 张（默认收起）` : '';
    const ignored = Math.max(0, (data.dropped || 0) - (data.junk || 0));
    const drop = ignored ? ` · 已忽略 ${ignored} 张` : '';
    return `${data.host || ''} · ${kind} · ${data.total} 张图片${fixed}${fromFeed}${api}${feedErr}${truncated}${off}${junk}${drop}${kept}`;
}

function renderGroups() {
    const box = $('#groups');
    if (S.thumbObserver) for (const card of S.cardItems.keys()) S.thumbObserver.unobserve(card);
    S.cardItems.clear();
    box.textContent = '';
    ensureThumbObserver();
    for (const g of S.groups) {
        const sec = document.createElement('section');
        sec.className = 'g-group';

        const head = document.createElement('div');
        head.className = 'g-group-head';
        const avatar = document.createElement('span');
        avatar.className = 'g-avatar';
        avatar.textContent = accountInitial(g.label || groupDisplay(g));
        const title = document.createElement('div');
        title.className = 'g-group-title';
        const line = document.createElement('div');
        line.className = 'g-group-line';
        const name = document.createElement('span');
        name.className = 'g-group-name';
        name.textContent = groupDisplay(g);
        name.title = name.textContent;
        const meta = document.createElement('span');
        meta.className = 'g-group-meta';
        meta.textContent = `${g.items.length} 张图片`;
        line.append(name, meta);
        title.append(line);
        if (g.sub) {
            const sub = document.createElement('span');
            sub.className = 'g-group-sub';
            sub.textContent = g.sub;
            sub.title = g.sub;
            title.append(sub);
        }

        const sp = document.createElement('span');
        sp.className = 'sp';
        const checkLabel = document.createElement('label');
        checkLabel.className = 'g-check';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.title = '选中/取消这条内容的全部图片';
        check.onchange = () => {
            if (S.running) return;
            for (const it of g.items) {
                if (check.checked) S.selected.add(it.key);
                else S.selected.delete(it.key);
            }
            refreshSelectionUI();
        };
        checkLabel.title = '选中/取消这条内容的全部图片';
        checkLabel.append(check);

        // 用户要的是「这条九宫格发过几张，点一下就把剩下没发的选中」：发送成功后勾不会掉，
        // 所以组内翻转就等价于「取消已发送、选中未发送」，而且只影响这一条微博
        const inv = document.createElement('button');
        inv.className = 'g-group-inv';
        inv.type = 'button';
        inv.textContent = '反选';
        inv.title = '只翻转这条内容的勾选：刚发送过的取消，剩下没发送的选中';
        inv.onclick = () => {
            if (S.running) return;
            for (const it of g.items) {
                if (S.selected.has(it.key)) S.selected.delete(it.key);
                else S.selected.add(it.key);
            }
            refreshSelectionUI();
        };
        head.append(avatar, title, sp);
        // 「跳转」：默认把用户的页面滚到这一条并描一圈高亮；页面上没有它的 DOM（被虚拟列表回收了）
        // 或设置里选了「新标签打开」，就开新标签 —— 那条地址是按 uid+bid 拼出来的，照样能打开
        if (!g.junk && g.url) {
            const open = document.createElement('button');
            open.className = 'g-group-open';
            open.type = 'button';
            open.textContent = (S.data && S.data.weibo) ? '↗ 微博' : '↗ 原帖';
            open.title = `${S.jumpMode === 'tab' ? '在新标签打开这条微博'
                : S.jumpMode === 'scrollOnly'
                    ? '滚到页面上这条微博（绝不新开标签页）'
                    : '滚到页面上这条微博' + (S.jumpMissing === 'tab' ? '（页面上没有就开新标签）' : '（页面上还没有就先往下滚找它）')}：${g.url}`;
            open.dataset.url = g.url;
            open.onclick = () => { void jumpToGroup(g); };
            head.append(open);
        }
        if (!g.junk) head.append(inv);
        head.append(checkLabel);

        const grid = document.createElement('div');
        grid.className = 'g-grid';
        // 「无用图片」默认折叠、也默认不建卡片：展开时才渲染，省得几百张头像把面板撑起来
        if (g.junk) {
            sec.classList.add('g-junk');
            const toggle = document.createElement('button');
            toggle.className = 'g-junk-toggle';
            toggle.textContent = S.junkOpen ? '收起' : '展开';
            toggle.title = '头像、图标、角标这类图默认折叠在这里，展开后也能勾选发送';
            const build = () => {
                if (grid.childElementCount) return;
                for (const it of g.items) grid.appendChild(makeCard(it));
            };
            toggle.onclick = () => {
                S.junkOpen = !S.junkOpen;
                if (S.junkOpen) build();
                grid.hidden = !S.junkOpen;
                toggle.textContent = S.junkOpen ? '收起' : '展开';
                fitLayout();
                refreshSelectionUI();
            };
            head.insertBefore(toggle, checkLabel);
            if (S.junkOpen) build();
            grid.hidden = !S.junkOpen;
        } else {
            for (const it of g.items) grid.appendChild(makeCard(it));
        }

        sec.append(head, grid);
        box.appendChild(sec);
        S.groupEls.set(g.key, { group: g, check, inv });
    }
    ensureGroupsObserver();
    fitLayout();
}

/* popup 视口是「先给个初值 → 按内容撑开 → 被屏幕/窗口夹住」，所以必须等它稳定下来
   才能把面板钉成实际尺寸：钉早了就会被那个初值锁死成小窗，不钉则写死 800 会溢出成横向滚动条 */
const PANEL_ASK_W = 800;
const PANEL_ASK_H = 600;
let pinTimer = 0;

function revealBoot() {
    const el = document.getElementById('bootMask');
    if (el && !el.hidden) el.hidden = true;
}

/* 第一帧就按「能拿到的最大尺寸」开口（而不是等 popup 自己一级级撑开）：
   小屏幕上兜底值 800 会先溢出再被钉小，用户看到的就是那一下跳转 */
function askPanelSize() {
    if (S.wide) return;
    const aw = (window.screen && window.screen.availWidth) || PANEL_ASK_W;
    const ah = (window.screen && window.screen.availHeight) || PANEL_ASK_H;
    const de = document.documentElement.style;
    de.setProperty('--panel-w', `${Math.round(Math.max(320, Math.min(PANEL_ASK_W, aw - 6)))}px`);
    de.setProperty('--panel-h', `${Math.round(Math.max(320, Math.min(PANEL_ASK_H, ah - 6)))}px`);
}

function setPanelSize(w, h) {
    const de = document.documentElement;
    de.style.setProperty('--panel-w', `${Math.max(200, Math.round(w))}px`);
    de.style.setProperty('--panel-h', `${Math.max(200, Math.round(h))}px`);
    S.settled = true;
    fitLayout();
    // 尺寸钉死、列数按最终宽度算完之后才揭开遮罩：揭开时看到的就是成品网格
    revealBoot();
}

function settlePanelSize() {
    if (S.wide) return;
    clearTimeout(pinTimer);
    let last = '';
    let stable = 0;
    const deadline = Date.now() + 2000;
    const tick = () => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const key = `${vw}x${vh}`;
        stable = key === last ? stable + 1 : 0;
        last = key;
        if (stable >= 3 || Date.now() > deadline) {
            setPanelSize(Math.min(PANEL_ASK_W, vw), Math.min(PANEL_ASK_H, vh));
            return;
        }
        pinTimer = setTimeout(tick, 120);
    };
    tick();
}

/* 每行三张卡片（用户指定），窗口不够宽才退成 2/1 —— 靠 1fr 铺满，任何情况都不出横向滚动条 */
// 用户要的是「每行三张」：只要每张还剩 ~110px 就保持三列（560 宽的 popup 里约 178px，400 宽也有 125px），
// 低于这个才退两列 —— 早先门槛 200 会让 560~640 的窗口直接掉成两列，用户看到就是"仍然一行两张"
const CARD_MIN = 110;
const CARD_COLS = 3;

function fitLayout() {
    const box = $('#groups');
    if (!box || !box.childElementCount) return;
    const grid = box.querySelector('.g-grid');
    const inner = grid ? grid.clientWidth : Math.round(window.innerWidth * 0.9);
    // popup 初值往往只有两三百宽，按它算会先排成两列、等撑开再跳三列（用户看到"先显示再缩放"）。
    // 还没钉尺寸时按目标宽（800）算，打开就是三列；钉完之后再按真实宽度收窄
    const basis = (S.wide || S.settled) ? inner : Math.max(inner, PANEL_ASK_W - 24);
    let cols = CARD_COLS;
    while (cols > 1 && basis / cols < CARD_MIN) cols--;
    box.style.setProperty('--cols', String(cols));
}

// popup 是「先给小视口、再撑开」的，首次渲染时量到的宽度经常偏小；宽度一变就重算列数，
// 不然面板已经 800 宽了还停在两列
function ensureGroupsObserver() {
    if (S.groupsRO || typeof ResizeObserver !== 'function') return;
    const box = $('#groups');
    if (!box) return;
    S.groupsRO = new ResizeObserver(() => fitLayout());
    S.groupsRO.observe(box);
}

const TYPE_BY_EXT = { jpg: 'JPG', jpeg: 'JPG', png: 'PNG', gif: 'GIF', webp: 'WEBP', bmp: 'BMP', avif: 'AVIF', svg: 'SVG' };

function imageTypeLabel(it) {
    let ext = '';
    try { ext = (/(?:\.|\/)([a-z0-9]{3,4})$/i.exec(new URL(it.url).pathname) || [])[1] || ''; } catch (e) { ext = ''; }
    return TYPE_BY_EXT[String(ext).toLowerCase()] || (it.kind === 'bg' ? '背景' : ext ? ext.toUpperCase() : '图');
}

function makeCard(it) {
    const card = document.createElement('div');
    card.className = 'g-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'checkbox');
    card.setAttribute('aria-checked', 'false');
    card.dataset.key = it.key;
    card.dataset.alt = it.alt || it.url;
    card.title = it.alt || it.url;

    const thumb = document.createElement('div');
    thumb.className = 'g-thumb';
    const img = new Image();
    img.decoding = 'async';
    img.draggable = false;
    img.alt = it.alt || '';
    card.classList.add('loading');

    const tick = document.createElement('span');
    tick.className = 'g-tick';
    const zoom = document.createElement('button');
    zoom.className = 'g-zoom';
    zoom.type = 'button';
    zoom.textContent = '⤢';
    zoom.title = '预览大图';
    zoom.onclick = (e) => { e.stopPropagation(); openLightbox(it); };

    const badges = document.createElement('div');
    badges.className = 'g-badges';
    const type = document.createElement('span');
    type.className = 'g-tag g-type';
    type.textContent = imageTypeLabel(it);
    const dims = document.createElement('span');
    dims.className = 'g-tag g-dims';
    dims.textContent = it.width && it.height ? `${it.width}×${it.height}` : '';
    badges.append(type, dims);
    const bar = document.createElement('div');
    bar.className = 'g-bar';
    bar.append(tick, zoom, badges);

    const state = document.createElement('span');
    state.className = 'g-state';
    thumb.append(img, state);

    const url = document.createElement('div');
    url.className = 'g-url';
    url.textContent = it.url;
    url.title = it.alt ? `${it.alt}\n${it.url}` : it.url;

    card.append(bar, thumb, url);
    card.onclick = () => toggleItem(it.key);
    card.onkeydown = (e) => {
        if (e.target !== card) return;
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleItem(it.key); }
    };
    card.ondblclick = () => openLightbox(it);
    S.cardEls.set(it.key, card);
    const st = S.batchState.get(it.key);
    if (st) applyCardState(card, st.state, st.info);
    observeThumb(card, it);
    return card;
}

// 批量结果只回传 url，而发送档位可以选（mw690/mw2000/large）——查卡片状态前统一归一到 large 地址
function batchUrlKey(url) { return weiboImageTierUrl(url, 'orig'); }

function thumbKey(url, pageUrl) {
    // 必须按「完整地址」缓存：imageDedupeKey 会去掉 sinaimg 的尺寸段，
    // orj360 和 mw690/mw2000 会撞成同一个 key —— 升档就被缓存悄悄吃掉，面板永远停在糊缩略图上
    return String(url || '') + '|' + (pageUrl || '');
}

function ensureThumbObserver() {
    if (S.thumbObserver || !('IntersectionObserver' in window)) return;
    S.thumbObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            S.thumbObserver.unobserve(entry.target);
            const it = S.cardItems.get(entry.target);
            const img = entry.target.querySelector('img');
            if (it && img) loadCardImage(it, img, entry.target);
        }
    }, { rootMargin: '240px' });
}

function observeThumb(card, it) {
    S.cardItems.set(card, it);
    if (S.thumbObserver) S.thumbObserver.observe(card);
    else loadCardImage(it, card.querySelector('img'), card);
}

async function loadCardImage(it, img, card) {
    if (!img || card.classList.contains('loaded') || card.classList.contains('imgfail')) return;
    const pageUrl = it.pageUrl || (S.data && S.data.pageUrl) || '';
    img.onload = () => {
        card.classList.remove('loading', 'imgfail');   // 某一档直连失败会先标 imgfail，后来换档成功要撤掉
        card.classList.add('loaded');
        const dimsEl = card.querySelector('.g-dims');
        if (dimsEl && img.naturalWidth) dimsEl.textContent = `${img.naturalWidth}×${img.naturalHeight}`;
        const typeEl = card.querySelector('.g-type');
        const mime = /^data:image\/([a-z0-9.+-]+)/i.exec(img.src);
        const real = mime && TYPE_BY_EXT[mime[1].toLowerCase()];
        if (typeEl && real) typeEl.textContent = real;
    };
    img.onerror = () => {
        if (card.classList.contains('loaded')) return;
        card.classList.remove('loading');
        card.classList.add('imgfail');
    };
    // 「全部用大图，不用缩略图」：按 card(mw690) → full(mw2000) → orig(large) 依次尝试。
    // 每一档先直连（扩展页发图片请求不带 Referer，图床通常直接放行，还省掉一次 base64 往返），
    // 直连失败再走后台带 Referer 的代理；三档都失败才回落到页面那张小图并明确标「缩略图」。
    const tiers = [['card', it.card], ['full', it.full], ['orig', it.url]];
    let used = '';
    for (const [name, u] of tiers) {
        if (!u) continue;
        if (await tryLoadDirect(img, u)) { used = name; break; }
        try {
            const data = await getTierData(u, pageUrl);
            if (data) { img.src = data; used = name; break; }
        } catch (e) { /* 换下一档 */ }
    }
    if (used) {
        // 档位只记在 dataset 和悬停提示里，卡片上只留 尺寸 + 类型 两个角标
        card.dataset.tier = used;
        card.title = `${it.url}
显示档位：${used}`;
        return;
    }
    const direct = it.thumb || it.url;
    if (direct) {
        img.src = direct;
        card.dataset.tier = 'thumb';
        card.classList.add('nohd');
        card.title = `${it.url}\n大图没取到，暂时显示页面里的小图`;
    } else {
        card.classList.remove('loading');
        card.classList.add('imgfail');
    }
}

// 直接给 img 设地址并等 load/error；不额外下载一份（浏览器缓存会复用）
function tryLoadDirect(img, url, timeout = 9000) {
    return new Promise((resolve) => {
        let done = false;
        const fin = (ok) => {
            if (done) return;
            done = true;
            img.removeEventListener('load', onload);
            img.removeEventListener('error', onerror);
            clearTimeout(timer);
            resolve(ok);
        };
        const onload = () => fin(true);
        const onerror = () => fin(false);
        const timer = setTimeout(() => fin(false), timeout);
        img.addEventListener('load', onload);
        img.addEventListener('error', onerror);
        img.src = url;
    });
}
function enqueueThumb(task) {
    return new Promise((resolve, reject) => {
        S.thumbQueue.push({ task, resolve, reject });
        pumpThumbQueue();
    });
}

function pumpThumbQueue() {
    while (S.thumbActive < 4 && S.thumbQueue.length) {
        const job = S.thumbQueue.shift();
        S.thumbActive++;
        Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => {
            S.thumbActive--;
            pumpThumbQueue();
        });
    }
}

async function fetchImageData(url, pageUrl) {
    if (/^data:image\//i.test(url)) return url;
    const res = await chrome.runtime.sendMessage({ action: 'fetchMedia', url, pageUrl: pageUrl || S.data?.pageUrl || '' });
    if (!res || !res.ok || !res.data) throw new Error((res && res.error) || '后台下载失败');
    const mime = String(res.mime || 'image/png');
    if (!/^image\//i.test(mime)) throw new Error('返回的不是图片（' + mime + '）');
    return `data:${mime};base64,${res.data}`;
}

async function getThumbData(it) {
    const pageUrl = it.pageUrl || S.data?.pageUrl || '';
    const candidates = [it.thumb, it.url].filter(Boolean).filter((u, i, arr) => arr.indexOf(u) === i);
    let lastErr = null;
    for (const url of candidates) {
        const key = thumbKey(url, pageUrl);
        if (S.thumbData.has(key)) return S.thumbData.get(key);
        if (!S.thumbCache.has(key)) S.thumbCache.set(key, enqueueThumb(() => fetchImageData(url, pageUrl)));
        try {
            const data = await S.thumbCache.get(key);
            S.thumbData.set(key, data);
            return data;
        } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('没有可用的图片地址');
}

// 按地址取某一档的图（card=mw690 给卡片、full=mw2000 给查看器、orig=large 只在发送/下载时用）
async function getTierData(url, pageUrl) {
    if (!url) throw new Error('没有可用的图片地址');
    const base = pageUrl || (S.data && S.data.pageUrl) || '';
    const key = thumbKey(url, base);
    if (S.thumbData.has(key)) return S.thumbData.get(key);
    if (!S.thumbCache.has(key)) S.thumbCache.set(key, enqueueThumb(() => fetchImageData(url, base)));
    const data = await S.thumbCache.get(key);
    S.thumbData.set(key, data);
    return data;
}

function toggleItem(key) {
    if (S.running) return;
    if (S.selected.has(key)) S.selected.delete(key);
    else S.selected.add(key);
    refreshSelectionUI();
}

function refreshSelectionUI() {
    // 「共 N 张」和全选都只算内容图；无用图片折叠组里的图仍然可以单独勾选发送
    const total = S.flat.reduce((n, it) => n + (it.junk ? 0 : 1), 0);
    let n = 0;
    for (const it of S.flat) {
        const on = S.selected.has(it.key);
        if (on && !it.junk) n++;
        const el = S.cardEls.get(it.key);
        if (el) {
            el.classList.toggle('sel', on);
            el.setAttribute('aria-checked', on ? 'true' : 'false');
        }
    }
    const all = total > 0 && n === total;
    const selAll = $('#selAll');
    selAll.checked = all;
    selAll.indeterminate = n > 0 && !all;
    selAll.disabled = S.running || total === 0;
    $('#selCount').textContent = `已选 ${n} / 共 ${total} 张`;
    $('#btnInvert').disabled = S.running || total === 0;
    $('#btnClear').disabled = S.running || n === 0;
    $('#btnSend').disabled = S.running || n === 0;
    $('#btnSendRun').disabled = S.running || n === 0;
    $('#btnRefresh').disabled = S.running;
    for (const { group, check, inv } of S.groupEls.values()) {
        const cnt = group.items.reduce((m, it) => m + (S.selected.has(it.key) ? 1 : 0), 0);
        check.checked = cnt > 0 && cnt === group.items.length;
        check.indeterminate = cnt > 0 && cnt < group.items.length;
        check.disabled = S.running;
        if (inv) inv.disabled = S.running;
    }
    $('#btnCancel').hidden = !S.running;
    saveSelectionToBg();
}

function stateLabel(state, info) {
    if (state === 'sending') return '发送中…';
    if (state === 'failed') return '失败';
    if (state === 'sent') return info || '已发送';
    return '';
}

function applyCardState(card, state, info) {
    card.classList.remove('sending', 'sent', 'failed');
    if (state) card.classList.add(state);
    const badge = card.querySelector('.g-state');
    badge.textContent = stateLabel(state, info);
    if (state === 'failed' && info) card.title = info;
    else if (state === 'sent') card.title = info || '已发送';
    else card.title = card.dataset.alt || '';
}

function setCardState(key, state, info = '') {
    S.batchState.set(key, { state, info });
    const card = S.cardEls.get(key);
    if (card) applyCardState(card, state, info);
}

function clearCardStates() {
    S.batchState.clear();
    for (const card of S.cardEls.values()) applyCardState(card, '', '');
}

function sendFilename(item, index, stamp) {
    const seq = String(index).padStart(2, '0');
    if (/^data:image\//i.test(item.url)) {
        const ext = ((/^data:image\/([a-z0-9.+-]+)/i.exec(item.url) || [])[1] || 'png').replace('jpeg', 'jpg');
        return sanitizeFilename(`mtb_${stamp}_${seq}.${ext}`, 110);
    }
    const base = baseNameFromUrl(item.url) || 'image.jpg';
    const hasExt = /\.[a-z0-9]{1,6}$/i.test(base);
    const name = hasExt ? base : `${base}.jpg`;
    return sanitizeFilename(`mtb_${stamp}_${seq}_${name}`, 110);
}

async function runBatch(autoQueue) {
    if (S.running) return;
    const list = S.flat.filter((it) => S.selected.has(it.key));
    if (!list.length) { toast('先勾选要发送的图片', true); return; }
    const stamp = Date.now().toString(36).slice(-6);
    // 用户选的发送档位：默认卡片档（mw690），不再无脑拉 4MB 的 large
    const tier = ((S.settings.gallery || {}).sendTier) || 'card';
    const items = list.map((it, i) => ({
        url: weiboImageTierUrl(it.url, tier),
        pageUrl: it.pageUrl || S.data?.pageUrl || '',
        filename: sendFilename(it, i + 1, stamp),
        label: groupDisplay({ label: it.groupLabel, key: it.groupKey }),
    }));
    clearCardStates();
    S.running = true;
    refreshSelectionUI();
    $('#progress').hidden = false;
    setProgress(0);
    $('#status').textContent = '正在启动…';
    $('#status').title = '';
    try {
        const res = await chrome.runtime.sendMessage({ action: 'startGalleryBatch', items, autoQueue, pageUrl: S.data?.pageUrl || '' });
        if (!res || !res.ok) throw new Error((res && res.error) || '后台没有响应');
        if (S.running) toast('批量发送已在后台开始，关闭面板也会继续', false, 3600);
    } catch (e) {
        S.running = false;
        refreshSelectionUI();
        $('#status').textContent = '';
        toast('启动批量发送失败：' + String(e && e.message || e), true);
        await syncBatchState();
    }
}

function applyBatchState(st, { announce = false } = {}) {
    if (!st) return;
    const mismatch = !!(st.pageUrl && S.data?.pageUrl && st.pageUrl !== S.data.pageUrl);
    S.running = !!st.running;
    if (S.running) {
        $('#progress').hidden = false;
        if (!mismatch) {
            for (const r of st.results || []) {
                for (const key of S.byUrl.get(batchUrlKey(r.url)) || []) {
                    if (S.cardEls.has(key)) setCardState(key, r.ok ? 'sent' : 'failed', r.ok ? (st.autoQueue ? '已排队' : '已发送') : (r.error || '失败'));
                }
            }
            if (st.currentUrl) {
                for (const cur of S.byUrl.get(batchUrlKey(st.currentUrl)) || []) setCardState(cur, 'sending');
            }
        }
        const done = (st.ok || 0) + (st.fail || 0);
        const total = st.total || 0;
        setProgress(total ? done / total : 0);
        $('#status').textContent = mismatch
            ? `另一个标签页正在批量发送 ${done}/${total || '?'}`
            : `${st.autoQueue ? '排队' : '发送'} ${Math.min(done + 1, total || done + 1)}/${total || '?'}${st.currentLabel ? ' · ' + st.currentLabel : ''}`;
        $('#status').title = $('#status').textContent;
        refreshSelectionUI();
        return;
    }
    if (!st.finishedAt) { refreshSelectionUI(); return; }
    if (!mismatch) {
        for (const r of st.results || []) {
            for (const key of S.byUrl.get(batchUrlKey(r.url)) || []) {
                if (S.cardEls.has(key)) setCardState(key, r.ok ? 'sent' : 'failed', r.ok ? (st.autoQueue ? '已排队' : '已发送') : (r.error || '失败'));
            }
        }
    }
    const done = (st.ok || 0) + (st.fail || 0);
    setProgress(st.canceled || st.error ? (st.total ? done / st.total : 0) : 1);
    const label = st.canceled ? '已停止' : (st.error || '完成');
    $('#status').textContent = `${mismatch ? '另一个标签页 · ' : ''}${label} · 成功 ${st.ok || 0} · 失败 ${st.fail || 0}`;
    $('#status').title = '';
    refreshSelectionUI();
    if (announce && !mismatch) {
        if (st.canceled) toast(`已停止：成功 ${st.ok || 0}，失败 ${st.fail || 0}`, true);
        else if (st.error) toast(`${st.error}（成功 ${st.ok || 0}，失败 ${st.fail || 0}）`, true);
        else toast(`批量发送完成：成功 ${st.ok || 0}，失败 ${st.fail || 0}`, !!st.fail);
    }
}

async function syncBatchState() {
    try {
        const res = await chrome.runtime.sendMessage({ action: 'galleryBatchState' });
        const st = res && res.state;
        if (!st) return;
        if (st.running) { applyBatchState(st); return; }
        if (st.finishedAt && Date.now() - st.finishedAt < 10 * 60 * 1000) {
            const mismatch = !!(st.pageUrl && S.data?.pageUrl && st.pageUrl !== S.data.pageUrl);
            if (!mismatch) { applyBatchState(st); return; }
            if (!$('#status').textContent) $('#status').textContent = `另一个标签页上次批量：成功 ${st.ok || 0}，失败 ${st.fail || 0}`;
        }
    } catch (e) { /* 后台没有响应 */ }
}

function setProgress(ratio) {
    $('#progressBar').style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
}

function openLightbox(item) {
    // 无用图片不混进正常大图序列：在哪个名单里点开，就在哪个名单里翻
    S.lbList = S.flat.filter((x) => !!x.junk === !!item.junk);
    S.lbIndex = S.lbList.findIndex((x) => x.key === item.key);
    if (S.lbIndex < 0) return;
    $('#lightbox').hidden = false;
    showLightboxItem();
}

function showLightboxItem() {
    const it = S.lbList[S.lbIndex];
    if (!it) return closeLightbox();
    const img = $('#lbImg');
    const pageUrl = it.pageUrl || S.data?.pageUrl || '';
    // 卡片已经取过 card 档，查看器直接复用那份缓存，再去升 full 档（微博是 mw2000）
    const thumbUrl = it.card || it.thumb || it.url;
    const token = ++S.lbToken;
    img.alt = it.alt || '';
    img.onerror = () => {
        if (S.lbToken !== token) return;
        const cached = S.thumbData.get(thumbKey(thumbUrl, pageUrl));
        if (cached && img.src !== cached) { img.src = cached; return; }
        $('#lbMeta').textContent = '这张图加载失败（可能限制了外链）';
    };
    const cached = S.thumbData.get(thumbKey(thumbUrl, pageUrl));
    if (cached) img.src = cached;
    else img.removeAttribute('src');
    const dims = it.width && it.height ? ` · ${it.width}×${it.height}` : '';
    $('#lbMeta').textContent = `${groupDisplay({ label: it.groupLabel, key: it.groupKey })} · ${S.lbIndex + 1}/${S.lbList.length}${dims}`;
    $('#lbPrev').hidden = S.lbList.length < 2;
    $('#lbNext').hidden = S.lbList.length < 2;
    (async () => {
        try {
            if (!cached) {
                const thumb = await getThumbData(it);
                if (S.lbToken !== token) return;
                img.src = thumb;
            }
            if (it.full && it.full !== thumbUrl) {
                const okDirect = await tryLoadDirect(img, it.full);
                if (S.lbToken !== token) return;
                if (okDirect) img.dataset.tier = 'full';
                else {
                    const data = await getTierData(it.full, pageUrl);
                    if (S.lbToken !== token) return;
                    img.src = data;
                    img.dataset.tier = 'full';
                }
            }
            if (S.lbToken === token && img.naturalWidth) {
                $('#lbMeta').textContent = `${groupDisplay({ label: it.groupLabel, key: it.groupKey })} · ${S.lbIndex + 1}/${S.lbList.length} · ${img.naturalWidth}×${img.naturalHeight}`;
            }
        } catch (e) {
            if (S.lbToken !== token) return;
            if (!img.getAttribute('src')) $('#lbMeta').textContent += ' · 加载失败';
        }
    })();
}

function stepLightbox(dir) {
    if ($('#lightbox').hidden || !S.lbList.length) return;
    S.lbIndex = (S.lbIndex + dir + S.lbList.length) % S.lbList.length;
    showLightboxItem();
}

function closeLightbox() {
    S.lbToken++;
    $('#lightbox').hidden = true;
    $('#lbImg').removeAttribute('src');
}

function toast(text, isErr = false, ms = 0) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.toggle('err', !!isErr);
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), ms || (isErr ? 3600 : 2200));
}


/* ---------------- 顶部 tab + 微博筛选 ---------------- */
function filterHost() {
    try { return new URL((S.tab && S.tab.url) || '').hostname.toLowerCase(); } catch (e) { return ''; }
}

function disabledHosts() {
    return ((S.settings || {}).sites || {}).disabled || [];
}

function isSiteDisabled() {
    return !!S.siteHost && disabledHosts().includes(S.siteHost);
}

// 内容脚本只在启动那一刻读 sites.disabled，所以这里改完必须刷新页面才看得见效果
function syncSiteOff() {
    const wrap = $('#siteOffWrap');
    if (!wrap) return;
    wrap.hidden = !S.siteHost;
    if (!S.siteHost) return;
    const off = isSiteDisabled();
    $('#siteOff').checked = off;
    wrap.classList.toggle('on', off);
    wrap.title = off
        ? `扩展已在 ${S.siteHost} 停用：悬浮工具栏和微博筛选都不注入（图片面板照常，它不靠内容脚本）。刷新本页才会生效`
        : `勾选后在 ${S.siteHost} 停用扩展：悬浮工具栏和微博筛选都不注入，刷新本页生效`;
}

async function setSiteOff(off) {
    const host = S.siteHost;
    if (!host) return;
    const list = disabledHosts().filter((h) => h !== host);
    if (off) list.push(host);
    S.settings.sites = { ...(S.settings.sites || {}), disabled: list };
    syncSiteOff();
    try {
        await chrome.runtime.sendMessage({ action: 'patchSettings', patch: { sites: { disabled: list } } });
    } catch (e) { /* 扩展刚重载时忽略 */ }
    toast(off ? `已停用 ${host}：刷新本页后工具栏和筛选都会消失` : `已恢复 ${host}：刷新本页后重新注入工具栏`);
    if (document.body.classList.contains('tab-filter')) void refreshFilterStatus();
}

function modeText(r) {
    const base = `已隐藏 ${r.hidden} 条 / 共 ${r.total} 条`;
    return r.mode === 'list' ? `${base} · 实验模式（改微博内部列表，无空位）` : `${base} · 页面隐藏（会留空位）`;
}

function setWfStatus(text, ok) {
    const el = $('#wfStatus');
    el.textContent = text;
    el.classList.toggle('ok', !!ok);
}

function updateExprUi(f) {
    const row = $('#wfExprRow');
    const hint = $('#wfExprHint');
    const box = $('#wfKeywords');
    if (f.keywordMode !== 'expr') {
        row.hidden = true;
        box.placeholder = '搜索微博内容（一行一个也行）';
        box.classList.remove('bad');
        return;
    }
    row.hidden = false;
    box.placeholder = '例：(抽奖 或 转发) 且 非 广告';
    const src = exprSource(f);
    if (!src) {
        box.classList.remove('bad');
        hint.textContent = '只留下式子成立的微博，其余全部挡掉。并排写就是「且」；认 或/且/非、|| / && / !、括号，"引号" 里整串算一个词';
        return;
    }
    const parsed = keywordExprOf(src);
    box.classList.toggle('bad', !parsed.ok);
    hint.classList.toggle('bad', !parsed.ok);
    hint.textContent = parsed.ok
        ? `看懂了（只留成立的）：${describeExpr(parsed.node)}`
        : `看不懂（${parsed.error}），这一条现在不筛任何东西`;
}

// 把解析出来的树讲回人话，让用户一眼确认「我写的确实是这个意思」
function describeExpr(node) {
    const w = (n, top) => {
        if (!n) return '';
        if (n.k === 'term') return `含「${n.v}」`;
        if (n.k === 'not') return `不含${w(n.a, false)}`;
        const a = w(n.a, false), b = w(n.b, false);
        if (n.k === 'and') return top ? `${a} 且 ${b}` : `${a} 且 ${b}`;
        return top ? `${a} 或 ${b}` : `(${a} 或 ${b})`;
    };
    return w(node, true);
}

function renderMasterRow(f) {
    $('#panelFilter').classList.toggle('off', !f.enabled);
    $('#wfEnabledHint').textContent = f.enabled ? describeWeiboFilter(f) : '没勾选时下面这些条件一条都不挡';
}

function syncFilterForm() {
    const f = normalizeWeiboFilter((S.settings || {}).weiboFilter);
    $('#wfEnabled').checked = f.enabled;
    renderMasterRow(f);
    for (const el of document.querySelectorAll('[data-wf-type]')) el.checked = f.types[el.dataset.wfType] !== false;
    $('#wfKeywords').value = f.keywords.join(f.keywordMode === 'expr' ? ' ' : '\n');
    $('#wfKeywordMode').value = f.keywordMode;
    $('#wfFrom').value = f.dateFrom;
    $('#wfTo').value = f.dateTo;
    $('#wfAllSites').checked = f.allSites;
    $('#wfExperimental').checked = f.experimental;
    $('#wfSiteHint').textContent = f.allSites ? '对所有微博站点生效' : `只对当前站点生效（${S.filterSite || filterHost() || '未知'}）`;
    updateExprUi(f);
}

function readFilterForm() {
    const types = {};
    for (const el of document.querySelectorAll('[data-wf-type]')) types[el.dataset.wfType] = el.checked;
    const keywordMode = $('#wfKeywordMode').value;
    return normalizeWeiboFilter({
        enabled: !!$('#wfEnabled').checked,
        site: S.filterSite || filterHost(),
        allSites: $('#wfAllSites').checked,
        types,
        keywordMode,
        // 表达式档整句原样交给 normalize 处理（按逗号拆开会把表达式拆坏）
        keywords: $('#wfKeywords').value,
        dateFrom: $('#wfFrom').value,
        dateTo: $('#wfTo').value,
        experimental: !!$('#wfExperimental').checked,
    });
}

async function pushFilter(filter) {
    if (!S.tabId) { setWfStatus('没有可作用的网页'); return; }
    try {
        const r = await chrome.tabs.sendMessage(S.tabId, { action: 'mtbWeiboFilter', filter });
        if (!filter.enabled) setWfStatus('未启用筛选：条件先留着，页面上一条都不挡');
        else if (r && typeof r.hidden === 'number') setWfStatus(modeText(r), true);
        else setWfStatus('已应用', true);
        if (r && r.pageError) setWfStatus(`实验模式不可用，已退回页面隐藏（会留空位）：${r.pageError}`, false);
    } catch (e) {
        setWfStatus('网页里的脚本连不上：刷新网页后再试（刚重载扩展时旧脚本会失效）');
    }
}

let wfTimer = 0;
function onFilterFormChanged() {
    const filter = readFilterForm();
    S.settings.weiboFilter = filter;
    renderMasterRow(filter);
    updateExprUi(filter);
    clearTimeout(wfTimer);
    wfTimer = setTimeout(() => {
        chrome.runtime.sendMessage({ action: 'patchSettings', patch: { weiboFilter: filter } }).catch(() => {});
        pushFilter(filter);
    }, 120);
}

async function refreshFilterStatus() {
    const f = normalizeWeiboFilter((S.settings || {}).weiboFilter);
    if (!S.tabId) { setWfStatus('没有可作用的网页'); return; }
    if (isSiteDisabled()) { setWfStatus('本站已用「禁用本站」停用扩展，筛选不会注入（取消勾选并刷新本页后恢复）'); return; }
    try {
        const r = await chrome.tabs.sendMessage(S.tabId, { action: 'mtbWeiboStatus' });
        if (r && r.applied) setWfStatus(modeText(r), true);
        else if (f.enabled) setWfStatus(`已开启，但这条规则只作用于 ${f.site || '—'}，本页不生效`);
        else setWfStatus('没勾「启用筛选」，本页显示全部微博；勾上立刻生效，不用刷新');
    } catch (e) { setWfStatus('网页里的脚本连不上：刷新网页后再试'); }
}

function switchTab(name) {
    for (const b of document.querySelectorAll('#gTabs button')) b.classList.toggle('active', b.dataset.panel === name);
    document.body.classList.toggle('tab-filter', name === 'filter');
    $('#panelImages').hidden = name !== 'images';
    $('#panelFilter').hidden = name !== 'filter';
    if (name === 'images') fitLayout();
    else refreshFilterStatus();
}

function initFilterTab() {
    const host = filterHost();
    S.filterSite = host;
    const tabBtn = document.querySelector('#gTabs button[data-panel="filter"]');
    if (!isWeiboHost(host)) {
        tabBtn.disabled = true;
        tabBtn.title = '微博筛选只支持 weibo.com / m.weibo.cn';
        $('#wfStatus').textContent = '当前页面不是微博，筛选不可用';
    }
    syncFilterForm();
    $('#panelFilter').classList.remove('loading');
    for (const el of document.querySelectorAll('#panelFilter input, #panelFilter select')) {
        el.addEventListener('input', onFilterFormChanged);
        el.addEventListener('change', onFilterFormChanged);
    }
    $('#wfAllSites').addEventListener('change', syncFilterForm);
    $('#wfEnabled').addEventListener('change', syncFilterForm);
    $('#wfClear').onclick = () => {
        const f = normalizeWeiboFilter({ enabled: false, site: S.filterSite || host });
        S.settings.weiboFilter = f;
        syncFilterForm();
        chrome.runtime.sendMessage({ action: 'patchSettings', patch: { weiboFilter: f } }).catch(() => {});
        pushFilter(f);
    };
    // 采集回来时用户可能已经切到筛选 tab 了，别硬掰回图片
    const active = document.querySelector('#gTabs button.active');
    switchTab(active ? active.dataset.panel : 'images');
}

(async function main() {
    const q = new URLSearchParams(location.search);
    S.wide = q.get('wide') === '1';
    if (S.wide) document.documentElement.classList.add('wide');
    // 先把设置读起来：贴主题要用它，而大窗模式紧接着就揭开遮罩，晚一步就被用户看见换肤那一下
    const settingsReady = loadSettings();
    bindEvents();
    if (S.wide) $('#btnWide').hidden = true;
    askPanelSize();
    settlePanelSize();
    await settingsReady;
    if (S.wide) revealBoot();
    // 遮罩绝不能把面板锁死：万一视口一直读不稳（定时器被节流、窗口刚在动），到点直接揭开
    setTimeout(revealBoot, 2600);
    let tabId = parseInt(q.get('tabId') || '', 10);
    if (!Number.isFinite(tabId)) tabId = await findTabId();
    S.tabId = Number.isFinite(tabId) && tabId > 0 ? tabId : null;
    if (!S.tabId) {
        showEmpty('没有找到可读取的网页', '请先切换到有图片的普通网页，再点扩展图标。');
        return;
    }
    // 先把筛选表单初始化好（需要 S.tab 的 host）：采集可能要好几百毫秒，
    // 期间用户点到还没绑事件的勾选框会白点，甚至拿「全没勾」把页面筛空
    try { S.tab = await chrome.tabs.get(S.tabId); } catch (e) { /* 取不到就按空 host 处理 */ }
    initFilterTab();
    await collect(false);
    await syncBatchState();
})();
