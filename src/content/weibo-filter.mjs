// 微博信息流筛选：不满足条件的微博整条 display:none。
//
// 已知限制（2026-10-21 真页面踩过）：帖子是绝对定位的虚拟列表
//   article.woo-panel-main → div.wbpro-scroller-item → div.vue-recycle-scroller__item-view（transform: translateY(…px)）
// 槽位坐标由 scroller 自己按累计高度算，只藏 article 会在原位置留一段空白（页面底色，看起来像"一块黑"）。
// 试过「连槽隐藏 + 把后面的槽上移」：scroller 会不停用原始 translateY 覆盖回来，滚动时整页闪、甚至堆到顶部全黑，
// 属于和虚拟列表的内部状态对打，已回退。所以现在只藏 article，空白保留 —— 稳定优先。

import { matchWeiboFilter, normalizeWeiboFilter, describeWeiboFilter, filterAppliesTo } from '../common/weibo-filter.js';

const POST_SEL = 'article, .card-wrap';
const HIDDEN_ATTR = 'data-mtb-filtered';

export function isWeiboHost(host = location.hostname) {
    return /(^|\.)weibo\.(com|cn)$/i.test(String(host || ''));
}

function hostOf(u) {
    try { return new URL(u, location.href).hostname; } catch (e) { return ''; }
}

// 头像/表情/图标不算「有图片」：内容图才有资格满足筛选条件
function isContentImage(img) {
    const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
    if (!src || /^data:image\/svg/i.test(src)) return false;
    const host = hostOf(src);
    if (/^tva\d*\.sinaimg\.cn$/i.test(host) || /^tvax\d*\.sinaimg\.cn$/i.test(host)) return false;
    if (/\/crop\./i.test(src)) return false;
    if (/face\.t\.sinajs\.cn/i.test(src)) return false;
    if (/avatar|emoji|icon/i.test(String(img.className || ''))) return false;
    const r = img.getBoundingClientRect();
    const w = Math.max(r.width, img.naturalWidth || 0, parseFloat(img.getAttribute('width')) || 0);
    const h = Math.max(r.height, img.naturalHeight || 0, parseFloat(img.getAttribute('height')) || 0);
    if (w && h && Math.min(w, h) >= 60) return true;
    return !!img.closest('[class*="picture"],[class*="Picture"],[class*="photo"],[class*="Photo"]');
}

function hasVideo(el) {
    if (el.querySelector('video')) return true;
    if (el.querySelector('[class*="videoBox"],[class*="video"],[class*="Video"],[class*="player"],[class*="Player"]')) return true;
    return !!el.querySelector('a[href*="/tv/"]');
}

function hasMusic(el) {
    if (el.querySelector('audio,[class*="music"],[class*="Music"],[class*="audio"],[class*="Audio"]')) return true;
    return /分享歌曲|网易云音乐|QQ音乐|酷狗音乐|音乐推荐/.test(el.textContent || '');
}

// 转发：真页面是容器带「独立的 retweet 类」+ 正文 `wbpro-feed-reText`（2026-10-21 实测：
// `retweet _retweet_ecgcn_86` / `_text_1h76l_2 _reText_1h76l_48 wbpro-feed-reText`）。
// 两个坑都踩过：① 不能用正文里的「转发」两个字——那是底部按钮文案，每条微博都有；
// ② 不能用 [class*="retweet"]——底部转发图标的类名是 `woo-font woo-font--retweet _retweetIcon_198pe_119`，
// 每条原创都带，会把全站判成转发。所以只认独立类名 `.retweet` 和带下划线的 `_reText_`。
function isRepost(el) {
    return !!el.querySelector('.retweet, [class*="wbpro-feed-reText"], [class*="_reText_"]');
}

// 发布时间：真页面的 _time_ 链接带 title="2026-10-21 08:55"（绝对时间，最可靠）；
// 没有就退回从「3分钟前 / 今天 12:30 / 10-18 / 2025-12-01」这类文案里猜。
function postDate(el) {
    const t = el.querySelector('[class*="_time_"],[class*="_time"]');
    const title = t && (t.getAttribute('title') || '');
    const m = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(title);
    if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    const text = t ? String(t.textContent || '').trim() : '';
    const pad = (x) => String(x).padStart(2, '0');
    const now = new Date();
    const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    let mm;
    if ((mm = /(\d{4})[-年/](\d{1,2})[-月/](\d{1,2})/.exec(text))) return `${mm[1]}-${pad(mm[2])}-${pad(mm[3])}`;
    if ((mm = /^(\d{1,2})[-月](\d{1,2})/.exec(text))) return `${now.getFullYear()}-${pad(mm[1])}-${pad(mm[2])}`;
    if (/刚刚|秒前/.test(text)) return ymd(now);
    if ((mm = /(\d+)\s*分钟前/.exec(text))) return ymd(new Date(now - mm[1] * 60000));
    if ((mm = /(\d+)\s*小时前/.exec(text))) return ymd(new Date(now - mm[1] * 3600000));
    if (/昨天/.test(text)) return ymd(new Date(now - 86400000));
    if (/今天/.test(text)) return ymd(now);
    return '';
}

function postInfoOf(el) {
    let hasImage = false;
    for (const img of el.querySelectorAll('img')) {
        if (isContentImage(img)) { hasImage = true; break; }
    }
    return {
        repost: isRepost(el),
        hasImage,
        hasVideo: hasVideo(el),
        hasMusic: hasMusic(el),
        text: el.textContent || '',
        date: postDate(el),
    };
}

function signatureOf(info, fp) {
    const text = String(info.text || '').replace(/\s+/g, ' ').trim();
    return `${fp}|${info.repost ? 1 : 0}${info.hasImage ? 1 : 0}${info.hasVideo ? 1 : 0}${info.hasMusic ? 1 : 0}|${info.date}|${text.length}|${text.slice(0, 26)}|${text.slice(-18)}`;
}

function postsOf(root) {
    const all = [...root.querySelectorAll(POST_SEL)];
    return all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
}

function fingerprint(f) {
    const t = f.types || {};
    return [f.enabled ? 1 : 0, f.site, f.allSites ? 1 : 0, ['original', 'repost', 'text', 'image', 'video', 'music'].map((k) => (t[k] === false ? 0 : 1)).join(''), f.keywordMode, f.keywords.join('|'), f.dateFrom, f.dateTo].join('~');
}

// 非实验模式：被隐藏的帖子就在 DOM 里，照着原帖把头像/正文/图片/转发尽量带出来
function domHiddenItems() {
    const out = [];
    for (const el of postsOf(document)) {
        if (el.getAttribute(HIDDEN_ATTR) !== '1') continue;
        const links = [...el.querySelectorAll('header a')];
        const name = links.find((a) => /_name_|_bolder_|_link_/.test(String(a.className)) && (a.textContent || '').trim());
        const time = el.querySelector('[class*="_time_"]');
        const avatar = el.querySelector('header img');
        const pics = [...el.querySelectorAll('img')]
            .map((img) => img.currentSrc || img.src || '')
            .filter((src) => src && /sinaimg/i.test(src) && !/tva\d*\.|\/crop\.|avatar|emoji/i.test(src))
            .slice(0, 4);
        const coverImg = el.querySelector('[class*="videoBox"] img, [class*="video"] img');
        const rtEl = el.querySelector('[class*="reText"], [class*="retweet"]');
        const body = el.querySelector('[class*="ogText"], p') || el;
        out.push({
            name: name ? name.textContent.trim() : '',
            avatar: avatar ? (avatar.currentSrc || avatar.src || '') : '',
            date: time ? (time.getAttribute('title') || '') : '',
            text: (body.innerText || body.textContent || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 600),
            pics,
            cover: coverImg ? (coverImg.currentSrc || coverImg.src || '') : '',
            rtName: '',
            rtText: rtEl ? (rtEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240) : '',
            url: time && time.href ? time.href : '',
        });
        if (out.length >= 200) break;
    }
    return out;
}

function ensureChipHost() {
    let host = document.getElementById('mtb-filter-chip');
    if (host) return host.shadowRoot;
    host = document.createElement('div');
    host.id = 'mtb-filter-chip';
    host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483646;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .box { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
        .chip {
          display: flex; align-items: center; gap: 6px; padding: 7px 10px 7px 12px; border-radius: 999px;
          background: rgba(18, 21, 28, .92); color: #e8eef8; border: 1px solid rgba(255, 255, 255, .14);
          box-shadow: 0 6px 20px rgba(0, 0, 0, .35); font: 12px/1.4 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
          pointer-events: auto; backdrop-filter: blur(8px); cursor: pointer; user-select: none;
        }
        .chip[hidden] { display: none; }
        .chip:hover { border-color: rgba(255, 255, 255, .3); }
        .caret { color: #9fb0c7; font-size: 10px; }
        .x { all: unset; cursor: pointer; width: 18px; height: 18px; border-radius: 50%; text-align: center; line-height: 18px; color: #9fb0c7; }
        .x:hover { background: rgba(255, 255, 255, .12); color: #fff; }
        .list {
          pointer-events: auto; width: 360px; max-width: calc(100vw - 40px); max-height: 55vh; overflow: auto;
          background: rgba(18, 21, 28, .97); color: #e8eef8; border: 1px solid rgba(255, 255, 255, .14);
          border-radius: 12px; box-shadow: 0 10px 32px rgba(0, 0, 0, .45);
          font: 12px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        }
        .list[hidden] { display: none; }
        .lh { position: sticky; top: 0; padding: 8px 12px; color: #9fb0c7; background: rgba(18, 21, 28, .98);
          border-bottom: 1px solid rgba(255, 255, 255, .08); }
        .lh b { color: #e8eef8; font-weight: 600; }
        a.card { display: block; padding: 10px 12px; color: inherit; text-decoration: none; border-bottom: 1px solid rgba(255, 255, 255, .06); }
        div.card { display: block; padding: 10px 12px; border-bottom: 1px solid rgba(255, 255, 255, .06); }
        a.card:hover { background: rgba(255, 255, 255, .055); }
        .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
        .av { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; flex: none; background: #222; }
        .who { min-width: 0; }
        .name { color: #cfe0f5; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .meta { color: #8b97a8; font-size: 11px; }
        .txt { color: #dbe6f6; word-break: break-word; white-space: pre-wrap;
          display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden; }
        .rt { margin-top: 6px; padding: 6px 8px; border-radius: 8px; background: rgba(255, 255, 255, .05);
          color: #b9c6d8; font-size: 11.5px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
        .pics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-top: 7px; }
        .pics img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; border-radius: 6px; background: #000; display: block; }
        .pics.video img { grid-column: span 2; aspect-ratio: 16 / 9; }
        .empty { padding: 14px 12px; color: #8b97a8; }
      </style>
      <div class="box">
        <div class="list" hidden><div class="lh">被筛选隐藏的微博 <b class="n"></b></div><div class="rows"></div></div>
        <div class="chip" hidden><span class="t"></span><span class="caret">▾</span><button class="x" type="button" title="清除筛选（恢复显示全部微博）">✕</button></div>
      </div>`;
    document.documentElement.appendChild(host);
    return shadow;
}

export function mountWeiboFilter(settings) {
    if (!isWeiboHost()) return null;
    const shadow = ensureChipHost();
    const chip = shadow.querySelector('.chip');
    const textEl = shadow.querySelector('.t');
    const caret = shadow.querySelector('.caret');
    const listEl = shadow.querySelector('.list');
    const rowsEl = shadow.querySelector('.rows');
    const countEl = shadow.querySelector('.n');
    const state = { filter: normalizeWeiboFilter(settings && settings.weiboFilter), sigs: new WeakMap(), hidden: 0, total: 0, timer: 0, seq: 0, pageMode: false, pageError: '', hiddenItems: [], listOpen: false };

    const renderHiddenList = () => {
        rowsEl.textContent = '';
        const items = state.hiddenItems || [];
        countEl.textContent = `${items.length}${items.length >= 200 ? '+' : ''} 条`;
        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '没有可列出的微博（可能是列表模式拿不到摘要）';
            rowsEl.appendChild(empty);
            return;
        }
        for (const it of items) {
            const safeUrl = /^https?:/i.test(String(it.url || '')) ? it.url : '';
            const row = document.createElement(safeUrl ? 'a' : 'div');
            row.className = 'card';
            if (safeUrl) {
                row.href = safeUrl;
                row.target = '_blank';
                row.rel = 'noopener';
                row.title = safeUrl;
            }
            const head = document.createElement('div');
            head.className = 'head';
            if (it.avatar && /^https?:/i.test(it.avatar)) {
                const av = document.createElement('img');
                av.className = 'av';
                av.src = it.avatar;
                av.alt = '';
                av.loading = 'lazy';
                head.appendChild(av);
            }
            const who = document.createElement('div');
            who.className = 'who';
            const nm = document.createElement('div');
            nm.className = 'name';
            nm.textContent = it.name || '未识别账号';
            const mt = document.createElement('div');
            mt.className = 'meta';
            mt.textContent = it.date || it.timeText || '';
            who.append(nm, mt);
            head.appendChild(who);
            row.appendChild(head);

            const txt = document.createElement('div');
            txt.className = 'txt';
            txt.textContent = it.text || '（没有正文摘要）';
            row.appendChild(txt);

            if (it.rtText) {
                const rt = document.createElement('div');
                rt.className = 'rt';
                rt.textContent = (it.rtName ? '转发 @' + it.rtName + '：' : '转发：') + it.rtText;
                row.appendChild(rt);
            }

            const shot = (it.pics && it.pics.length) ? it.pics : (it.cover ? [it.cover] : []);
            if (shot.length) {
                const box = document.createElement('div');
                box.className = 'pics' + (it.cover && !(it.pics && it.pics.length) ? ' video' : '');
                for (const src of shot.slice(0, 4)) {
                    if (!/^https?:/i.test(src)) continue;
                    const im = document.createElement('img');
                    im.src = src;
                    im.alt = '';
                    im.loading = 'lazy';
                    box.appendChild(im);
                }
                if (box.childElementCount) row.appendChild(box);
            }
            rowsEl.appendChild(row);
        }
    };

    const setListOpen = (open) => {
        state.listOpen = !!open;
        listEl.hidden = !state.listOpen;
        caret.textContent = state.listOpen ? '▴' : '▾';
        if (state.listOpen) renderHiddenList();
    };
    chip.addEventListener('click', (e) => {
        if (e.target && e.target.classList && e.target.classList.contains('x')) return;
        e.preventDefault();
        setListOpen(!state.listOpen);
    });

    const clearFilter = () => {
        try {
            chrome.runtime.sendMessage({ action: 'patchSettings', patch: { weiboFilter: { enabled: false } } })
                .catch(() => { /* 扩展刚重载时忽略 */ });
        } catch (e) { /* 同上 */ }
    };
    shadow.querySelector('.x').addEventListener('click', clearFilter);

    // 实验模式：让后台往页面主世界注入一段代码，直接改微博自己的信息流数组（列表会自己重排、不留空位）。
    // 失败就退回「只隐藏页面元素」——那条路缩不会坏页面，只是留空位。
    const pageFilterApply = async (filter, enabled) => {
        try {
            const r = await chrome.runtime.sendMessage({ action: 'applyWeiboFilterPage', filter, enabled });
            return r || { ok: false, error: '后台没有响应' };
        } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
        }
    };

    const doApply = async () => {
        const f = state.filter;
        const active = filterAppliesTo(f, location.hostname);
        const wantExp = active && f.experimental;
        let pageRes = null;
        if (wantExp || state.pageMode) {
            pageRes = await pageFilterApply(wantExp ? f : null, wantExp);
        }
        const usePage = !!(wantExp && pageRes && pageRes.ok);
        state.pageMode = usePage;
        state.pageError = wantExp && !usePage ? String((pageRes && pageRes.error) || '实验模式不可用') : '';

        const fp = fingerprint({ ...f, enabled: active });
        let hidden = 0, total = 0;
        for (const el of postsOf(document)) {
            total++;
            const info = usePage ? null : (active ? postInfoOf(el) : null);
            const sig = info ? signatureOf(info, fp) : fp;
            if (state.sigs.get(el) === sig) { if (el.getAttribute(HIDDEN_ATTR) === '1') hidden++; continue; }
            state.sigs.set(el, sig);
            const show = !info || matchWeiboFilter(info, f);
            if (show || usePage) {
                if (el.getAttribute(HIDDEN_ATTR) === '1') {
                    el.removeAttribute(HIDDEN_ATTR);
                    el.style.removeProperty('display');
                }
            } else {
                el.setAttribute(HIDDEN_ATTR, '1');
                el.style.setProperty('display', 'none', 'important');
                hidden++;
            }
        }
        if (usePage) {
            // 列表已经不渲染被筛掉的帖子了；计数以后台那份数组为准
            hidden = Number(pageRes.hidden) || 0;
            total = Math.max(Number(pageRes.total) || 0, total);
        }
        state.hidden = hidden;
        state.total = total;
        // 下拉列表的数据：实验模式用页面主世界带回来的摘要；普通模式从被隐藏的 DOM 里现读
        state.hiddenItems = usePage
            ? (Array.isArray(pageRes.items) ? pageRes.items : [])
            : (active && hidden > 0 ? domHiddenItems() : []);
        chip.hidden = !(active && hidden > 0);
        if (chip.hidden) {
            if (state.listOpen) setListOpen(false);
        } else {
            // 全被筛掉时给一句明确的出路，别让人以为页面坏了
            textEl.textContent = hidden === total && total > 0
                ? `全部 ${total} 条都被筛掉了 · 点开查看`
                : `已隐藏 ${hidden} 条 · ${usePage ? '实验模式 · ' : ''}${describeWeiboFilter(f)}`;
            textEl.title = (usePage
                ? '实验模式：改的是微博内部列表数据，微博改版后可能失效（刷新页面即可恢复）'
                : '不满足筛选条件的微博已整条隐藏') + '；点这条可展开被隐藏的微博，✕ 可清除筛选';
            if (state.listOpen) renderHiddenList();
        }
        return { hidden, total, mode: usePage ? 'list' : 'dom', pageError: state.pageError };
    };

    // 串行执行：storage 推送和面板消息可能同时到达，并发跑会互相覆盖（状态各算各的）
    const queueApply = () => {
        const next = (state.pending || Promise.resolve()).catch(() => {}).then(doApply);
        state.pending = next;
        return next;
    };

    const schedule = () => {
        clearTimeout(state.timer);
        state.timer = setTimeout(() => { void queueApply(); }, 60);
    };

    // 虚拟列表插入新帖、回收复用节点都会走 childList
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true });
    void queueApply();

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg) return false;
        if (msg.action === 'mtbWeiboStatus') {
            sendResponse({ ok: true, hidden: state.hidden, total: state.total, applied: filterAppliesTo(state.filter, location.hostname), mode: state.pageMode ? 'list' : 'dom', pageError: state.pageError });
            return false;
        }
        if (msg.action !== 'mtbWeiboFilter') return false;
        state.filter = normalizeWeiboFilter(msg.filter);
        state.sigs = new WeakMap();   // 条件变了要整批重判
        queueApply().then((out) => sendResponse({ ok: true, ...out })).catch(() => sendResponse({ ok: false }));
        return true;
    });

    return {
        apply(nextSettings) {
            state.filter = normalizeWeiboFilter(nextSettings && nextSettings.weiboFilter);
            state.sigs = new WeakMap();
            void queueApply();
        },
        status() { return { hidden: state.hidden, total: state.total, applied: filterAppliesTo(state.filter, location.hostname), mode: state.pageMode ? 'list' : 'dom', pageError: state.pageError }; },
        destroy() {
            mo.disconnect();
            clearTimeout(state.timer);
        },
    };
}
