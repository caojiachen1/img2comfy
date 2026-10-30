// 本页图片窗口的纯数据逻辑：微博图 URL 升级、去重键、账号分组标签。

export function isWeiboHost(host) {
    return /(^|\.)weibo\.(com|cn)$/i.test(String(host || ''));
}

// 微博图片 CDN 的 URL 形状是 https://<域名>/<尺寸变体>/<pid>.jpg，同一 pid 换变体就是不同清晰度。
// 变体名一大堆（orj360/mw690/wap180/tw420/thumb980/square/bmiddle/auto-webkit…），
// 逐个枚举会漏（漏了就给用户看糊图），所以按形状认：首段是「字母+数字」或已知变体词 → 换目标档位。
// crop.* 是裁过的头像/封面，别的档位下不存在，必须原样留着。
const WEIBO_SIZE_SEG = /^(?:thumb\d*|thumbnail|orj\d+|mw\d+|wap\d+|tw\d+|sq\d+|square|bmiddle|middle2|small|medium|hd|large|original|auto-webkit|[a-z]{1,8}\d{2,5})$/i;

// 三档实测（同 pid，微博页面内 fetch）：large 7008×4672/4.2MB、mw2000 2000×1333/283KB、
// mw690 690×460/41KB、orj360 405×270/14KB。
// 卡片只有 ~250px，拉 4MB 原图既慢又看不出差别，所以卡片用 card、大图查看器用 full，
// 只有发给 ComfyUI / 下载才用 orig（真原图）。
const WEIBO_TIERS = { orig: 'large', full: 'mw2000', card: 'mw690' };

export function weiboImageTierUrl(url, tier) {
    const seg = WEIBO_TIERS[tier] || WEIBO_TIERS.orig;
    try {
        const u = new URL(String(url || ''));
        if (!/(^|\.)sinaimg\.cn$/i.test(u.hostname)) return u.href;
        const parts = u.pathname.split('/');
        if (parts.length < 3 || !parts[1] || !parts[2]) return u.href;
        if (/^crop\./i.test(parts[1])) return u.href;
        if (parts[1].toLowerCase() === seg) return u.href;
        if (!WEIBO_SIZE_SEG.test(parts[1])) return u.href;
        parts[1] = seg;
        u.pathname = parts.join('/');
        return u.href;
    } catch (e) {
        return String(url || '');
    }
}

export function upgradeWeiboImageUrl(url) {
    return weiboImageTierUrl(url, 'orig');
}

// 同一个 pid 在 wx1/tvax1/ss1 等不同图片域名下是同一张，去重时只看 pathname；
// 其它站保留查询串（签名图床的 query 可能决定内容），只去掉 hash。
export function imageDedupeKey(url) {
    try {
        const u = new URL(String(url || ''));
        u.hash = '';
        // 同一 pid 会以 /orj360/、/mw690/、/large/ 等尺寸目录出现在不同域名下，
        // 去重键必须去掉第一段尺寸目录
        if (/(^|\.)sinaimg\.cn$/i.test(u.hostname)) return u.pathname.replace(/^\/[^/]+\//, '/');
        return u.href;
    } catch (e) {
        return String(url || '');
    }
}

export function accountInitial(name) {
    const t = String(name || '').trim();
    if (!t) return '?';
    return Array.from(t)[0].toUpperCase();
}

/* 一条微博的固定地址，面板「跳转」按钮用。桌面版是 weibo.com/<uid>/<bid>；
   没有 uid（或本来就是移动版页面）就退到 m.weibo.cn/status/<id> —— 那个形状只靠 id 就能打开。 */
export function weiboStatusUrl(item, host) {
    const it = item && typeof item === 'object' ? item : {};
    let uid = '';
    let id = '';
    try {
        uid = String((it.user && (it.user.id || it.user.uid)) || '');
        id = String(it.mblogid || it.bid || it.mid || it.idstr || it.id || '');
    } catch (e) { return ''; }
    if (!id || id.length < 5) return '';
    if (/^m\./i.test(String(host || ''))) return 'https://m.weibo.cn/status/' + id;
    return /^\d{5,}$/.test(uid) ? 'https://weibo.com/' + uid + '/' + id : 'https://m.weibo.cn/status/' + id;
}

/* 微博信息流里的一个条目（列表里的 item，或翻页接口返回的 status）→ 面板补图用的帖子形状。
   这是「一条微博有哪些图」的唯一映射处：读列表和读翻页接口两条路都走它，别在页面里再写一份。
   转发的图挂在 retweeted_status 上，而九宫格显示在这一条下面，所以两边并成一组、按 pathname 去重；
   档位优先 large，只有 mw2000 的导出就退一档（两个键名各版本都见过）。 */
export function weiboStatusToPost(item, index, host) {
    const it = item && typeof item === 'object' ? item : {};
    const rt = it.retweeted_status && typeof it.retweeted_status === 'object' ? it.retweeted_status : null;
    const pics = [];
    const seen = new Set();
    for (const src of [it, rt]) {
        if (!src) continue;
        const infos = src.pic_infos || {};
        let ids = [];
        try {
            ids = (Array.isArray(src.pic_ids) && src.pic_ids.length) ? src.pic_ids : Object.keys(infos);
        } catch (e) { ids = []; }
        for (const pid of ids) {
            const info = infos[pid] || {};
            const big = info.large || info.mw2000 || {};
            const url = String(big.url || big.latest_url || info.url || '');
            if (!/^https?:\/\//i.test(url)) continue;
            let key = url;
            try { key = new URL(url).pathname; } catch (e) { }
            if (seen.has(key)) continue;
            seen.add(key);
            pics.push({ url, width: Number(big.width || info.width) || 0, height: Number(big.height || info.height) || 0 });
        }
    }
    const user = it.user && typeof it.user === 'object' ? it.user : {};
    const strip = (h) => String(h == null ? '' : h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return {
        index: Number(index) || 0,
        id: String(it.mid || it.idstr || it.id || ''),
        mid: String(it.mid || ''),
        bid: String(it.bid || it.mblogid || ''),
        uid: String(user.id || user.uid || ''),
        name: strip(user.screen_name || ''),
        text: strip(it.text || it.longText || (rt && rt.text) || '').slice(0, 200),
        url: weiboStatusUrl(it, host),
        pics,
    };
}

// 翻页页数：面板上给的是 1/3/5/10，产品侧兜到 1~10（一次问太多页容易把自己送进微博的限流）
export function clampLoadPages(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return 3;
    return Math.max(1, Math.min(10, n));
}

/* 把「微博自己信息流数据」里的帖子并进采集分组（DOM 扫描之后跑）。
   归组三条路，按可靠性递减：
   1) 帖子 id 对上采集器的键格式 acct:<uid>#ps<mid|bid> —— 同一条微博 DOM 在不在都归同一组；
   2) 这些图已经登记在某个组里（这条帖子上一轮扫描在 DOM 里、这一轮被虚拟列表回收了，键会变，靠图找回来）；
   3) 都对不上才新建 feed 组。
   新组没有真实文档位置，按列表下标在「有真 y 的组」之间插值 —— 微博列表下标和页面位置同向（上→下），
   面板「顺序=信息流顺序」的排序才不会被喂成一团。 */
export function mergeFeedPosts(acc, posts, meta = {}) {
    const stats = { groups: 0, items: 0, matched: 0, skipped: 0 };
    if (!acc || !Array.isArray(acc.groups) || !acc.byKey || !acc.seen || !Array.isArray(posts) || !posts.length) {
        return stats;
    }
    if (!acc.byPid) acc.byPid = new Map();
    const pageUrl = String(meta.pageUrl || '');
    const rows = [];

    for (const p of posts) {
        if (!p || typeof p !== 'object') continue;
        const srcPics = Array.isArray(p.pics) ? p.pics : [];
        const pics = [];
        for (const raw of srcPics) {
            const url = raw && /^https?:\/\//i.test(String(raw.url || '')) ? upgradeWeiboImageUrl(raw.url) : '';
            if (!url) continue;
            const dk = imageDedupeKey(url);
            if (pics.some((x) => x.dk === dk)) continue;
            pics.push({ url, dk, width: Number(raw.width) || 0, height: Number(raw.height) || 0 });
        }
        if (!pics.length) { stats.skipped++; continue; }

        const ids = [];
        for (const v of [p.mid, p.bid, p.id]) {
            const s = String(v == null ? '' : v);
            if (s.length >= 5 && ids.indexOf(s) < 0) ids.push(s);
        }
        const owners = [];
        for (const v of [p.uid, p.name]) {
            const s = String(v == null ? '' : v);
            if (s && owners.indexOf('acct:' + s) < 0) owners.push('acct:' + s);
        }
        let key = '';
        for (const idv of ids) {
            for (const own of owners) {
                const cand = own + '#ps' + idv;
                if (acc.byKey.has(cand)) { key = cand; break; }
            }
            if (key) break;
        }
        if (!key) {
            // 账户段只是命名空间，**帖子 id 本身就能唯一定位一条内容**。
            // 小红书作者 uid 有两个来源（卡片底部链接 / 页面本身），账户段对不上但 #ps<id> 相同时
            // 必须认回同一组，否则「展开全部图」会另起一组，用户看到同一笔记出现两次。
            for (const idv of ids) {
                const tail = '#ps' + idv;
                for (const g of acc.groups) {
                    if (String(g.key || '').slice(-tail.length) === tail) { key = g.key; break; }
                }
                if (key) break;
            }
        }
        if (!key) {
            for (const pic of pics) {
                const found = acc.byPid.get(pic.dk);
                // 只认 DOM 量出来的那个组：feed 组自己按 mid 就能认回来，
                // 让「两条转发同一批图的微博」落到 byPid 上会被并成一组（少一条微博）
                if (found && found.indexOf('feed:') !== 0) { key = found; break; }
            }
        }

        let g = key ? acc.byKey.get(key) : null;
        // DOM 那边没认出永久链接时（有些版式就是没有），用数据里的地址补上
        if (g && !g.url && p.url) g.url = String(p.url);
        if (g && key.indexOf('feed:') !== 0) stats.matched++;
        if (!g) {
            key = 'feed:' + (ids[0] || pics[0].dk);
            if (acc.byKey.has(key)) { g = acc.byKey.get(key); } else {
                g = { key, label: String(p.name || ''), sub: String(p.text || '').slice(0, 72), url: String(p.url || ''), items: [], junk: false, y: 0, feed: true };
                acc.byKey.set(key, g);
                acc.groups.push(g);
                stats.groups++;
            }
        }
        // 组里只要有过 DOM 量到的条目，这个 y 就是真的，可以当插值锚点
        const domItem = g.items.find((it) => it && it.src !== 'feed' && Number.isFinite(it.y));
        rows.push({ g, pics, index: Number(p.index) || 0, anchorY: domItem ? domItem.y : null });
        if (domItem) g.y = Math.min(Number.isFinite(g.y) ? g.y : Infinity, domItem.y);
    }

    const anchors = rows.filter((r) => r.anchorY != null).sort((a, b) => a.index - b.index);
    const spacing = (() => {
        if (anchors.length < 2) return 600;
        const gaps = [];
        for (let i = 1; i < anchors.length; i++) {
            const d = anchors[i].index - anchors[i - 1].index;
            if (d > 0) gaps.push((anchors[i].anchorY - anchors[i - 1].anchorY) / d);
        }
        if (!gaps.length) return 600;
        gaps.sort((a, b) => a - b);
        return Math.max(120, Math.min(4000, Math.round(gaps[Math.floor(gaps.length / 2)])));
    })();
    const yAt = (idx) => {
        if (!anchors.length) return idx * spacing;
        let prev = null, next = null;
        for (const a of anchors) {
            if (a.index <= idx) prev = a;
            if (a.index >= idx && !next) next = a;
        }
        if (prev && next && prev !== next) {
            const t = (idx - prev.index) / (next.index - prev.index);
            return Math.round(prev.anchorY + (next.anchorY - prev.anchorY) * t);
        }
        if (prev) return Math.round(prev.anchorY + (idx - prev.index) * spacing);
        return Math.round(next.anchorY - (next.index - idx) * spacing);
    };

    for (const r of rows) {
        const y = r.anchorY != null ? r.anchorY : yAt(r.index);
        r.g.y = y;
        for (const pic of r.pics) {
            const key = r.g.key + '|' + pic.dk;
            if (acc.seen.has(key)) continue;
            acc.seen.add(key);
            acc.byPid.set(pic.dk, r.g.key);
            const card = weiboImageTierUrl(pic.url, 'card');
            r.g.items.push({
                key, url: pic.url, thumb: card, card, full: weiboImageTierUrl(pic.url, 'full'),
                y, width: pic.width, height: pic.height,
                kind: 'image', alt: '', pageUrl, groupKey: r.g.key, src: 'feed',
            });
            stats.items++;
        }
    }
    return stats;
}
