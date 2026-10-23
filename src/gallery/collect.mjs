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
        // 被微博筛选隐藏的整条微博：页面上已经当它没发过，面板里也不许出现它的图
        if (img.closest('[data-mtb-filtered="1"]')) { note(img, 'filtered-post', sz); continue; }
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
            if (el.closest('[data-mtb-filtered="1"]')) continue;
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

// 注入到页面**主世界**执行：把微博自己那份信息流数据里的图片捞出来（只读，绝不改页面数据）。
// 为什么必须问数据而不是扫 DOM：桌面版信息流是虚拟列表，屏幕上下各留几条，滚过去的帖子整条被摘掉，
// 光扫 DOM 就永远拿不到那些图；而列表里每条都自带 pic_ids/pic_infos（含各档地址和真实宽高），
// 一次就能把这个页面已经加载出来的所有微博的图全捞出来。
// 这个函数会被序列化后执行，必须完全自包含；找列表的那段判定与 background 里 weiboFilterPage 同源。
export function weiboFeedPage(arg) {
    const opt = arg || {};
    try {
        const maxPosts = Math.max(1, Math.min(500, Number(opt.max) || 300));
        const strip = (h) => String(h == null ? '' : h).replace(/<[^>]+>/g, '');
        const flat = (s) => strip(s).replace(/\s+/g, ' ').trim();

        const findList = () => {
            const appEl = document.querySelector('#app');
            const root = appEl && appEl._vnode && appEl._vnode.component;
            if (!root) return null;
            // 单页应用切页后旧组件仍挂在 Vue 树里，所以优先挑「页面里已渲染帖子能找到」且「组件可见」的那份
            let rendered = '';
            try {
                rendered = [...document.querySelectorAll('article')].map((a) => String(a.textContent || '').replace(/\s+/g, '')).join('|').slice(0, 30000);
            } catch (e) { rendered = ''; }
            const keyOf = (it) => String((it && (it.mid || it.idstr || it.id)) || '');
            const seen = new Set();
            let best = null;
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

        // 被微博筛选挡掉的帖子在页面上就是「没发过」，面板里也不许把它的数据捞回来。
        // 条目里没有 DOM 身份可对，只能拿正文当前缀去认（和上面挑列表同一套指纹办法）
        let hiddenText = '';
        try {
            hiddenText = [...document.querySelectorAll('[data-mtb-filtered="1"]')]
                .map((a) => String(a.textContent || '').replace(/\s+/g, '')).join('|');
        } catch (e) { hiddenText = ''; }
        const isHidden = (t) => {
            if (!hiddenText) return false;
            const k = String(t || '').replace(/\s+/g, '').slice(0, 12);
            return k.length >= 6 && hiddenText.indexOf(k) >= 0;
        };

        const hasPics = (src) => {
            if (!src || typeof src !== 'object') return false;
            try {
                if (Array.isArray(src.pic_ids) && src.pic_ids.length) return true;
                const infos = src.pic_infos;
                return !!(infos && typeof infos === 'object' && Object.keys(infos).length);
            } catch (e) { return false; }
        };

        const list = findList();
        if (!list) return { ok: false, error: '没找到微博信息流数组' };
        const posts = [];
        for (let i = 0; i < list.length && posts.length < maxPosts; i++) {
            let it;
            try { it = list[i]; } catch (e) { continue; }
            if (!it || typeof it !== 'object') continue;
            let rt = null;
            try { rt = it.retweeted_status && typeof it.retweeted_status === 'object' ? it.retweeted_status : null; } catch (e) { rt = null; }
            // 只把「有没有图」的判断留在这里（省得把一堆纯文字帖子搬出去），
            // 「一条微博有哪些图」一律由 src/common/gallery.js 的 weiboStatusToPost 映射，别在页面里再写一份
            if (!hasPics(it) && !hasPics(rt)) continue;
            const text = flat(it.text || it.longText || (rt && rt.text) || '');
            if (isHidden(text.replace(/ /g, ''))) continue;
            let user = {};
            try { user = { id: (it.user && it.user.id) || '', uid: (it.user && it.user.uid) || '', screen_name: (it.user && it.user.screen_name) || '' }; } catch (e) { user = {}; }
            const slim = (src) => {
                if (!src || typeof src !== 'object') return null;
                let ids = [];
                let infos = {};
                try {
                    ids = Array.isArray(src.pic_ids) ? src.pic_ids.slice() : [];
                    infos = src.pic_infos || {};
                } catch (e) { return null; }
                const keep = {};
                for (const pid of (ids.length ? ids : Object.keys(infos))) {
                    const info = infos[pid];
                    if (!info || typeof info !== 'object') continue;
                    const big = info.large || info.mw2000 || {};
                    keep[pid] = { large: { url: big.url || big.latest_url || '', width: big.width, height: big.height } };
                }
                return { pic_ids: ids, pic_infos: keep };
            };
            const mine = slim(it);
            const theirs = slim(rt);
            posts.push({
                index: i,
                mid: it.mid, bid: it.bid, mblogid: it.mblogid, idstr: it.idstr, id: it.id,
                text: it.text || it.longText || '',
                user,
                pic_ids: (mine && mine.pic_ids) || [],
                pic_infos: (mine && mine.pic_infos) || {},
                retweeted_status: theirs ? { pic_ids: theirs.pic_ids, pic_infos: theirs.pic_infos } : (rt ? {} : null),
            });
        }
        return { ok: true, total: list.length, posts };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e || '').slice(0, 160) };
    }
}

// 注入到页面主世界执行：替用户「翻页」。两条路，先温和后直接：
// ① 调微博组件自己的 loadMoreData（Home 组件上就有）—— 这是它正常加载下一页的同一条代码路径，
//    列表真的变长、视口一动不动，也不会出现我们和它的分页状态各说各话；
// ② 拿不到那个方法时，克隆页面自己已经发过的那条信息流请求（从 performance 里取，不猜接口名），
//    带上 Home 的 max_id 游标直接向后端要后面几页 —— 完全不碰页面。
// 两条都绝不滚动页面，也不发任何写操作（只有 GET 读流）。
export async function weiboLoadMorePages(arg) {
    const opt = arg || {};
    const maxPages = Math.max(1, Math.min(10, Number(opt.pages) || 3));
    const waitMs = Math.max(1500, Math.min(12000, Number(opt.waitMs) || 7000));
    const out = { ok: false, route: '', before: 0, after: 0, added: 0, pages: 0, stopped: '', error: '', detail: '', fallback: false, statuses: [] };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visibleOf = (inst) => {
        try {
            const el = inst && inst.subTree && inst.subTree.el;
            if (!el || el.nodeType !== 1 || !el.isConnected) return 0;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
            const r = el.getBoundingClientRect();
            return (r.width > 0 || r.height > 0) ? 1 : 0;
        } catch (e) { return 0; }
    };
    // 认「哪个组件手里有信息流」不能只认分组页那一种形状：
    //   分组页 = Home 组件的 data.list + max_id_str（接口按游标翻）
    //   个人主页 = ProfileFeed 组件的 data.data + page（接口按页码翻，返回体是 data.list）
    // 分组页还会给每个标签页各留一份 Home，先遍历到的那份可能内部状态是空的（一调就抛），
    // 所以候选要全收下来（可见的、更长的排前面）逐个试。
    const looksLikeStatuses = (v) => {
        if (!Array.isArray(v) || !v.length) return false;
        let f = null;
        try { f = v[0]; } catch (e) { return false; }
        if (!f || typeof f !== 'object') return false;
        return ('mid' in f || 'idstr' in f || 'mblogid' in f)
            && ('user' in f || 'text' in f || 'pic_ids' in f || 'created_at' in f);
    };
    const findFeeds = () => {
        try {
            const appEl = document.querySelector('#app');
            const root = appEl && appEl._vnode && appEl._vnode.component;
            if (!root) return [];
            const seen = new Set();
            const hits = [];
            const visit = (vn, d) => {
                if (!vn || d > 40) return;
                if (vn.component) walk(vn.component, d + 1);
                if (Array.isArray(vn.children)) vn.children.forEach((c) => visit(c, d + 1));
            };
            const walk = (inst, d) => {
                if (!inst || seen.has(inst) || d > 40) return;
                seen.add(inst);
                let data = null;
                try { data = inst.data; } catch (e) { }
                if (data && typeof data === 'object') {
                    let keys = [];
                    try { keys = Object.keys(data); } catch (e) { keys = []; }
                    for (const k of keys) {
                        let v = null;
                        try { v = data[k]; } catch (e) { continue; }
                        if (!looksLikeStatuses(v)) continue;
                        hits.push({ inst, data, key: k, list: v, len: v.length, visible: visibleOf(inst) });
                    }
                }
                visit(inst.subTree, 0);
            };
            walk(root, 0);
            hits.sort((a, b) => b.visible - a.visible || b.len - a.len);
            return hits;
        } catch (e) { return []; }
    };
    const noMoreOf = (data) => {
        try { return data.isNoData === true || data.isOver === true || data.isEnd === true; } catch (e) { return false; }
    };
    // 有的组件是原地 push 数组，有的是整个换掉（`data.data = [...旧, ...新]`）——
    // 攥着旧引用永远看不到变长，所以长度每次都从组件的 data 上重新读
    const lenOf = (c) => {
        try { const v = c.data[c.key]; return Array.isArray(v) ? v.length : c.len; } catch (e) { return c.len; }
    };
    const listOf = (c) => {
        try { const v = c.data[c.key]; return Array.isArray(v) ? v : []; } catch (e) { return []; }
    };
    const idOf = (s) => { try { return String((s && (s.mid || s.idstr || s.id)) || ''); } catch (e) { return ''; } };
    // 页面里发过的请求太多，先按形状筛出「读流接口」：带 page/list_id/containerid 的优先，其次新发的在前
    const FEED_URL_SKIP = /config|getTipsAd|allGroups|unreadHint|detectVideoCodec|copyright|getNavConfig|\/side|sidedetail|profile\/info|profile\/detail|multimedia|\/log\/|getLiveInfo|search\/emoticon/i;
    const feedUrls = () => {
        const rows = [];
        try {
            for (const e of performance.getEntriesByType('resource')) {
                const n = String((e && e.name) || '');
                if (!/\/ajax\/(?:feed|statuses|profile)\/[a-z0-9_]+/i.test(n)) continue;
                if (FEED_URL_SKIP.test(n)) continue;
                rows.push({ n, t: (e && e.startTime) || 0, paged: /[?&](?:page|max_id|since_id|containerid|list_id)=/i.test(n) ? 1 : 0 });
            }
        } catch (e) { return []; }
        rows.sort((a, b) => b.paged - a.paged || b.t - a.t);
        return rows.map((r) => r.n);
    };
    const parseList = (json) => {
        try {
            const data = (json && json.data) || json || {};
            if (Array.isArray(data.statuses)) return { items: data.statuses, data };
            if (Array.isArray(data.list)) return { items: data.list, data };
            if (Array.isArray(json.statuses)) return { items: json.statuses, data };
            if (Array.isArray(json.list)) return { items: json.list, data };
        } catch (e) { }
        return { items: [], data: {} };
    };

    try {
        const feeds = findFeeds();
        const best = feeds[0] || null;
        out.before = best ? lenOf(best) : 0;
        let winner = null;
        const tried = [];
        for (const c of feeds) {
            let fn = null;
            try { fn = c.inst.ctx && typeof c.inst.ctx.loadMoreData === 'function' ? c.inst.ctx.loadMoreData : null; } catch (e) { fn = null; }
            if (!fn) continue;
            const len = lenOf(c);
            try {
                const r = fn.call(c.inst.ctx);
                if (r && typeof r.then === 'function') await Promise.race([r, sleep(waitMs)]);
            } catch (e) { tried.push(String((e && e.message) || e).slice(0, 70)); continue; }
            const t0 = Date.now();
            while (lenOf(c) === len && Date.now() - t0 < waitMs) await sleep(200);
            if (lenOf(c) > len) { winner = c; out.before = len; out.pages = 1; break; }
            tried.push('这一页没加载出来');
        }
        if (winner) {
            out.route = 'component';
            for (let i = out.pages; i < maxPages; i++) {
                if (noMoreOf(winner.data)) { out.stopped = '没有更多了'; break; }
                const len = lenOf(winner);
                try {
                    const r = winner.inst.ctx.loadMoreData.call(winner.inst.ctx);
                    if (r && typeof r.then === 'function') await Promise.race([r, sleep(waitMs)]);
                } catch (e) {
                    out.stopped = '微博自己的翻页中途出错了';
                    out.detail = String((e && e.message) || e).slice(0, 120);
                    break;
                }
                const t0 = Date.now();
                while (lenOf(winner) === len && Date.now() - t0 < waitMs) await sleep(200);
                if (lenOf(winner) === len) { out.stopped = '第 ' + (i + 1) + ' 页没加载出来'; break; }
                out.pages++;
                await sleep(400);
            }
            out.after = lenOf(winner);
            out.added = out.after - out.before;
            out.ok = out.added > 0;
            if (out.ok) return out;
        }
        if (!out.ok) out.detail = tried.join('；').slice(0, 200);

        // ②：克隆页面自己发过的那条读流请求（组件翻页没走通、或那个组件根本没有方法时走这里）。
        // 一条 URL 拿不到东西就换下一条试（个人主页/超话页的接口名和参数都不一样），最多试 3 条
        const seenId = new Set();
        for (const f of feeds) {
            try { for (const it of listOf(f)) { const k = idOf(it); if (k) seenId.add(k); } } catch (e) { }
        }
        const urls = feedUrls();
        if (!urls.length) { out.error = out.detail || '页面里没有可克隆的信息流请求'; out.detail = ''; return out; }
        out.route = 'fetch';
        out.fallback = winner != null || tried.length > 0;
        let cursorOf = '';
        try { cursorOf = best ? String(best.data.max_id_str || best.data.max_id || '') : ''; } catch (e) { cursorOf = ''; }
        let pageFrom = 0;
        try { pageFrom = best && best.data.page ? (parseInt(best.data.page, 10) || 0) : 0; } catch (e) { pageFrom = 0; }
        for (let k = 0; k < urls.length && k < 3 && !out.ok; k++) {
            let u = null;
            try { u = new URL(urls[k], location.href); } catch (e) { continue; }
            u.searchParams.delete('refresh');
            u.searchParams.delete('fast_refresh');
            const byPage = u.searchParams.has('page');
            if (byPage) {
                let start = (parseInt(u.searchParams.get('page'), 10) || 1);
                if (pageFrom > start) start = pageFrom;
                u.searchParams.set('page', String(start));
            } else if (cursorOf) {
                u.searchParams.set('max_id', cursorOf);
            }
            let pages = 0;
            let requests = 0;
            let lastError = '';
            while (pages < maxPages && requests < maxPages * 2 + 2) {
                requests++;
                let json = null;
                try {
                    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
                    const timer = ctrl ? setTimeout(() => ctrl.abort(), waitMs) : 0;
                    const res = await fetch(u.href, {
                        credentials: 'include', signal: ctrl ? ctrl.signal : undefined,
                        headers: { 'x-requested-with': 'XMLHttpRequest' },
                    });
                    if (timer) clearTimeout(timer);
                    if (!res || !res.ok) { lastError = '接口回了 HTTP ' + ((res && res.status) || 0); break; }
                    json = await res.json();
                } catch (e) { lastError = '向微博要下一页失败了'; out.detail = String((e && e.message) || e).slice(0, 120); break; }
                const parsed = parseList(json);
                if (!parsed.items.length) { lastError = lastError || '这一页是空的'; break; }
                let fresh = 0;
                for (const s of parsed.items) {
                    const id = idOf(s);
                    if (id && seenId.has(id)) continue;
                    if (id) seenId.add(id);
                    out.statuses.push(s);
                    fresh++;
                }
                if (fresh) pages++;
                out.pages = Math.max(out.pages, pages);
                if (byPage) {
                    let cur = parseInt(u.searchParams.get('page'), 10) || 1;
                    u.searchParams.set('page', String(cur + 1));
                } else {
                    let next = '';
                    try { next = String(parsed.data.max_id_str || parsed.data.max_id || json.max_id_str || json.max_id || ''); } catch (e) { next = ''; }
                    if (!next || next === String(u.searchParams.get('max_id') || '')) { lastError = '没有更多了'; break; }
                    u.searchParams.set('max_id', next);
                }
                if (!fresh && pages === 0 && requests >= 2) { lastError = '后面几页都是重复的'; break; }
                await sleep(400);
            }
            out.ok = out.statuses.length > 0;
            if (!out.ok && lastError) out.stopped = lastError;
        }
        out.added = out.statuses.length;
        out.ok = out.statuses.length > 0;
        return out;
    } catch (e) {
        out.error = String((e && e.message) || e || '').slice(0, 140);
        return out;
    }
}

