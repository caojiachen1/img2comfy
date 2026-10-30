// 小红书「把每条笔记的全部图片解析出来」：读笔记内页 SSR，不走签名接口。
//
// 为什么只能这么读（2026-10-30 实测）：
//   · 列表页/主页的 noteCard 只有 1 张 cover，**没有 imageList** —— 用户看到的「一条笔记一张图」就是这么来的；
//   · 翻页与详情接口 edith.xiaohongshu.com/api/sns/web/v1/user_posted|feed 不带 x-s 签名直接
//     **406 {"code":-1}**，签名是前端 JS 算的，replay 不了（微博那条 since_id 纯接口路线在这站不成立）；
//   · 但笔记内页 https://www.xiaohongshu.com/explore/<id>?xsec_token=… 的 SSR 里，
//     `feed.undertakeNote.items[].noteCard.imageList` 带着**这条笔记的全部图片**（含 width/height 与
//     WB_PRV/WB_DFT 两档 URL），带 cookie 取就是 200。所以「按笔记逐个取内页」是唯一稳的路。
//
// SSR 那份状态不是合法 JSON：里面混着 `new Map([])`、`new Set([])`、值位置的 `undefined`，
// 而且 `note.noteDetailMap` 就是 `new Map([])`（空的）—— 别去那儿找数据，数据在 feed.undertakeNote。
// 贪婪正则会在第一个 `}` 截断（实测在 21566 字符处炸），所以括号配平要自己扫（字符串内的花括号不算）。

const UNDEFINED_AT_VALUE = /(?<=[:\[,])\s*undefined\b/;

/* SSR 里的 window.__INITIAL_STATE__ → JS 对象。消毒三件事：new Map(...)/new Set(...)、值位置 undefined。
   解析不了返回 null，让调用方明确报「这份页面读不到数据」，不返回半截对象骗人。 */
export function parseSsrState(html) {
    const s = String(html || '');
    const at = s.indexOf('__INITIAL_STATE__');
    if (at < 0) return null;
    const start = s.indexOf('{', at);
    if (start < 0) return null;
    let depth = 0;
    let instr = false;
    let esc = false;
    let end = -1;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (instr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') instr = false;
            continue;
        }
        if (c === '"') instr = true;
        else if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (!depth) { end = i + 1; break; }
        }
    }
    if (end < 0) return null;
    let raw = s.slice(start, end);
    raw = raw.replace(/new Map\((?:[^()]|\([^()]*\))*\)/g, '{}');
    raw = raw.replace(/new Set\((?:[^()]|\([^()]*\))*\)/g, '[]');
    // 全局循环替换：一次 re.sub 只换掉每处第一个匹配，`,undefined,undefined` 这种会漏
    while (UNDEFINED_AT_VALUE.test(raw)) raw = raw.replace(UNDEFINED_AT_VALUE, ' null');
    try { return JSON.parse(raw); }
    catch (e) { return null; }
}

/* 内页 state → 这条笔记的 noteCard（含全部 imageList）。
   undertakeNote 是按 id 挂的，但也见过 key 与请求 id 不一致（重定向/相关推荐），所以匹配不上时
   退到「唯一的那一条」，别直接给空 —— 空了用户看到的就是「一条图都没解析出来」。 */
export function undertakeCard(state, noteId) {
    const items = ((((state || {}).feed) || {}).undertakeNote || {}).items || [];
    for (const it of items) {
        const nc = (it && it.noteCard) || {};
        if (it.id === noteId || nc.noteId === noteId) return nc;
    }
    if (items.length === 1) return (items[0] && items[0].noteCard) || {};
    return {};
}

// WB_DFT 是无水印的正常档，WB_PRV 是预览（带水印）。都拿不到才算这张没图。
export function pickImageUrl(img) {
    const infos = (img && img.infoList) || [];
    let prv = '';
    for (const x of infos) {
        const u = String((x && x.url) || '');
        if (!u) continue;
        if (x.imageScene === 'WB_DFT') return https(u);
        if (x.imageScene === 'WB_PRV' && !prv) prv = u;
    }
    return https(prv || (infos[0] && infos[0].url) || '');
}

function https(u) {
    return String(u || '').replace(/^http:/i, 'https:');
}

/* 主页 SSR → 这个账号已列出的笔记（id + xsecToken）。
   xsecToken 是**每条**都带的反爬令牌，取内页必须原样带上，不带就是 404/校验页。 */
export function listedNotes(state) {
    const groups = (((state || {}).user) || {}).notes || [];
    const out = [];
    const buckets = Array.isArray(groups[0]) ? groups : [groups];
    for (const arr of buckets) {
        for (const it of Array.isArray(arr) ? arr : []) {
            const nc = (it && it.noteCard) || {};
            const id = it && (it.id || nc.noteId);
            if (!id) continue;
            out.push({
                id, token: String(it.xsecToken || nc.xsecToken || ''),
                title: String(nc.displayTitle || '').slice(0, 80),
                type: String(nc.type || ''),
                cover: pickImageUrl(nc.cover || {}),
                likes: String(((nc.interactInfo || {}).likedCount) || ''),
            });
        }
    }
    return out;
}

// 一条笔记 → 面板要的帖子形状（和 weiboStatusToPost 同一套字段，好共用 mergeFeedPosts 那条合并链）
export function xhsNoteToPost(note, host) {
    const pics = [];
    for (const im of note.imageList || []) {
        const url = pickImageUrl(im);
        if (!url) continue;
        pics.push({ url, width: Number(im.width) || 0, height: Number(im.height) || 0 });
    }
    const u = note.user || {};
    return {
        index: 0, id: String(note.noteId || note.id || ''), mid: String(note.noteId || note.id || ''),
        bid: String(note.noteId || note.id || ''), uid: String(u.userId || u.userid || ''),
        name: String(u.nickname || u.nickName || ''),
        text: String(note.title || note.desc || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        url: `https://${host || 'www.xiaohongshu.com'}/explore/${note.noteId || note.id || ''}`,
        pics,
    };
}

export function noteDetailUrl(noteId, token, host) {
    return `https://${host || 'www.xiaohongshu.com'}/explore/${noteId}`
        + `?xsec_token=${encodeURIComponent(token || '')}&xsec_source=pc_feed`;
}

export function profileUrl(uid, host) {
    return `https://${host || 'www.xiaohongshu.com'}/user/profile/${uid}`;
}

export function profileUid(url) {
    const m = /xiaohongshu\.com\/user\/profile\/([0-9a-f]{20,32})/i.exec(String(url || ''));
    return m ? m[1] : '';
}

export function isXhsHost(host) {
    return /(^|\.)xiaohongshu\.com$/i.test(String(host || ''));
}
