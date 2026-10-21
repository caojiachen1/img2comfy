// 微博信息流筛选：按「原创/转发 + 纯文字/含图片/含视频/含音乐 + 关键字 + 时间」决定一条微博显示还是隐藏。
// 纯函数放这里，DOM 读取在 src/content/weibo-filter.mjs —— 这样判定语义能被单测钉住。

export const WEIBO_TYPES = ['original', 'repost', 'text', 'image', 'video', 'music'];

export const DEFAULT_WEIBO_FILTER = {
    enabled: false,
    site: '',            // 最近一次在哪个微博站点上配的（host）
    allSites: false,     // 勾上就作用于所有微博站点
    types: { original: true, repost: true, text: true, image: true, video: true, music: true },
    keywordMode: 'has',  // has | none（关键字为空时整条规则不生效）
    keywords: [],
    dateFrom: '',
    dateTo: '',
    experimental: false,   // 实验：直接改微博内部列表数据，让被筛的帖子真的不存在（默认关，有风险）
};

const MAX_KEYWORDS = 50;
const DAY_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

/** 「一行一个」输入框 → 数组：换行/中英文逗号/分号/顿号都当分隔，去掉空项与重复（不区分大小写） */
export function splitKeywords(text) {
    const out = [];
    const seen = new Set();
    for (const raw of String(text || '').split(/[\n\r,，;；、]+/)) {
        const k = raw.trim();
        if (!k) continue;
        const low = k.toLowerCase();
        if (seen.has(low)) continue;
        seen.add(low);
        out.push(k);
        if (out.length >= MAX_KEYWORDS) break;
    }
    return out;
}

function normDay(v) {
    const m = DAY_RE.exec(String(v || '').trim());
    if (!m) return '';
    const [, y, mo, d] = m;
    const pad = (x) => String(x).padStart(2, '0');
    return `${y}-${pad(mo)}-${pad(d)}`;
}

export function normalizeWeiboFilter(f) {
    const src = f && typeof f === 'object' ? f : {};
    const t = src.types && typeof src.types === 'object' ? src.types : {};
    const types = {};
    for (const k of WEIBO_TYPES) types[k] = t[k] !== false;
    return {
        enabled: !!src.enabled,
        site: String(src.site || '').toLowerCase(),
        allSites: !!src.allSites,
        types,
        keywordMode: src.keywordMode === 'none' ? 'none' : 'has',
        keywords: Array.isArray(src.keywords) ? splitKeywords(src.keywords.join('\n')) : splitKeywords(src.keywords),
        dateFrom: normDay(src.dateFrom),
        dateTo: normDay(src.dateTo),
        experimental: !!src.experimental,
    };
}

/** 当前条件该不该作用在这个 host 上（不勾「所有微博网站」时只认配它的那个站点） */
export function filterAppliesTo(filter, host) {
    const f = normalizeWeiboFilter(filter);
    if (!f.enabled) return false;
    if (f.allSites) return true;
    return !!f.site && String(host || '').toLowerCase() === f.site;
}

/**
 * 这条微博该不该显示。info 由页面侧读出：{repost, hasImage, hasVideo, hasMusic, text, date:'YYYY-MM-DD'|''}。
 * 类型是「勾了的才要」：原创/转发二选一，纯文字/含图/含视频/含音乐按命中的任一类型通过。
 */
export function matchWeiboFilter(info, filter) {
    const f = normalizeWeiboFilter(filter);
    if (!f.enabled) return true;
    const v = info || {};
    const wantOriginal = f.types.original, wantRepost = f.types.repost;
    if (v.repost) {
        if (!wantRepost) return false;
    } else if (!wantOriginal) return false;
    const hasImage = !!v.hasImage, hasVideo = !!v.hasVideo, hasMusic = !!v.hasMusic;
    const textOnly = !hasImage && !hasVideo && !hasMusic;
    const passMedia = (f.types.text && textOnly)
        || (f.types.image && hasImage)
        || (f.types.video && hasVideo)
        || (f.types.music && hasMusic);
    if (!passMedia) return false;
    if (f.keywords.length) {
        const text = String(v.text || '').toLowerCase();
        const hit = f.keywords.some((k) => text.includes(k.toLowerCase()));
        if (f.keywordMode === 'has' && !hit) return false;
        if (f.keywordMode === 'none' && hit) return false;
    }
    if (f.dateFrom || f.dateTo) {
        // 时间读不出来的帖子不参与时间判断（宁可多留，不误杀）
        if (v.date) {
            if (f.dateFrom && v.date < f.dateFrom) return false;
            if (f.dateTo && v.date > f.dateTo) return false;
        }
    }
    return true;
}

/** 面板/提示条上的一句话，说明当前生效的条件 */
export function describeWeiboFilter(filter) {
    const f = normalizeWeiboFilter(filter);
    if (!f.enabled) return '未启用';
    const parts = [];
    if (!f.types.original) parts.push('不含原创');
    if (!f.types.repost) parts.push('不含转发');
    const media = [['image', '含图片'], ['video', '含视频'], ['music', '含音乐'], ['text', '纯文字']]
        .filter(([k]) => f.types[k]).map(([, label]) => label);
    if (media.length < 4) parts.push(media.length ? '只看' + media.join('/') : '不看任何类型');
    if (f.keywords.length) parts.push(`${f.keywordMode === 'has' ? '包含' : '不含'}「${f.keywords.slice(0, 3).join('、')}」${f.keywords.length > 3 ? '等 ' + f.keywords.length + ' 个' : ''}`);
    if (f.dateFrom || f.dateTo) parts.push(`${f.dateFrom || '不限'} ~ ${f.dateTo || '至今'}`);
    return parts.length ? parts.join(' · ') : '启用但没有条件（等同不筛）';
}

/* ---------------- 实验模式：直接判微博自己那份数据里的条目 ---------------- */

/** 'Wed Oct 21 10:44:13 +0800 2026' / ISO / 时间戳 → 'YYYY-MM-DD'（读不出就空串） */
export function dateOfCreatedAt(v) {
    if (v === undefined || v === null || v === '') return '';
    const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 把微博条目对象（Home.data.list 里那种）翻成判定要的 info */
export function weiboItemInfo(item) {
    const it = item || {};
    const page = it.page_info || {};
    const pageType = String(page.object_type || page.type || '').toLowerCase();
    const text = String(it.text || it.longText || '').replace(/<[^>]+>/g, '');
    const pics = !!(it.pic_ids && it.pic_ids.length) || !!it.pic_infos;
    return {
        repost: !!it.retweeted_status,
        hasImage: pics,
        hasVideo: pageType.includes('video') || !!(it.mix_media_info && /video/i.test(JSON.stringify(it.mix_media_info).slice(0, 400))),
        hasMusic: pageType.includes('music') || /分享歌曲|网易云音乐|QQ音乐|酷狗音乐/.test(text),
        text,
        date: dateOfCreatedAt(it.created_at),
    };
}

export function matchWeiboItem(item, filter) {
    return matchWeiboFilter(weiboItemInfo(item), filter);
}
