// 微博信息流筛选：按「原创/转发 + 纯文字/含图片/含视频/含音乐 + 关键字 + 时间」决定一条微博显示还是隐藏。
// 纯函数放这里，DOM 读取在 src/content/weibo-filter.mjs —— 这样判定语义能被单测钉住。

export const WEIBO_TYPES = ['original', 'repost', 'text', 'image', 'video', 'music'];

export const DEFAULT_WEIBO_FILTER = {
    enabled: false,
    site: '',            // 最近一次在哪个微博站点上配的（host）
    allSites: false,     // 勾上就作用于所有微博站点
    types: { original: true, repost: true, text: true, image: true, video: true, music: true },
    keywordMode: 'has',  // has | none | expr（关键字为空时整条规则不生效；expr = 一整条逻辑表达式）
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

/* ---------------- 关键字逻辑表达式（keywordMode === 'expr'） ----------------
 * 语法（优先级 非 > 且 > 或）：
 *   词                    正文里含这个词
 *   A 且 B / A && B / A B   两个都要有（并排写就是「且」）
 *   A 或 B / A || B / A|B / A,B   有一个就行
 *   非 A / !A / NOT A      不许有
 *   ( ) 调优先级；"…" 或 「…」 把含运算符的词包起来
 * 解析不出来就**不筛**（宁可多留，绝不误杀），UI 那边另给一句「看不懂」。
 */
export const EXPR_MAX_LEN = 200;
const EXPR_MAX_NODES = 80;
const EXPR_AND = ['&&', 'and', '且'];
const EXPR_OR = ['||', 'or', '或', ',', '，', '、'];
const EXPR_NOT = ['!', 'not', '非'];
const EXPR_QUOTE = { '"': '"', "'": "'", '“': '”', '「': '」', '『': '』' };

function exprClassify(word) {
    const low = String(word).toLowerCase();
    if (EXPR_AND.indexOf(low) >= 0) return 'and';
    if (EXPR_OR.indexOf(low) >= 0) return 'or';
    if (EXPR_NOT.indexOf(low) >= 0) return 'not';
    return null;
}

function tokenizeExpr(s) {
    const toks = [];
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === '(' || c === '（') { toks.push({ t: '(' }); i++; continue; }
        if (c === ')' || c === '）') { toks.push({ t: ')' }); i++; continue; }
        if (c === '&' || c === '|') {
            toks.push({ t: c === '&' ? 'and' : 'or' });
            i += (s[i + 1] === c) ? 2 : 1;
            continue;
        }
        if (c === '!') { toks.push({ t: 'not' }); i++; continue; }
        // 逗号是「或」：这些字符都会被上面的取词循环当断点，所以必须在这里就变成 token，
        // 不然它们会被静默吃掉，两条关键字反而变成「并排写 = 且」
        if (c === ',' || c === '，' || c === '、') { toks.push({ t: 'or' }); i++; continue; }
        if (EXPR_QUOTE[c]) {
            const close = EXPR_QUOTE[c];
            const end = s.indexOf(close, i + 1);
            if (end < 0) throw new Error('引号没闭合');
            const word = s.slice(i + 1, end).trim();
            if (!word) throw new Error('引号里是空的');
            toks.push({ t: 'term', v: word.toLowerCase() });
            i = end + 1;
            continue;
        }
        let j = i;
        while (j < s.length && !/[\s()（）&|!,，、]/.test(s[j])) j++;
        const word = s.slice(i, j).trim();
        i = j === i ? i + 1 : j;
        if (!word) continue;
        const op = exprClassify(word);
        if (op) toks.push({ t: op }); else toks.push({ t: 'term', v: word.toLowerCase() });
    }
    return toks;
}

export function parseKeywordExpr(src) {
    const s = String(src || '').trim();
    if (!s) return { ok: false, empty: true, error: '', node: null };
    if (s.length > EXPR_MAX_LEN) return { ok: false, empty: false, error: `太长了（最多 ${EXPR_MAX_LEN} 字）`, node: null };
    let toks;
    try { toks = tokenizeExpr(s); } catch (e) { return { ok: false, empty: false, error: String((e && e.message) || e), node: null }; }
    if (!toks.length) return { ok: false, empty: false, error: '没写出任何条件', node: null };
    let p = 0;
    let nodes = 0;
    const peek = () => toks[p];
    const label = (t) => (t === 'and' ? '且' : t === 'or' ? '或' : '非');
    const primary = () => {
        if (++nodes > EXPR_MAX_NODES) throw new Error('条件太多');
        const t = peek();
        if (!t) throw new Error('末尾还缺一个词');
        if (t.t === 'term') { p++; return { k: 'term', v: t.v }; }
        if (t.t === '(') {
            p++;
            const a = orExpr();
            if (!peek() || peek().t !== ')') throw new Error('括号没配对');
            p++;
            return a;
        }
        if (t.t === ')') throw new Error('括号没配对');
        throw new Error(`「${label(t.t)}」后面得有词`);
    };
    const notExpr = () => {
        if (peek() && peek().t === 'not') { p++; return { k: 'not', a: notExpr() }; }
        return primary();
    };
    const andExpr = () => {
        let a = notExpr();
        for (;;) {
            const t = peek();
            if (!t) break;
            if (t.t === 'or' || t.t === ')') break;
            if (t.t === 'and') p++;
            a = { k: 'and', a, b: notExpr() };
        }
        return a;
    };
    const orExpr = () => {
        let a = andExpr();
        while (peek() && peek().t === 'or') { p++; a = { k: 'or', a, b: andExpr() }; }
        return a;
    };
    try {
        const node = orExpr();
        if (p < toks.length) return { ok: false, empty: false, error: '后面有多出来的东西', node: null };
        return { ok: true, empty: false, error: '', node };
    } catch (e) {
        return { ok: false, empty: false, error: String((e && e.message) || e || '看不懂'), node: null };
    }
}

/** 这条正文该不该留；节点为空一律当「不筛」= true，绝不因为读不懂而隐藏 */
export function evalKeywordExpr(node, text) {
    if (!node) return true;
    const low = String(text || '').toLowerCase();
    const walk = (n) => {
        if (!n) return true;
        if (n.k === 'term') return !n.v || low.indexOf(n.v) >= 0;
        if (n.k === 'not') return !walk(n.a);
        if (n.k === 'and') return walk(n.a) && walk(n.b);
        if (n.k === 'or') return walk(n.a) || walk(n.b);
        return true;
    };
    try { return walk(node); } catch (e) { return true; }
}

const EXPR_CACHE = new Map();
/** 同一句话要被整条信息流反复求值，解析结果缓存住（只留最近 40 条） */
export function keywordExprOf(src) {
    const key = String(src || '').trim();
    const hit = EXPR_CACHE.get(key);
    if (hit) return hit;
    const r = parseKeywordExpr(key);
    if (EXPR_CACHE.size > 40) EXPR_CACHE.delete(EXPR_CACHE.keys().next().value);
    EXPR_CACHE.set(key, r);
    return r;
}

/** filter → 表达式原文（expr 档下 keywords 只装这一整句，不许按逗号拆） */
export function exprSource(f) {
    const src = f && f.keywords;
    return (Array.isArray(src) ? src.join(' ') : String(src || '')).trim();
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
    const keywordMode = src.keywordMode === 'none' ? 'none' : src.keywordMode === 'expr' ? 'expr' : 'has';
    const rawKw = Array.isArray(src.keywords) ? src.keywords.join(keywordMode === 'expr' ? ' ' : '\n') : src.keywords;
    return {
        enabled: !!src.enabled,
        site: String(src.site || '').toLowerCase(),
        allSites: !!src.allSites,
        types,
        keywordMode,
        keywords: keywordMode === 'expr' ? [String(rawKw || '').trim()].filter(Boolean) : splitKeywords(rawKw),
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
    if (f.keywordMode === 'expr') {
        const src = exprSource(f);
        if (src) {
            const parsed = keywordExprOf(src);
            // 看不懂的表达式不筛：宁可多留几条，也不许因为语法写错把整页微博藏掉
            if (parsed.ok && !evalKeywordExpr(parsed.node, v.text)) return false;
        }
    } else if (f.keywords.length) {
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
    if (f.keywordMode === 'expr') {
        const src = exprSource(f);
        const parsed = src ? keywordExprOf(src) : { ok: false };
        if (src) parts.push(parsed.ok ? `只留符合逻辑式「${src}」的` : `逻辑式看不懂（${parsed.error}），这条没生效`);
    } else if (f.keywords.length) {
        parts.push(`${f.keywordMode === 'has' ? '包含' : '不含'}「${f.keywords.slice(0, 3).join('、')}」${f.keywords.length > 3 ? '等 ' + f.keywords.length + ' 个' : ''}`);
    }
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
