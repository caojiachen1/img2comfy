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
