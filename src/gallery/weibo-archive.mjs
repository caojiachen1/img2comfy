// 微博个人主页「整档」抓取：走 /ajax/statuses/mymblog 接口，不碰 DOM。
//
// 为什么要有这个模块（都是实测踩出来的）：
//   1) 页面侧「帮我翻页」最多翻到 ~300 条就到底（微博自己截断），更早的七年内容拿不到；
//      接口路线实测 60 页 / 1176 条全量，且响应里的 data.total 会自报总数，能当场校验有没有漏。
//   2) 单页请求要 0.2~0.5s，整档 30~60s —— 比调用方（CLI/MCP）那层 60s 硬顶更长的活儿
//      绝不能塞在一次 RPC 里返回，所以这里只做「推进 + 回调」，由后台起任务、调用方轮询进度。
//   3) MV3 的 service worker 空闲 30s 会被回收，所以每页都要落一次游标断点，被杀了能续。
//
// 本文件保持零 chrome 依赖（fetch/存储/睡眠/中止全部注入），这样翻页与去重逻辑能在
// node test/unit_pure.mjs 里用真实接口夹具跑断言，不需要浏览器。

export const ARCHIVE_STORE_KEY = 'mtbWeiboArchive';
/* 构建标记：改一次归档相关代码就 +1。真人 Edge 的 ESM service worker 实测会连着几次
   「重新加载」后仍跑上一版（本仓库开发中踩过三次），有这个字段，一条 weiboArchiveState
   就能判定浏览器到底加载了哪一版，不用靠行为反推。 */
export const WA_BUILD = 'wa9';
export const MYMBLOG_API = 'https://weibo.com/ajax/statuses/mymblog';
// feature 分桶实测：只有 0 报 data.total，1/2/14 各回 20 条但 total=-1，9/24 空。
// 0 是主页时间线，其余几个是页面顶部那些标签（视频/文章/…），并集才接近「全部」。
export const DEFAULT_FEATURES = [0, 1, 2, 14];

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

/* 微博的 created_at 是 "Sat Oct 10 20:14:13 +0800 2026" —— 这个形状 new Date() 在部分
   引擎上直接 Invalid Date，而且它不带年份前置，必须自己拆。解不出来就留空，不猜。 */
export function parseWeiboDate(s) {
    const m = /^\w+\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s[+-]\d{4}\s+(\d{4})$/.exec(String(s || '').trim());
    if (!m) return '';
    const mon = MONTHS[m[1][0].toUpperCase() + m[1].slice(1, 3).toLowerCase()];
    if (!mon) return '';
    const pad = (x) => String(x).padStart(2, '0');
    return `${m[6]}-${pad(mon)}-${pad(m[2])} ${m[3]}:${m[4]}:${m[5]}`;
}

/* 正文里的花体数字（𝟐𝟎𝟒𝟎𝟔𝟎𝟖）是「拍摄场次」，NFKD 一归一化就变回 ASCII。
   图博不会在正文写穿搭，但一定会写日期码，所以这是聚合与检索的主键。 */
export function eventDateOf(text) {
    let t = '';
    try { t = String(text || '').normalize('NFKD'); } catch (e) { t = String(text || ''); }
    const m = /(20\d{2})(0[1-9]|1[0-2])([0-3]\d)/.exec(t);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

// 一条接口 status → 归档记录。只留分析真要用的字段：正文取 text_raw（text 是带标签的 HTML），
// 图取 pic_ids（URL 由档位函数拼，不把四种档位都存进档案），转发原帖的图单列，别和本条混在一起。
export function normStatus(s, uid) {
    if (!s || typeof s !== 'object') return null;
    const id = String(s.id || s.idstr || '');
    if (!id) return null;
    const bid = String(s.mblogid || s.mid || id);
    const rt = s.retweeted_status && typeof s.retweeted_status === 'object' ? s.retweeted_status : null;
    const text = String(s.text_raw || s.text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const dt = parseWeiboDate(s.created_at);
    return {
        id, bid, mid: String(s.mid || ''),
        url: uid ? `https://weibo.com/${uid}/${bid}` : `https://m.weibo.cn/status/${bid}`,
        created_at: dt, ts: dt ? Date.parse(dt.replace(' ', 'T') + '+08:00') : 0,
        event: eventDateOf(text), text,
        pics: Array.isArray(s.pic_ids) ? s.pic_ids.slice() : [],
        pic_num: Number(s.pic_num) || 0,
        rt_pics: rt && Array.isArray(rt.pic_ids) ? rt.pic_ids.slice() : [],
        repost: !!rt, isLongText: !!s.isLongText, video: (s.page_info || {}).type === 'video',
        source: String(s.source || ''), region: String(s.region_name || ''),
        rep: Number(s.reposts_count) || 0, com: Number(s.comments_count) || 0, like: Number(s.attitudes_count) || 0,
    };
}

/* 一页应答 → { list, cursor, declaredTotal }。游标字段三个版本都见过（since_id / max_id_id /
   maxId），列表有时在 data.list、有时直接 list —— 认不全就会原地打转把整档翻成一页。 */
export function parseArchivePage(payload) {
    const root = payload && typeof payload === 'object' ? payload : {};
    const d = root.data && typeof root.data === 'object' ? root.data : root;
    const list = Array.isArray(d.list) ? d.list : (Array.isArray(root.list) ? root.list : []);
    const raw = d.since_id || d.max_id_id || d.maxId || root.since_id || '';
    return {
        list,
        cursor: String(raw || ''),
        declaredTotal: Number(d.total) > 0 ? Number(d.total) : 0,
    };
}

/* features 从 RPC 过来可能是 0、'0'、[0,1]、[]、带 null。Number(null)===0 会把
   「我只想抓视频桶」悄悄变成「抓时间线」，所以先按原值滤掉空，再转数、再去重；
   标量按单桶处理（传 0 就是 [0]），全非法才退回默认四桶。 */
export function normFeatures(v) {
    const raw = Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : [v]);
    const feats = [...new Set(raw
        .filter((x) => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x)))
        .map(Number))];
    return feats.length ? feats : DEFAULT_FEATURES.slice();
}

/* 断点里「已下过哪些图」只是记账，文件可能被用户从下载目录里删掉 —— 只信账本就会永久漏下那几张
   （实测踩过：账本记 5 张，磁盘上只剩 2 张）。rescan 用实际存在的文件把账本重算一遍。 */
export function reconcileDone(pids, existingFiles) {
    const have = new Set();
    for (const f of existingFiles || []) {
        // 文件名就是 pid；Chrome 重名时会加 " (1)" 后缀，也要认回来
        const m = /\/?([0-9a-zA-Z]{16,})(?: \(\d+\))?\.(?:jpg|jpeg|png|webp)$/i.exec(String(f || ''));
        if (m) have.add(m[1]);
    }
    return new Set((pids || []).filter((p) => have.has(p)));
}

export function newArchiveState(uid, opt = {}) {
    return {
        uid: String(uid || ''), features: normFeatures(opt.features),
        maxPages: Number(opt.maxPages) || 400, delayMs: Number(opt.delayMs) || 600,
        posts: [], byId: null, seenPages: 0, cursor: '', declaredTotal: 0,
        perFeature: {}, running: false, done: false, canceled: false, stopped: '', error: '',
        startedAt: 0, finishedAt: 0, checkpointedAt: 0,
    };
}

// 去重只认 id：同一条微博在不同 feature 桶里会各出现一次，bid 也可能因版本不同而缺
export function addPosts(st, list, uid) {
    if (!st.byId) st.byId = new Set(st.posts.map((p) => p.id));
    let added = 0;
    for (const s of list) {
        const r = normStatus(s, st.uid || uid);
        if (!r || st.byId.has(r.id)) continue;
        st.byId.add(r.id);
        st.posts.push(r);
        added++;
    }
    return added;
}

export function publicArchive(st) {
    // first/last 必须按时间取，不能取数组两端：微博把置顶帖放在最前面，
    // 按插入序取会把「最新一条」报成那条置顶（实测报成 2024-06-09，真最新是 2026-10-10）。
    let old = null;
    let recent = null;
    for (const p of st.posts) {
        const t = Number(p.ts) || 0;
        if (!t) continue;
        if (!old || t < old.ts) old = p;
        if (!recent || t > recent.ts) recent = p;
    }
    return {
        build: WA_BUILD,
        uid: st.uid, features: st.features, running: !!st.running, done: !!st.done,
        canceled: !!st.canceled, stopped: st.stopped || '', error: st.error || '',
        pages: st.seenPages, posts: st.posts.length, declaredTotal: st.declaredTotal || 0,
        // complete 只在接口自报过 total 时才有意义（feature=0 才报）
        complete: st.declaredTotal > 0 ? st.posts.length >= st.declaredTotal : null,
        withPics: st.posts.filter((p) => p.pics.length).length,
        picTotal: uniqPics(st.posts).length,
        first: old ? old.created_at : '', last: recent ? recent.created_at : '',
        perFeature: st.perFeature, startedAt: st.startedAt, finishedAt: st.finishedAt,
        cursor: st.cursor,
    };
}

export function uniqPics(posts) {
    const seen = new Set();
    const out = [];
    for (const p of posts || []) for (const pid of p.pics) if (pid && !seen.has(pid)) { seen.add(pid); out.push(pid); }
    return out;
}

/* 抓取主循环。每页都调 checkpoint（游标级），每 checkpointEvery 页调一次 fullCheckpoint（整档落盘），
   这样 SW 被回收后 resume 最多重问几页，而不是整档作废。 */
export async function crawlArchive(deps, st) {
    const { fetchPage, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = deps;
    st.running = true;
    st.done = false;
    st.startedAt = st.startedAt || Date.now();
    const every = Math.max(1, Number(deps.checkpointEvery) || 10);
    outer: for (const feat of st.features) {
        // 上一轮已经判到底的桶，续跑时不必再敲接口（抓完再 Start 一次会白烧几十次请求）
        if (st.perFeature[feat] && st.perFeature[feat].end) continue;
        let cursor = st.perFeature[feat] && st.perFeature[feat].cursor ? st.perFeature[feat].cursor : '';
        let page = st.perFeature[feat] ? st.perFeature[feat].page : 0;
        st.perFeature[feat] = st.perFeature[feat] || { cursor: '', page: 0, added: 0, end: false, error: '' };
        let same = 0;
        while (page < st.maxPages) {
            if (deps.shouldStop && deps.shouldStop()) { st.canceled = true; break outer; }
            let payload;
            try {
                payload = await fetchPage({ uid: st.uid, feature: feat, page: page + 1, sinceId: cursor });
            } catch (e) {
                st.error = String((e && e.message) || e);
                st.perFeature[feat].error = st.error;
                break outer;
            }
            const pg = parseArchivePage(payload);
            if (pg.declaredTotal && pg.declaredTotal > st.declaredTotal) st.declaredTotal = pg.declaredTotal;
            const added = addPosts(st, pg.list, st.uid);
            page++;
            st.seenPages++;
            st.perFeature[feat] = { cursor: pg.cursor, page, added: st.perFeature[feat].added + added, end: false, error: '' };
            st.cursor = pg.cursor;
            // 游标原地不动 = 接口没往后翻（参数没生效 / 到底了）。连吃两次就收手，绝不空转。
            same = pg.cursor && pg.cursor === cursor ? same + 1 : 0;
            cursor = pg.cursor;
            if (deps.onProgress) deps.onProgress(publicArchive(st));
            if (st.declaredTotal && st.posts.length >= st.declaredTotal && feat === st.features[0]) {
                st.perFeature[feat].end = true;
                st.stopped = 'reached-total';
                break;
            }
            if (!pg.list.length) { st.perFeature[feat].end = true; st.stopped = 'empty-page'; break; }
            if (same >= 2) { st.perFeature[feat].end = true; st.stopped = 'cursor-stuck'; break; }
            if (page >= st.maxPages) { st.perFeature[feat].end = true; st.stopped = 'max-pages'; break; }
            if (sleep && st.delayMs) await sleep(st.delayMs);
            if (deps.checkpoint && st.seenPages % every === 0) {
                await deps.checkpoint(serializeArchive(st));
                st.checkpointedAt = Date.now();
            }
        }
    }
    if (deps.checkpoint) await deps.checkpoint(serializeArchive(st));
    st.running = false;
    st.done = !st.canceled && !st.error;
    st.finishedAt = Date.now();
    return publicArchive(st);
}

/* 面板「API 模式 · 无限下拉」用的增量抓取：一次只推进第一个桶的游标 1~10 页就返回，
   并把这一批新采到的**原始 status** 一起带回去（调用方要按面板形状映射）。
   和 crawlArchive 共用同一份 perFeature 游标状态，所以下拉过的内容再点整档不会重复敲接口。
   停的条件和整档一致：空页 / 游标两次不动 / 收满 declaredTotal，都写进 stopped 让人看得见。 */
export async function takePages(st, fetchPage, n = 1, featOpt) {
    // 面板只要时间线，所以调用方会显式传 0；不传才退回「这份档案的第一个桶」
    const feat = Number.isFinite(Number(featOpt)) ? Number(featOpt) : (st.features && st.features.length ? st.features[0] : 0);
    const pf = st.perFeature[feat] || (st.perFeature[feat] = { cursor: '', page: 0, added: 0, end: false, error: '' });
    const pages = Math.max(1, Math.min(10, Number(n) || 1));
    const out = { fetched: 0, added: 0, fresh: [], done: false, failed: false, stopped: '', cursor: pf.cursor || '', declaredTotal: st.declaredTotal || 0 };
    if (pf.end) { out.done = true; out.stopped = 'already-end'; return out; }
    if (!st.byId) st.byId = new Set(st.posts.map((p) => p.id));
    let cursor = pf.cursor || '';
    let same = 0;
    for (let i = 0; i < pages; i++) {
        let payload;
        try { payload = await fetchPage({ uid: st.uid, feature: feat, page: pf.page + 1, sinceId: cursor }); }
        catch (e) {
            out.stopped = String((e && e.message) || e);
            // 失败要单独标出来：调用方（面板无限下拉）必须因此停手，
            // 不能把「这一页没拿到」当成「还没到底」，每滚一下又去敲一个 403
            out.failed = true;
            pf.error = out.stopped;
            break;
        }
        const pg = parseArchivePage(payload);
        out.fetched++;
        pf.page++;
        if (pg.declaredTotal > (st.declaredTotal || 0)) st.declaredTotal = pg.declaredTotal;
        for (const s of pg.list) {
            const r = normStatus(s, st.uid);
            if (!r || st.byId.has(r.id)) continue;
            st.byId.add(r.id);
            st.posts.push(r);
            out.fresh.push(s);
        }
        st.seenPages++;
        out.cursor = pg.cursor || cursor;
        same = pg.cursor && pg.cursor === cursor ? same + 1 : 0;
        cursor = out.cursor;
        pf.cursor = cursor;
        out.declaredTotal = st.declaredTotal || 0;
        if (!pg.list.length) { pf.end = true; out.stopped = 'empty-page'; break; }
        if (same >= 2) { pf.end = true; out.stopped = 'cursor-stuck'; break; }
        if (st.declaredTotal && st.posts.length >= st.declaredTotal) { pf.end = true; out.stopped = 'reached-total'; break; }
    }
    out.added = out.fresh.length;
    out.done = !!pf.end;
    out.posts = st.posts.length;
    return out;
}

// 落盘形态：Set 不可序列化，所以剥掉 byId，恢复时再按 posts 重建
export function serializeArchive(st) {
    const { byId, ...rest } = st;
    return { ...rest, posts: st.posts, version: 1 };
}

export function restoreArchive(obj) {
    const st = newArchiveState((obj && obj.uid) || '');
    Object.assign(st, obj || {});
    st.posts = Array.isArray(obj && obj.posts) ? obj.posts : [];
    st.byId = new Set(st.posts.map((p) => p.id));
    st.running = false;
    return st;
}

/* 图片下载计划。档位只有三档是真存在的（large 原图 / mw2000 / mw690），
   文件名带上 pid 保证可续传：skip 传已完成的 pid 集合，重复调用只会补没下的。 */
export const TIERS = { orig: 'large', full: 'mw2000', card: 'mw690', thumb: 'orj360' };

export function mediaPlan(st, opt = {}) {
    const tier = TIERS[opt.tier] ? opt.tier : 'orig';
    const subdir = String(opt.subdir || 'mtb-weibo').replace(/^\/+|\/+$/g, '');
    const skip = opt.skip instanceof Set ? opt.skip : new Set(opt.skip || []);
    const out = [];
    const seen = new Set();
    for (const p of st.posts) {
        const day = (p.created_at || '').slice(0, 10) || 'unknown';
        for (const pid of p.pics) {
            if (!pid || seen.has(pid) || skip.has(pid)) continue;
            seen.add(pid);
            out.push({
                pid, key: `${subdir}/${st.uid}/${day}/${pid}.jpg`,
                url: `https://wx1.sinaimg.cn/${TIERS[tier]}/${pid}.jpg`, tier: TIERS[tier], day,
            });
        }
    }
    const limit = Number(opt.limit) || 0;
    return limit > 0 ? out.slice(0, limit) : out;
}
