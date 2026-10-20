// 注入到目标页执行：收集当前页面（含 iframe）的图片，按微博账户分组。
// 注意：这个函数会被 chrome.scripting.executeScript 序列化后执行，必须完全自包含，
// 不能引用模块外的任何变量/函数。

export async function collectPageImages(options = {}) {
    const opt = options || {};
    const max = Math.max(1, Math.min(1000, Number(opt.max) || 400));
    const minDisplay = Number(opt.minDisplay) || 56;
    const minNatural = Number(opt.minNatural) || 160;
    const host = location.hostname;
    // 每张被丢掉的图都记一笔原因（只累计数字）；传 opt.debug 才连样本一起带回来
    const dbg = opt.debug === true ? [] : null;
    const dropHist = {};
    function note(el, why, extra) {
        const k = String(why).split('@')[0];
        dropHist[k] = (dropHist[k] || 0) + 1;
        if (!dbg || dbg.length >= 400) return;
        const rec = { why };
        try { rec.u = absolute(el.currentSrc || el.getAttribute('src') || '').replace(/^https?:\/\/[^/]+\//, '/').slice(0, 60); } catch (e) { rec.u = ''; }
        if (extra) for (const k2 in extra) rec[k2] = extra[k2];
        dbg.push(rec);
    }

    // 「无用图片」不再丢，而是收进一个默认折叠的分组，用户自己决定要不要展开。
    // 只收有真实 http(s) 地址的；data: 占位、没有地址的仍然直接扔。
    const junkItems = [];
    const junkSeen = new Set();
    const JUNK_MAX = 240;
    function rawUrlFor(img) {
        for (const attr of ['data-original', 'data-full', 'data-large', 'data-src', 'data-lazy-src']) {
            const v = img.getAttribute && img.getAttribute(attr);
            if (v) { const u = absolute(v); if (/^https?:/i.test(u)) return u; }
        }
        const u = absolute(img.currentSrc || img.getAttribute('src') || '');
        return /^https?:/i.test(u) ? u : '';
    }
    function keepJunk(img, y, why) {
        if (junkItems.length >= JUNK_MAX) return;
        const u = rawUrlFor(img);
        if (!u || !looksLikeImage(u)) return;
        const key = 'junk|' + dedupeKey(largeUrl(u));
        if (junkSeen.has(key)) return;
        junkSeen.add(key);
        const url = largeUrl(u);
        junkItems.push({
            url, thumb: url, card: tierUrl(url, 'card'), full: tierUrl(url, 'full'),
            y: Math.round(y || 0), width: 0, height: 0, kind: 'image',
            alt: cleanText(img.alt).slice(0, 60), pageUrl, why,
        });
    }
    // 顶层页是微博时，iframe 里的图片也按微博规则升级/分组
    const weibo = opt.weibo === true || /(^|\.)weibo\.(com|cn)$/i.test(host);
    const pageUrl = location.href;
    const pageTitle = (document.title || host || '本页图片').trim();
    const JUNK_URL = /(?:^data:image\/svg|favicon|sprite|emoji|(?:^|[\/_.-])icon(?:[\/_.-]|$)|\/icons?\/|\/avatar|\/avatars?\/|profile_image|\/logo(?:[\/_.-]|$)|pixel|spacer|1x1|transparent|blank\.(?:gif|png)|sinaimg\.cn\/crop\.|\/\/tva[x]?\d*\.)/i;
    const JUNK_ALT = /^(?:头像|avatar|icon|logo|表情|emoji|二维码|qr ?code)$/i;
    const WEIBO_USER_HREF = /(?:weibo\.(?:com|cn)\/(?:u\/\d+|n\/[^/?#]+|\d{4,})|m\.weibo\.cn\/(?:u\/\d+|n\/[^/?#]+))/i;
    const GENERIC_USER_HREF = /(?:\/(?:u|user|users|profile|people|author)\/|\/@)[^/?#]+/i;
    const BLACKLIST_NAME = /^(?:微博|首页|视频|关注|粉丝|登录|注册|搜索|超话|热门|发现|消息|更多|分享|评论|赞|转发|收藏|我的)$/;

    function cleanText(v) {
        return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    }

    function parentOf(node) {
        if (!node) return null;
        if (node.parentElement) return node.parentElement;
        const root = node.getRootNode ? node.getRootNode() : null;
        return root && root.host ? root.host : null;
    }

    function absolute(u) {
        const s = cleanText(u);
        if (!s) return '';
        if (/^(?:data|blob):/i.test(s)) return s;
        if (s.startsWith('//')) return location.protocol + s;
        try { return new URL(s, document.baseURI).href; } catch (e) { return ''; }
    }

    // 与 src/common/gallery.js 的 weiboImageTierUrl 保持一致（这个函数会被序列化进页面执行，不能 import）
    const SIZE_SEG = /^(?:thumb\d*|thumbnail|orj\d+|mw\d+|wap\d+|tw\d+|sq\d+|square|bmiddle|middle2|small|medium|hd|large|original|auto-webkit|[a-z]{1,8}\d{2,5})$/i;
    const TIERS = { orig: 'large', full: 'mw2000', card: 'mw690' };
    function tierUrl(url, tier) {
        if (!weibo) return url;
        const seg = TIERS[tier] || TIERS.orig;
        try {
            const u = new URL(url);
            if (!/(^|\.)sinaimg\.cn$/i.test(u.hostname)) return u.href;
            const parts = u.pathname.split('/');
            if (parts.length < 3 || !parts[1] || !parts[2]) return u.href;
            if (/^crop\./i.test(parts[1])) return u.href;
            if (parts[1].toLowerCase() === seg) return u.href;
            if (!SIZE_SEG.test(parts[1])) return u.href;
            parts[1] = seg;
            u.pathname = parts.join('/');
            return u.href;
        } catch (e) { return url; }
    }
    const largeUrl = (url) => tierUrl(url, 'orig');

    function dedupeKey(url) {
        try {
            const u = new URL(url);
            u.hash = '';
            return /(^|\.)sinaimg\.cn$/i.test(u.hostname) ? u.pathname.replace(/^\/[^/]+\//, '/') : u.href;
        } catch (e) { return url; }
    }

    // 微博页里存在 <img src="/u/false"> 这类占位/坏地址（相对路径会解析成 https://weibo.com/u/false），
    // 它根本不是图片，收进来就是一张永远「加载失败」的卡片。
    // 判定：带图片扩展名的算；跨域地址算（图床常常没有扩展名）；同域又没有扩展名的不算。
    function looksLikeImage(u) {
        try {
            if (/^data:image\//i.test(u)) return true;
            const x = new URL(u);
            if (/\.(?:png|jpe?g|gif|webp|avif|bmp|tiff?|heic|ico)$/i.test(x.pathname)) return true;
            return x.hostname !== host;
        } catch (e) { return false; }
    }

    function isJunk(url, alt) {
        if (!url) return true;
        if (JUNK_URL.test(url)) return true;
        if (alt && JUNK_ALT.test(cleanText(alt))) return true;
        return false;
    }

    function largestFromSrcset(srcset) {
        let best = '', bestW = -1;
        for (const part of String(srcset || '').split(',')) {
            const bits = part.trim().split(/\s+/);
            const url = bits[0];
            if (!url) continue;
            const desc = bits[1] || '';
            const weight = desc ? (parseFloat(desc) || 0) * (desc.endsWith('x') ? 1000 : 1) : 1;
            if (weight >= bestW) { bestW = weight; best = url; }
        }
        return best;
    }

    function bestUrlFor(img) {
        const candidates = [];
        for (const attr of ['data-original', 'data-full', 'data-large', 'data-orig-src', 'data-src', 'data-lazy-src', 'data-url', 'data-image']) {
            const v = img.getAttribute(attr);
            if (v) candidates.push(absolute(v));
        }
        candidates.push(absolute(largestFromSrcset(img.getAttribute('srcset'))));
        const picture = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null;
        if (picture) for (const src of picture.querySelectorAll('source')) candidates.push(absolute(largestFromSrcset(src.getAttribute('srcset'))));
        candidates.push(absolute(img.currentSrc || img.getAttribute('src') || ''));
        for (const c of candidates) {
            if (!c) continue;
            if (!/^https?:/i.test(c) && !/^data:image\//i.test(c)) continue;
            if (/^data:image\/svg/i.test(c)) continue;
            if (!looksLikeImage(c)) continue;
            const up = largeUrl(c);
            if (!isJunk(up, img.alt)) return up;
        }
        return '';
    }

    function styleVisible(el) {
        try {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
            let node = parentOf(el), hops = 0;
            while (node && node !== document.body && hops < 8) {
                const s = getComputedStyle(node);
                if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
                node = parentOf(node); hops++;
            }
            return true;
        } catch (e) { return true; }
    }

    // 只在 opt.debug 为真时才用：定位「这张图为什么没进列表」，把被哪一层挡住的证据带出来
    function hiddenWhy(el) {
        try {
            let node = el, hops = 0;
            for (; node && node !== document.body && hops < 9; node = parentOf(node), hops++) {
                const s = getComputedStyle(node);
                if (s.display === 'none') return 'display-none@' + node.tagName + '.' + String(node.className || '').slice(0, 24);
                if (s.visibility === 'hidden') return 'visibility-hidden@' + node.tagName + '.' + String(node.className || '').slice(0, 24);
                if (parseFloat(s.opacity) === 0) return 'opacity-0@' + node.tagName + '.' + String(node.className || '').slice(0, 24);
            }
            return 'hidden-unknown';
        } catch (e) { return 'hidden-error'; }
    }

    // 一条微博的容器：桌面版是 <article>，移动版是 .card9 / .vue-recycle-scroller__item-view 这类。
    // 必须优先认它 —— 九宫格每个格子常常自带作者链接，按「最近的带作者链接的祖先」认就会被拆成一格一组。
    const POST_SEL = 'article,[role="article"],.card9,.m-panel,.card-wrap,.vue-recycle-scroller__item-view,'
        + '[feed-item],.WB_feed_type,.mod_detail,.weibo-main,.mwb-list-item';
    function postBox(el) {
        let node = el, hops = 0;
        for (; node && node !== document.body && hops < 18; node = parentOf(node), hops++) {
            if (node.nodeType === 1 && node.matches?.(POST_SEL)) return node;
        }
        return null;
    }

    function findCard(el) {
        if (!weibo) {
            let n = el;
            for (let i = 0; n && n.nodeType === 1 && i < 12; i++, n = parentOf(n)) {
                if (n.matches?.('article, [role="article"]')) return n;
            }
            return null;
        }
        const box = postBox(el);
        if (box) return box;
        const grid = galleryOf(el);
        if (grid) return grid;
        let node = parentOf(el), withUser = null;
        for (let i = 0; node && node !== document.body && i < 12; i++, node = parentOf(node)) {
            if (!withUser && node.querySelectorAll) {
                for (const a of node.querySelectorAll('a[href]')) {
                    if (WEIBO_USER_HREF.test(a.href || '')) { withUser = node; break; }
                }
            }
            if (withUser) break;
        }
        return withUser || el.closest?.('li, [class*="card"], [class*="Card"], [class*="feed"], [class*="Feed"], [class*="post"], [class*="Post"]') || null;
    }

    // 微博把「18小时前」这个时间也包成指向这条微博的链接（weibo.com/<uid>/<pid>），
    // 它比昵称短，会被作者打分器的「同分取短名」抢走；九宫格每格也各有一条这种链接。
    const POST_PERMALINK = /^https?:\/\/(?:www\.|m\.)?weibo\.(?:com|cn)\/\d{5,}\/[\w]+/i;
    const TIME_TEXT = /^(?:刚刚|\d+\s*(?:秒|分钟|小时|天|周|月|年)前|\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2}|(?:今天|昨天|前天)\s*\d{1,2}:\d{2})$/;
    // 桌面版信息流的表头长这样（class 是 CSS Module 哈希过的，但词根稳定）：
    //   <a class="_default_xxx" href="/u/<uid>">（头像，里面 innerText 是空的）
    //   <a class="_link_xxx _bolder_xxx" href="/mygroups?gid=…">账户名</a>   ← 名字指回分组页，不像用户主页链接
    //   <a class="_superText_xxx" href="/p/…">某某超话</a>
    //   <a class="_time_xxx" href="/<uid>/<pid>">55分钟前</a>
    // 正文里的 @提及是 <a href="/n/<昵称>">@某某</a>，它才是过去被当成发帖人的那个。
    const NAME_CLASS = /(?:^|[^a-z])(?:name|nick|title|bolder|fwv|link)(?:_|$)/i;

    function uidOf(card) {
        for (const a of card.querySelectorAll('a[href]')) {
            const href = a.href || '';
            const m = href.match(/\/u\/(\d{5,})(?:[/?#]|$)/i) || href.match(/weibo\.(?:com|cn)\/(\d{5,})\//i);
            if (m) return m[1];
        }
        return '';
    }

    function headerNameOf(card) {
        for (const a of card.querySelectorAll('a[href]')) {
            if (!NAME_CLASS.test(String(a.className || ''))) continue;
            const text = cleanText(a.innerText || a.textContent);
            if (!text || text.length > 30) continue;
            if (text.startsWith('@') || TIME_TEXT.test(text) || BLACKLIST_NAME.test(text)) continue;
            // 「128」「3条评论」这类计数/操作条也常常挂着 _link_ 类名，不是账户名
            if (/^\d+$/.test(text) || /^\d+\s*(?:万)?\s*(?:[条人])?(?:评论|转发|赞|收藏|阅读|讨论)/.test(text)) continue;
            return text;
        }
        return '';
    }

    function authorOf(card) {
        if (!card) return null;
        const uid = weibo ? uidOf(card) : '';
        if (weibo) {
            const name = headerNameOf(card);
            if (name) return { key: 'acct:' + (uid || name), label: name };
        }
        let best = null;
        for (const a of card.querySelectorAll('a[href]')) {
            const href = a.href || a.getAttribute('href') || '';
            const text = cleanText(a.innerText || a.textContent);
            if (!text || text.length > 30 || BLACKLIST_NAME.test(text)) continue;
            if (TIME_TEXT.test(text)) continue;
            if (uid && text.startsWith('@')) continue;   // 有 uid 就不拿正文 @提及当发帖人
            let score = 0;
            if (weibo) {
                if (!WEIBO_USER_HREF.test(href)) continue;
                if (POST_PERMALINK.test(href) && !/(?:\/u\/|\/n\/)\w+/i.test(href)) continue;
                if (/\/(?:u|n)\/\d+/.test(href)) score += 1;
            } else {
                const rel = a.getAttribute('rel') || '';
                const cls = String(a.className || '');
                if (!(rel === 'author' || /author|user|name|nick|owner/i.test(cls) || GENERIC_USER_HREF.test(href))) continue;
                if (rel === 'author') score += 3;
                if (/\/(?:\/u\/|user|users|profile|people|author)\//i.test(href)) score += 2;
                if (/author|user|name|nick|owner/i.test(cls)) score += 1;
            }
            if (/name|nick|author|user/i.test(String(a.className || ''))) score += 2;
            if (!best || score > best.score || (score === best.score && text.length < best.text.length)) best = { score, text, href };
        }
        if (best) {
            const buid = uid || (best.href.match(/(?:\/u\/|m\.weibo\.cn\/u\/)(\d+)/i)
                || best.href.match(/weibo\.(?:com|cn)\/(\d{5,})(?:[/?#]|$)/i)
                || [])[1] || '';
            return { key: buid ? 'acct:' + buid : 'acct:' + best.text, label: best.text };
        }
        for (const el of card.querySelectorAll('[class*="name"],[class*="Name"],[class*="nick"],[class*="Nick"],[class*="author"],[class*="Author"]')) {
            if (el.children.length > 2) continue;
            const text = cleanText(el.innerText || el.textContent);
            if (text && text.length <= 30 && !BLACKLIST_NAME.test(text) && !TIME_TEXT.test(text)) return { key: 'acct:' + (uid || text), label: text };
        }
        return null;
    }

    const pageGroup = weibo ? { key: '__weibo_unknown', label: '未识别账号', sub: '' } : { key: '__page', label: pageTitle, sub: '' };

    // 九宫格是若干兄弟图并排放在同一个容器里：往上找第一个装着 2~30 张图的祖先当这条微博的容器。
    // 微博的每个格子常常自带作者链接和「单图永久链接」，不归组就会被拆成一格一条微博。
    function galleryOf(el) {
        let node = parentOf(el);
        for (let i = 0; node && node !== document.body && i < 8; i++, node = parentOf(node)) {
            const n = node.querySelectorAll ? node.querySelectorAll('img').length : 0;
            if (n >= 2) return n <= 30 ? node : null;   // 再多就是整个信息流，不能当一条微博
        }
        return null;
    }

    function textOf(node) {
        return node ? cleanText(node.innerText || node.textContent).slice(0, 200) : '';
    }

    // 九宫格容器自己没有文字，正文在上层那条微博里
    function postText(card) {
        const own = textOf(card);
        if (own.length >= 8) return own;
        let node = parentOf(card);
        for (let i = 0; node && node !== document.body && i < 8; i++, node = parentOf(node)) {
            const t = textOf(node);
            if (t.length < 8) continue;
            const n = node.querySelectorAll ? node.querySelectorAll('img').length : 0;
            if (n > 40) break;
            return t;
        }
        return '';
    }

    // 这条微博的稳定 id：优先容器自己的 mid/bid 属性，其次正文里那条指向本条微博的永久链接。
    // 绝不能用图片地址当种子 —— 图是懒加载的，两轮扫描取到的第一张图会变，一条微博就被拆成两组。
    function postIdOf(card) {
        const attr = (card.getAttribute && (card.getAttribute('mid') || card.getAttribute('bid')
            || card.dataset && (card.dataset.mid || card.dataset.id))) || '';
        if (/^\w{5,}$/.test(attr)) return attr;
        for (const a of card.querySelectorAll('a[href]')) {
            const href = a.href || '';
            const m = href.match(/\/(?:status|detail|pics)\/(\w{5,})/i)
                || (weibo ? href.match(/weibo\.(?:com|cn)\/\d{5,}\/(\w{5,})/i) : null);
            if (m) return m[1];
        }
        return '';
    }

    function postOf(card, author) {
        const text = postText(card);
        const sid = postIdOf(card);
        let h = 5381;
        const seed = sid || text;
        for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
        const sub = text.replace(author.label || '', ' ').replace(/\s+/g, ' ').trim().slice(0, 72);
        return { key: author.key + '#p' + (sid ? 's' + sid : 'h' + h.toString(36)), label: author.label, sub };
    }

    const cardCache = new WeakMap();
    const postCards = new Map();   // 组键 → 微博容器，用来补被折叠的九宫格图
    function infoFor(el) {
        const card = findCard(el);
        if (!card) return pageGroup;
        if (cardCache.has(card)) return cardCache.get(card) || pageGroup;
        // 微博必须一条微博一组：认不出账户名也不能整条并回「页面组」——
        // 真页面实测 12 条已挂载的微博被并成 3 组（其中一组塞了 8 张别的微博的图），
        // 用户读作「分组不对、还少图」。认不出作者时至少用这条微博自己的 uid + id/正文当分组键。
        const orphanUid = weibo ? uidOf(card) : '';
        const author = authorOf(card) || (weibo ? { key: orphanUid ? 'acct:' + orphanUid : '__anon', label: '' } : null);
        const post = author ? postOf(card, author) : null;
        cardCache.set(card, post);
        return post || pageGroup;
    }

    const seen = new Set();
    const items = [];
    let truncated = false;

    // 元素在文档里的位置：信息流按这个排序，也用来识别「虚拟列表甩到画布外的回收节点」。
    // 微博会把看过的帖子整条搬到 top:-10088 这类位置留着复用，它的图仍在 DOM 里、尺寸也正常，
    // 不挡掉就会出现「面板里全是我现在看不到的图」。文档坐标是负得离谱的，跟正常往上滚过的位置不同：
    // 正常滚过的帖子 docTop 仍是正数。
    function docTop(el) {
        try {
            const r = el.getBoundingClientRect();
            let top = r.top;
            // 信息流不一定挂在窗口滚动上：x.com 这类是内层容器自己滚，
            // 只加 window.scrollY 会把「在容器里滚过去的帖子」算成大负数、当成回收节点误杀，
            // 所以把各级可滚动祖先的 scrollTop 一起累加回文档坐标
            let node = parentOf(el), hops = 0;
            while (node && node !== document.body && hops++ < 24) {
                if (node.scrollTop > 0) {
                    let scrollable = false;
                    try {
                        const s = getComputedStyle(node);
                        scrollable = /auto|scroll|hidden/.test(s.overflowY);
                    } catch (e) { scrollable = true; }
                    if (scrollable) top += node.scrollTop;
                }
                node = parentOf(node);
            }
            return top + (window.scrollY || document.documentElement.scrollTop || 0);
        } catch (e) { return 0; }
    }

    function pushItem(el, url, thumb, width, height, kind, alt, y) {
        if (!url || items.length >= max) { if (items.length >= max) { truncated = true; note(el, 'cap'); } return false; }
        url = largeUrl(url);
        thumb = thumb || url;
        const dkey = dedupeKey(url);
        // 去重只能按组去：转发微博会原样复用同一批 pid，全局去重会把第二条微博的图吃掉
        // （真页面实测 7 张 dupe），用户读作「这条微博少了几张图」
        const info = infoFor(el);
        const key = info.key + '|' + dkey;
        if (seen.has(key)) { note(el, 'dupe', { url: url.replace(/^https?:\/\/[^/]+/, '').slice(0, 46) }); return false; }
        seen.add(key);
        items.push({
            url, thumb: thumb || url,
            // 卡片/大图各用自己的档位：卡片拉 41KB 的 mw690，查看器拉 283KB 的 mw2000，
            // 只有发给 ComfyUI 才用 4MB 的 large
            card: tierUrl(url, 'card'), full: tierUrl(url, 'full'),
            y: Math.round(y || 0),
            width: Math.round(width) || 0, height: Math.round(height) || 0,
            kind: kind || 'image', alt: cleanText(alt).slice(0, 120),
            pageUrl, groupKey: info.key, groupLabel: info.label, groupSub: info.sub || '',
        });
        if (weibo && !postCards.has(info.key)) {
            const card = findCard(el);
            if (card) postCards.set(info.key, card);
        }
        return true;
    }

    // 开放 shadow root 里的图片也要收（普通 document.images 看不到）
    const imageEls = [];
    const seenRoots = new Set();
    const scanImages = (root, depth) => {
        if (!root || seenRoots.has(root)) return;
        seenRoots.add(root);
        for (const img of root.querySelectorAll('img')) imageEls.push(img);
        if (depth >= 3) return;
        let shadows = 0;
        for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) {
                scanImages(el.shadowRoot, depth + 1);
                if (++shadows >= 300) break;
            }
        }
    };
    scanImages(document, 0);

    for (const img of imageEls) {
        if (items.length >= max) { truncated = true; break; }
        const rect = img.getBoundingClientRect();
        const y = docTop(img);
        const sz = dbg ? { w: Math.round(rect.width), h: Math.round(rect.height), nw: img.naturalWidth, nh: img.naturalHeight } : null;
        if (y < -800) { note(img, 'off-canvas-stash', sz); continue; }
        const attrW = parseFloat(img.getAttribute('width')) || 0;
        const attrH = parseFloat(img.getAttribute('height')) || 0;
        // 只有「根本没渲染出尺寸」的图（懒加载还没解码、content-visibility 跳过渲染、布局塌成 0×0）
        // 才允许退到 naturalWidth 或标签属性；渲染出来就是 20×14 的一律当角标/图标挡掉 —— 
        // 真页面实测被 minDisplay 挡下的样本全是头像、角标和表情，没有一张是内容图，不能往松了改。
        const rendered = rect.width >= 2 && rect.height >= 2;
        const dw = rendered ? rect.width : (img.naturalWidth || attrW);
        const dh = rendered ? rect.height : (img.naturalHeight || attrH);
        if (dw < 2 || dh < 2) { note(img, 'no-size', sz); continue; }
        if (dw < minDisplay || dh < minDisplay) { note(img, 'display-small', sz); keepJunk(img, y, 'display-small'); continue; }
        if (!styleVisible(img)) { note(img, hiddenWhy(img), sz); keepJunk(img, y, 'hidden'); continue; }
        if (img.naturalWidth && img.naturalHeight
            && (img.naturalWidth < minNatural || img.naturalHeight < minNatural)
            && (dw < 120 || dh < 120)) { note(img, 'source-small', sz); keepJunk(img, y, 'source-small'); continue; }
        // 分隔条/横幅按「又扁又窄边」判，不能只看比例：微博长图的比例能到 10+，短边仍有 690px
        const ratio = Math.max(dw / dh, dh / dw);
        if (ratio > 8 && Math.min(dw, dh) < 120) { note(img, 'banner-ratio', sz); keepJunk(img, y, 'banner-ratio'); continue; }
        const url = bestUrlFor(img);
        if (!url || isJunk(url, img.alt)) { note(img, url ? 'junk-url' : 'no-url', sz); if (url) keepJunk(img, y, 'junk-url'); continue; }
        // data: 的 1×1 占位图常在未解码的懒加载标签上（尺寸是从属性里读来的），
        // 它不是能重新取字节的内容图 —— 没解码成功就一律不收
        if (/^data:image\//i.test(url) && !(img.naturalWidth > 2 && img.naturalHeight > 2)) { note(img, 'placeholder-data', sz); continue; }
        const rawThumb = absolute(img.currentSrc || img.getAttribute('src') || '');
        const placeholder = /^data:image\/(?:gif|png);base64,R0lGODlhAQAB/i.test(rawThumb)
            || (img.naturalWidth > 0 && img.naturalWidth <= 2 && img.naturalHeight <= 2);
        const thumb = rawThumb && !placeholder && !/^blob:/i.test(rawThumb) ? rawThumb : url;
        pushItem(img, url, thumb, img.naturalWidth || dw, img.naturalHeight || dh, 'image', img.alt, y);
    }

    // background-image 容器：x.com 这类「容器画图 + 隐形占位 img」也能进本页图片列表。
    if (items.length < max) {
        let scanned = 0;
        const candidates = document.querySelectorAll('[style*="background-image"],[class*="photo"],[class*="Photo"],[class*="image"],[class*="Image"],[class*="pic"],[class*="Pic"]');
        for (const el of candidates) {
            if (items.length >= max) { truncated = true; break; }
            if (++scanned > 1500) break;
            const rect = el.getBoundingClientRect();
            if (rect.width < 120 || rect.height < 120) continue;
            const y = docTop(el);
            if (y < -800) continue;
            if (!styleVisible(el)) continue;
            const inner = el.querySelector('img, video');
            if (inner && styleVisible(inner)) continue;
            let bg = '';
            try { bg = getComputedStyle(el).backgroundImage || ''; } catch (e) { bg = ''; }
            if (!bg || bg === 'none') continue;
            const m = /url\((['"]?)(.*?)\1\)/i.exec(bg);
            if (!m) continue;
            const url = absolute(m[2]);
            if (!url || (!/^https?:/i.test(url) && !/^data:image\//i.test(url))) continue;
            if (/^data:image\/svg/i.test(url)) continue;
            if (isJunk(largeUrl(url), '')) continue;
            pushItem(el, url, '', rect.width, rect.height, 'bg', el.getAttribute('aria-label') || '', y);
        }
    }

    const groupMap = new Map();
    for (const it of items) {
        let g = groupMap.get(it.groupKey);
        if (!g) {
            g = { key: it.groupKey, label: it.groupLabel, sub: it.groupSub || '', y: it.y, items: [] };
            groupMap.set(it.groupKey, g);
        } else if (it.y < g.y) g.y = it.y;
        g.items.push({
            url: it.url, thumb: it.thumb, card: it.card, full: it.full, y: it.y,
            width: it.width, height: it.height,
            kind: it.kind, alt: it.alt, pageUrl: it.pageUrl,
        });
    }

    // 九宫格被折叠的图（角标「+6」= 一共 15 张，DOM 里只有 9 张）必须问微博自己的接口：
    // /ajax/statuses/show?id=<bid> 就是页面自己用的那条，同源带 cookie，返回 pic_ids + pic_infos。
    // 真页面实测：一条「+6」的微博接口回 15 张、DOM 只有 9 张 —— 不补就是"少了一大堆"。
    let enriched = 0;
    if (weibo && typeof fetch === 'function' && postCards.size) {
        let asked = 0;
        for (const [key, card] of postCards) {
            if (asked >= 6 || items.length >= max) break;
            const mark = card.querySelector('[class*="_picNum_"], [class*="picNum"]');
            if (!mark) continue;
            const bid = postIdOf(card);
            const g = groupMap.get(key);
            if (!bid || !g) continue;
            asked++;
            try {
                const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
                const timer = ctrl ? setTimeout(() => ctrl.abort(), 1800) : 0;
                const res = await fetch('/ajax/statuses/show?id=' + encodeURIComponent(bid), {
                    credentials: 'include', signal: ctrl ? ctrl.signal : undefined,
                });
                if (timer) clearTimeout(timer);
                if (!res || !res.ok) continue;
                const j = await res.json();
                const ids = Array.isArray(j.pic_ids) ? j.pic_ids : [];
                const infos = j.pic_infos || {};
                const y = Math.round(docTop(card));
                for (const pid of ids) {
                    if (items.length >= max) break;
                    const info = infos[pid] || {};
                    const raw = (info.large && info.large.url) || (info.mw2000 && info.mw2000.url) || '';
                    if (!raw) continue;
                    const u = largeUrl(raw);
                    const dk = key + '|' + dedupeKey(u);
                    if (seen.has(dk)) continue;
                    seen.add(dk);
                    const it = {
                        url: u, thumb: u, card: tierUrl(u, 'card'), full: tierUrl(u, 'full'),
                        y, width: (info.large && info.large.width) | 0, height: (info.large && info.large.height) | 0,
                        kind: 'image', alt: '', pageUrl,
                    };
                    items.push({ ...it, groupKey: key, groupLabel: g.label, groupSub: g.sub || '' });
                    g.items.push(it);
                    enriched++;
                }
            } catch (e) { /* 接口抽风就算了，不影响主扫描 */ }
        }
    }

    // 面板顺序 = 信息流顺序（从上往下），否则用户看到的是乱序的「别的页面的图」；
    // 「无用图片」永远排最后，且默认折叠
    const groups = [...groupMap.values()].sort((a, b) => a.y - b.y);
    if (junkItems.length) {
        const jy = junkItems.reduce((m, i) => Math.min(m, i.y), Infinity);
        groups.push({ key: '__junk', label: '无用图片', sub: '', y: Number.isFinite(jy) ? jy : 0, items: junkItems, junk: true });
    }

    return {
        pageUrl, pageTitle, host, weibo,
        // 面板「只看屏幕附近」要用扫描那一刻的视口位置（文档坐标）
        view: { y: Math.round(window.scrollY || document.documentElement.scrollTop || 0), h: Math.round(window.innerHeight || 0) },
        total: items.length, truncated,
        junk: junkItems.length, enriched,
        dropped: Object.keys(dropHist).reduce((n, k) => n + dropHist[k], 0), dropHist,
        skipped: dbg || null,
        groups,
    };
}

