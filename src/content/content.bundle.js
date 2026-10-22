(function(){
"use strict";
var __M = {};
__M["src/content/probe.js"] = (function(){
// 媒体命中检测：从旧实现迁移，保留全部踩坑结论（遮挡剔除、shadow DOM、
// pointer-events:none 的轮播分页、background-image 衬底、模糊副本优先取清晰原图）。

function makeProber({ minImgSize = 200, wrapSelector = '#mtb-root' } = {}) {
    const opts = { minImgSize };

    // 尺寸闸门：细长横幅（只有一边够长）和「显示很小、源很大」的缩略图都算真媒体，
    // 只有两边都小、源也小的图标才排除。
    function sizeOk(w, h, nw, nh) {
        const min = opts.minImgSize;
        if (w >= min && h >= min) return true;
        if (Math.min(w, h) >= min * 0.4 && w * h >= min * min) return true;
        return nw >= min && nh >= min && Math.min(w, h) >= 64;
    }

    function isBlurred(el) {
        let node = el, hops = 0;
        while (node && hops < 6) {
            const f = getComputedStyle(node).filter;
            if (f && f.includes('blur')) return true;
            node = node.parentElement;
            hops++;
        }
        return false;
    }

    function isElementVisible(el) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
        let node = el.parentElement;
        while (node && node !== document.body) {
            const s = getComputedStyle(node);
            if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
            node = node.parentElement;
        }
        return true;
    }

    function isOpaqueOccluder(el) {
        if (!el || !el.getBoundingClientRect) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < opts.minImgSize || rect.height < opts.minImgSize) return false;
        // 可见性必须问在 IMG/VIDEO 之前：x.com 的照片是「background-image 容器 + 里面一张
        // opacity:0 的占位 img」，占位 img 一旦被认成不透明遮挡物，它爹（真正那张图）
        // 就会被剔除，整站再也弹不出工具栏。
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false;
        if (el.tagName === 'VIDEO') return true;
        if (el.tagName === 'IMG' && (el.currentSrc || el.src)) return true;
        const bgc = cs.backgroundColor;
        if (bgc && bgc !== 'transparent') {
            const m = bgc.match(/rgba?\(([^)]+)\)/);
            if (m) {
                const parts = m[1].split(/[\s,/]+/).filter((s) => s !== '').map(parseFloat);
                const alpha = parts.length >= 4 ? parts[3] : 1;
                if (alpha >= 0.9) return true;
            } else return true;
        }
        const bgi = cs.backgroundImage;
        if (bgi && bgi !== 'none' && !bgi.includes('gradient')) return true;
        return false;
    }

    const BG_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*))\s*\)/g;
    const GRADIENT_RE = /(?:repeating-)?(?:linear|radial|conic)-gradient\((?:[^()]|\([^()]*\))*\)/gi;

    function bgImageOf(el) {
        const bgi = getComputedStyle(el).backgroundImage;
        if (!bgi || bgi === 'none') return null;
        // 渐变里嵌的 url() 不是这个容器的图片来源，整段去掉再找
        const stripped = bgi.replace(GRADIENT_RE, '');
        BG_URL_RE.lastIndex = 0;
        let m;
        while ((m = BG_URL_RE.exec(stripped))) {
            const raw = (m[1] || m[2] || m[3] || '').trim();
            if (!raw || raw === 'none' || /^blob:/i.test(raw)) continue;
            if (/^data:/i.test(raw)) {
                // 内联 SVG 当背景的多半是图标/纹理，交给宿主解码也拿不到有意义的内容
                if (/^data:image\/(?:svg\+xml|vnd\.adobe\.illustrator\+svg)/i.test(raw)) continue;
                if (/^data:image\//i.test(raw)) return raw;
                continue;
            }
            if (/^https?:/i.test(raw)) return raw;
            try { return new URL(raw, document.baseURI).href; } catch (e) { /* 解不了的相对路径就跳过 */ }
        }
        return null;
    }

    // —— 缩略图抑制 ——
    // 只收起「能点开大图的缩略图」的工具栏（微博九宫格、点开 lightbox 的网格图等）。
    // 判定必须保守：大图、查看器里的图、不可点开的普通插图都继续出按钮，别破坏「有图就有按钮」。
    const VIEWER_ATTRS = '[data-lightbox],[data-fancybox],[data-gallery],[data-photoswipe],[data-zoom],[aria-modal="true"],[role="dialog"]';
    const VIEWER_CLASS = /(?:lightbox|viewer|photo-?view|image-?view|zoom-?view|fancybox|photoswipe|modal|overlay|gallery-?view|preview-?mask)/i;
    const WEIBO_HOST = /(^|\.)weibo\.(com|cn)$/i;

    function inViewerChrome(el) {
        let node = el, hops = 0;
        while (node && node.nodeType === 1 && hops < 12) {
            try {
                const cs = getComputedStyle(node);
                if (node.matches?.('dialog[open], [aria-modal="true"], [role="dialog"]')) return true;
                if ((cs.position === 'fixed' || cs.position === 'absolute') && VIEWER_CLASS.test(String(node.id || '') + ' ' + String(node.className || ''))) return true;
                if (cs.position === 'fixed') {
                    const r = node.getBoundingClientRect();
                    const z = parseInt(cs.zIndex, 10);
                    if (r.width >= innerWidth * .65 && r.height >= innerHeight * .45 && (!Number.isFinite(z) || z >= 10)) return true;
                }
            } catch (e) { /* ignore */ }
            node = node.parentElement; hops++;
        }
        return false;
    }

    function hasViewerTrigger(el) {
        let node = el, hops = 0;
        while (node && node.nodeType === 1 && hops < 8) {
            try {
                if (node.matches?.(VIEWER_ATTRS)) return true;
                if (getComputedStyle(node).cursor === 'zoom-in') return true;
                if (node.tagName === 'A') {
                    const href = node.getAttribute('href') || '';
                    if (/^(?:javascript:|#)/i.test(href)) return true;
                    if (/\.(?:jpe?g|png|webp|avif|gif|bmp)(?:[?#]|$)/i.test(href)) return true;
                    if (/(?:photo|image|img|pic|picture|zoom|lightbox|preview|viewer|gallery|media)/i.test(href)) return true;
                    if (/(?:^|\/)p\//i.test(href)) return true;
                }
            } catch (e) { /* ignore */ }
            node = node.parentElement; hops++;
        }
        return false;
    }

    function isSuppressedThumbnail(c) {
        if (c.kind === 2) return false;                      // 视频不参与
        const rect = c.el.getBoundingClientRect();
        const longSide = Math.max(rect.width, rect.height);
        if (longSide < 40) return false;
        const src = c.srcOverride || c.el.currentSrc || c.el.src || '';
        // 已经是 large/original 原图（典型是查看器）就不算缩略图
        if (/\/(?:large|original|mw2000)\//i.test(src)) return false;
        if (inViewerChrome(c.el)) return false;
        const weibo = WEIBO_HOST.test(location.hostname);
        if (c.kind === 1) {
            // background-image 容器拿不到原始尺寸，只做保守的小图判定
            if (longSide > 320) return false;
            return weibo || hasViewerTrigger(c.el);
        }
        const nw = c.natural?.width || 0, nh = c.natural?.height || 0;
        if (!nw || !nh) return false;
        const scale = Math.max(nw / Math.max(1, rect.width), nh / Math.max(1, rect.height));
        if (scale < 1.5) return false;
        if (longSide > (weibo ? 380 : 460)) return false;
        return weibo || hasViewerTrigger(c.el);
    }

    function findMediaAtPoint(x, y) {
        const stack = document.elementsFromPoint(x, y);
        const candidates = [];
        const seen = new Set();

        const consider = (media, stackIdx, hostEl) => {
            if (!media || seen.has(media)) return;
            if (!(media.tagName === 'IMG' || media.tagName === 'VIDEO')) return;
            if (!isElementVisible(media)) return;
            const rect = media.getBoundingClientRect();
            if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
            const nw = media.naturalWidth || media.videoWidth || 0;
            const nh = media.naturalHeight || media.videoHeight || 0;
            if (!sizeOk(rect.width, rect.height, nw, nh)) return;
            const src = media.currentSrc || media.src || media.getAttribute('src') || '';
            if (media.tagName === 'IMG' && !src) return;
            seen.add(media);
            candidates.push({
                el: media, srcOverride: null, stackIdx, hostEl,
                kind: media.tagName === 'VIDEO' ? 2 : 0,
                blurred: isBlurred(media),
                dataSrc: media.tagName === 'IMG' && src.startsWith('data:'),
                natural: { width: nw, height: nh },
            });
        };

        const processHitEl = (el, stackIdx, hostEl) => {
            if (!el || !el.closest) return;
            if (!hostEl && el.closest(wrapSelector)) return;
            const direct = el.closest('img, video');
            if (direct) consider(direct, stackIdx, hostEl);
            if (el.querySelectorAll) for (const m of el.querySelectorAll('img, video')) consider(m, stackIdx, hostEl);
            if (el instanceof HTMLElement) {
                const rect = el.getBoundingClientRect();
                if (sizeOk(rect.width, rect.height, 0, 0) && isElementVisible(el)) {
                    const url = bgImageOf(el);
                    if (url) {
                        candidates.push({
                            el, srcOverride: url, stackIdx, hostEl, kind: 1,
                            blurred: isBlurred(el), dataSrc: false,
                            natural: { width: rect.width, height: rect.height },
                        });
                    }
                }
            }
        };

        const scanShadow = (root, stackIdx, hostEl, depth) => {
            if (depth > 3) return;
            let els;
            try { els = root.elementsFromPoint(x, y); } catch (e) { return; }
            if (!els) return;
            for (const el of els) {
                processHitEl(el, stackIdx, hostEl);
                if (el.shadowRoot) scanShadow(el.shadowRoot, stackIdx, hostEl, depth + 1);
            }
        };

        for (let i = 0; i < stack.length; i++) {
            const el = stack[i];
            processHitEl(el, i, null);
            if (el.shadowRoot) scanShadow(el.shadowRoot, i, el, 0);
        }
        if (!candidates.length) return null;

        const maxIdx = Math.max(...candidates.map((c) => c.stackIdx));
        const occluderFlags = [];
        for (let j = 0; j < maxIdx; j++) occluderFlags[j] = isOpaqueOccluder(stack[j]);
        const visible = candidates.filter((c) => {
            const ref = c.hostEl || c.el;
            for (let j = 0; j < c.stackIdx; j++) {
                if (!occluderFlags[j]) continue;
                const occ = stack[j];
                // 父遮挡物：它画在自己内部任何媒体之下；子遮挡物：父容器自己的 background-image
                // 永远画在所有后代之下，两种都不能拿来剔除候选。
                if (occ === ref || (occ.contains && (occ.contains(ref) || ref.contains(occ)))) continue;
                // 命中栈下标只反映「谁在栈里出现得早」：pointer-events:none 的图片根本不在栈里，
                // 它带着父容器的下标，于是压在它下面的那张图会被当成遮挡物把它剔除
                if (paintAbove(ref, occ) >= 0) return false;
            }
            return true;
        });
        // 一个都不剩时不再直接放弃（那是「有图却什么都不弹」的主要来源）：退回候选里最上层那个。
        // 真有媒体盖在它上面时，那个媒体本身就在候选里，pickTopLayer 照样会选中它。
        const pool = visible.length ? visible : candidates;

        for (const c of pool) if (c.kind === undefined) c.kind = 0;
        // 只认最上层那张：被压在下面的图片永远不该弹出工具栏
        const best = pickTopLayer(pool);
        if (opts.skipThumbnails !== false && isSuppressedThumbnail(best)) return null;
        return {
            el: best.el,
            src: best.srcOverride,
            kind: best.kind === 2 ? 'video' : (best.srcOverride ? 'bg' : 'image'),
            natural: best.natural,
            displayRect: best.el.getBoundingClientRect(),
        };
    }

    // CSS 绘制顺序近似比较：负数 = a 画在 b 上面（a 更靠近用户）。
    // 只能靠 elementsFromPoint 下标判定图层深浅是不够的——命中栈会漏掉
    // pointer-events:none 的元素，而兄弟层叠里「父容器在栈里的位置」比它自己的图片更深，
    // 用父容器下标当图片下标就会把下面那张图当成最上层。
    function paintAbove(a, b) {
        if (!a || !b || a === b) return 0;
        try {
            if (a.contains(b)) return 1;                    // b 是 a 的后代，画在 a 之上
            if (b.contains(a)) return -1;
            const ca = treePath(a), cb = treePath(b);
            let i = 0;
            while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++;
            if (i === 0) return 0;                          // 不在同一棵树（跨 iframe），无从比较
            const ka = layerKey(ca[i]), kb = layerKey(cb[i]);
            if (ka.group !== kb.group) return kb.group - ka.group;
            if (ka.z !== kb.z) return kb.z - ka.z;
            return kb.order - ka.order;
        } catch (e) { return 0; }
    }

    function treePath(el) {
        const chain = [];
        let node = el;
        while (node && node.nodeType === 1) {
            chain.unshift(node);
            if (node.parentElement) { node = node.parentElement; continue; }
            const root = node.getRootNode ? node.getRootNode() : null;
            node = root && root.host ? root.host : null;
        }
        return chain;
    }

    // 在同一父容器下，谁更靠上：定位元素（含负 z）> 常规流；同组内比 z-index，再比 DOM 顺序
    function layerKey(el) {
        const cs = getComputedStyle(el);
        const z = parseInt(cs.zIndex, 10);
        const positioned = cs.position !== 'static';
        const zi = Number.isFinite(z) ? z : 0;
        return {
            group: positioned ? (zi < 0 ? -1 : 1) : 0,
            z: positioned ? zi : 0,
            order: orderInParent(el),
        };
    }

    function orderInParent(el) {
        const p = el.parentElement;
        if (!p) return 0;
        const kids = p.children;
        for (let i = 0; i < kids.length; i++) if (kids[i] === el) return i;
        return 0;
    }

    function overlaps(a, b) {
        const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const inter = x * y;
        const smaller = Math.min(a.width * a.height, b.width * b.height);
        return smaller > 0 ? inter / smaller : 0;
    }

    // 同层重叠时（惰性加载常见：模糊缩略图盖在清晰原图上面）仍取清晰的那张
    function upgradeFromPlaceholder(top, list) {
        if (!top.blurred && !top.dataSrc) return top;
        const rect = top.el.getBoundingClientRect();
        let better = null;
        for (const c of list) {
            if (c === top || c.blurred || c.dataSrc) continue;
            if (overlaps(rect, c.el.getBoundingClientRect()) < 0.8) continue;
            if (!better || paintAbove(c.el, better.el) < 0) better = c;
        }
        return better || top;
    }

    function pickTopLayer(list) {
        let top = list[0];
        for (const c of list) if (paintAbove(c.el, top.el) < 0) top = c;
        return upgradeFromPlaceholder(top, list);
    }

    return { findMediaAtPoint, isElementVisible, isOpaqueOccluder, isBlurred, paintAbove, opts };
}

function frameOffsetInTop() {
    let dx = 0, dy = 0, w = window;
    try {
        while (w !== w.top) {
            const fe = w.frameElement;
            if (!fe) return null;
            const r = fe.getBoundingClientRect();
            dx += r.left; dy += r.top;
            w = w.parent;
        }
    } catch (e) { return null; }
    return { dx, dy, vw: w.innerWidth, vh: w.innerHeight };
}

return { "makeProber": (typeof makeProber === 'undefined' ? undefined : makeProber), "frameOffsetInTop": (typeof frameOffsetInTop === 'undefined' ? undefined : frameOffsetInTop) };
})();
__M["src/content/ui.mjs"] = (function(){
// 悬浮工具栏 UI：Shadow DOM 宿主、按钮渲染、拖拽定位、结果面板、标注遮罩。

const ROOT_ID = 'mtb-root';
const NS = 'mtb';

const CSS = `
:host {
  all: initial;
  --tb-text: #eef2f9;
  --tb-text-hover: #fff;
  --tb-muted: #9aa5b8;
  --tb-faint: #6f7a8e;
  --tb-accent: #6ea8ff;
  --tb-accent2: #9d8bff;
  --tb-gear: #cfe1ff;
  --tb-border: rgba(255,255,255,.10);
  --tb-hairline: rgba(255,255,255,.07);
  --tb-hover: rgba(255,255,255,.075);
  --tb-press: rgba(255,255,255,.13);
  --tb-surface: linear-gradient(180deg, rgba(30,34,43,.93), rgba(14,16,21,.96));
  --tb-menu-surface: linear-gradient(180deg, rgba(29,32,41,.985), rgba(13,15,20,.99));
  --tb-gear-surface: linear-gradient(180deg, rgba(110,168,255,.16), rgba(110,168,255,.06));
  --tb-gear-border: rgba(110,168,255,.22);
  --tb-shadow: 0 18px 46px rgba(0,0,0,.55), 0 4px 12px rgba(0,0,0,.38);
  --ic-filter: grayscale(1) brightness(1.55) contrast(1.05);
  --ic-filter-hover: grayscale(1) brightness(1.95) contrast(1.02);
}
* { box-sizing: border-box; font-family: "Segoe UI Variable","Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,.16); border-radius: 99px; border: 2px solid transparent; background-clip: content-box; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.28); background-clip: content-box; border: 2px solid transparent; }
::-webkit-scrollbar-track { background: transparent; }
.wrap {
  position: absolute; z-index: 2147483647; display: none; pointer-events: auto;
  --scale: 1; --gap: 4px; --radius: 8px; --opacity: .92;
  align-items: center; gap: var(--gap);
  padding: calc(4px * var(--scale)) calc(3px * var(--scale));
  background: var(--tb-surface);
  border: 1px solid var(--tb-border);
  border-radius: calc(var(--radius) + 7px);
  box-shadow: var(--tb-shadow), inset 0 1px 0 rgba(255,255,255,.07);
  backdrop-filter: blur(18px) saturate(170%); -webkit-backdrop-filter: blur(18px) saturate(170%);
}
.wrap::before {
  content: ''; position: absolute; left: 14%; right: 14%; top: 0; height: 1px; pointer-events: none;
  background: linear-gradient(90deg, transparent, rgba(150,183,255,.5), transparent);
}
.wrap.show { display: flex; }
.wrap.vertical { flex-direction: column; align-items: stretch; }
.wrap.vertical .draghandle { width: 100%; height: calc(9px * var(--scale)); }
.wrap.vertical .draghandle::before { transform: rotate(90deg); }
.wrap.vertical button.btn { justify-content: flex-start; }
.wrap.grid { display: none; grid-template-columns: repeat(var(--cols, 3), minmax(0, 1fr)); }
.wrap.grid.show { display: grid; }
.wrap.grid button.btn { justify-content: center; }
.wrap.grid button.btn .tx { overflow: hidden; text-overflow: ellipsis; }
.bar { display: flex; gap: var(--gap); align-items: center; }
button.btn {
  appearance: none; -webkit-appearance: none;
  background: transparent; color: var(--tb-text); border: 1px solid transparent;
  padding: calc(5px * var(--scale)) calc(8px * var(--scale));
  border-radius: var(--radius); cursor: pointer;
  font-size: calc(12px * var(--scale)); font-weight: 500;
  display: inline-flex; align-items: center; gap: calc(5px * var(--scale));
  white-space: nowrap; line-height: 1.25;
  transition: background .16s ease, border-color .16s ease, color .16s ease, box-shadow .16s ease, transform .1s ease;
}
button.btn:hover { background: var(--tb-hover); border-color: var(--tb-border); box-shadow: inset 0 1px 0 rgba(255,255,255,.08); color: var(--tb-text-hover); }
button.btn:active { transform: scale(.965); background: var(--tb-press); }
button.btn:focus-visible { outline: none; box-shadow: 0 0 0 2px rgba(110,168,255,.5); }
button.btn[disabled] { opacity: .5; cursor: progress; }
button.btn.busy .ic { animation: mtb-breathe 1.2s ease-in-out infinite; }
button.btn .ic {
  display: inline-grid; place-items: center; min-width: 1em;
  font-size: calc(13px * var(--scale)); line-height: 1;
  filter: var(--ic-filter); opacity: .94;
  transition: filter .16s ease, opacity .16s ease, transform .16s ease;
}
button.btn:hover .ic { filter: var(--ic-filter-hover); opacity: 1; transform: scale(1.05); }
button.btn.icon { width: calc(31px * var(--scale)); height: calc(31px * var(--scale)); padding: calc(6px * var(--scale)); justify-content: center; }
button.btn.icon .tx { display: none; }
button.btn.text .ic { display: none; }
button.btn.gear { color: var(--tb-gear); background: var(--tb-gear-surface); border-color: var(--tb-gear-border); }
button.btn.gear:hover { background: linear-gradient(180deg, rgba(110,168,255,.22), rgba(110,168,255,.08)); border-color: rgba(110,168,255,.4); box-shadow: 0 0 16px rgba(110,168,255,.18), inset 0 1px 0 rgba(255,255,255,.1); }
.btn.more .caret { font-size: calc(9px * var(--scale)); opacity: .55; margin-left: calc(1px * var(--scale)); }
.btn.more:hover .caret { opacity: .9; }
.draghandle {
  width: calc(12px * var(--scale)); height: calc(24px * var(--scale));
  border-radius: 6px; cursor: grab; opacity: .62; user-select: none;
  display: flex; align-items: center; justify-content: center; font-size: 0;
  transition: opacity .16s ease, background .16s ease;
}
.draghandle::before {
  content: ''; width: calc(4px * var(--scale)); height: calc(16px * var(--scale));
  background-image: radial-gradient(circle, var(--tb-faint) 1px, transparent 1.4px);
  background-size: calc(4px * var(--scale)) calc(4px * var(--scale));
  background-repeat: repeat-y; background-position: center;
}
.draghandle:hover { opacity: 1; background: var(--tb-hover); }
.draghandle:hover::before { background-image: radial-gradient(circle, var(--tb-accent) 1px, transparent 1.4px); }
.dragging .draghandle { cursor: grabbing; }
.dragging { outline: 1px dashed rgba(110,168,255,.6); outline-offset: 3px; }
.menu {
  position: absolute; left: 0; z-index: 2147483647; display: none; pointer-events: auto;
  min-width: 188px; max-width: min(320px, 88vw); max-height: 62vh; overflow: auto;
  padding: 6px;
  background: var(--tb-menu-surface);
  border: 1px solid var(--tb-border); border-radius: calc(var(--radius) + 6px);
  box-shadow: var(--tb-shadow), inset 0 1px 0 rgba(255,255,255,.07);
  backdrop-filter: blur(20px) saturate(170%); -webkit-backdrop-filter: blur(20px) saturate(170%);
}
.menu.show { display: block; }
.menu .mi {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px;
  cursor: pointer; white-space: nowrap; font-size: calc(12.5px * var(--scale)); color: var(--tb-text);
  transition: background .13s ease, color .13s ease;
}
.menu .mi:hover { background: linear-gradient(90deg, rgba(110,168,255,.17), rgba(110,168,255,.05)); color: var(--tb-text-hover); }
.menu .mi .ic { width: 1.4em; display: inline-grid; place-items: center; font-size: calc(13px * var(--scale)); filter: var(--ic-filter); }
.menu .mi:hover .ic { filter: var(--ic-filter-hover); }
.menu .mi.busy { opacity: .55; pointer-events: none; }
.menu .hint { padding: 5px 10px 8px; font-size: 10.5px; color: var(--tb-faint); letter-spacing: .2px; }
.wrap[data-theme="light"] {
  --tb-text: #171b23; --tb-text-hover: #0b1220; --tb-muted: #4f5769; --tb-faint: #77808f; --tb-gear: #2f62c8;
  --tb-surface: linear-gradient(180deg, rgba(255,255,255,.97), rgba(238,241,247,.97));
  --tb-menu-surface: linear-gradient(180deg, rgba(255,255,255,.99), rgba(242,244,249,.99));
  --tb-gear-surface: rgba(47,98,200,.09); --tb-gear-border: rgba(47,98,200,.22);
  --tb-border: rgba(15,23,42,.10); --tb-hover: rgba(15,23,42,.06); --tb-press: rgba(15,23,42,.11);
  --tb-shadow: 0 16px 40px rgba(15,23,42,.22), 0 4px 10px rgba(15,23,42,.12);
  --ic-filter: grayscale(1) brightness(.45) contrast(1.15);
  --ic-filter-hover: grayscale(1) brightness(.15) contrast(1.2);
}
.wrap[data-theme="light"]::before { background: linear-gradient(90deg, transparent, rgba(70,120,255,.4), transparent); }
.wrap[data-theme="glass"] {
  --tb-surface: linear-gradient(180deg, rgba(38,44,58,.44), rgba(10,13,20,.34));
  --tb-border: rgba(255,255,255,.3); --tb-hover: rgba(255,255,255,.16); --tb-press: rgba(255,255,255,.24);
  --tb-gear-surface: rgba(255,255,255,.14); --tb-gear-border: rgba(255,255,255,.28);
  --tb-shadow: 0 16px 42px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.24);
  --ic-filter: grayscale(1) brightness(2.4) contrast(.9);
  --ic-filter-hover: grayscale(1) brightness(3) contrast(.9);
  text-shadow: 0 1px 2px rgba(0,0,0,.6);
}
.wrap[data-theme="neon"] {
  --tb-text: #d9f6ff; --tb-text-hover: #fff; --tb-muted: #7fc6e0; --tb-faint: #5b93ab; --tb-accent: #67d6ff; --tb-gear: #9fe6ff;
  --tb-surface: linear-gradient(180deg, rgba(13,18,32,.95), rgba(6,9,18,.975));
  --tb-menu-surface: linear-gradient(180deg, rgba(10,15,28,.985), rgba(5,8,16,.99));
  --tb-gear-surface: rgba(80,190,255,.14); --tb-gear-border: rgba(103,214,255,.4);
  --tb-border: rgba(103,214,255,.36); --tb-hover: rgba(80,190,255,.14); --tb-press: rgba(80,190,255,.22);
  --tb-shadow: 0 12px 38px rgba(0,0,0,.55), 0 0 24px rgba(80,190,255,.2), inset 0 1px 0 rgba(160,230,255,.12);
  --ic-filter: grayscale(1) brightness(1.8) sepia(.4) hue-rotate(150deg) saturate(2);
  --ic-filter-hover: grayscale(1) brightness(2.1) sepia(.5) hue-rotate(150deg) saturate(2.6);
}
.wrap[data-theme="neon"]::before { background: linear-gradient(90deg, transparent, rgba(103,214,255,.75), transparent); }
.wrap[data-theme="light"] button.btn.gear:hover { background: rgba(47,98,200,.14); border-color: rgba(47,98,200,.35); }
.wrap[data-theme="glass"] button.btn.gear:hover { background: rgba(255,255,255,.24); border-color: rgba(255,255,255,.45); box-shadow: inset 0 1px 0 rgba(255,255,255,.3); }
.wrap[data-theme="neon"] button.btn.gear:hover { background: rgba(80,190,255,.26); border-color: rgba(103,214,255,.6); box-shadow: 0 0 20px rgba(80,190,255,.28); }
@keyframes mtb-breathe { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
.logbox {
  position: fixed; z-index: 2147483647; right: 16px; top: 96px; display: none; pointer-events: auto;
  width: min(360px, 42vw); max-height: 46vh; overflow: hidden; color: #dbe6ef;
  background: linear-gradient(180deg, rgba(27,30,39,.96), rgba(13,15,20,.975));
  border: 1px solid var(--tb-border); border-radius: 14px;
  box-shadow: 0 22px 58px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
  backdrop-filter: blur(20px) saturate(170%); -webkit-backdrop-filter: blur(20px) saturate(170%);
}
.logbox.show { display: block; }
.logbox header { display:flex; align-items:center; gap:8px; padding:8px 12px; background:rgba(255,255,255,.03); border-bottom:1px solid var(--tb-hairline); font-weight:600; font-size:12px; letter-spacing:.2px; cursor:move; }
.logbox header .sp { flex:1; }
.logbox header .act { cursor:pointer; color:var(--tb-muted); font-size:11.5px; padding:1px 7px; border-radius:5px; transition:background .13s, color .13s; }
.logbox header .act:hover { background:rgba(255,255,255,.08); color:#fff; }
.logbox .lines { max-height: calc(46vh - 34px); overflow:auto; padding:8px 12px 10px; font-family: ui-monospace,Consolas,monospace; font-size:11.5px; line-height:1.55; }
.logbox .ln { display:flex; gap:8px; white-space:pre-wrap; word-break:break-word; }
.logbox .ln .ts { color:#647589; flex:none; font-variant-numeric: tabular-nums; }
.logbox .ln.err { color:#ff9aa8; }
.logbox .ln.busy { color:#8ff0c5; }
.logbox .ln.busy .tx::before { content:''; display:inline-block; width:7px; height:7px; margin-right:6px; border-radius:50%; background:#5ce08a; animation: mtb-pulse 1s infinite ease-in-out; }
@keyframes mtb-pulse { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
.panel {
  position: absolute; z-index: 2147483647; display: none; max-width: min(580px, 92vw); pointer-events: auto;
  background: linear-gradient(180deg, rgba(27,30,39,.97), rgba(13,15,20,.985));
  backdrop-filter: blur(20px) saturate(170%); -webkit-backdrop-filter: blur(20px) saturate(170%);
  color: var(--tb-text); border: 1px solid var(--tb-border); border-radius: 14px;
  box-shadow: 0 26px 68px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.06);
  font-size: 12.5px; line-height: 1.5; overflow: hidden;
}
.panel.show { display: block; }
.panel header { display:flex; align-items:center; gap:8px; padding: 9px 12px; background:rgba(255,255,255,.03); border-bottom: 1px solid var(--tb-hairline); font-weight: 600; letter-spacing:.2px; cursor: move; }
.panel header .tt::before { content:''; display:inline-block; width:6px; height:6px; margin-right:8px; border-radius:50%; background:var(--tb-accent); box-shadow:0 0 9px rgba(110,168,255,.8); vertical-align:1px; }
.panel header .sp { flex: 1; }
.panel header .act { padding:2px 8px; border-radius:6px; color:var(--tb-muted); font-weight:500; transition:background .13s, color .13s; }
.panel header .act:hover { background:rgba(255,255,255,.08); color:#fff; }
.panel header .close { display:inline-grid; place-items:center; width:22px; height:22px; border-radius:6px; color:var(--tb-muted); }
.panel header .close:hover { background:rgba(255,107,125,.16); color:#ff9fae; }
.panel .body { padding: 12px; max-height: 62vh; overflow: auto; }
.panel .row { display:flex; gap:6px; align-items:center; flex-wrap: wrap; margin: 6px 0; }
.panel .k { color:var(--tb-muted); min-width: 92px; display:inline-block; }
.panel pre { margin:0; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace,Consolas,monospace; font-size: 12px; color:#dbe5f2; }
.panel button.act { background: rgba(255,255,255,.06); border:1px solid var(--tb-border); color:var(--tb-text); border-radius:8px; padding:5px 11px; cursor:pointer; font-size:12px; transition:background .14s, border-color .14s, color .14s; }
.panel button.act:hover { background: rgba(110,168,255,.16); border-color: rgba(110,168,255,.35); color:#fff; }
.panel img.result { max-width: 100%; max-height: 46vh; display:block; border-radius:8px; border:1px solid var(--tb-border); box-shadow:0 10px 28px rgba(0,0,0,.35); }
.panel .thumbs { display:flex; gap:8px; flex-wrap:wrap; }
.panel .thumbs figure { margin:0; width: 92px; }
.panel .thumbs img { width:92px; height: auto; display:block; border-radius:6px; border:1px solid var(--tb-border); }
.panel .thumbs figcaption { font-size:10.5px; color:var(--tb-muted); text-align:center; }
.panel .close { cursor:pointer; } .panel .close:hover { opacity:1; }
.masklayer { position:absolute; pointer-events:none; left:0; top:0; }
.masklayer canvas { position:absolute; left:0; top:0; width:100%; height:100%; }
.boxlayer { position:absolute; pointer-events:none; inset:0; }
.box { position:absolute; border:2px solid var(--bc, #5ce08a); box-shadow: 0 0 0 1px rgba(0,0,0,.5) inset, 0 0 12px rgba(92,224,138,.22); }
.box .tag { position:absolute; left:0; top:-16px; background: var(--bc,#5ce08a); color:#04121a; font-size:10px; padding:0 5px; border-radius:3px; white-space:nowrap; font-weight:700; letter-spacing:.2px; }
.pt { position:absolute; width:7px; height:7px; margin:-3.5px; border-radius:50%; background:#ff5c7a; box-shadow:0 0 0 1px #000, 0 0 8px rgba(255,92,122,.7); }
.toast { position:absolute; z-index:2147483647; left:50%; transform:translateX(-50%); bottom:26px; pointer-events:auto;
  background: linear-gradient(180deg, rgba(30,34,43,.97), rgba(14,16,21,.97)); color:#f2f6fc; padding:9px 16px; border-radius:10px; font-size:12.5px;
  border:1px solid var(--tb-border); box-shadow:0 16px 40px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); display:none; max-width:80vw; }
.toast.show { display:block; }
.toast.err { border-color:rgba(255,107,125,.6); color:#ffb3be; }
.pickhint { position:absolute; z-index:2147483647; left:50%; transform:translateX(-50%); top:12px; pointer-events:auto;
  background: linear-gradient(180deg, rgba(12,32,24,.94), rgba(8,22,17,.96));
  color:#c3ffdd; border:1px solid rgba(90,224,154,.45); padding:7px 14px; border-radius:10px; font-size:12.5px; display:none;
  box-shadow:0 10px 28px rgba(0,0,0,.45), 0 0 18px rgba(90,224,154,.15); }
.pickhint.show { display:block; }
.prompt { position:absolute; z-index:2147483647; display:none; pointer-events:auto;
  background: linear-gradient(180deg, rgba(28,31,40,.97), rgba(13,15,20,.985));
  border:1px solid var(--tb-border); border-radius:14px; padding:12px; width: min(430px, 90vw);
  box-shadow:0 24px 60px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.06);
  backdrop-filter: blur(20px) saturate(170%); -webkit-backdrop-filter: blur(20px) saturate(170%); }
.prompt.show { display:block; }
.prompt .t { font-weight:600; font-size:12.5px; letter-spacing:.2px; margin-bottom:8px; color:var(--tb-text); }
.prompt textarea { width:100%; height:66px; background:rgba(8,10,15,.8); color:#eef2f9; border:1px solid var(--tb-border); border-radius:9px; padding:9px 10px; font-size:12.5px; resize:vertical; outline:none; transition:border-color .15s, box-shadow .15s; }
.prompt textarea:focus { border-color:rgba(110,168,255,.6); box-shadow:0 0 0 3px rgba(110,168,255,.14); }
.prompt .row { display:flex; gap:6px; justify-content:flex-end; margin-top:10px; }
.prompt button { background:rgba(255,255,255,.06); border:1px solid var(--tb-border); color:var(--tb-text); border-radius:8px; padding:5px 12px; cursor:pointer; font-size:12px; transition:background .14s, border-color .14s; }
.prompt button:hover { background:rgba(255,255,255,.12); border-color:rgba(255,255,255,.2); }
.prompt button.primary { background: linear-gradient(135deg,#4f8dff,#7b6bff); border-color:transparent; color:#fff; box-shadow:0 6px 16px rgba(72,111,220,.35); }
.prompt button.primary:hover { filter:brightness(1.08); }
`;

function ensureRoot() {
    let host = document.getElementById(ROOT_ID);
    if (host) return { host, shadow: host.shadowRoot };
    host = document.createElement('div');
    host.id = ROOT_ID;
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483647;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    document.documentElement.appendChild(host);
    return { host, shadow };
}

function mountToolbar({ shadow, settings }) {
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.setAttribute('data-theme', settings.toolbar.theme);
    shadow.appendChild(wrap);
    const mask = document.createElement('div');
    mask.className = 'masklayer';
    shadow.appendChild(mask);
    const box = document.createElement('div');
    box.className = 'boxlayer';
    box.style.cssText = 'display:none;position:absolute;';
    shadow.appendChild(box);
    return { wrap, mask, box };
}

// 同一张图被滚动/布局挪动（1px 容差防抖动）
function rectMoved(a, r) {
    return !a || Math.abs(a.top - r.top) > 1 || Math.abs(a.left - r.left) > 1
        || Math.abs(a.width - r.width) > 1 || Math.abs(a.height - r.height) > 1;
}

class Toolbar {
    constructor({ wrap, settings, onDragEnd }) {
        this.wrap = wrap;
        this.settings = settings;
        this.onDragEnd = onDragEnd;
        this.items = [];
        this.buttons = new Map();
        this.dragging = false;
        this.pointer = { x: 0, y: 0 };
        this.bindDrag();
    }

    applySettings(settings) {
        this.settings = settings;
        const t = settings.toolbar;
        this.wrap.style.setProperty('--scale', String(t.scale));
        this.wrap.style.setProperty('--gap', t.gap + 'px');
        this.wrap.style.setProperty('--radius', t.radius + 'px');
        this.wrap.style.opacity = String(t.opacity);
        this.wrap.setAttribute('data-theme', t.theme);
        this.wrap.classList.toggle('vertical', t.layout === 'vertical');
        this.wrap.classList.toggle('grid', t.layout === 'grid');
        if (t.layout === 'grid') this.wrap.style.setProperty('--cols', String(t.gridColumns || 3));
        // 用新设置重建清单：直接渲染旧的 this.items 会让「常驻/折叠」改动拖到下次悬停才生效
        const items = this.itemBuilder ? this.itemBuilder(settings, this.mediaType || 'image') : this.items;
        this.render(items, this.mediaType);
    }

    render(items, mediaType) {
        this.items = items;
        this.mediaType = mediaType;
        this.buttons.clear();
        this.wrap.innerHTML = '';
        this.menu = null; // wrap 被清空，菜单节点也随之作废，必须重建
        this.menuOpen = false;
        const handle = document.createElement('div');
        handle.className = 'draghandle';
        handle.textContent = '⠿';
        handle.title = '拖动可改变工具栏位置';
        this.wrap.appendChild(handle);
        const limit = this.settings.toolbar.maxTools | 0;
        const capped = limit > 0 ? items.slice(0, limit) : items;
        const overflow = limit > 0 ? items.slice(limit) : [];
        // 常驻的直接排开，折叠的（加上超出 maxTools 的）收进 ▾ 下拉
        const pinned = capped.filter((it) => !it.collapsed);
        const folded = capped.filter((it) => it.collapsed).concat(overflow);
        for (const it of pinned) this.wrap.appendChild(this.makeButton(it));
        this.menuItems = folded;
        this.moreBtn = null;
        this.closeMenu();
        if (folded.length) {
            const more = document.createElement('button');
            more.className = 'btn more';
            more.innerHTML = `<span class="ic">⋯</span><span class="tx">更多</span><span class="caret">▾</span>`;
            more.title = `${folded.length} 个折叠的按钮`;
            more.dataset.tool = '__more';
            more.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.toggleMenu(); };
            this.wrap.appendChild(more);
            this.moreBtn = more;
            this.renderMenu();
        }
        const gear = document.createElement('button');
        gear.className = 'btn gear';
        gear.innerHTML = '<span class="ic">⚙️</span>';
        gear.title = '打开设置（可在设置里勾选要显示的按钮）';
        gear.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.onOpenSettings?.(); };
        this.wrap.appendChild(gear);
    }

    ensureMenu() {
        if (!this.menu) {
            const m = document.createElement('div');
            m.className = 'menu';
            this.wrap.appendChild(m);
            this.menu = m;
        }
        if (!this._docBound) {
            this._docBound = true;
            // 页面里很多组件会 stopPropagation，用捕获阶段才收得到「点了别处」；
            // shadow 里的目标在 document 上会被重定向，所以必须看 composedPath。
            // 监听只挂一次，内部一律读 this.menu（节点会随 render 重建）
            document.addEventListener('pointerdown', (e) => {
                if (!this.menuOpen || !this.menu) return;
                const path = e.composedPath ? e.composedPath() : [e.target];
                if (path.includes(this.menu) || (this.moreBtn && path.includes(this.moreBtn))) return;
                this.closeMenu();
            }, true);
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeMenu(); }, true);
        }
        return this.menu;
    }

    renderMenu() {
        const m = this.ensureMenu();
        m.innerHTML = '';
        const tip = document.createElement('div');
        tip.className = 'hint';
        tip.textContent = '折叠的功能（在设置里可改回常驻）';
        m.appendChild(tip);
        for (const it of this.menuItems || []) {
            const row = document.createElement('div');
            row.className = 'mi';
            row.innerHTML = `<span class="ic">${escapeHtml(it.icon || '•')}</span><span class="tx">${escapeHtml(it.label)}</span>`;
            row.title = it.hint || it.label;
            row.dataset.tool = it.id;
            row.onclick = (e) => {
                e.preventDefault(); e.stopPropagation();
                this.closeMenu();
                this.onClick?.(it, row, e);
            };
            this.buttons.set(it.id, row);
            m.appendChild(row);
        }
    }

    placeMenu() {
        const m = this.menu;
        if (!m) return;
        m.style.bottom = 'auto'; m.style.top = 'auto'; m.style.left = 'auto'; m.style.right = 'auto';
        const r = this.wrap.getBoundingClientRect();
        const h = m.offsetHeight;
        if (r.bottom + h + 10 > window.innerHeight && r.top - h - 10 > 0) {
            m.style.bottom = '100%';
            m.style.marginBottom = '4px';
        } else {
            m.style.top = '100%';
            m.style.marginTop = '4px';
        }
        // 菜单跟着「⋯ 更多」按钮走：CSS 里 .menu 是 left:0，会贴到整条工具栏的左端，
        // 按钮在右边时看着就像"菜单飘在别处"。这里按按钮对齐，并保证不出视口。
        const btn = (this.moreBtn ? this.moreBtn.getBoundingClientRect() : r);
        const w = m.offsetWidth || 168;
        let x = btn.left;
        if (x + w > window.innerWidth - 4) x = btn.right - w;
        x = Math.max(4, Math.min(x, window.innerWidth - w - 4));
        m.style.left = `${Math.round(x - r.left)}px`;
    }

    openMenu() {
        if (!this.menuItems || !this.menuItems.length) return;
        const m = this.ensureMenu();
        m.classList.add('show');
        this.menuOpen = true;
        this.placeMenu();
    }

    toggleMenu() { if (this.menuOpen) this.closeMenu(); else this.openMenu(); }

    closeMenu() {
        this.menuOpen = false;
        if (this.menu) this.menu.classList.remove('show');
    }

    makeButton(item) {
        const b = document.createElement('button');
        const mode = this.settings.toolbar.iconMode;
        b.className = 'btn' + (mode === 'icon' ? ' icon' : mode === 'text' ? ' text' : '');
        b.innerHTML = `<span class="ic">${escapeHtml(item.icon || '•')}</span><span class="tx">${escapeHtml(item.label)}</span>`;
        b.title = item.hint || item.label;
        b.dataset.tool = item.id;
        b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.onClick?.(item, b, e); };
        this.buttons.set(item.id, b);
        return b;
    }

    setBusy(id, text) {
        const b = this.buttons.get(id);
        if (!b) { this.onLog?.(text || ''); return; }   // '__progress' 这类没有对应按钮的，交给日志窗
        b.disabled = !!text;
        b.classList.toggle('busy', !!text);
        if (text) this.onLog?.(text);
    }

    resetBusy() {
        for (const b of this.buttons.values()) {
            b.disabled = false;
            b.classList.remove('busy');
        }
    }

    bindDrag() {
        let start = null;
        const onDown = (e) => {
            if (!e.target.classList.contains('draghandle')) return;
            e.preventDefault(); e.stopPropagation();
            this.dragging = true;
            this.wrap.classList.add('dragging');
            // 拖动基准是「当前已经落位的屏幕坐标」：位置是锁住的，不能从媒体矩形重算
            start = {
                x: e.clientX, y: e.clientY,
                placed: { ...(this.placed || this.lock || { x: 0, y: 0 }) },
                off: { ...this.settings.toolbar },
            };
            window.addEventListener('pointermove', onMove, true);
            window.addEventListener('pointerup', onUp, true);
        };
        const onMove = (e) => {
            if (!this.dragging) return;
            e.preventDefault();
            this.lock = { x: start.placed.x + (e.clientX - start.x), y: start.placed.y + (e.clientY - start.y) };
            this.placeAt(this.lock.x, this.lock.y);
        };
        const onUp = async () => {
            if (!this.dragging) return;
            this.dragging = false;
            this.wrap.classList.remove('dragging');
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
            // 只累加「真正移动了多少」：拖到屏幕边上被夹住时不会把偏移量算多，
            // 下次重新锚定（换图后首次弹出）才能落在拖过的位置
            const dx = Math.round((this.placed?.x ?? 0) - start.placed.x);
            const dy = Math.round((this.placed?.y ?? 0) - start.placed.y);
            const next = { ...this.settings.toolbar, offsetX: Math.round((start.off.offsetX || 0) + dx), offsetY: Math.round((start.off.offsetY || 0) + dy), anchorOffset: 'custom', dragMoved: true };
            this.settings.toolbar = next;
            await this.onDragEnd?.(next);
        };
        this.wrap.addEventListener('pointerdown', onDown, true);
        // 在窗口外松手 / 系统打断手势时 pointerup 会丢，拖拽状态卡住就一直残留
        const abort = () => {
            if (!this.dragging) return;
            this.dragging = false;
            this.wrap.classList.remove('dragging');
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
        };
        window.addEventListener('pointercancel', abort, true);
        window.addEventListener('blur', abort, true);
    }

    // 按 anchor+offset 算出工具栏应落在的屏幕坐标（视口系）
    anchorPoint(rect) {
        const t = this.settings.toolbar;
        const w = this.wrap.offsetWidth, h = this.wrap.offsetHeight;
        const m = 8;
        let top, left;
        switch (t.anchor) {
            case 'top-left': top = rect.top + m; left = rect.left + m; break;
            case 'bottom-right': top = rect.bottom - h - m; left = rect.right - w - m; break;
            case 'bottom-left': top = rect.bottom - h - m; left = rect.left + m; break;
            case 'center': top = rect.top + (rect.height - h) / 2; left = rect.left + (rect.width - w) / 2; break;
            case 'top-edge': top = rect.top + m; left = rect.left + (rect.width - w) / 2; break;
            case 'bottom-edge': top = rect.bottom - h - m; left = rect.left + (rect.width - w) / 2; break;
            case 'left-edge': top = rect.top + (rect.height - h) / 2; left = rect.left + m; break;
            case 'right-edge': top = rect.top + (rect.height - h) / 2; left = rect.right - w - m; break;
            default: top = rect.top + m; left = rect.right - w - m;
        }
        return { x: left + (t.offsetX || 0), y: top + (t.offsetY || 0) };
    }

    // 视口夹取：按钮多到比视口还宽时 Math.max 兜底的下界优先，保证不会被推出屏幕
    placeAt(x, y) {
        const host = this.wrap.getRootNode().host;
        const hr = host ? host.getBoundingClientRect() : null;
        const ox = hr ? hr.left : 0, oy = hr ? hr.top : 0;
        const vw = hr && hr.width ? hr.width : window.innerWidth;
        const vh = hr && hr.height ? hr.height : window.innerHeight;
        const w = this.wrap.offsetWidth, h = this.wrap.offsetHeight;
        // 宿主是铺满视口的 fixed 层，绝对定位的坐标原点就是宿主左上角。
        // 旧写法额外加 window.scrollX/Y，页面一滚动工具栏就跟着往下飞
        const cx = Math.max(4, Math.min(x - ox, Math.max(4, vw - w - 4)));
        const cy = Math.max(4, Math.min(y - oy, Math.max(4, vh - h - 4)));
        this.wrap.style.left = cx + 'px';
        this.wrap.style.top = cy + 'px';
        this.placed = { x: cx + ox, y: cy + oy };
    }

    // rect = 媒体元素在视口中的矩形。只要矩形变了就重新锚定：滚动/布局把图挪走、
    // 或指针换到另一张图，工具栏都得贴着图走；矩形没变就不动，免得心跳重探把它原地抖出来。
    // 认矩形不认元素身份：大图查看器常在加载原图时换掉 <img> 节点，按节点认会永久冻在旧锚点上。
    position(rect, force = false) {
        if (!rect) return;
        this.currentTarget = rect;
        if (force || rectMoved(this.lockRect, rect)) {
            this.lock = this.anchorPoint(rect);
            this.lockRect = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
        }
        this.placeAt(this.lock.x, this.lock.y);
        if (this.menuOpen) this.placeMenu();
        if (this.onMoved) this.onMoved(rect);
    }

    show(rect, force = false) {
        this.wrap.classList.add('show');
        this.position(rect, force);
    }

    hide() {
        this.wrap.classList.remove('show');
        this.currentTarget = null;
        this.lock = null;
        this.placed = null;
        this.lockRect = null;
    }
}

class ResultPanel {
    constructor({ shadow, settings }) {
        this.shadow = shadow;
        this.el = document.createElement('div');
        this.el.className = 'panel';
        this.el.innerHTML = `<header><span class="tt">结果</span><span class="sp"></span><span class="act export">导出</span><span class="act copy">复制</span><span class="close">✕</span></header><div class="body"></div>`;
        shadow.appendChild(this.el);
        this.tt = this.el.querySelector('.tt');
        this.body = this.el.querySelector('.body');
        this.el.querySelector('.close').onclick = () => this.hide();
        this.bindDrag();
        this.current = null;
    }

    bindDrag() {
        const header = this.el.querySelector('header');
        let s = null;
        header.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.act') || e.target.closest('.close')) return;
            s = { x: e.clientX, y: e.clientY, top: parseFloat(this.el.style.top), left: parseFloat(this.el.style.left) };
            header.setPointerCapture(e.pointerId);
        });
        header.addEventListener('pointermove', (e) => {
            if (!s) return;
            this.el.style.left = (s.left + e.clientX - s.x) + 'px';
            this.el.style.top = (s.top + e.clientY - s.y) + 'px';
        });
        header.addEventListener('pointerup', () => { s = null; });
    }

    show({ title = '结果', html = '', dataUrl = null, text = null, actions = [], near = null, thumbs = null }) {
        this.tt.textContent = title;
        const parts = [];
        if (dataUrl) parts.push(`<img class="result" src="${dataUrl}" alt="结果" />`);
        if (thumbs?.length) parts.push('<div class="thumbs">' + thumbs.map((t) => `<figure><img src="${t.dataUrl}"/><figcaption>${escapeHtml(t.caption || '')}</figcaption></figure>`).join('') + '</div>');
        if (text) parts.push(`<pre>${escapeHtml(text)}</pre>`);
        if (html) parts.push(html);
        this.body.innerHTML = parts.join('');
        const row = document.createElement('div');
        row.className = 'row';
        for (const a of actions) {
            const b = document.createElement('button');
            b.className = 'act';
            b.textContent = a.label;
            b.onclick = () => a.run();
            row.appendChild(b);
        }
        if (row.childNodes.length) this.body.appendChild(row);
        this.current = { dataUrl, text };
        this.el.classList.add('show');
        this.el.querySelector('.export').style.display = dataUrl ? '' : 'none';
        this.el.querySelector('.copy').style.display = (text || dataUrl) ? '' : 'none';
        this.place(near);
        return this;
    }

    place(near) {
        const w = this.el.offsetWidth, h = this.el.offsetHeight;
        // 日志窗占着右边，结果面板别再压上去
        const dock = this.shadow && this.shadow.querySelector('.logbox.show');
        const reserve = dock ? dock.offsetWidth + 28 : 16;
        let left = near ? near.right + 12 : innerWidth - w - reserve;
        if (left + w > innerWidth - reserve || !near) left = Math.max(8, innerWidth - w - reserve);
        const top = near ? Math.max(8, Math.min(near.top, innerHeight - h - 12)) : 40;
        this.el.style.left = left + 'px';
        this.el.style.top = top + 'px';
        this.el.style.position = 'fixed';
    }

    hide() { this.el.classList.remove('show'); }
    get visible() { return this.el.classList.contains('show'); }
}

/** 右侧悬浮日志窗：推理中/取帧/失败这类过程信息都进这里，不再挤在工具栏按钮旁边 */
class LogDock {
    constructor({ shadow, autoHideMs = 10000, max = 120 }) {
        const el = document.createElement('div');
        el.className = 'logbox';
        el.innerHTML = `<header><span class="tt">日志</span><span class="sp"></span><span class="act clear">清空</span><span class="act close">✕</span></header><div class="lines"></div>`;
        shadow.appendChild(el);
        this.el = el;
        this.lines = el.querySelector('.lines');
        this.max = max;
        this.autoHideMs = autoHideMs;
        this.busy = null;
        this.timer = 0;
        el.querySelector('.close').onclick = () => this.hide();
        el.querySelector('.clear').onclick = () => { this.lines.innerHTML = ''; this.busy = null; this.hide(); };
        this.bindDrag();
        el.__log = (text, err) => this.line(text, { err });
    }

    line(text, { err = false } = {}) {
        const t = String(text || '').trim();
        if (!t) return null;
        this.endBusy();
        const row = this.append(t, { err });
        this.open();
        this.scheduleHide();
        return row;
    }

    // 进行中的任务原地刷同一行（准备模型… → 推理中…），传空串表示结束并补上耗时
    status(text) {
        const t = String(text || '').trim();
        if (!t) { this.endBusy(); this.scheduleHide(); return; }
        const err = /失败|错误|异常/.test(t);
        if (this.busy) {
            if (this.busy.text !== t) { this.busy.text = t; this.busy.row.querySelector('.tx').textContent = t; }
            this.busy.row.classList.toggle('err', err);
            clearTimeout(this.timer);
        } else {
            this.busy = { row: this.append(t, { err, busy: true }), text: t, at: Date.now() };
            this.open();
        }
        return this;
    }

    endBusy() {
        if (!this.busy) return;
        const { row, at, text } = this.busy;
        const secs = (Date.now() - at) / 1000;
        row.querySelector('.tx').textContent = `${text} · ${secs >= 1 ? secs.toFixed(1) + 's' : Math.round(secs * 1000) + 'ms'}`;
        row.classList.remove('busy');
        this.busy = null;
    }

    append(text, { err = false, busy = false } = {}) {
        const row = document.createElement('div');
        row.className = 'ln' + (err ? ' err' : '') + (busy ? ' busy' : '');
        const ts = document.createElement('span');
        ts.className = 'ts';
        ts.textContent = clockTime();
        const tx = document.createElement('span');
        tx.className = 'tx';
        tx.textContent = text;
        row.append(ts, tx);
        this.lines.appendChild(row);
        while (this.lines.children.length > this.max) this.lines.removeChild(this.lines.firstChild);
        this.lines.scrollTop = this.lines.scrollHeight;
        return row;
    }

    open() { this.el.classList.add('show'); }
    hide() { this.endBusy(); this.el.classList.remove('show'); }
    get visible() { return this.el.classList.contains('show'); }
    scheduleHide() { clearTimeout(this.timer); this.timer = setTimeout(() => this.hide(), this.autoHideMs); }

    bindDrag() {
        const header = this.el.querySelector('header');
        let s = null;
        header.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.act')) return;
            const r = this.el.getBoundingClientRect();
            s = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
            header.setPointerCapture(e.pointerId);
        });
        header.addEventListener('pointermove', (e) => {
            if (!s) return;
            this.el.style.right = 'auto';
            this.el.style.left = Math.max(4, s.left + e.clientX - s.x) + 'px';
            this.el.style.top = Math.max(4, Math.min(s.top + e.clientY - s.y, innerHeight - 40)) + 'px';
        });
        header.addEventListener('pointerup', () => { s = null; });
        header.addEventListener('pointercancel', () => { s = null; });
    }
}

function clockTime() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

class Picker {
    constructor({ shadow, settings }) {
        this.el = document.createElement('div');
        this.el.className = 'pickhint';
        shadow.appendChild(this.el);
        this.active = false;
        this.handler = null;
    }

    start(text, onPoint, onDone) {
        this.active = true;
        this.el.textContent = text;
        this.el.classList.add('show');
        this.onPoint = onPoint;
        this.onDone = onDone;
        this.handler = (e) => {
            if (!this.active) return;
            if (e.key === 'Escape') { this.stop(); onDone?.(null); return; }
            if (e.type !== 'mousedown') return;
            const t = e.target;
            if (t.closest && t.closest('#' + ROOT_ID)) return;
            e.preventDefault(); e.stopPropagation();
            const rect = this.rect || document.body.getBoundingClientRect();
            onPoint?.({ clientX: e.clientX, clientY: e.clientY, x: e.clientX - rect.left, y: e.clientY - rect.top, negative: e.button === 2 || e.shiftKey });
            if (e.button === 2) this.stop(), onDone?.('cancel');
        };
        window.addEventListener('mousedown', this.handler, true);
        window.addEventListener('keydown', this.handler, true);
        // 屏蔽页面自身对该次点击的响应
        const blocker = (e) => { if (this.active) { e.stopPropagation(); } };
        this.blocker = blocker;
        for (const type of ['mousedown', 'mouseup', 'click']) window.addEventListener(type, blocker, true);
    }

    stop() {
        this.active = false;
        this.el.classList.remove('show');
        if (this.handler) { window.removeEventListener('mousedown', this.handler, true); window.removeEventListener('keydown', this.handler, true); }
        if (this.blocker) for (const type of ['mousedown', 'mouseup', 'click']) window.removeEventListener(type, this.blocker, true);
    }

    setRect(rect) { this.rect = rect; }
}

function drawBoxes(layer, boxes, rect) {
    if (!layer) return;
    layer.innerHTML = '';
    if (!boxes || !boxes.length || !rect) { layer.style.display = 'none'; return; }
    layer.style.display = 'block';
    layer.style.left = rect.left + window.scrollX + 'px';
    layer.style.top = rect.top + window.scrollY + 'px';
    layer.style.width = rect.width + 'px';
    layer.style.height = rect.height + 'px';
    const kx = rect.width, ky = rect.height;
    boxes.forEach((b, i) => {
        const d = document.createElement('div');
        d.className = 'box';
        const colors = ['#5ce08a', '#ff6b8a', '#5cc8ff', '#ffd166', '#c77dff'];
        d.style.setProperty('--bc', b.color || colors[i % colors.length]);
        d.style.left = (b.x / (b.refWidth || kx) * 100) + '%';
        d.style.top = (b.y / (b.refHeight || ky) * 100) + '%';
        d.style.width = ((b.width || 10) / (b.refWidth || kx) * 100) + '%';
        d.style.height = ((b.height || 10) / (b.refHeight || ky) * 100) + '%';
        if (b.label) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = b.label; d.appendChild(t); }
        layer.appendChild(d);
    });
    for (const p of (boxes.points || [])) {
        const dot = document.createElement('div');
        dot.className = 'pt';
        dot.style.left = (p.x / kx * 100) + '%';
        dot.style.top = (p.y / ky * 100) + '%';
        layer.appendChild(dot);
    }
}

function drawMask(layer, maskUrls, rect, { color = 'rgba(90,220,140,.45)' } = {}) {
    if (!layer) return;
    layer.innerHTML = '';
    if (!rect) return;
    layer.style.left = rect.left + window.scrollX + 'px';
    layer.style.top = rect.top + window.scrollY + 'px';
    layer.style.width = rect.width + 'px';
    layer.style.height = rect.height + 'px';
    (maskUrls || []).forEach((url) => {
        const c = document.createElement('canvas');
        const img = new Image();
        img.onload = () => {
            c.width = img.width; c.height = img.height;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const id = ctx.getImageData(0, 0, c.width, c.height);
            for (let i = 0; i < id.data.length; i += 4) {
                const on = id.data[i] > 127;
                id.data[i] = on ? 90 : 0; id.data[i + 1] = on ? 220 : 0; id.data[i + 2] = on ? 140 : 0;
                id.data[i + 3] = on ? 115 : 0;
            }
            ctx.putImageData(id, 0, 0);
        };
        img.src = url;
        layer.appendChild(c);
    });
}

function toast(shadow, text, ms = 2600, isError = false) {
    let el = shadow.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; shadow.appendChild(el); }
    el.textContent = text;
    el.classList.toggle('err', !!isError);
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), ms);
    const dock = shadow.querySelector('.logbox');
    if (dock && dock.__log) dock.__log(text, !!isError);   // 一闪而过的提示在日志窗里留个底
    return el;
}

function promptFor(shadow, { title = '输入', placeholder = '', value = '', near = null } = {}) {
    return new Promise((resolve) => {
        let el = shadow.querySelector('.prompt');
        if (!el) {
            el = document.createElement('div');
            el.className = 'prompt';
            el.innerHTML = `<div class="t"></div><textarea></textarea><div class="row"><button class="c">取消</button><button class="primary ok">确定</button></div>`;
            shadow.appendChild(el);
        }
        el.querySelector('.t').textContent = title;
        const ta = el.querySelector('textarea');
        ta.value = value;
        el.classList.add('show');
        el.style.position = 'fixed';
        el.style.left = (near ? Math.min(near.left, innerWidth - 440) : innerWidth / 2 - 210) + 'px';
        el.style.top = (near ? Math.max(10, near.top) : innerHeight / 3) + 'px';
        const done = (v) => { el.classList.remove('show'); el.querySelector('.ok').onclick = null; el.querySelector('.c').onclick = null; resolve(v); };
        el.querySelector('.ok').onclick = () => done(ta.value.trim());
        el.querySelector('.c').onclick = () => done(null);
        ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(ta.value.trim()); } if (e.key === 'Escape') done(null); };
        setTimeout(() => ta.focus(), 30);
    });
}

function attachToActiveLayer(host) {
    const fs = document.fullscreenElement;
    const target = fs && !['VIDEO', 'AUDIO', 'CANVAS', 'IMG', 'PICTURE'].includes(fs.tagName) ? fs : document.documentElement;
    if (host.parentNode !== target) target.appendChild(host);
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}


return { "CSS": (typeof CSS === 'undefined' ? undefined : CSS), "ensureRoot": (typeof ensureRoot === 'undefined' ? undefined : ensureRoot), "mountToolbar": (typeof mountToolbar === 'undefined' ? undefined : mountToolbar), "Toolbar": (typeof Toolbar === 'undefined' ? undefined : Toolbar), "ResultPanel": (typeof ResultPanel === 'undefined' ? undefined : ResultPanel), "LogDock": (typeof LogDock === 'undefined' ? undefined : LogDock), "Picker": (typeof Picker === 'undefined' ? undefined : Picker), "drawBoxes": (typeof drawBoxes === 'undefined' ? undefined : drawBoxes), "drawMask": (typeof drawMask === 'undefined' ? undefined : drawMask), "toast": (typeof toast === 'undefined' ? undefined : toast), "promptFor": (typeof promptFor === 'undefined' ? undefined : promptFor), "attachToActiveLayer": (typeof attachToActiveLayer === 'undefined' ? undefined : attachToActiveLayer), "escapeHtml": (typeof escapeHtml === 'undefined' ? undefined : escapeHtml), "ROOT_ID": (typeof ROOT_ID === 'undefined' ? undefined : ROOT_ID) };
})();
__M["src/common/util.js"] = (function(){
// 通用小工具：无 chrome / DOM 依赖，content、host、options 共用。

const MB = 1048576;

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

// 数值容错解析：设置页所有 input 都走这里，空/非法一律回落到默认值
function toNum(v, def = 0) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : def;
}

function toInt(v, def = 0) {
    return Math.round(toNum(v, def));
}

function deepMerge(base, patch) {
    if (Array.isArray(base) || Array.isArray(patch)) return clone(patch !== undefined ? patch : base);
    if (!isObj(base)) return clone(patch === undefined ? base : patch);
    const out = clone(base);
    if (!isObj(patch)) return out;
    for (const k of Object.keys(patch)) {
        out[k] = isObj(patch[k]) && isObj(base[k]) ? deepMerge(base[k], patch[k]) : clone(patch[k]);
    }
    return out;
}

function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(clone);
    const o = {};
    for (const k of Object.keys(v)) o[k] = clone(v[k]);
    return o;
}

let idSeq = 0;
function uid(prefix = 't') {
    idSeq = (idSeq + 1) % 100000;
    return `${prefix}_${Date.now().toString(36)}${idSeq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function formatBytes(n) {
    if (!isNum(n) || n < 0) return '?';
    if (n < 1024) return n + ' B';
    if (n < MB) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    if (n < 1024 * MB) return (n / MB).toFixed(n < 10 * MB ? 1 : 0) + ' MB';
    return (n / (1024 * MB)).toFixed(2) + ' GB';
}

function formatDuration(sec) {
    if (!isNum(sec)) return '--:--';
    const s = Math.max(0, sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
    const ss = r.toFixed(2).padStart(5, '0');
    return (h > 0 ? h + ':' : '') + mm + ':' + ss;
}

// Windows/Linux 文件名非法字符；站点 URL 路径段常含冒号（抖音 tplv 参数），必须清洗
function sanitizeFilename(name, max = 120) {
    let s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
    if (s.length > max) s = s.slice(0, max);
    if (!s) s = 'image_' + Date.now();
    return s;
}

// 内容指纹（采样 FNV-1a + 长度）：判断「同名的是不是同一张图」，不用把整张图算一遍
function bytesFingerprint(bytes) {
    const n = bytes ? bytes.length : 0;
    let h = 0x811c9dc5;
    const step = n > 65536 ? Math.floor(n / 65536) : 1;
    for (let i = 0; i < n; i += step) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return n + ':' + h.toString(16);
}

// ComfyUI 的 /upload/image 带 overwrite:true，同名不同内容会互相盖掉（用户报的「只剩最后一张」）。
// 同一张图重复发还是复用同名，只有内容不同才加 _2/_3 序号。
function uniqueUploadName(used, filename, fingerprint) {
    const seen = used.get(filename);
    if (seen === undefined) { used.set(filename, fingerprint); return filename; }
    if (seen === fingerprint) return filename;
    const dot = String(filename).lastIndexOf('.');
    const base = dot > 0 ? String(filename).slice(0, dot) : String(filename);
    const ext = dot > 0 ? String(filename).slice(dot) : '';
    for (let i = 2; i < 1000; i++) {
        const cand = `${base}_${i}${ext}`;
        const s = used.get(cand);
        if (s === undefined) { used.set(cand, fingerprint); return cand; }
        if (s === fingerprint) return cand;
    }
    const tail = `${base}_${Date.now().toString(36)}${ext}`;
    used.set(tail, fingerprint);
    return tail;
}

function extFromMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('png')) return 'png';
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    if (m.includes('webp')) return 'webp';
    if (m.includes('gif')) return 'gif';
    if (m.includes('avif')) return 'avif';
    if (m.includes('bmp')) return 'bmp';
    if (m.includes('svg')) return 'svg';
    if (m.includes('tiff')) return 'tif';
    if (m.includes('mp4')) return 'mp4';
    if (m.includes('webm')) return 'webm';
    return 'png';
}

function mimeFromExt(name) {
    const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    const e = m ? m[1].toLowerCase() : '';
    return ({
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
        gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
        mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4s: 'video/mp4',
    })[e] || 'application/octet-stream';
}

function baseNameFromUrl(url) {
    try {
        const u = new URL(url);
        const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
        return seg || '';
    } catch (e) {
        return '';
    }
}

function filenameFromUrl(url, fallbackExt = 'png') {
    const base = baseNameFromUrl(url);
    if (base && base.includes('.')) return sanitizeFilename(base);
    const host = (() => { try { return new URL(url).hostname; } catch (e) { return 'web'; } })();
    return sanitizeFilename(`${host}_${Date.now()}.${fallbackExt}`);
}

// 模板替换：链接型工具用 {src} {width} {height} {time} {pageUrl} {filename} 等占位符
function fillTemplate(tpl, vars) {
    return String(tpl || '').replace(/\{([a-zA-Z0-9_.]+)\}/g, (all, key) => {
        const v = vars[key];
        if (v === undefined || v === null) return '';
        return encodeURIComponent(String(v));
    });
}

function fillTemplateRaw(tpl, vars) {
    return String(tpl || '').replace(/\{([a-zA-Z0-9_.]+)\}/g, (all, key) => {
        const v = vars[key];
        return v === undefined || v === null ? '' : String(v);
    });
}

function debounce(fn, ms = 200) {
    let t = null;
    return (...args) => {
        if (t) clearTimeout(t);
        t = setTimeout(() => { t = null; fn(...args); }, ms);
    };
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function bytesToBase64(bytes) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

function base64ToBytes(b64) {
    const bin = atob(b64.replace(/^data:[^,]*;base64,/, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function dataUrlToBytes(dataUrl) {
    const i = String(dataUrl).indexOf(',');
    if (i < 0) throw new Error('不是合法的 dataURL');
    const meta = dataUrl.slice(0, i);
    const mime = /^data:([^;,]*)/.exec(meta)?.[1] || 'application/octet-stream';
    if (meta.includes(';base64')) return { mime, bytes: base64ToBytes(dataUrl.slice(i + 1)) };
    return { mime, bytes: new TextEncoder().encode(decodeURIComponent(dataUrl.slice(i + 1))) };
}

function bytesToDataUrl(bytes, mime = 'image/png') {
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

// dataURL 头部嗅探真实类型：站点经常把 jpeg 标成 png 或反之
function sniffMime(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const hex = (n) => Array.from(b.slice(0, n)).map((x) => x.toString(16).padStart(2, '0')).join('');
    const s = hex(Math.min(12, b.length));
    if (s.startsWith('89504e47')) return 'image/png';
    if (s.startsWith('ffd8ff')) return 'image/jpeg';
    if (s.startsWith('47494638')) return 'image/gif';
    if (s.startsWith('424d')) return 'image/bmp';
    if (b.length >= 12 && s.slice(0, 8) === '52494646' && hex(12).slice(16) === '57454250') return 'image/webp';
    if (b.length >= 12 && s.slice(0, 8) === '52494646') {
        const sub = hex(12).slice(16);
        if (sub === '41564946') return 'image/avif';
        if (sub === '57454250') return 'image/webp';
    }
    if (s.startsWith('000001')) return 'video/mp4';
    if (hex(4) === '1a45dfa3') return 'video/webm';
    return 'image/png';
}

function ratioText(w, h) {
    if (!w || !h) return '?';
    const g = (a, b) => (b ? g(b, a % b) : a);
    const d = g(w, h) || 1;
    const rw = w / d, rh = h / d;
    if (rw <= 64 && rh <= 64) return `${rw}:${rh}`;
    return `${(w / h).toFixed(3)}:1`;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 相对/绝对坐标互转，裁剪与标注叠加都要用
function normRect(r, w, h) {
    let { x = 0, y = 0, width = w, height = h } = r || {};
    if (r && r.relative) {
        x *= w; y *= h; width *= w; height *= h;
    }
    x = clamp(Math.round(x), 0, w);
    y = clamp(Math.round(y), 0, h);
    width = clamp(Math.round(width), 0, w - x);
    height = clamp(Math.round(height), 0, h - y);
    return { x, y, width, height };
}

function pick(obj, keys) {
    const out = {};
    for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
    return out;
}

return { "MB": (typeof MB === 'undefined' ? undefined : MB), "clamp": (typeof clamp === 'undefined' ? undefined : clamp), "lerp": (typeof lerp === 'undefined' ? undefined : lerp), "isNum": (typeof isNum === 'undefined' ? undefined : isNum), "toNum": (typeof toNum === 'undefined' ? undefined : toNum), "toInt": (typeof toInt === 'undefined' ? undefined : toInt), "deepMerge": (typeof deepMerge === 'undefined' ? undefined : deepMerge), "isObj": (typeof isObj === 'undefined' ? undefined : isObj), "clone": (typeof clone === 'undefined' ? undefined : clone), "uid": (typeof uid === 'undefined' ? undefined : uid), "formatBytes": (typeof formatBytes === 'undefined' ? undefined : formatBytes), "formatDuration": (typeof formatDuration === 'undefined' ? undefined : formatDuration), "sanitizeFilename": (typeof sanitizeFilename === 'undefined' ? undefined : sanitizeFilename), "bytesFingerprint": (typeof bytesFingerprint === 'undefined' ? undefined : bytesFingerprint), "uniqueUploadName": (typeof uniqueUploadName === 'undefined' ? undefined : uniqueUploadName), "extFromMime": (typeof extFromMime === 'undefined' ? undefined : extFromMime), "mimeFromExt": (typeof mimeFromExt === 'undefined' ? undefined : mimeFromExt), "baseNameFromUrl": (typeof baseNameFromUrl === 'undefined' ? undefined : baseNameFromUrl), "filenameFromUrl": (typeof filenameFromUrl === 'undefined' ? undefined : filenameFromUrl), "fillTemplate": (typeof fillTemplate === 'undefined' ? undefined : fillTemplate), "fillTemplateRaw": (typeof fillTemplateRaw === 'undefined' ? undefined : fillTemplateRaw), "debounce": (typeof debounce === 'undefined' ? undefined : debounce), "sleep": (typeof sleep === 'undefined' ? undefined : sleep), "bytesToBase64": (typeof bytesToBase64 === 'undefined' ? undefined : bytesToBase64), "base64ToBytes": (typeof base64ToBytes === 'undefined' ? undefined : base64ToBytes), "dataUrlToBytes": (typeof dataUrlToBytes === 'undefined' ? undefined : dataUrlToBytes), "bytesToDataUrl": (typeof bytesToDataUrl === 'undefined' ? undefined : bytesToDataUrl), "sniffMime": (typeof sniffMime === 'undefined' ? undefined : sniffMime), "ratioText": (typeof ratioText === 'undefined' ? undefined : ratioText), "escapeHtml": (typeof escapeHtml === 'undefined' ? undefined : escapeHtml), "normRect": (typeof normRect === 'undefined' ? undefined : normRect), "pick": (typeof pick === 'undefined' ? undefined : pick) };
})();
__M["src/common/imgops/geometry.js"] = (function(){
// 重采样与几何变换：全部在像素数组上完成，不经 canvas，保证可单测与跨上下文一致。

const { clamp, toNum, toInt, normRect } = __M["src/common/util.js"];

function mkPx(width, height, data) {
    return { width, height, data: data || new Uint8ClampedArray(width * height * 4) };
}

function clonePx(src) {
    return mkPx(src.width, src.height, new Uint8ClampedArray(src.data));
}

const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const lanczos = (a) => (x) => (Math.abs(x) >= a ? 0 : sinc(x) * sinc(x / a));

// Keys 三次卷积核：a=-0.5 为 Catmull-Rom（bicubic），a=1 为立方 B 样条
function keysCubic(a) {
    return (x) => {
        const ax = Math.abs(x);
        if (ax <= 1) return ((a + 2) * ax - (a + 3)) * ax * ax + 1;
        if (ax < 2) return ((-a * ax + 5 * a) * ax - 8 * a) * ax + 4 * a;
        return 0;
    };
}

const RESAMPLE_FILTERS = {
    nearest: { support: 0.5, fn: () => 1 },
    box: { support: 0.5, fn: (x) => (Math.abs(x) <= 0.5 ? 1 : 0) },
    triangle: { support: 1, fn: (x) => (Math.abs(x) >= 1 ? 0 : 1 - Math.abs(x)) },
    bicubic: { support: 2, fn: keysCubic(-0.5) },
    bspline: { support: 2, fn: keysCubic(1) },
    mitchell: { support: 2, fn: keysCubic(1 / 3) },
    lanczos2: { support: 2, fn: lanczos(2) },
    lanczos3: { support: 3, fn: lanczos(3) },
    lanczos4: { support: 4, fn: lanczos(4) },
};
// area 是缩小的别名：等价于按目标像素覆盖的源区域做面积加权平均
RESAMPLE_FILTERS.area = { support: 0.5, fn: RESAMPLE_FILTERS.box.fn };

function buildAxis(inSize, outSize, filterName) {
    const f = RESAMPLE_FILTERS[filterName] || RESAMPLE_FILTERS.lanczos3;
    const ratio = inSize / outSize;
    if (filterName === 'nearest') {
        const taps = new Array(outSize);
        for (let i = 0; i < outSize; i++) {
            taps[i] = { idx: [clamp(Math.round((i + 0.5) * ratio - 0.5), 0, inSize - 1)], sum: [1] };
        }
        return taps;
    }
    const support = f.support * (ratio > 1 ? ratio : 1);
    // 缩小时把核按缩放比拉开，采样偏移同步压缩回核空间，等价面积加权
    const kscale = ratio > 1 ? 1 / ratio : 1;
    const taps = new Array(outSize);
    for (let i = 0; i < outSize; i++) {
        const center = (i + 0.5) * ratio;
        const left = Math.max(0, Math.floor(center - support));
        const right = Math.min(inSize - 1, Math.ceil(center + support));
        const idx = [];
        const sum = [];
        let acc = 0;
        for (let j = left; j <= right; j++) {
            const w = f.fn((j + 0.5 - center) * kscale);
            if (w !== 0) { idx.push(j); sum.push(w); acc += w; }
        }
        if (!idx.length) { idx.push(clamp(Math.round(center - 0.5), 0, inSize - 1)); sum.push(1); acc = 1; }
        for (let k = 0; k < sum.length; k++) sum[k] = acc ? sum[k] / acc : 1;
        taps[i] = { idx, sum };
    }
    return taps;
}

function resize(src, outW, outH, filter = 'lanczos3') {
    outW = Math.max(1, Math.round(outW));
    outH = Math.max(1, Math.round(outH));
    if (outW === src.width && outH === src.height) return clonePx(src);
    const { width: iw, height: ih, data } = src;
    const axisX = buildAxis(iw, outW, filter);
    const axisY = buildAxis(ih, outH, filter);

    // 横向先出中间图（Byte 精度），避免 Float32 中间缓存在大图上占数百 MB
    const tmp = new Uint8ClampedArray(outW * ih * 4);
    for (let y = 0; y < ih; y++) {
        const rowIn = y * iw * 4;
        const rowOut = y * outW * 4;
        for (let x = 0; x < outW; x++) {
            const t = axisX[x];
            let r = 0, g = 0, b = 0, a = 0;
            for (let k = 0; k < t.idx.length; k++) {
                const p = rowIn + t.idx[k] * 4;
                const w = t.sum[k];
                r += data[p] * w; g += data[p + 1] * w; b += data[p + 2] * w; a += data[p + 3] * w;
            }
            const o = rowOut + x * 4;
            tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
        }
    }
    const out = new Uint8ClampedArray(outW * outH * 4);
    // 垂直方向必须用浮点累加：写进 Uint8Clamped 会把每个部分和先截断取整，
    // 常数图会掉 1 个级、棋盘均值会偏移，Lanczos 的振铃也被抹平
    const rowAcc = new Float32Array(outW * 4);
    for (let y = 0; y < outH; y++) {
        const t = axisY[y];
        rowAcc.fill(0);
        for (let k = 0; k < t.idx.length; k++) {
            const rowIn = t.idx[k] * outW * 4;
            const w = t.sum[k];
            for (let x = 0; x < outW * 4; x++) rowAcc[x] += tmp[rowIn + x] * w;
        }
        out.set(rowAcc, y * outW * 4);
    }
    return mkPx(outW, outH, out);
}

// 目标尺寸解析：percent / longest / width / height / exact，永不放大超过 maxDim 上限
function resolveSize(src, p) {
    const maxDim = toInt(p.maxDim, 8192) || 8192;
    let w = src.width, h = src.height;
    if (p.mode === 'percent' || p.percent !== undefined) {
        const s = toNum(p.percent, 100) / 100;
        w = src.width * s; h = src.height * s;
    } else if (p.mode === 'longest') {
        const s = toNum(p.value, Math.max(src.width, src.height)) / Math.max(src.width, src.height);
        w = src.width * s; h = src.height * s;
    } else if (p.mode === 'width') {
        const s = toNum(p.value, src.width) / src.width;
        w = src.width * s; h = src.height * s;
    } else if (p.mode === 'height') {
        const s = toNum(p.value, src.height) / src.height;
        h = src.height * s; w = src.width * s;
    } else if (p.mode === 'exact') {
        w = toNum(p.width, src.width); h = toNum(p.height, src.height);
        if (p.keepAspect) {
            const s = Math.min(w / src.width, h / src.height);
            w = src.width * s; h = src.height * s;
        }
    }
    return {
        width: clamp(Math.round(w), 1, maxDim),
        height: clamp(Math.round(h), 1, maxDim),
    };
}

function flip(src, dir) {
    const { width, height, data } = src;
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const sx = dir === 'h' ? width - 1 - x : x;
            const sy = dir === 'v' ? height - 1 - y : y;
            const i = (y * width + x) * 4, j = (sy * width + sx) * 4;
            out[i] = data[j]; out[i + 1] = data[j + 1]; out[i + 2] = data[j + 2]; out[i + 3] = data[j + 3];
        }
    }
    return mkPx(width, height, out);
}

function rotate90(src, times) {
    const n = ((times % 4) + 4) % 4;
    if (n === 0) return clonePx(src);
    const { width, height, data } = src;
    const isOdd = n === 1 || n === 3;
    const ow = isOdd ? height : width, oh = isOdd ? width : height;
    const out = new Uint8ClampedArray(ow * oh * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let dx, dy;
            if (n === 1) { dx = height - 1 - y; dy = x; }            // 顺时针 90
            else if (n === 2) { dx = width - 1 - x; dy = height - 1 - y; }
            else { dx = y; dy = width - 1 - x; }
            const i = (y * width + x) * 4, j = (dy * ow + dx) * 4;
            out[j] = data[i]; out[j + 1] = data[i + 1]; out[j + 2] = data[i + 2]; out[j + 3] = data[i + 3];
        }
    }
    return mkPx(ow, oh, out);
}

// 任意角度用逆向映射 + 双线性，正向散射会在大角度留下空洞
function rotate(src, angleDeg, { expand = true, fill = [0, 0, 0, 0], filter = 'bicubic' } = {}) {
    const a = toNum(angleDeg, 0);
    const near90 = Math.abs(((a % 90) + 90) % 90) < 1e-6 && Math.abs(a % 90) < 1e-6;
    const q = Math.round(a / 90);
    if (near90 && Math.abs(a - q * 90) < 1e-6 && Math.abs(a) >= 0) {
        const isRightAngle = Math.abs(a % 180) === 90 || Math.abs(a % 180) === 0;
        if (isRightAngle && Math.abs((a / 90) % 1) < 1e-9) return rotate90(src, -Math.round(a / 90));
    }
    const rad = (a * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const sw = src.width, sh = src.height;
    const halfW = sw / 2, halfH = sh / 2;
    let dw, dh, cx, cy;
    if (expand) {
        const bb = [[-halfW, -halfH], [halfW, -halfH], [-halfW, halfH], [halfW, halfH]]
            .map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
        const xs = bb.map((p) => p[0]), ys = bb.map((p) => p[1]);
        dw = Math.max(1, Math.round(Math.max(...xs) - Math.min(...xs)));
        dh = Math.max(1, Math.round(Math.max(...ys) - Math.min(...ys)));
        cx = dw / 2; cy = dh / 2;
    } else { dw = sw; dh = sh; cx = sw / 2; cy = sh / 2; }

    const out = new Uint8ClampedArray(dw * dh * 4);
    for (let i = 0; i < out.length; i += 4) {
        out[i] = fill[0]; out[i + 1] = fill[1]; out[i + 2] = fill[2]; out[i + 3] = fill[3];
    }
    const sd = src.data;
    const invCos = cos, invSin = sin; // 正向→源向：旋转 -a
    const sample = (fx, fy) => {
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        const acc = [0, 0, 0, 0];
        for (let dy = 0; dy <= 1; dy++) {
            for (let dx = 0; dx <= 1; dx++) {
                const px = x0 + dx, py = y0 + dy;
                if (px < 0 || py < 0 || px >= sw || py >= sh) continue;
                const wgt = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
                const p = (py * sw + px) * 4;
                acc[0] += sd[p] * wgt; acc[1] += sd[p + 1] * wgt; acc[2] += sd[p + 2] * wgt; acc[3] += sd[p + 3] * wgt;
            }
        }
        return acc;
    };
    for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
            const rx = x - cx, ry = y - cy;
            const fx = rx * invCos + ry * invSin + halfW - 0.5;
            const fy = -rx * invSin + ry * invCos + halfH - 0.5;
            if (fx < -0.5 || fy < -0.5 || fx > sw - 0.5 || fy > sh - 0.5) continue;
            const c = filter === 'nearest'
                ? (() => {
                    const px = clamp(Math.round(fx), 0, sw - 1), py = clamp(Math.round(fy), 0, sh - 1);
                    const p = (py * sw + px) * 4;
                    return [sd[p], sd[p + 1], sd[p + 2], sd[p + 3]];
                })()
                : sample(clamp(fx, 0, sw - 1), clamp(fy, 0, sh - 1));
            const o = (y * dw + x) * 4;
            out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = c[3];
        }
    }
    return mkPx(dw, dh, out);
}

function crop(src, rect) {
    const r = normRect(rect, src.width, src.height);
    if (r.width < 1 || r.height < 1) throw new Error('裁剪区域为空');
    const out = new Uint8ClampedArray(r.width * r.height * 4);
    for (let y = 0; y < r.height; y++) {
        const si = ((r.y + y) * src.width + r.x) * 4;
        out.set(src.data.subarray(si, si + r.width * 4), y * r.width * 4);
    }
    return mkPx(r.width, r.height, out);
}

function pad(src, { top = 0, right = 0, bottom = 0, left = 0, color = [0, 0, 0, 0] } = {}) {
    const dw = src.width + left + right, dh = src.height + top + bottom;
    const out = new Uint8ClampedArray(dw * dh * 4);
    for (let i = 0; i < out.length; i += 4) {
        out[i] = color[0]; out[i + 1] = color[1]; out[i + 2] = color[2]; out[i + 3] = color[3];
    }
    for (let y = 0; y < src.height; y++) {
        const si = y * src.width * 4;
        out.set(src.data.subarray(si, si + src.width * 4), ((y + top) * dw + left) * 4);
    }
    return mkPx(dw, dh, out);
}

// 把 src 贴到 dst 的 (x,y)，越界裁剪，alpha 混合
function place(src, dst, x, y, opacity = 1) {
    x = Math.round(x); y = Math.round(y);
    for (let j = 0; j < src.height; j++) {
        const dy = y + j;
        if (dy < 0 || dy >= dst.height) continue;
        for (let i = 0; i < src.width; i++) {
            const dx = x + i;
            if (dx < 0 || dx >= dst.width) continue;
            const s = (j * src.width + i) * 4, d = (dy * dst.width + dx) * 4;
            const sa = (src.data[s + 3] / 255) * opacity;
            if (sa >= 1) {
                dst.data[d] = src.data[s]; dst.data[d + 1] = src.data[s + 1];
                dst.data[d + 2] = src.data[s + 2]; dst.data[d + 3] = src.data[s + 3];
            } else if (sa > 0) {
                const da = dst.data[d + 3] / 255;
                const oa = sa + da * (1 - sa);
                for (let c = 0; c < 3; c++) {
                    dst.data[d + c] = oa > 0 ? (src.data[s + c] * sa + dst.data[d + c] * da * (1 - sa)) / oa : 0;
                }
                dst.data[d + 3] = Math.round(oa * 255);
            }
        }
    }
    return dst;
}

function createCanvasPx(width, height, color = [0, 0, 0, 0]) {
    const out = mkPx(width, height);
    for (let i = 0; i < out.data.length; i += 4) {
        out.data[i] = color[0]; out.data[i + 1] = color[1]; out.data[i + 2] = color[2]; out.data[i + 3] = color[3];
    }
    return out;
}

// 通用裁边：黑边/白边/纯色边/自动（按四角取样）。沿用三重防误裁：
// 单边上限、裁后最小占比、最小尺寸，避免暗场景被当成黑边吃掉。
function trimBorder(src, opts = {}) {
    const mode = opts.mode || 'auto';
    const tolerance = toNum(opts.tolerance, 12);
    const contentRatio = toNum(opts.contentRatio, 0.015);
    const maxRatio = toNum(opts.maxTrimRatio, 0.45);
    const minKeepRatio = toNum(opts.minKeepRatio, 0.3);
    const minDim = toInt(opts.minDim, 8);
    const analyze = downscaleForAnalysis(src, toInt(opts.analysisSize, 480));
    const { width: aw, height: ah, data } = analyze;

    let refColor;
    if (mode === 'black') refColor = [0, 0, 0];
    else if (mode === 'white') refColor = [255, 255, 255];
    else if (mode === 'transparent') refColor = null;
    else if (mode === 'color' && opts.color) refColor = opts.color.slice(0, 3);
    else {
        const corners = [[0, 0], [aw - 1, 0], [0, ah - 1], [aw - 1, ah - 1]].map(([x, y]) => {
            const p = (y * aw + x) * 4;
            return [data[p], data[p + 1], data[p + 2], data[p + 3]];
        });
        const opaque = corners.filter((c) => c[3] > 8);
        if (!opaque.length) refColor = null;
        else {
            // 四角色差过大说明不是统一纯色衬底，退化为按亮度判黑
            const spread = Math.max(...opaque.flatMap((c) => c.slice(0, 3))) - Math.min(...opaque.flatMap((c) => c.slice(0, 3)));
            refColor = spread > 40 ? [0, 0, 0] : opaque.reduce((a, c) => [a[0] + c[0] / opaque.length, a[1] + c[1] / opaque.length, a[2] + c[2] / opaque.length], [0, 0, 3]);
        }
    }

    const isBg = (p) => {
        if (mode === 'transparent') return data[p + 3] <= tolerance;
        if (!refColor) return false;
        return Math.abs(data[p] - refColor[0]) <= tolerance
            && Math.abs(data[p + 1] - refColor[1]) <= tolerance
            && Math.abs(data[p + 2] - refColor[2]) <= tolerance
            && (mode === 'transparent' || data[p + 3] > tolerance);
    };

    const rowContent = new Int32Array(ah), colContent = new Int32Array(aw);
    for (let y = 0; y < ah; y++) {
        for (let x = 0; x < aw; x++) {
            if (!isBg((y * aw + x) * 4)) { rowContent[y]++; colContent[x]++; }
        }
    }
    const rowHas = (y) => rowContent[y] > aw * contentRatio;
    const colHas = (x) => colContent[x] > ah * contentRatio;
    const maxT = { y: Math.floor(ah * maxRatio), x: Math.floor(aw * maxRatio) };
    let top = 0, bottom = ah - 1, left = 0, right = aw - 1;
    while (top < maxT.y && !rowHas(top)) top++;
    while (bottom > ah - 1 - maxT.y && !rowHas(bottom)) bottom--;
    while (left < maxT.x && !colHas(left)) left++;
    while (right > aw - 1 - maxT.x && !colHas(right)) right--;

    const scale = analyze.width / src.width;
    const nx = Math.round(left / scale), ny = Math.round(top / scale);
    const nw = clamp(Math.round((right - left + 1) / scale), 1, src.width - nx);
    const nh = clamp(Math.round((bottom - top + 1) / scale), 1, src.height - ny);
    if (nw >= src.width && nh >= src.height) return { image: clonePx(src), trimmed: null };
    if (nw < src.width * minKeepRatio || nh < src.height * minKeepRatio || nw < minDim || nh < minDim) {
        return { image: clonePx(src), trimmed: null };
    }
    return { image: crop(src, { x: nx, y: ny, width: nw, height: nh }), trimmed: { x: nx, y: ny, width: nw, height: nh } };
}

function downscaleForAnalysis(src, maxSide) {
    const m = Math.max(src.width, src.height);
    if (m <= maxSide) return src;
    const s = maxSide / m;
    return resize(src, Math.max(1, Math.round(src.width * s)), Math.max(1, Math.round(src.height * s)), 'area');
}

function aspectFit(src, maxW, maxH, filter = 'area') {
    const s = Math.min(maxW / src.width, maxH / src.height, 1);
    if (s >= 1) return clonePx(src);
    return resize(src, Math.round(src.width * s), Math.round(src.height * s), filter);
}


return { "mkPx": (typeof mkPx === 'undefined' ? undefined : mkPx), "clonePx": (typeof clonePx === 'undefined' ? undefined : clonePx), "RESAMPLE_FILTERS": (typeof RESAMPLE_FILTERS === 'undefined' ? undefined : RESAMPLE_FILTERS), "resize": (typeof resize === 'undefined' ? undefined : resize), "resolveSize": (typeof resolveSize === 'undefined' ? undefined : resolveSize), "flip": (typeof flip === 'undefined' ? undefined : flip), "rotate": (typeof rotate === 'undefined' ? undefined : rotate), "crop": (typeof crop === 'undefined' ? undefined : crop), "pad": (typeof pad === 'undefined' ? undefined : pad), "place": (typeof place === 'undefined' ? undefined : place), "createCanvasPx": (typeof createCanvasPx === 'undefined' ? undefined : createCanvasPx), "trimBorder": (typeof trimBorder === 'undefined' ? undefined : trimBorder), "downscaleForAnalysis": (typeof downscaleForAnalysis === 'undefined' ? undefined : downscaleForAnalysis), "aspectFit": (typeof aspectFit === 'undefined' ? undefined : aspectFit), "rotate90": (typeof rotate90 === 'undefined' ? undefined : rotate90) };
})();
__M["src/common/ext-state.js"] = (function(){
// 扩展上下文是否还活着，以及把 Chrome 的内部报错翻译成人话。
//
// 为什么需要：在 edge://extensions 里点「重新加载」之后，已经打开的网页里那份内容脚本会变成僵尸 ——
// 它的 chrome.runtime 端口已随旧扩展一起销毁，之后任何 sendMessage 都会抛/返回
// "Extension context invalidated."。旧脚本没法自愈（删不掉也重连不上），唯一出路是刷新页面，
// 所以这里把这句天书换成明确指令，别让它以「分割失败: Extension context invalidated」的形式吓人。

const DEAD_TEXT = '扩展已更新，本页面里的旧脚本已失效：请按 F5 刷新页面后再用';

// wasm 是 32 位地址空间，浏览器里一份 1.3GB 的权重 + 激活值就会越界，
// ORT 崩出来只有一句 "memory access out of bounds"，用户看不出跟模型大小有关。
const MEMORY_TEXT = '浏览器内存放不下这个模型（wasm 只有 4GB 地址空间）：请在设置里换小一点的模型/档位（如 SmolVLM2-256M/500M、q4），或改用 WebGPU 设备';

const DEAD_RE = /Extension context invalidated|extension context has been invalidated|Could not establish connection\. Receiving end does not exist|message port closed|Cannot access a chrome-extension: URL of a different extension/i;
const MEMORY_RE = /memory access out of bounds|out of memory|Aborted\(|RuntimeError: memory|Cannot allocate memory|too many bytes/i;

function extAlive() {
    try { return !!(globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.id); } catch (e) { return false; }
}

/** @returns {{dead:boolean, text:string}} */
function friendlyError(e) {
    const msg = String((e && e.message) || e || '未知错误');
    if (DEAD_RE.test(msg)) return { dead: true, text: DEAD_TEXT };
    if (MEMORY_RE.test(msg)) return { dead: false, text: MEMORY_TEXT, memory: true };
    return { dead: false, text: msg };
}

/** 给「已经拿到手的错误字符串」用（bgSend 返回的是 {ok:false,error}，不是异常） */
function friendlyText(msg) {
    return friendlyError({ message: String(msg || '') }).text;
}

return { "DEAD_TEXT": (typeof DEAD_TEXT === 'undefined' ? undefined : DEAD_TEXT), "MEMORY_TEXT": (typeof MEMORY_TEXT === 'undefined' ? undefined : MEMORY_TEXT), "extAlive": (typeof extAlive === 'undefined' ? undefined : extAlive), "friendlyError": (typeof friendlyError === 'undefined' ? undefined : friendlyError), "friendlyText": (typeof friendlyText === 'undefined' ? undefined : friendlyText) };
})();
__M["src/content/frame.js"] = (function(){
// 视频取帧：4 级降级链，全部来自旧实现并经测试矩阵验证。
// 1) 直接画布取帧 2) CORS 克隆 video（免整包下载） 3) 整包 refetch 重建 4) 标签页截图裁剪。

const { trimBorder } = __M["src/common/imgops/geometry.js"];
const { resize: resizePx, mkPx } = __M["src/common/imgops/geometry.js"];
const { friendlyText } = __M["src/common/ext-state.js"];

const MEDIA_FETCH_CAP = 500 * 1024 * 1024;
const corsCloneCache = new Map();
const refetchCache = new Map();

function bgSend(msg) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ ...msg, __from: 'content', pageUrl: location.href }, (res) => {
                if (chrome.runtime.lastError) resolve({ ok: false, error: friendlyText(chrome.runtime.lastError.message) });
                else resolve(res);
            });
        } catch (e) { resolve({ ok: false, error: friendlyText(e && e.message) }); }
    });
}

function canvasOf(video) {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.getContext('2d').getImageData(0, 0, 1, 1); // 触发跨域污染检查
    return canvas;
}

function frameOffsetInTop() {
    let dx = 0, dy = 0, w = window;
    try {
        while (w !== w.top) {
            const fe = w.frameElement;
            if (!fe) return null;
            const r = fe.getBoundingClientRect();
            dx += r.left; dy += r.top;
            w = w.parent;
        }
    } catch (e) { return null; }
    return { dx, dy, vw: w.innerWidth, vh: w.innerHeight };
}

async function cropScreenshot(dataUrl, rect) {
    const off = frameOffsetInTop();
    if (!off) throw new Error('视频位于跨域 iframe 中且画面受跨域保护，无法通过截图取帧');
    const dpr = window.devicePixelRatio || 1;
    const left = Math.max(rect.left + off.dx, 0), top = Math.max(rect.top + off.dy, 0);
    const right = Math.min(rect.right + off.dx, off.vw), bottom = Math.min(rect.bottom + off.dy, off.vh);
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const sw = Math.round((right - left) * dpr), sh = Math.round((bottom - top) * dpr);
            if (sw <= 0 || sh <= 0) { reject(new Error('视频不在可视区域内，无法截图取帧')); return; }
            const canvas = document.createElement('canvas');
            canvas.width = sw; canvas.height = sh;
            canvas.getContext('2d').drawImage(img, Math.round(left * dpr), Math.round(top * dpr), sw, sh, 0, 0, sw, sh);
            resolve(canvas);
        };
        img.onerror = () => reject(new Error('标签页截图解析失败'));
        img.src = dataUrl;
    });
}

async function fetchMediaBlob(src, onProgress) {
    await bgSend({ action: 'allowDirectMediaFetch', url: src });
    try {
        let res;
        try {
            res = await fetch(src, { credentials: 'include', cache: 'no-store' });
        } catch (e) {
            res = await fetch(src, { credentials: 'omit', cache: 'no-store' });
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const total = parseInt(res.headers.get('Content-Length') || '0', 10);
        if (total > MEDIA_FETCH_CAP) {
            res.body?.cancel?.().catch(() => {});
            throw new Error('视频文件过大（' + Math.round(total / 1048576) + 'MB），超出内部取帧上限');
        }
        if (res.body && res.body.getReader) {
            const reader = res.body.getReader();
            const chunks = [];
            let received = 0, last = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.length;
                if (received > MEDIA_FETCH_CAP) { reader.cancel().catch(() => {}); throw new Error('视频文件过大，超出内部取帧上限'); }
                const text = total ? '⏳ ' + Math.min(99, Math.round((received / total) * 100)) + '%' : '⏳ ' + (received / 1048576).toFixed(1) + 'MB';
                if (text !== last) { last = text; onProgress && onProgress(text); }
            }
            return new Blob(chunks, { type: res.headers.get('Content-Type') || 'video/mp4' });
        }
        const blob = await res.blob();
        if (blob.size > MEDIA_FETCH_CAP) throw new Error('视频文件过大，超出内部取帧上限');
        return blob;
    } finally {
        bgSend({ action: 'removeDirectMediaFetch' });
    }
}

async function captureViaCorsClone(video, src, onProgress) {
    await bgSend({ action: 'allowDirectMediaFetch', url: src });
    try {
        if (!corsCloneCache.has(src)) {
            const p = (async () => {
                const v2 = document.createElement('video');
                v2.crossOrigin = 'use-credentials';
                v2.muted = true; v2.preload = 'metadata'; v2.src = src;
                try {
                    await new Promise((resolve, reject) => {
                        const to = setTimeout(() => reject(new Error('CORS 克隆加载超时')), 15000);
                        v2.addEventListener('loadedmetadata', () => { clearTimeout(to); resolve(); }, { once: true });
                        v2.addEventListener('error', () => { clearTimeout(to); reject(new Error('CORS 克隆加载失败')); }, { once: true });
                    });
                    return v2;
                } catch (e) {
                    corsCloneCache.delete(src);
                    v2.removeAttribute('src'); v2.load();
                    throw e;
                }
            })();
            corsCloneCache.set(src, p);
            if (corsCloneCache.size > 3) {
                const oldest = corsCloneCache.keys().next().value;
                if (oldest !== src) {
                    Promise.resolve(corsCloneCache.get(oldest)).then((v) => { v.removeAttribute('src'); v.load(); }).catch(() => {});
                    corsCloneCache.delete(oldest);
                }
            }
        }
        const v2 = await corsCloneCache.get(src);
        onProgress && onProgress('⏳ 解码中');
        const t = video.currentTime || 0;
        const clamped = (isFinite(v2.duration) && v2.duration > 0) ? Math.max(0, Math.min(t, v2.duration - 0.05)) : t;
        await new Promise((resolve, reject) => {
            const to = setTimeout(() => reject(new Error('CORS 克隆 seek 超时')), 15000);
            v2.addEventListener('seeked', () => { clearTimeout(to); resolve(); }, { once: true });
            v2.currentTime = clamped;
        });
        if (!v2.videoWidth || !v2.videoHeight) throw new Error('CORS 克隆画面未就绪');
        return canvasOf(v2);
    } finally {
        bgSend({ action: 'removeDirectMediaFetch' });
    }
}

async function captureViaRefetch(video, src, onProgress) {
    if (!refetchCache.has(src)) {
        const p = fetchMediaBlob(src, onProgress)
            .then((blob) => ({ url: URL.createObjectURL(blob) }))
            .catch((e) => { refetchCache.delete(src); throw e; });
        refetchCache.set(src, p);
        if (refetchCache.size > 3) {
            const oldest = refetchCache.keys().next().value;
            if (oldest !== src) {
                Promise.resolve(refetchCache.get(oldest)).then((en) => URL.revokeObjectURL(en.url)).catch(() => {});
                refetchCache.delete(oldest);
            }
        }
    }
    const entry = await refetchCache.get(src);
    onProgress && onProgress('⏳ 解码中');
    const v2 = document.createElement('video');
    v2.muted = true; v2.playsInline = true; v2.preload = 'auto'; v2.src = entry.url;
    await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('重建视频加载超时')), 20000);
        v2.addEventListener('loadedmetadata', () => { clearTimeout(to); resolve(); }, { once: true });
        v2.addEventListener('error', () => { clearTimeout(to); reject(new Error('重建视频加载失败')); }, { once: true });
    });
    const t = video.currentTime || 0;
    const clamped = (isFinite(v2.duration) && v2.duration > 0) ? Math.max(0, Math.min(t, v2.duration - 0.05)) : t;
    await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('重建视频 seek 超时')), 10000);
        v2.addEventListener('seeked', () => { clearTimeout(to); resolve(); }, { once: true });
        v2.currentTime = clamped;
    });
    if (!v2.videoWidth || !v2.videoHeight) throw new Error('重建视频画面未就绪');
    return canvasOf(v2);
}

function canvasToPx(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return mkPx(id.width, id.height, new Uint8ClampedArray(id.data));
}

function pxToCanvas(px) {
    const c = document.createElement('canvas');
    c.width = px.width; c.height = px.height;
    c.getContext('2d').putImageData(new ImageData(px.data, px.width, px.height), 0, 0);
    return c;
}

// 返回 {canvas, dataUrl, method, via}；dataUrl 走 PNG，保证无损
async function captureVideoFrame(video, { onProgress, trim = true, maxSide = 0, format = 'png', quality = 0.95 } = {}) {
    if (!video.videoWidth || !video.videoHeight) throw new Error('视频画面尚未加载，请稍候再试');
    let canvas = null, via = 'canvas';
    try {
        canvas = canvasOf(video);
    } catch (e) {
        canvas = null;
    }
    if (!canvas) {
        const src = video.currentSrc || video.src || '';
        if (/^https?:/i.test(src)) {
            try { canvas = await captureViaCorsClone(video, src, onProgress); via = 'cors-clone'; }
            catch (e) { console.debug('[mtb] 免下载取帧失败:', e && e.message); }
            if (!canvas) {
                try { canvas = await captureViaRefetch(video, src, onProgress); via = 'refetch'; }
                catch (e) { console.debug('[mtb] 内部取帧失败，降级截图:', e && e.message); }
            }
        }
    }
    if (!canvas) {
        via = 'screenshot';
        onProgress && onProgress('⏳ 截图取帧');
        let shot = null;
        document.getElementById('mtb-root')?.style && (document.getElementById('mtb-root').style.visibility = 'hidden');
        try {
            const res = await bgSend({ action: 'captureVisibleTab' });
            shot = res && res.success ? res.dataUrl : null;
            if (!shot && res && res.error && /MAX_CAPTURE_VISIBLE_TAB/i.test(res.error)) {
                throw new Error('截图接口限流（连续点击过快），请等 1 秒再试');
            }
        } finally {
            const r = document.getElementById('mtb-root');
            if (r) r.style.visibility = 'visible';
        }
        if (!shot) throw new Error('无法截取标签页画面（视频画布受跨域保护且截图失败）');
        canvas = await cropScreenshot(shot, video.getBoundingClientRect());
    }
    if (trim) {
        const trimmed = trimBorder(canvasToPx(canvas), { mode: 'black', tolerance: 30, contentRatio: 0.015, maxTrimRatio: 0.45, minKeepRatio: 0.3 });
        if (trimmed.trimmed) canvas = pxToCanvas(trimmed.image);
    }
    if (maxSide && Math.max(canvas.width, canvas.height) > maxSide) {
        const s = maxSide / Math.max(canvas.width, canvas.height);
        const px = resizePx(canvasToPx(canvas), Math.round(canvas.width * s), Math.round(canvas.height * s), 'lanczos3');
        canvas = pxToCanvas(px);
    }
    const mime = format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
    const dataUrl = canvas.toDataURL(mime, mime === 'image/png' ? undefined : quality);
    return { canvas, dataUrl, method: via, width: canvas.width, height: canvas.height, mime };
}

// 顺序取多帧（导出帧序列/拼图用）：同一 video 上串行 seek，避免并发抢解码器
async function captureFrames(video, times, opts = {}) {
    const out = [];
    const wasPaused = video.paused;
    for (const t of times) {
        try { video.pause(); } catch (e) { /* 某些播放器会忽略 */ }
        await seekTo(video, t);
        const f = await captureVideoFrame(video, opts);
        out.push({ time: t, ...f });
    }
    if (!wasPaused) { try { await video.play(); } catch (e) { /* 自动播放策略可能拒绝 */ } }
    return out;
}

function seekTo(video, t) {
    return new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('seek 超时')), 12000);
        const done = () => { clearTimeout(to); resolve(); };
        video.addEventListener('seeked', done, { once: true });
        const dur = isFinite(video.duration) ? video.duration : 0;
        video.currentTime = dur ? Math.max(0, Math.min(t, dur - 0.001)) : t;
    });
}

function videoTimeList(video, count, { from = 0, to = 0 } = {}) {
    const dur = isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (!dur) return [video.currentTime || 0];
    const a = from > 0 ? from : 0;
    const b = to > 0 ? Math.min(to, dur) : dur;
    const n = Math.max(1, Math.round(count));
    const list = [];
    for (let i = 0; i < n; i++) list.push(a + (b - a) * ((i + 0.5) / n));
    return list;
}

return { "bgSend": (typeof bgSend === 'undefined' ? undefined : bgSend), "captureVideoFrame": (typeof captureVideoFrame === 'undefined' ? undefined : captureVideoFrame), "captureFrames": (typeof captureFrames === 'undefined' ? undefined : captureFrames), "seekTo": (typeof seekTo === 'undefined' ? undefined : seekTo), "videoTimeList": (typeof videoTimeList === 'undefined' ? undefined : videoTimeList) };
})();
__M["src/common/imgops/color.js"] = (function(){
// 色彩与色调算子。约定：所有强度类参数用 -100..100 或 0..200 的直观区间，
// 与设置页滑块一致；内部换算成乘性/加性系数。

const { clamp, toNum, toInt } = __M["src/common/util.js"];
const { mkPx, clonePx } = __M["src/common/imgops/geometry.js"];

function mapPixels(src, fn) {
    const out = new Uint8ClampedArray(src.data.length);
    const d = src.data;
    for (let i = 0; i < d.length; i += 4) fn(d[i], d[i + 1], d[i + 2], d[i + 3], out, i);
    return mkPx(src.width, src.height, out);
}

function applyLuts(src, lutR, lutG, lutB) {
    const out = new Uint8ClampedArray(src.data.length);
    const d = src.data;
    for (let i = 0; i < d.length; i += 4) {
        out[i] = lutR[d[i]]; out[i + 1] = lutG[d[i + 1]]; out[i + 2] = lutB[d[i + 2]]; out[i + 3] = d[i + 3];
    }
    return mkPx(src.width, src.height, out);
}

function buildLut(fn) {
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = fn(i);
    return lut;
}

function hexToRgb(hex) {
    const s = String(hex || '').replace('#', '').trim();
    if (/^[0-9a-f]{3}$/i.test(s)) {
        return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)];
    }
    if (/^[0-9a-f]{6}$/i.test(s)) {
        return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
    }
    if (/^[0-9a-f]{8}$/i.test(s)) {
        return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), parseInt(s.slice(6, 8), 16)];
    }
    return [255, 255, 255];
}

function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d > 1e-6) {
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
    }
    return [h, s, l];
}

function hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
}

function hslToRgb(h, s, l) {
    if (s <= 1e-6) { const v = l * 255; return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 1e-6) {
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
    }
    return [h, max <= 1e-6 ? 0 : d / max, max];
}

function hsvToRgb(h, s, v) {
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    switch (((i % 6) + 6) % 6) {
        case 0: return [v * 255, t * 255, p * 255];
        case 1: return [q * 255, v * 255, p * 255];
        case 2: return [p * 255, v * 255, t * 255];
        case 3: return [p * 255, q * 255, v * 255];
        case 4: return [t * p * 255, p * q * 255, v * 255];
        default: return [v * 255, p * t * 255, q * 255];
    }
}

// 亮度公式默认 Rec.709，ccir601 与既有代码/老素材习惯一致，保留可选
function luma(r, g, b, mode = 'luma709') {
    if (mode === 'average') return (r + g + b) / 3;
    if (mode === 'lightness') return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
    if (mode === 'max') return Math.max(r, g, b);
    if (mode === 'ccir601') return 0.299 * r + 0.587 * g + 0.114 * b;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function toGray(src, mode = 'luma709') {
    const { width, height, data } = src;
    const out = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 0; j < out.length; i += 4, j++) {
        out[j] = clamp(Math.round(luma(data[i], data[i + 1], data[i + 2], mode)), 0, 255);
    }
    return { width, height, data: out };
}

function brightness(src, amount = 0) {
    const v = toNum(amount, 0) * 2.55;
    return mapPixels(src, (r, g, b, a, o, i) => {
        o[i] = r + v; o[i + 1] = g + v; o[i + 2] = b + v; o[i + 3] = a;
    });
}

function contrast(src, amount = 0) {
    const c = 1 + toNum(amount, 0) / 100;
    return mapPixels(src, (r, g, b, a, o, i) => {
        o[i] = (r - 128) * c + 128; o[i + 1] = (g - 128) * c + 128; o[i + 2] = (b - 128) * c + 128; o[i + 3] = a;
    });
}

function saturation(src, amount = 0) {
    const s = 1 + toNum(amount, 0) / 100;
    return mapPixels(src, (r, g, b, a, o, i) => {
        const l = luma(r, g, b);
        o[i] = l + (r - l) * s; o[i + 1] = l + (g - l) * s; o[i + 2] = l + (b - l) * s; o[i + 3] = a;
    });
}

// vibrance：只提低饱和像素，避免皮肤/红蓝溢出
function vibrance(src, amount = 0) {
    const v = toNum(amount, 0) / 100;
    return mapPixels(src, (r, g, b, a, o, i) => {
        const l = luma(r, g, b);
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = mx <= 0 ? 0 : (mx - mn) / mx;
        const f = 1 + v * (1 - sat);
        o[i] = l + (r - l) * f; o[i + 1] = l + (g - l) * f; o[i + 2] = l + (b - l) * f; o[i + 3] = a;
    });
}

function hueRotate(src, degrees = 0) {
    const d = toNum(degrees, 0) / 360;
    if (!d) return clonePx(src);
    return mapPixels(src, (r, g, b, a, o, i) => {
        const [h, s, l] = rgbToHsl(r, g, b);
        const [nr, ng, nb] = hslToRgb((h + d) % 1, s, l);
        o[i] = nr; o[i + 1] = ng; o[i + 2] = nb; o[i + 3] = a;
    });
}

// 色温按白平衡增益的逆操作做：偏暖 = R 增 B 减，并轻微补偿 G 保亮度
function temperature(src, amount = 0) {
    const t = toNum(amount, 0) / 100;
    return mapPixels(src, (r, g, b, a, o, i) => {
        o[i] = r * (1 + t * 0.25);
        o[i + 1] = g * (1 - Math.abs(t) * 0.03);
        o[i + 2] = b * (1 - t * 0.25);
        o[i + 3] = a;
    });
}

function tint(src, amount = 0) {
    const t = toNum(amount, 0) / 100;
    return mapPixels(src, (r, g, b, a, o, i) => {
        o[i] = r * (1 - t * 0.12);
        o[i + 1] = g * (1 + t * 0.2);
        o[i + 2] = b * (1 - t * 0.12);
        o[i + 3] = a;
    });
}

function gamma(src, value = 1) {
    const g = Math.max(0.05, toNum(value, 1));
    const inv = 1 / g;
    const lut = buildLut((i) => 255 * Math.pow(i / 255, inv));
    return applyLuts(src, lut, lut, lut);
}

function levels(src, { inBlack = 0, inWhite = 100, gammaValue = 1, outBlack = 0, outWhite = 100, channel = 'rgb' } = {}) {
    const lo = toNum(inBlack, 0) / 100 * 255;
    const hi = toNum(inWhite, 100) / 100 * 255;
    const g = Math.max(0.05, toNum(gammaValue, 1));
    const oLo = toNum(outBlack, 0) / 100 * 255;
    const oHi = toNum(outWhite, 100) / 100 * 255;
    const span = Math.max(1, hi - lo);
    const fn = (v) => {
        let x = clamp((v - lo) / span, 0, 1);
        x = Math.pow(x, 1 / g);
        return oLo + x * (oHi - oLo);
    };
    const lut = buildLut(fn);
    if (channel === 'luma') {
        return mapPixels(src, (r, g2, b, a, o, i) => {
            const l = luma(r, g2, b), nl = fn(l);
            const d = nl - l;
            o[i] = r + d; o[i + 1] = g2 + d; o[i + 2] = b + d; o[i + 3] = a;
        });
    }
    if (channel === 'r') return applyLuts(src, lut, (x) => x, (x) => x);
    if (channel === 'g') return applyLuts(src, (x) => x, lut, (x) => x);
    if (channel === 'b') return applyLuts(src, (x) => x, (x) => x, lut);
    return applyLuts(src, lut, lut, lut);
}

function posterize(src, levelsCount = 4) {
    const n = Math.max(2, toInt(levelsCount, 4));
    const step = 255 / (n - 1);
    const lut = buildLut((i) => Math.round(Math.round(i / step) * step));
    return applyLuts(src, lut, lut, lut);
}

function invert(src, { alpha = false } = {}) {
    return mapPixels(src, (r, g, b, a, o, i) => {
        o[i] = 255 - r; o[i + 1] = 255 - g; o[i + 2] = 255 - b; o[i + 3] = alpha ? 255 - a : a;
    });
}

function grayscale(src, mode = 'luma709') {
    return mapPixels(src, (r, g, b, a, o, i) => {
        const l = luma(r, g, b, mode);
        o[i] = l; o[i + 1] = l; o[i + 2] = l; o[i + 3] = a;
    });
}

function sepia(src, amount = 100) {
    const t = clamp(toNum(amount, 100) / 100, 0, 1);
    return mapPixels(src, (r, g, b, a, o, i) => {
        const sr = 0.393 * r + 0.769 * g + 0.189 * b;
        const sg = 0.349 * r + 0.686 * g + 0.168 * b;
        const sb = 0.272 * r + 0.534 * g + 0.131 * b;
        o[i] = r + (sr - r) * t; o[i + 1] = g + (sg - g) * t; o[i + 2] = b + (sb - b) * t; o[i + 3] = a;
    });
}

function duotone(src, { dark = '#1a1a2e', light = '#e8e8e8', amount = 100 } = {}) {
    const d = hexToRgb(dark), l = hexToRgb(light);
    const t = clamp(toNum(amount, 100) / 100, 0, 1);
    const lutR = new Uint8ClampedArray(256), lutG = new Uint8ClampedArray(256), lutB = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
        const k = i / 255;
        lutR[i] = d[0] + (l[0] - d[0]) * k;
        lutG[i] = d[1] + (l[1] - d[1]) * k;
        lutB[i] = d[2] + (l[2] - d[2]) * k;
    }
    const out = mapPixels(src, (r, g, b, a, o, i) => {
        const v = luma(r, g, b);
        o[i] = lutR[v]; o[i + 1] = lutG[v]; o[i + 2] = lutB[v]; o[i + 3] = a;
    });
    return t >= 1 ? out : blend(src, out, 'normal', t * 100);
}

// 叠加纯色（水印底色、遮色块）
function colorOverlay(src, { color = '#000000', opacity = 30, blend: mode = 'normal' } = {}) {
    const c = hexToRgb(color);
    const flat = mkPx(src.width, src.height);
    for (let i = 0; i < flat.data.length; i += 4) {
        flat.data[i] = c[0]; flat.data[i + 1] = c[1]; flat.data[i + 2] = c[2]; flat.data[i + 3] = 255;
    }
    return blend(src, flat, mode, opacity);
}

const BLEND_MODES = {
    normal: (a, b) => b,
    multiply: (a, b) => (a * b) / 255,
    screen: (a, b) => 255 - ((255 - a) * (255 - b)) / 255,
    overlay: (a, b) => (a <= 128 ? (2 * a * b) / 255 : 255 - (2 * (255 - a) * (255 - b)) / 255),
    // Photoshop/CSS 标准 soft-light：Cb<=0.5 用二次衰减，否则用 D(Cb) 提升
    softLight: (a, b) => {
        const A = a / 255, B = b / 255;
        const D = (x) => (x <= 0.25 ? ((16 * x - 12) * x + 4) * x : Math.sqrt(x));
        return (B <= 0.5 ? A - (1 - 2 * B) * A * (1 - A) : A + (2 * B - 1) * (D(A) - A)) * 255;
    },
    hardLight: (a, b) => (b <= 128 ? (2 * a * b) / 255 : 255 - (2 * (255 - a) * (255 - b)) / 255),
    difference: (a, b) => Math.abs(a - b),
    exclusion: (a, b) => a + b - (2 * a * b) / 255,
    lighten: (a, b) => Math.max(a, b),
    darken: (a, b) => Math.min(a, b),
    add: (a, b) => a + b,
};

function blend(base, top, mode = 'normal', opacity = 100) {
    const op = clamp(toNum(opacity, 100) / 100, 0, 1);
    if (op <= 0) return clonePx(base);
    const fn = BLEND_MODES[mode] || BLEND_MODES.normal;
    const w = Math.min(base.width, top.width), h = Math.min(base.height, top.height);
    const out = clonePx(base);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * base.width + x) * 4, j = (y * top.width + x) * 4;
            const ta = (top.data[j + 3] / 255) * op;
            if (ta <= 0) continue;
            for (let c = 0; c < 3; c++) {
                const mixed = fn(base.data[i + c], top.data[j + c]);
                out.data[i + c] = base.data[i + c] * (1 - ta) + mixed * ta;
            }
            out.data[i + 3] = out.data[i + 3] * (1 - ta) + top.data[j + 3] * ta;
        }
    }
    return out;
}

// 白平衡：grey-world 最稳，percentile 抗大面积单色干扰，manual 给高级用户
function whiteBalance(src, { method = 'grey-world', strength = 100, rGain = 1, gGain = 1, bGain = 1 } = {}) {
    const d = src.data;
    let gains = [rGain, gGain, bGain];
    if (method === 'grey-world' || method === 'percentile' || method === 'auto') {
        const sums = [0, 0, 0];
        let n = 0;
        if (method === 'percentile') {
            const histR = new Int32Array(256), histG = new Int32Array(256), histB = new Int32Array(256);
            for (let i = 0; i < d.length; i += 4) { histR[d[i]]++; histG[d[i + 1]]++; histB[d[i + 2]]++; n++; }
            const cut = (hist) => {
                const lo = Math.floor(n * 0.02), hi = n - lo;
                let acc = 0, low = 0, high = 255;
                for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= lo) { low = v; break; } }
                acc = 0;
                for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n - hi) { high = v; break; } }
                return (low + high) / 2;
            };
            gains = [cut(histR), cut(histG), cut(histB)];
            const mean = (gains[0] + gains[1] + gains[2]) / 3;
            gains = gains.map((g) => (g > 1 ? mean / g : 1));
        } else {
            for (let i = 0; i < d.length; i += 4) {
                if (d[i + 3] < 8) continue;
                sums[0] += d[i]; sums[1] += d[i + 1]; sums[2] += d[i + 2]; n++;
            }
            if (!n) return clonePx(src);
            const avg = [sums[0] / n, sums[1] / n, sums[2] / n];
            const gray = (avg[0] + avg[1] + avg[2]) / 3;
            gains = avg.map((a) => (a > 1 ? gray / a : 1));
        }
    }
    const s = clamp(toNum(strength, 100) / 100, 0, 1);
    gains = gains.map((g) => 1 + (g - 1) * s);
    return mapPixels(src, (r, g, b, a, o, i) => {
        o[i] = r * gains[0]; o[i + 1] = g * gains[1]; o[i + 2] = b * gains[2]; o[i + 3] = a;
    });
}

function histogramOf(src, bins = 256, channel = 'luma') {
    const h = new Float64Array(bins);
    const d = src.data;
    for (let i = 0; i < d.length; i += 4) {
        const v = channel === 'luma' ? luma(d[i], d[i + 1], d[i + 2])
            : channel === 'r' ? d[i] : channel === 'g' ? d[i + 1] : d[i + 2];
        h[clamp(Math.round((v / 255) * (bins - 1)), 0, bins - 1)]++;
    }
    return h;
}

function equalizeHist(src, { channel = 'luma', clip = 0 } = {}) {
    const d = src.data;
    if (channel !== 'luma') {
        const mk = (ch) => {
            const h = new Int32Array(256);
            for (let i = 0; i < d.length; i += 4) h[d[i + ch]]++;
            const total = d.length / 4;
            const lut = new Uint8ClampedArray(256);
            let acc = 0;
            for (let v = 0; v < 256; v++) { acc += h[v]; lut[v] = Math.round((acc / total) * 255); }
            return lut;
        };
        return applyLuts(src, mk(0), mk(1), mk(2));
    }
    const h = new Int32Array(256);
    for (let i = 0; i < d.length; i += 4) h[Math.round(luma(d[i], d[i + 1], d[i + 2]))]++;
    const total = d.length / 4;
    let acc = 0;
    const lut = new Float64Array(256);
    for (let v = 0; v < 256; v++) { acc += h[v]; lut[v] = (acc / total) * 255 - v; }
    return mapPixels(src, (r, g, b, a, o, i) => {
        const l = luma(r, g, b);
        const delta = lut[clamp(Math.round(l), 0, 255)];
        o[i] = r + delta; o[i + 1] = g + delta; o[i + 2] = b + delta; o[i + 3] = a;
    });
}

// CLAHE：分块限幅直方图均衡 + 块间双线性插值，只做亮度通道以保色
function clahe(src, { clipLimit = 3, tiles = 8 } = {}) {
    const { width, height, data } = src;
    const tx = Math.max(1, toInt(tiles, 8)), ty = tx;
    const tw = Math.ceil(width / tx), th = Math.ceil(height / ty);
    const lumaMap = new Float32Array(width * height);
    for (let i = 0, j = 0; j < lumaMap.length; j++, i += 4) lumaMap[j] = luma(data[i], data[i + 1], data[i + 2]);

    const luts = [];
    const clip = Math.max(1, clipLimit);
    for (let b = 0; b < tx * ty; b++) {
        const bx = (b % tx) * tw, by = Math.floor(b / tx) * th;
        const bw = Math.min(tw, width - bx), bh = Math.min(th, height - by);
        const hist = new Float64Array(256);
        let count = 0;
        for (let y = 0; y < bh; y++) {
            for (let x = 0; x < bw; x++) { hist[Math.round(lumaMap[(by + y) * width + bx + x])]++; count++; }
        }
        const limit = Math.max(1, Math.round((count / 256) * clip));
        let excess = 0;
        for (let v = 0; v < 256; v++) if (hist[v] > limit) { excess += hist[v] - limit; hist[v] = limit; }
        const add = excess / 256;
        for (let v = 0; v < 256; v++) hist[v] += add;
        const lut = new Float64Array(256);
        let acc = 0;
        for (let v = 0; v < 256; v++) { acc += hist[v]; lut[v] = (acc / (bw * bh)) * 255; }
        luts.push(lut);
    }
    const tileLut = (cx, cy) => luts[clamp(cy, 0, ty - 1) * tx + clamp(cx, 0, tx - 1)];
    return mapPixels(src, (r, g, b, a, o, i) => {
        const px = i / 4;
        const x = px % width, y = Math.floor(px / width);
        const fx = x / tw - 0.5, fy = y / th - 0.5;
        const cx = clamp(Math.floor(fx), 0, tx - 1), cy = clamp(Math.floor(fy), 0, ty - 1);
        const gx = clamp(fx - cx, 0, 1), gy = clamp(fy - cy, 0, 1);
        const v = clamp(Math.round(luma(r, g, b)), 0, 255);
        const l00 = tileLut(cx, cy)[v], l10 = tileLut(cx + 1, cy)[v];
        const l01 = tileLut(cx, cy + 1)[v], l11 = tileLut(cx + 1, cy + 1)[v];
        const nl = l00 * (1 - gx) * (1 - gy) + l10 * gx * (1 - gy) + l01 * (1 - gx) * gy + l11 * gx * gy;
        const delta = nl - v;
        o[i] = r + delta; o[i + 1] = g + delta; o[i + 2] = b + delta; o[i + 3] = a;
    });
}

// 自动色阶：按百分位裁切黑白场，percent 默认 0.5%
function autoLevels(src, { percent = 0.5, channel = 'luma' } = {}) {
    const p = clamp(toNum(percent, 0.5), 0, 49) / 100;
    const hist = histogramOf(src, 256, channel);
    const total = src.width * src.height;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * p) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * p) { hi = v; break; } }
    if (hi - lo < 8) return clonePx(src);
    return levels(src, { inBlack: (lo / 255) * 100, inWhite: (hi / 255) * 100, channel });
}

function autoEnhance(src, { strength = 100 } = {}) {
    const s = clamp(toNum(strength, 100) / 100, 0, 1.5);
    let out = autoLevels(src, { percent: 0.4 });
    out = gamma(out, 1 / (1 + 0.06 * s));
    out = vibrance(out, 14 * s);
    out = contrast(out, 6 * s);
    return out;
}

function channelMixer(src, { r = [100, 0, 0], g = [0, 100, 0], b = [0, 0, 100] } = {}) {
    const M = [r, g, b].map((row) => row.map((v) => toNum(v, 0) / 100));
    return mapPixels(src, (x, y, z, a, o, i) => {
        o[i] = x * M[0][0] + y * M[0][1] + z * M[0][2];
        o[i + 1] = x * M[1][0] + y * M[1][1] + z * M[1][2];
        o[i + 2] = x * M[2][0] + y * M[2][1] + z * M[2][2];
        o[i + 3] = a;
    });
}

function curves(src, { channel = 'rgb', points = [[0, 0], [255, 255]] } = {}) {
    const pts = (points || []).map((p) => [clamp(toNum(p[0], 0), 0, 255), clamp(toNum(p[1], 0), 0, 255)]).sort((a, b) => a[0] - b[0]);
    if (pts.length < 2) return clonePx(src);
    const lut = buildLut((v) => {
        if (v <= pts[0][0]) return pts[0][1];
        for (let k = 1; k < pts.length; k++) {
            if (v <= pts[k][0]) {
                const t = (v - pts[k - 1][0]) / Math.max(1e-6, pts[k][0] - pts[k - 1][0]);
                // Catmull-Rom 风格平滑：用邻近段斜率做三次插值，避免折点
                const p0 = pts[Math.max(0, k - 2)], p1 = pts[k - 1], p2 = pts[k], p3 = pts[Math.min(pts.length - 1, k + 1)];
                const m1 = (p2[1] - p0[1]) / Math.max(1e-6, p2[0] - p0[0]);
                const m2 = (p3[1] - p1[1]) / Math.max(1e-6, p3[0] - p1[0]);
                const t2 = t * t, t3 = t2 * t;
                return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 * (p2[0] - p1[0])
                    + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2 * (p2[0] - p1[0]);
            }
        }
        return pts[pts.length - 1][1];
    });
    if (channel === 'r') return applyLuts(src, lut, (v) => v, (v) => v);
    if (channel === 'g') return applyLuts(src, (v) => v, lut, (v) => v);
    if (channel === 'b') return applyLuts(src, (v) => v, (v) => v, lut);
    return applyLuts(src, lut, lut, lut);
}


return { "mapPixels": (typeof mapPixels === 'undefined' ? undefined : mapPixels), "applyLuts": (typeof applyLuts === 'undefined' ? undefined : applyLuts), "hexToRgb": (typeof hexToRgb === 'undefined' ? undefined : hexToRgb), "rgbToHex": (typeof rgbToHex === 'undefined' ? undefined : rgbToHex), "rgbToHsl": (typeof rgbToHsl === 'undefined' ? undefined : rgbToHsl), "hslToRgb": (typeof hslToRgb === 'undefined' ? undefined : hslToRgb), "rgbToHsv": (typeof rgbToHsv === 'undefined' ? undefined : rgbToHsv), "hsvToRgb": (typeof hsvToRgb === 'undefined' ? undefined : hsvToRgb), "toGray": (typeof toGray === 'undefined' ? undefined : toGray), "brightness": (typeof brightness === 'undefined' ? undefined : brightness), "contrast": (typeof contrast === 'undefined' ? undefined : contrast), "saturation": (typeof saturation === 'undefined' ? undefined : saturation), "vibrance": (typeof vibrance === 'undefined' ? undefined : vibrance), "hueRotate": (typeof hueRotate === 'undefined' ? undefined : hueRotate), "temperature": (typeof temperature === 'undefined' ? undefined : temperature), "tint": (typeof tint === 'undefined' ? undefined : tint), "gamma": (typeof gamma === 'undefined' ? undefined : gamma), "levels": (typeof levels === 'undefined' ? undefined : levels), "posterize": (typeof posterize === 'undefined' ? undefined : posterize), "invert": (typeof invert === 'undefined' ? undefined : invert), "grayscale": (typeof grayscale === 'undefined' ? undefined : grayscale), "sepia": (typeof sepia === 'undefined' ? undefined : sepia), "duotone": (typeof duotone === 'undefined' ? undefined : duotone), "colorOverlay": (typeof colorOverlay === 'undefined' ? undefined : colorOverlay), "blend": (typeof blend === 'undefined' ? undefined : blend), "whiteBalance": (typeof whiteBalance === 'undefined' ? undefined : whiteBalance), "histogramOf": (typeof histogramOf === 'undefined' ? undefined : histogramOf), "equalizeHist": (typeof equalizeHist === 'undefined' ? undefined : equalizeHist), "clahe": (typeof clahe === 'undefined' ? undefined : clahe), "autoLevels": (typeof autoLevels === 'undefined' ? undefined : autoLevels), "autoEnhance": (typeof autoEnhance === 'undefined' ? undefined : autoEnhance), "channelMixer": (typeof channelMixer === 'undefined' ? undefined : channelMixer), "curves": (typeof curves === 'undefined' ? undefined : curves), "luma": (typeof luma === 'undefined' ? undefined : luma), "clonePx": (typeof clonePx === 'undefined' ? undefined : clonePx), "mkPx": (typeof mkPx === 'undefined' ? undefined : mkPx), "buildLut": (typeof buildLut === 'undefined' ? undefined : buildLut) };
})();
__M["src/common/imgops/filter.js"] = (function(){
// 空间域滤波、噪声、局部效果与蒙版类算子。

const { clamp, toNum, toInt } = __M["src/common/util.js"];
const { mkPx, clonePx } = __M["src/common/imgops/geometry.js"];
const { mapPixels, hexToRgb, rgbToHsv, luma } = __M["src/common/imgops/color.js"];

function gaussianKernel1D(sigma) {
    const s = Math.max(0.1, toNum(sigma, 1));
    const radius = Math.max(1, Math.ceil(s * 3));
    const k = new Float64Array(radius * 2 + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
        const v = Math.exp(-(i * i) / (2 * s * s));
        k[i + radius] = v; sum += v;
    }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    return { k, radius };
}

// 横向一维卷积：结果按行缓存，避免为整图开 Float32 临时缓冲
function convolveHorizontal(src, out, k, radius) {
    const { width, height, data } = src;
    for (let y = 0; y < height; y++) {
        const row = y * width * 4;
        for (let x = 0; x < width; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let i = -radius; i <= radius; i++) {
                const sx = clamp(x + i, 0, width - 1);
                const wgt = k[i + radius];
                const p = row + sx * 4;
                r += data[p] * wgt; g += data[p + 1] * wgt; b += data[p + 2] * wgt; a += data[p + 3] * wgt;
            }
            const o = row + x * 4;
            out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
        }
    }
}

function gaussianBlur(src, sigma = 2) {
    const { k, radius } = gaussianKernel1D(sigma);
    const tmp = new Uint8ClampedArray(src.width * src.height * 4);
    convolveHorizontal(src, tmp, k, radius);
    const stage = mkPx(src.width, src.height, tmp);
    const out = new Uint8ClampedArray(stage.data.length);
    const { width, height, data } = stage;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let i = -radius; i <= radius; i++) {
                const sy = clamp(y + i, 0, height - 1);
                const wgt = k[i + radius];
                const p = (sy * width + x) * 4;
                r += data[p] * wgt; g += data[p + 1] * wgt; b += data[p + 2] * wgt; a += data[p + 3] * wgt;
            }
            const o = (y * width + x) * 4;
            out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
        }
    }
    return mkPx(width, height, out);
}

function boxBlur(src, radius = 3) {
    const r = Math.max(1, toInt(radius, 3));
    const { width, height, data } = src;
    const tmp = new Float32Array(width * height * 4);
    const win = r * 2 + 1;
    for (let y = 0; y < height; y++) {
        for (let c = 0; c < 4; c++) {
            let acc = 0;
            for (let x = -r; x <= r; x++) acc += data[(y * width + clamp(x, 0, width - 1)) * 4 + c];
            for (let x = 0; x < width; x++) {
                tmp[(y * width + x) * 4 + c] = acc / win;
                const add = data[(y * width + clamp(x + r + 1, 0, width - 1)) * 4 + c];
                const sub = data[(y * width + clamp(x - r, 0, width - 1)) * 4 + c];
                acc += add - sub;
            }
        }
    }
    const out = new Uint8ClampedArray(data.length);
    for (let x = 0; x < width; x++) {
        for (let c = 0; c < 4; c++) {
            let acc = 0;
            for (let y = -r; y <= r; y++) acc += tmp[(clamp(y, 0, height - 1) * width + x) * 4 + c];
            for (let y = 0; y < height; y++) {
                out[(y * width + x) * 4 + c] = acc / win;
                acc += tmp[(clamp(y + r + 1, 0, height - 1) * width + x) * 4 + c]
                    - tmp[(clamp(y - r, 0, height - 1) * width + x) * 4 + c];
            }
        }
    }
    return mkPx(width, height, out);
}

function convolve(src, kernel, { divisor = 0, offset = 0, edge = 'clamp' } = {}) {
    const size = kernel.length;
    const half = Math.floor(size / 2);
    let div = divisor;
    if (!div) { div = kernel.flat().reduce((a, b) => a + b, 0); if (!div) div = 1; }
    const { width, height, data } = src;
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let j = 0; j < size; j++) {
                for (let i = 0; i < size; i++) {
                    let sx = x + i - half, sy = y + j - half;
                    if (edge === 'clamp') { sx = clamp(sx, 0, width - 1); sy = clamp(sy, 0, height - 1); }
                    else if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
                    const wgt = kernel[j][i];
                    if (!wgt) continue;
                    const p = (sy * width + sx) * 4;
                    r += data[p] * wgt; g += data[p + 1] * wgt; b += data[p + 2] * wgt; a += data[p + 3] * wgt;
                }
            }
            const o = (y * width + x) * 4;
            out[o] = r / div + offset; out[o + 1] = g / div + offset; out[o + 2] = b / div + offset; out[o + 3] = a / div;
        }
    }
    return mkPx(width, height, out);
}

const KERNELS = {
    identity: [[0, 0, 0], [0, 1, 0], [0, 0, 0]],
    sharpen: [[0, -1, 0], [-1, 5, -1], [0, -1, 0]],
    sharpenSoft: [[-0.2, -0.2, -0.2], [-0.2, 1.9, -0.2], [-0.2, -0.2, -0.2]],
    emboss: [[-2, -1, 0], [-1, 1, 1], [0, 1, 2]],
    edgeDetect: [[-1, -1, -1], [-1, 8, -1], [-1, -1, -1]],
    laplacian: [[0, 1, 0], [1, -4, 1], [0, 1, 0]],
    unsharpMask: [[-1, -1, -1], [-1, 9, -1], [-1, -1, -1]],
    box3: [[1, 1, 1], [1, 1, 1], [1, 1, 1]],
    gaussian3: [[1, 2, 1], [2, 4, 2], [1, 2, 1]],
    gaussian5: [
        [1, 4, 6, 4, 1], [4, 16, 24, 16, 4], [6, 24, 36, 24, 6], [4, 16, 24, 16, 4], [1, 4, 6, 4, 1],
    ],
    sobelX: [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]],
    sobelY: [[-1, -2, -1], [0, 0, 0], [1, 2, 1]],
    scharrX: [[-3, 0, 3], [-10, 0, 10], [-3, 0, 3]],
    scharrY: [[-3, -10, -3], [0, 0, 0], [3, 10, 3]],
    prewittX: [[-1, 0, 1], [-1, 0, 1], [-1, 0, 1]],
    findEdges: [[0, -1, 0], [-1, 4, -1], [0, -1, 0]],
};

// amount 走核中心插值，用户拉 0 时等价原图
function sharpen(src, amount = 60, soft = false) {
    const a = clamp(toNum(amount, 60) / 100, 0, 3);
    const base = KERNELS.identity, k = soft ? KERNELS.sharpenSoft : KERNELS.sharpen;
    const mixed = k.map((row, j) => row.map((v, i) => base[j][i] + (v - base[j][i]) * a));
    return convolve(src, mixed);
}

function unsharp(src, { radius = 2, amount = 100, threshold = 0 } = {}) {
    const amt = toNum(amount, 100) / 100;
    const thr = toNum(threshold, 0);
    const blurred = gaussianBlur(src, radius);
    const out = new Uint8ClampedArray(src.data.length);
    const d = src.data, b = blurred.data;
    for (let i = 0; i < d.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            const diff = d[i + c] - b[i + c];
            out[i + c] = Math.abs(diff) >= thr ? d[i + c] + diff * amt : d[i + c];
        }
        out[i + 3] = d[i + 3];
    }
    return mkPx(src.width, src.height, out);
}

function medianFilter(src, radius = 1, { channels = 'rgb' } = {}) {
    const r = clamp(toInt(radius, 1), 1, 8);
    const { width, height, data } = src;
    const out = clonePx(data === src.data ? mkPx(width, height, new Uint8ClampedArray(data)) : src).data;
    const size = r * 2 + 1;
    const buf = [new Uint8Array(size * size), new Uint8Array(size * size), new Uint8Array(size * size)];
    const chs = channels === 'rgb' ? [0, 1, 2] : [0, 1, 2, 3];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            for (const c of chs) {
                let n = 0;
                for (let j = -r; j <= r; j++) {
                    const sy = clamp(y + j, 0, height - 1);
                    for (let i = -r; i <= r; i++) {
                        buf[c][n++] = data[(sy * width + clamp(x + i, 0, width - 1)) * 4 + c];
                    }
                }
                buf[c].subarray(0, n).sort();
                out[(y * width + x) * 4 + c] = buf[c][Math.floor(n / 2)];
            }
            out[(y * width + x) * 4 + 3] = data[(y * width + x) * 4 + 3];
        }
    }
    return mkPx(width, height, out);
}

function bilateralFilter(src, { spaceSigma = 6, rangeSigma = 30, radius = 0 } = {}) {
    const r = Math.max(1, toInt(radius, 0) || Math.max(1, Math.round(toNum(spaceSigma, 6))));
    const ss2 = 2 * Math.max(0.5, toNum(spaceSigma, 6)) ** 2;
    const rs2 = 2 * Math.max(1, toNum(rangeSigma, 30)) ** 2;
    const { width, height, data } = src;
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const ci = (y * width + x) * 4;
            let wr = 0, ar = 0, ag = 0, ab = 0, aa = 0;
            for (let j = -r; j <= r; j++) {
                const sy = clamp(y + j, 0, height - 1);
                const dy = j * j;
                for (let i = -r; i <= r; i++) {
                    const sx = clamp(x + i, 0, width - 1);
                    const p = (sy * width + sx) * 4;
                    const spatial = -(dy + i * i) / ss2;
                    const dr = data[p] - data[ci], dg = data[p + 1] - data[ci + 1], db = data[p + 2] - data[ci + 2];
                    const range = -(dr * dr + dg * dg + db * db) / rs2;
                    const wgt = Math.exp(spatial + range);
                    wr += wgt;
                    ar += data[p] * wgt; ag += data[p + 1] * wgt; ab += data[p + 2] * wgt; aa += data[p + 3] * wgt;
                }
            }
            out[ci] = ar / wr; out[ci + 1] = ag / wr; out[ci + 2] = ab / wr; out[ci + 3] = aa / wr;
        }
    }
    return mkPx(width, height, out);
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function addNoise(src, { type = 'gaussian', amount = 12, seed = 1 } = {}) {
    const rnd = mulberry32(toInt(seed, 1) || 1);
    const a = toNum(amount, 12);
    return mapPixels(src, (r, g, b, al, o, i) => {
        if (type === 'saltPepper') {
            const t = rnd();
            const v = t < a / 200 ? 0 : t < a / 100 + a / 200 ? 255 : null;
            if (v === null) { o[i] = r; o[i + 1] = g; o[i + 2] = b; }
            else { o[i] = o[i + 1] = o[i + 2] = v; }
            o[i + 3] = al;
            return;
        }
        if (type === 'speckle') {
            const n1 = (rnd() + rnd() + rnd() - 1.5) * (a / 100);
            o[i] = r + r * n1; o[i + 1] = g + g * n1; o[i + 2] = b + b * n1; o[i + 3] = al;
            return;
        }
        const gauss = () => {
            const u = Math.max(1e-9, rnd()), v = rnd();
            return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * (a / 100) * 60;
        };
        o[i] = r + gauss(); o[i + 1] = g + gauss(); o[i + 2] = b + gauss(); o[i + 3] = al;
    });
}

function pixelate(src, { size = 12, mode = 'block' } = {}) {
    const n = Math.max(2, toInt(size, 12));
    const { width, height, data } = src;
    const out = new Uint8ClampedArray(data.length);
    for (let y0 = 0; y0 < height; y0 += n) {
        for (let x0 = 0; x0 < width; x0 += n) {
            if (mode === 'sample') {
                const p = (y0 * width + x0) * 4;
                for (let y = y0; y < Math.min(y0 + n, height); y++) {
                    for (let x = x0; x < Math.min(x0 + n, width); x++) {
                        const o = (y * width + x) * 4;
                        out[o] = data[p]; out[o + 1] = data[p + 1]; out[o + 2] = data[p + 2]; out[o + 3] = data[p + 3];
                    }
                }
                continue;
            }
            let r = 0, g = 0, b = 0, a = 0, cnt = 0;
            for (let y = y0; y < Math.min(y0 + n, height); y++) {
                for (let x = x0; x < Math.min(x0 + n, width); x++) {
                    const p = (y * width + x) * 4;
                    r += data[p]; g += data[p + 1]; b += data[p + 2]; a += data[p + 3]; cnt++;
                }
            }
            r /= cnt; g /= cnt; b /= cnt; a /= cnt;
            for (let y = y0; y < Math.min(y0 + n, height); y++) {
                for (let x = x0; x < Math.min(x0 + n, width); x++) {
                    const o = (y * width + x) * 4;
                    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
                }
            }
        }
    }
    return mkPx(width, height, out);
}

function oilPaint(src, { radius = 3, intensity = 30 } = {}) {
    const r = clamp(toInt(radius, 3), 1, 8);
    const bins = Math.max(4, toInt(intensity, 30));
    const { width, height, data } = src;
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const hist = new Float64Array(bins);
            const accR = new Float64Array(bins), accG = new Float64Array(bins), accB = new Float64Array(bins);
            for (let j = -r; j <= r; j++) {
                const sy = clamp(y + j, 0, height - 1);
                for (let i = -r; i <= r; i++) {
                    const p = (sy * width + clamp(x + i, 0, width - 1)) * 4;
                    const l = luma(data[p], data[p + 1], data[p + 2]);
                    const bin = clamp(Math.round((l / 255) * (bins - 1)), 0, bins - 1);
                    hist[bin]++; accR[bin] += data[p]; accG[bin] += data[p + 1]; accB[bin] += data[p + 2];
                }
            }
            let best = 0;
            for (let b = 1; b < bins; b++) if (hist[b] > hist[best]) best = b;
            const o = (y * width + x) * 4;
            out[o] = accR[best] / hist[best]; out[o + 1] = accG[best] / hist[best]; out[o + 2] = accB[best] / hist[best];
            out[o + 3] = data[o + 3];
        }
    }
    return mkPx(width, height, out);
}

function vignette(src, { amount = 60, radius = 70, soften = 40, color = '#000000' } = {}) {
    const c = hexToRgb(color);
    const a = clamp(toNum(amount, 60) / 100, -1, 1);
    const inner = clamp(toNum(radius, 70) / 100, 0, 1);
    const soft = clamp(toNum(soften, 40) / 100, 0.01, 1);
    const { width, height } = src;
    const cx = width / 2, cy = height / 2;
    const maxR = Math.hypot(cx, cy);
    return mapPixels(src, (r, g, b, al, o, i) => {
        const px = (i / 4) % width, py = Math.floor((i / 4) / width);
        const d = Math.hypot(px - cx, py - cy) / maxR;
        const t = clamp((d - inner) / soft, 0, 1);
        const f = t * t * Math.abs(a);
        o[i] = r + (c[0] - r) * f; o[i + 1] = g + (c[1] - g) * f; o[i + 2] = b + (c[2] - b) * f; o[i + 3] = al;
    });
}

// 抠色：色距模型可选 RGB 欧氏或 HSV 锥形（对压缩噪点更稳）
function chromaKey(src, { color = '#00ff00', tolerance = 30, feather = 8, model = 'rgb', invert = false } = {}) {
    const target = hexToRgb(color);
    const tol = Math.max(1, toNum(tolerance, 30));
    const feat = Math.max(0, toNum(feather, 8));
    const tv = rgbToHsv(target[0], target[1], target[2]);
    const out = clonePx(src);
    const d = out.data;
    for (let i = 0; i < d.length; i += 4) {
        let dist;
        if (model === 'hsv') {
            const v = rgbToHsv(d[i], d[i + 1], d[i + 2]);
            const dh = Math.min(Math.abs(v[0] - tv[0]), 1 - Math.abs(v[0] - tv[0])) * 255 * 2;
            dist = Math.hypot(dh, (v[1] - tv[1]) * 255, (v[2] - tv[2]) * 255);
        } else {
            dist = Math.hypot(d[i] - target[0], d[i + 1] - target[1], d[i + 2] - target[2]);
        }
        const lo = tol, hi = tol + feat;
        let alpha = dist <= lo ? 0 : dist >= hi ? 255 : ((dist - lo) / Math.max(1, hi - lo)) * 255;
        if (invert) alpha = 255 - alpha;
        d[i + 3] = Math.min(d[i + 3], alpha);
    }
    return out;
}

function alphaMask(src, mask, { feather = 0, invert = false } = {}) {
    const out = clonePx(src);
    const d = out.data;
    const md = mask.data;
    const featherPx = Math.max(0, toInt(feather, 0));
    const blurred = featherPx > 0
        ? gaussianBlur(mkPx(mask.width, mask.height, (() => {
            const c = new Uint8ClampedArray(mask.width * mask.height * 4);
            for (let i = 0; i < mask.width * mask.height; i++) {
                const v = invert ? 255 - md[i] : md[i];
                c[i * 4] = c[i * 4 + 1] = c[i * 4 + 2] = c[i * 4 + 3] = v;
            }
            return c;
        })(), featherPx / 2), null) : null;
    for (let i = 0, j = 0; j < md.length; j++, i += 4) {
        const v = blurred ? luma(blurred.data[i], blurred.data[i + 1], blurred.data[i + 2]) : (invert ? 255 - md[j] : md[j]);
        if (mask.width === src.width && mask.height === src.height) d[i + 3] = Math.round((d[i + 3] * v) / 255);
    }
    return out;
}

// 圆角/羽化：只改 alpha，输出仍为 RGBA
function borderRadius(src, { radius = 24, feather = 0, corners = 'all', background = 'transparent' } = {}) {
    const { width, height, data } = src;
    const base = Math.min(width, height);
    const r = clamp(toNum(radius, 24), 0, base / 2);
    const feat = Math.max(0, toNum(feather, 0));
    const all = corners === 'all';
    const wants = (k) => all || String(corners).includes(k);
    // 每个角一段 1/4 圆弧，圆心在离边 r 处；像素落在角区内才按弧判定
    const cornersDef = [
        { k: 'tl', cx: r, cy: r, in: (x, y) => x < r && y < r },
        { k: 'tr', cx: width - r, cy: r, in: (x, y) => x >= width - r && y < r },
        { k: 'bl', cx: r, cy: height - r, in: (x, y) => x < r && y >= height - r },
        { k: 'br', cx: width - r, cy: height - r, in: (x, y) => x >= width - r && y >= height - r },
    ];
    const out = clonePx(src);
    const o = out.data;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            let inside = 1;
            if (r > 0) {
                for (const c of cornersDef) {
                    if (!c.in(x, y) || !wants(c.k)) continue;
                    const d = Math.hypot(x - c.cx, y - c.cy);
                    inside = feat > 0 ? clamp((r + feat - d) / feat, 0, 1) : (d <= r ? 1 : 0);
                    break;
                }
            }
            o[i + 3] = Math.round(data[i + 3] * inside);
        }
    }
    if (background && background !== 'transparent') {
        const c = hexToRgb(background);
        for (let i = 0; i < o.length; i += 4) {
            const a = o[i + 3] / 255;
            o[i] = o[i] * a + c[0] * (1 - a);
            o[i + 1] = o[i + 1] * a + c[1] * (1 - a);
            o[i + 2] = o[i + 2] * a + c[2] * (1 - a);
            o[i + 3] = 255;
        }
    }
    return out;
}

// 局部处理：对矩形列表分别执行 fn（人脸打码、区域锐化都用它），边缘做羽化过渡
function applyToRects(src, fn, rects, { feather = 6, blurBefore = 0 } = {}) {
    const processed = fn(src);
    const out = clonePx(src);
    for (const rect of rects || []) {
        const x0 = clamp(Math.round(rect.x - feather), 0, src.width - 1);
        const y0 = clamp(Math.round(rect.y - feather), 0, src.height - 1);
        const x1 = clamp(Math.round(rect.x + rect.width + feather), 0, src.width);
        const y1 = clamp(Math.round(rect.y + rect.height + feather), 0, src.height);
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const dx = Math.max(rect.x - x, x - (rect.x + rect.width), 0);
                const dy = Math.max(rect.y - y, y - (rect.y + rect.height), 0);
                const d = Math.hypot(dx, dy);
                let t = feather > 0 ? clamp(1 - d / feather, 0, 1) : (d === 0 ? 1 : 0);
                if (t <= 0) continue;
                const i = (y * src.width + x) * 4;
                for (let c = 0; c < 3; c++) out.data[i + c] = src.data[i + c] * (1 - t) + processed.data[i + c] * t;
                out.data[i + 3] = Math.round(src.data[i + 3] * (1 - t) + processed.data[i + 3] * t);
            }
        }
    }
    return out;
}


return { "gaussianKernel1D": (typeof gaussianKernel1D === 'undefined' ? undefined : gaussianKernel1D), "gaussianBlur": (typeof gaussianBlur === 'undefined' ? undefined : gaussianBlur), "boxBlur": (typeof boxBlur === 'undefined' ? undefined : boxBlur), "convolve": (typeof convolve === 'undefined' ? undefined : convolve), "KERNELS": (typeof KERNELS === 'undefined' ? undefined : KERNELS), "sharpen": (typeof sharpen === 'undefined' ? undefined : sharpen), "unsharp": (typeof unsharp === 'undefined' ? undefined : unsharp), "medianFilter": (typeof medianFilter === 'undefined' ? undefined : medianFilter), "bilateralFilter": (typeof bilateralFilter === 'undefined' ? undefined : bilateralFilter), "addNoise": (typeof addNoise === 'undefined' ? undefined : addNoise), "pixelate": (typeof pixelate === 'undefined' ? undefined : pixelate), "oilPaint": (typeof oilPaint === 'undefined' ? undefined : oilPaint), "vignette": (typeof vignette === 'undefined' ? undefined : vignette), "chromaKey": (typeof chromaKey === 'undefined' ? undefined : chromaKey), "alphaMask": (typeof alphaMask === 'undefined' ? undefined : alphaMask), "borderRadius": (typeof borderRadius === 'undefined' ? undefined : borderRadius), "applyToRects": (typeof applyToRects === 'undefined' ? undefined : applyToRects), "convolveHorizontal": (typeof convolveHorizontal === 'undefined' ? undefined : convolveHorizontal) };
})();
__M["src/common/imgops/edge.js"] = (function(){
// 梯度/边缘、二值化与形态学。灰度域实现，输出统一回 RGBA 便于流水线串联。

const { clamp, toNum, toInt } = __M["src/common/util.js"];
const { mkPx, clonePx } = __M["src/common/imgops/geometry.js"];
const { gaussianBlur, convolve, KERNELS } = __M["src/common/imgops/filter.js"];
const { toGray } = __M["src/common/imgops/color.js"];


function grayToPx(g) {
    const out = new Uint8ClampedArray(g.width * g.height * 4);
    for (let i = 0, j = 0; i < out.length; i += 4, j++) {
        out[i] = out[i + 1] = out[i + 2] = g.data[j];
        out[i + 3] = 255;
    }
    return mkPx(g.width, g.height, out);
}

// 保留原图 alpha（透明 PNG 抠色后仍透明）
function keepAlpha(result, src) {
    if (!src || src.width !== result.width || src.height !== result.height) return result;
    for (let i = 3; i < result.data.length; i += 4) result.data[i] = src.data[i];
    return result;
}

function grayConvolve(g, kernel) {
    const size = kernel.length, half = Math.floor(size / 2);
    let div = kernel.flat().reduce((a, b) => a + b, 0);
    if (!div) div = 1;
    const { width, height, data } = g;
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let acc = 0;
            for (let j = 0; j < size; j++) {
                const sy = clamp(y + j - half, 0, height - 1);
                for (let i = 0; i < size; i++) {
                    const sx = clamp(x + i - half, 0, width - 1);
                    acc += data[sy * width + sx] * kernel[j][i];
                }
            }
            out[y * width + x] = acc / div;
        }
    }
    return { width, height, data: out };
}

function sobel(src, { mode = 'magnitude', grayscale = true, luma = 'luma709' } = {}) {
    const g = toGray(src, luma);
    const gx = grayConvolve(g, KERNELS.sobelX).data;
    const gy = grayConvolve(g, KERNELS.sobelY).data;
    // 幅值可达 1020+，必须先放 Float32；写进 Uint8Clamped 会被截到 255，
    // 之后按截断值归一化会把所有边缘压成同一个灰级
    const mag = new Float32Array(g.width * g.height);
    let max = 1;
    for (let i = 0; i < mag.length; i++) {
        const v = mode === 'x' ? Math.abs(gx[i]) : mode === 'y' ? Math.abs(gy[i]) : Math.hypot(gx[i], gy[i]);
        mag[i] = v;
        if (v > max) max = v;
    }
    const out = new Uint8ClampedArray(mag.length);
    for (let i = 0; i < out.length; i++) out[i] = clamp(Math.round((mag[i] / max) * 255), 0, 255);
    return keepAlpha(grayToPx({ width: g.width, height: g.height, data: out }), grayscale ? null : src);
}

function scharr(src, opts = {}) {
    const g = toGray(src, opts.luma || 'luma709');
    const gx = grayConvolve(g, KERNELS.scharrX).data;
    const gy = grayConvolve(g, KERNELS.scharrY).data;
    const mag = new Float32Array(g.width * g.height);
    let max = 1;
    for (let i = 0; i < mag.length; i++) {
        const v = Math.hypot(gx[i], gy[i]);
        mag[i] = v; if (v > max) max = v;
    }
    const out = new Uint8ClampedArray(mag.length);
    for (let i = 0; i < out.length; i++) out[i] = clamp(Math.round((mag[i] / max) * 255), 0, 255);
    return grayToPx({ width: g.width, height: g.height, data: out });
}

function laplacian(src, { scale = 'auto', kernel = '4' } = {}) {
    const g = toGray(src, 'luma709');
    const k = kernel === '8'
        ? [[1, 1, 1], [1, -8, 1], [1, 1, 1]]
        : KERNELS.laplacian;
    const r = grayConvolve(g, k);
    const out = new Uint8ClampedArray(r.data.length);
    if (scale === 'abs') {
        for (let i = 0; i < out.length; i++) out[i] = clamp(Math.round(Math.abs(r.data[i])), 0, 255);
    } else {
        for (let i = 0; i < out.length; i++) out[i] = clamp(Math.round(r.data[i] + 128), 0, 255);
    }
    return grayToPx({ width: r.width, height: r.height, data: out });
}

// LoG 用高斯差（DoG）近似：省一次二维卷积，效果对阈值分割等价
function logEdge(src, { sigma = 2, scale = 1.6, normalize = true } = {}) {
    const g = toGray(src, 'luma709');
    const b1 = gaussianBlurPx(g, sigma);
    const b2 = gaussianBlurPx(g, sigma * toNum(scale, 1.6));
    const out = new Uint8ClampedArray(g.data.length);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < out.length; i++) {
        const v = b2.data[i] - b1.data[i];
        out[i] = v;
        if (v < min) min = v; if (v > max) max = v;
    }
    const span = Math.max(1e-6, max - min);
    for (let i = 0; i < out.length; i++) out[i] = clamp(Math.round(((out[i] - min) / span) * 255), 0, 255);
    if (!normalize) for (let i = 0; i < out.length; i++) out[i] = out[i] > 128 ? 255 : 0;
    return grayToPx({ width: g.width, height: g.height, data: out });
}

function gaussianBlurPx(g, sigma) {
    const px = grayToPx(g);
    const blurred = gaussianBlur(px, sigma);
    const data = new Uint8ClampedArray(g.data.length);
    for (let i = 0, j = 0; j < data.length; i += 4, j++) data[j] = blurred.data[i];
    return { width: g.width, height: g.height, data };
}

// Canny：高斯平滑 -> Sobel 梯度与方向 -> 非极大值抑制 -> 双阈值 -> 滞回连通
function canny(src, { low = 40, high = 120, sigma = 1.4, luma = 'luma709' } = {}) {
    const g0 = toGray(src, luma);
    const g = gaussianBlurPx(g0, toNum(sigma, 1.4));
    const { width, height } = g;
    const gx = new Float32Array(width * height);
    const gy = new Float32Array(width * height);
    const mag = new Float32Array(width * height);
    const dir = new Float32Array(width * height);
    const at = (x, y) => g.data[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            gx[i] = (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
                * -1 + (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
            gy[i] = (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
                * -1 + (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
            mag[i] = Math.hypot(gx[i], gy[i]);
            let d = Math.atan2(gy[i], gx[i]) * 180 / Math.PI;
            if (d < 0) d += 180;
            dir[i] = d;
        }
    }
    const nms = new Float32Array(width * height);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const d = dir[i];
            let a, b;
            if (d < 22.5 || d >= 157.5) { a = mag[i - 1]; b = mag[i + 1]; }
            else if (d < 67.5) { a = mag[i - width + 1]; b = mag[i + width - 1]; }
            else if (d < 112.5) { a = mag[i - width]; b = mag[i + width]; }
            else { a = mag[i - width - 1]; b = mag[i + width + 1]; }
            nms[i] = (mag[i] >= a && mag[i] >= b) ? mag[i] : 0;
        }
    }
    const lo = toNum(low, 40), hi = toNum(high, 120);
    const strong = new Uint8Array(width * height);
    const weak = new Uint8Array(width * height);
    for (let i = 0; i < nms.length; i++) {
        if (nms[i] >= hi) strong[i] = 1;
        else if (nms[i] >= lo) weak[i] = 1;
    }
    const stack = [];
    for (let i = 0; i < strong.length; i++) if (strong[i]) stack.push(i);
    while (stack.length) {
        const i = stack.pop();
        const x = i % width, y = (i / width) | 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                const j = ny * width + nx;
                if (weak[j] && !strong[j]) { strong[j] = 1; stack.push(j); }
            }
        }
    }
    const out = new Uint8ClampedArray(width * height);
    for (let i = 0; i < out.length; i++) out[i] = strong[i] ? 255 : 0;
    return grayToPx({ width, height, data: out });
}

function otsuThreshold(g) {
    const hist = new Float64Array(256);
    for (let i = 0; i < g.data.length; i++) hist[g.data[i]]++;
    const total = g.data.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, wF = 0, best = -1, thr = 0;
    for (let i = 0; i < 256; i++) {
        wB += hist[i];
        if (!wB) continue;
        wF = total - wB;
        if (!wF) break;
        sumB += i * hist[i];
        const mB = sumB / wB, mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > best) { best = between; thr = i; }
    }
    return thr;
}

function boxSum(src, radius) {
    const { width, height, data } = src;
    const acc = new Float64Array((width + 1) * (height + 1));
    for (let y = 0; y < height; y++) {
        let rowSum = 0;
        for (let x = 0; x < width; x++) {
            rowSum += data[y * width + x];
            acc[(y + 1) * (width + 1) + (x + 1)] = acc[y * (width + 1) + (x + 1)] + rowSum;
        }
    }
    return (x0, y0, x1, y1) => {
        const w = x1 - x0, h = y1 - y0;
        if (w <= 0 || h <= 0) return 0;
        const s = acc[y1 * (width + 1) + x1] - acc[y0 * (width + 1) + x1] - acc[y1 * (width + 1) + x0] + acc[y0 * (width + 1) + x0];
        return s / (w * h);
    };
}

function threshold(src, { mode = 'otsu', value = 128, blockSize = 21, C = 8, k = 0.2, sigmaLocal = 0.02, invert = false, output = 'binary', luma = 'luma709', color = null } = {}) {
    const g = toGray(src, luma);
    const { width, height, data } = g;
    const out = new Uint8ClampedArray(data.length);
    const thrMap = new Uint8ClampedArray(data.length);

    if (mode === 'fixed') {
        const t = toNum(value, 128);
        for (let i = 0; i < data.length; i++) thrMap[i] = t;
    } else if (mode === 'otsu' || mode === 'trirate') {
        const t = otsuThreshold(g);
        for (let i = 0; i < data.length; i++) thrMap[i] = t;
    } else if (mode === 'mean' || mode === 'gaussian') {
        const r = Math.max(1, Math.round(toNum(blockSize, 21) / 2));
        const sum = boxSum(g, 0);
        const c = toNum(C, 8);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const x0 = clamp(x - r, 0, width), y0 = clamp(y - r, 0, height);
                const x1 = clamp(x + r + 1, 0, width), y1 = clamp(y + r + 1, 0, height);
                // 积分图均值得到邻域平均，再减去常数 C（OpenCV 语义）
                const mean = sum(x0, y0, x1, y1);
                thrMap[y * width + x] = clamp(Math.round(mean - c), 0, 255);
            }
        }
    } else if (mode === 'sauvola') {
        const r = Math.max(1, Math.round(toNum(blockSize, 21) / 2));
        const kk = toNum(k, 0.2);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let s = 0, s2 = 0, n = 0;
                for (let j = -r; j <= r; j++) {
                    const sy = clamp(y + j, 0, height - 1);
                    for (let i = -r; i <= r; i++) {
                        const v = data[sy * width + clamp(x + i, 0, width - 1)];
                        s += v; s2 += v * v; n++;
                    }
                }
                const mean = s / n;
                const std = Math.sqrt(Math.max(0, s2 / n - mean * mean));
                thrMap[y * width + x] = clamp(Math.round(mean * (1 + kk * (std / 128 - 1))), 0, 255);
            }
        }
    } else if (mode === 'localSigma') {
        const r = Math.max(1, Math.round(toNum(blockSize, 31) / 2));
        const sg = toNum(sigmaLocal, 0.02) * 255;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let s = 0, s2 = 0, n = 0;
                for (let j = -r; j <= r; j++) {
                    const sy = clamp(y + j, 0, height - 1);
                    for (let i = -r; i <= r; i++) {
                        const v = data[sy * width + clamp(x + i, 0, width - 1)];
                        s += v; s2 += v * v; n++;
                    }
                }
                const mean = s / n;
                const std = Math.sqrt(Math.max(0, s2 / n - mean * mean));
                thrMap[y * width + x] = clamp(Math.round(mean + sg * std - toNum(C, 0)), 0, 255);
            }
        }
    } else {
        for (let i = 0; i < data.length; i++) thrMap[i] = toNum(value, 128);
    }

    if (mode === 'trirate') {
        const t = thrMap[0];
        const lo = Math.round(t * 0.7), hi = Math.round(Math.min(255, t * 1.3 + 10));
        for (let i = 0; i < data.length; i++) {
            const v = data[i] < lo ? 0 : data[i] > hi ? 255 : (invert ? 0 : 128);
            out[i] = v === 128 ? (invert ? 255 : 128) : v;
        }
    } else {
        for (let i = 0; i < data.length; i++) {
            const on = data[i] >= thrMap[i];
            out[i] = (invert ? !on : on) ? 255 : 0;
        }
    }

    if (output === 'gray') {
        for (let i = 0; i < out.length; i++) out[i] = out[i] > 0 ? data[i] : 0;
    }
    const gray = { width, height, data: out };
    if (output === 'keep-color') {
        const res = clonePx(src);
        for (let i = 0, j = 0; j < out.length; i += 4, j++) {
            if (out[j] === 0) { res.data[i] = res.data[i + 1] = res.data[i + 2] = color ? (typeof color === 'string' ? 0 : color[0]) : 0; }
        }
        return res;
    }
    return grayToPx(gray);
}

function morphWindow(shape, r) {
    const pts = [];
    for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
            if (shape === 'cross' && dx !== 0 && dy !== 0) continue;
            if (shape === 'circle' && Math.hypot(dx, dy) > r + 0.01) continue;
            pts.push([dx, dy]);
        }
    }
    return pts;
}

function morphology(src, { op = 'erode', radius = 1, shape = 'rect' } = {}) {
    const r = clamp(toInt(radius, 1), 1, 15);
    const pts = morphWindow(shape, r);
    const g = toGray(src, 'average');
    const { width, height, data } = g;
    const mode = op === 'dilate' || op === 'open' || op === 'gradient' || op === 'tophat';
    const out = new Uint8ClampedArray(data.length);

    const single = (input, wantMax) => {
        const o = new Uint8ClampedArray(input.length);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let v = wantMax ? 0 : 255;
                for (const [dx, dy] of pts) {
                    const p = input[clamp(y + dy, 0, height - 1) * width + clamp(x + dx, 0, width - 1)];
                    if (wantMax ? p > v : p < v) v = p;
                }
                o[y * width + x] = v;
            }
        }
        return o;
    };

    let base = data;
    if (op === 'erode' || op === 'open' || op === 'tophat') base = single(data, false);
    if (op === 'dilate' || op === 'close' || op === 'tophat') {
        base = single(op === 'close' ? data : base, true);
    }
    out.set(base);

    if (op === 'gradient') {
        const er = single(data, false), di = single(data, true);
        for (let i = 0; i < out.length; i++) out[i] = clamp(di[i] - er[i], 0, 255);
    } else if (op === 'tophat') {
        const er = single(data, false), di = single(er, true);
        for (let i = 0; i < out.length; i++) out[i] = clamp(data[i] - di[i], 0, 255);
    } else if (op === 'blackhat') {
        const di = single(data, true), er = single(di, false);
        for (let i = 0; i < out.length; i++) out[i] = clamp(er[i] - data[i], 0, 255);
    }
    return grayToPx({ width, height, data: out });
}


return { "toGray": (typeof toGray === 'undefined' ? undefined : toGray), "grayConvolve": (typeof grayConvolve === 'undefined' ? undefined : grayConvolve), "sobel": (typeof sobel === 'undefined' ? undefined : sobel), "scharr": (typeof scharr === 'undefined' ? undefined : scharr), "laplacian": (typeof laplacian === 'undefined' ? undefined : laplacian), "logEdge": (typeof logEdge === 'undefined' ? undefined : logEdge), "canny": (typeof canny === 'undefined' ? undefined : canny), "otsuThreshold": (typeof otsuThreshold === 'undefined' ? undefined : otsuThreshold), "threshold": (typeof threshold === 'undefined' ? undefined : threshold), "morphology": (typeof morphology === 'undefined' ? undefined : morphology), "grayToPx": (typeof grayToPx === 'undefined' ? undefined : grayToPx), "keepAlpha": (typeof keepAlpha === 'undefined' ? undefined : keepAlpha) };
})();
__M["src/common/cv.js"] = (function(){
// 分析与测量类算子：统计、直方图、主色板、连通域、轮廓、角点、霍夫、模板匹配、
// 感知哈希与相似度。全部返回可 JSON 化的结果，方便跨上下文消息传递。

const { clamp, toNum, toInt } = __M["src/common/util.js"];
const { mkPx, clonePx, resize } = __M["src/common/imgops/geometry.js"];
const { luma, rgbToHsv, rgbToHex, toGray } = __M["src/common/imgops/color.js"];

function stats(src) {
    const d = src.data;
    const n = d.length / 4;
    let sr = 0, sg = 0, sb = 0, sa = 0, s2r = 0, s2g = 0, s2b = 0;
    let min = 255, max = 0, opaque = 0, transparent = 0;
    for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
        sr += r; sg += g; sb += b; sa += a;
        s2r += r * r; s2g += g * g; s2b += b * b;
        const l = luma(r, g, b);
        if (l < min) min = l;
        if (l > max) max = l;
        if (a > 8) opaque++; else transparent++;
    }
    const std = (s2, s) => Math.sqrt(Math.max(0, s2 / n - (s / n) * (s / n)));
    return {
        width: src.width, height: src.height, pixels: n,
        mean: [sr / n, sg / n, sb / n],
        stddev: [std(s2r, sr), std(s2g, sg), std(s2b, sb)],
        lumaMin: min, lumaMax: max,
        alphaCover: n ? opaque / n : 0,
        transparentPixels: transparent,
    };
}

function histogram(src, bins = 256, channel = 'luma') {
    const h = new Array(bins).fill(0);
    const d = src.data;
    for (let i = 0; i < d.length; i += 4) {
        const v = channel === 'luma' ? luma(d[i], d[i + 1], d[i + 2])
            : channel === 'r' ? d[i] : channel === 'g' ? d[i + 1] : channel === 'b' ? d[i + 2]
                : channel === 'alpha' ? d[i + 3] : d[i] * 0.33 + d[i + 1] * 0.34 + d[i + 2] * 0.33;
        h[clamp(Math.round((v / 255) * (bins - 1)), 0, bins - 1)]++;
    }
    const total = d.length / 4;
    let entropy = 0;
    for (const c of h) if (c) { const p = c / total; entropy -= p * Math.log2(p); }
    return { bins: h, binCount: bins, channel, entropy, total };
}

// 中位切割取主色：按色域最长轴分裂，返回按面积排序的颜色与占比
function palette(src, { count = 6, ignoreTransparent = true } = {}) {
    const k = Math.max(1, toInt(count, 6));
    const pixels = [];
    const d = src.data;
    const step = Math.max(1, Math.floor(Math.sqrt((src.width * src.height) / 20000)));
    for (let y = 0; y < src.height; y += step) {
        for (let x = 0; x < src.width; x += step) {
            const i = (y * src.width + x) * 4;
            if (ignoreTransparent && d[i + 3] < 16) continue;
            pixels.push([d[i], d[i + 1], d[i + 2]]);
        }
    }
    if (!pixels.length) return { colors: [], sampleCount: 0 };
    const boxes = [pixels];
    while (boxes.length < k) {
        let best = -1, bestSpan = -1, bestAxis = 0;
        boxes.forEach((box, idx) => {
            if (box.length < 2) return;
            for (let ax = 0; ax < 3; ax++) {
                let lo = 255, hi = 0;
                for (const p of box) { if (p[ax] < lo) lo = p[ax]; if (p[ax] > hi) hi = p[ax]; }
                const span = hi - lo;
                if (span > bestSpan) { bestSpan = span; best = idx; bestAxis = ax; }
            }
        });
        if (best < 0) break;
        const box = boxes[best].slice().sort((a, b) => a[bestAxis] - b[bestAxis]);
        const mid = box.length >> 1;
        boxes.splice(best, 1, box.slice(0, mid), box.slice(mid));
    }
    const total = src.width * src.height;
    const colors = boxes.filter((b) => b.length).map((box) => {
        let r = 0, g = 0, b2 = 0;
        for (const p of box) { r += p[0]; g += p[1]; b2 += p[2]; }
        const n = box.length;
        const rgb = [Math.round(r / n), Math.round(g / n), Math.round(b2 / n)];
        return { rgb, hex: rgbToHex(rgb[0], rgb[1], rgb[2]), share: n / (boxes.reduce((a, b) => a + b.length, 0) || 1), samples: n, total };
    }).sort((a, b) => b.share - a.share);
    return { colors, sampleCount: pixels.length };
}

// 8/4 连通域标记（两遍扫描 + union-find），返回标签图与每域几何
function connectedComponents(binary, { connectivity = 8, minArea = 0, binarize = true, threshold = 128 } = {}) {
    const g = binary.data.length === binary.width * binary.height
        ? binary
        : toGray({ width: binary.width, height: binary.height, data: binary.data }, 'average');
    const { width, height, data } = g;
    const isOn = (i) => (binarize ? data[i] >= threshold : data[i] > 0);
    const parent = new Int32Array(width * height);
    const labels = new Int32Array(width * height);
    let next = 1;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const neigh4 = [[-1, 0], [0, -1]];
    const neigh8 = [[-1, -1], [0, -1], [1, -1], [-1, 0]];
    const nb = connectivity === 4 ? neigh4 : neigh8;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            if (!isOn(i)) { labels[i] = 0; continue; }
            let best = 0;
            for (const [dx, dy] of nb) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                const j = ny * width + nx;
                if (!isOn(j)) continue;
                if (labels[j] && (!best || find(labels[j]) < find(best))) best = labels[j];
            }
            if (!best) { labels[i] = next; parent[next] = next; next++; }
            else {
                labels[i] = best;
                for (const [dx, dy] of nb) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                    const j = ny * width + nx;
                    if (labels[j]) union(labels[j], best);
                }
            }
        }
    }
    const remap = new Int32Array(next);
    let count = 0;
    const areas = [], boxes = [];
    for (let i = 0; i < labels.length; i++) {
        if (!labels[i]) continue;
        const root = find(labels[i]);
        if (!remap[root]) remap[root] = ++count;
        labels[i] = remap[root];
        const idx = labels[i] - 1;
        if (!areas[idx]) { areas[idx] = 0; boxes[idx] = { x0: width, y0: height, x1: 0, y1: 0 }; }
        areas[idx]++;
        const x = i % width, y = (i / width) | 0;
        const b = boxes[idx];
        if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x;
        if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
    }
    const regions = [];
    for (let l = 0; l < count; l++) {
        if (areas[l] < minArea) continue;
        const b = boxes[l];
        regions.push({
            label: l + 1, area: areas[l],
            x: b.x0, y: b.y0, width: b.x1 - b.x0 + 1, height: b.y1 - b.y0 + 1,
            fillRatio: areas[l] / Math.max(1, (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1)),
        });
    }
    regions.sort((a, b) => b.area - a.area);
    return { labels, count: regions.length, regions, width, height };
}

// Moore 邻域边界追踪 + RDP 简化；hole 检测靠奇偶嵌套（外层轮廓优先）
function contours(binary, { threshold = 128, simplify = 1.5, minArea = 24, connectivity = 8 } = {}) {
    const cc = connectedComponents(binary, { connectivity, threshold, minArea });
    const { labels, width, height } = cc;
    const on = (x, y) => (x >= 0 && y >= 0 && x < width && y < height && labels[y * width + x] > 0);
    const visited = new Uint8Array(width * height);
    const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const out = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            if (!labels[i] || visited[i]) continue;
            if (on(x - 1, y) && on(x, y - 1) && on(x + 1, y) && on(x, y + 1)) continue;
            const start = [x, y];
            let px = x, py = y, prevDir = 6;
            const pts = [];
            let guard = 0;
            do {
                pts.push([px, py]);
                visited[py * width + px] = 1;
                let found = false;
                for (let k = 1; k <= 8; k++) {
                    const d = (prevDir + k) % 8;
                    const nx = px + dirs[d][0], ny = py + dirs[d][1];
                    if (on(nx, ny)) { px = nx; py = ny; prevDir = d; found = true; break; }
                }
                if (!found) break;
            } while ((px !== start[0] || py !== start[1]) && guard++ < width * height * 2);
            const poly = simplify > 0 ? rdp(pts, simplify) : pts;
            if (poly.length < 3) continue;
            const area = polyArea(poly);
            if (Math.abs(area) < minArea) continue;
            out.push({
                points: poly,
                area: Math.abs(area),
                perimeter: polyLength(poly),
                boundingRect: polyBBox(poly),
                convexHull: convexHull(poly),
                minAreaRect: minAreaRect(poly),
                circularity: (4 * Math.PI * Math.abs(area)) / Math.max(1, polyLength(poly) ** 2),
            });
        }
    }
    out.sort((a, b) => b.area - a.area);
    return out;
}

function polyArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        a += x1 * y2 - x2 * y1;
    }
    return a / 2;
}

function polyLength(pts) {
    let l = 0;
    for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        l += Math.hypot(x2 - x1, y2 - y1);
    }
    return l;
}

function polyBBox(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0 + 1), height: Math.round(y1 - y0 + 1) };
}

function convexHull(pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const pt of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop(); lower.push(pt); }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) { const pt = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop(); upper.push(pt); }
    lower.pop(); upper.pop();
    return lower.concat(upper);
}

// 旋转最小外接矩：凸包 + 卡尺（边对）
function minAreaRect(pts) {
    const hull = pts.length > 3 ? convexHull(pts) : pts;
    let best = null;
    for (let i = 0; i < hull.length; i++) {
        const [x1, y1] = hull[i], [x2, y2] = hull[(i + 1) % hull.length];
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        let minP = Infinity, maxP = -Infinity, minQ = Infinity, maxQ = -Infinity;
        for (const [px, py] of hull) {
            const p = px * ux + py * uy;
            const q = -px * uy + py * ux;
            if (p < minP) minP = p; if (p > maxP) maxP = p;
            if (q < minQ) minQ = q; if (q > maxQ) maxQ = q;
        }
        const area = (maxP - minP) * (maxQ - minQ);
        if (!best || area < best.area) {
            best = {
                area,
                width: maxP - minP,
                height: maxQ - minQ,
                angle: Math.atan2(uy, ux) * 180 / Math.PI,
                corners: [
                    [minP * ux - minQ * uy, minP * uy + minQ * ux],
                    [maxP * ux - minQ * uy, maxP * uy + minQ * ux],
                    [maxP * ux - maxQ * uy, maxP * uy + maxQ * ux],
                    [minP * ux - maxQ * uy, minP * uy + maxQ * ux],
                ].map((c) => [Math.round(c[0] * 10) / 10, Math.round(c[1] * 10) / 10]),
            };
        }
    }
    if (!best) return null;
    return { width: Math.round(best.width), height: Math.round(best.height), angle: Math.round(best.angle * 10) / 10, area: Math.round(best.area), corners: best.corners };
}

function rdp(pts, eps) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length);
    keep[0] = 1; keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        if (b <= a + 1) continue;
        const [ax, ay] = pts[a], [bx, by] = pts[b];
        const dx = bx - ax, dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        let maxD = -1, idx = -1;
        for (let i = a + 1; i < b; i++) {
            const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
            if (d > maxD) { maxD = d; idx = i; }
        }
        if (maxD > eps && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    return pts.filter((_, i) => keep[i]);
}

function harrisCorners(src, { blockSize = 3, k = 0.04, thresholdRatio = 0.01, maxCorners = 200, nonMaxRadius = 6 } = {}) {
    const g = toGray(src, 'luma709');
    const gx = [], gy = [];
    const { width, height, data } = g;
    const at = (x, y) => data[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
    const Ix = new Float32Array(width * height), Iy = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            Ix[i] = (at(x + 1, y - 1) - at(x - 1, y - 1) + 2 * (at(x + 1, y) - at(x - 1, y)) + at(x + 1, y + 1) - at(x - 1, y + 1)) / 8;
            Iy[i] = (at(x - 1, y + 1) - at(x - 1, y - 1) + 2 * (at(x, y + 1) - at(x, y - 1)) + at(x + 1, y + 1) - at(x + 1, y - 1)) / 8;
        }
    }
    const r = Math.max(1, toInt(blockSize, 3));
    const R = new Float32Array(width * height);
    let maxR = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sxx = 0, syy = 0, sxy = 0;
            for (let j = -r; j <= r; j++) {
                for (let i = -r; i <= r; i++) {
                    const p = clamp(y + j, 0, height - 1) * width + clamp(x + i, 0, width - 1);
                    sxx += Ix[p] * Ix[p]; syy += Iy[p] * Iy[p]; sxy += Ix[p] * Iy[p];
                }
            }
            const det = sxx * syy - sxy * sxy;
            const tr = sxx + syy;
            R[y * width + x] = det - toNum(k, 0.04) * tr * tr;
            if (R[y * width + x] > maxR) maxR = R[y * width + x];
        }
    }
    const thr = maxR * toNum(thresholdRatio, 0.01);
    const cand = [];
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            if (R[i] < thr) continue;
            let isMax = true;
            for (let j = -1; j <= 1 && isMax; j++) {
                for (let k2 = -1; k2 <= 1; k2++) {
                    if (!k2 && !j) continue;
                    if (R[i + j * width + k2] > R[i]) { isMax = false; break; }
                }
            }
            if (isMax) cand.push({ x, y, score: R[i] });
        }
    }
    cand.sort((a, b) => b.score - a.score);
    const kept = [];
    const rad = toInt(nonMaxRadius, 6);
    for (const c of cand) {
        if (kept.every((o) => Math.hypot(o.x - c.x, o.y - c.y) > rad)) kept.push(c);
        if (kept.length >= toInt(maxCorners, 200)) break;
    }
    return kept;
}

// HSV 范围分割：用于按颜色抠图/统计（支持色相跨越 0 度）
function inRange(src, { hueMin = 0, hueMax = 60, satMin = 0.3, satMax = 1, valMin = 0.2, valMax = 1, invert = false } = {}) {
    const d = src.data;
    const mask = new Uint8ClampedArray(src.width * src.height);
    let hueWrap = toNum(hueMin, 0) > toNum(hueMax, 60);
    const hx = (h) => {
        if (!hueWrap) return h >= hueMin / 360 && h <= hueMax / 360;
        return h >= hueMin / 360 || h <= hueMax / 360;
    };
    for (let i = 0, j = 0; j < mask.length; i += 4, j++) {
        const [h, s, v] = rgbToHsv(d[i], d[i + 1], d[i + 2]);
        const hit = hx(h) && s >= satMin && s <= satMax && v >= valMin && v <= valMax;
        mask[j] = (hit !== invert) ? 255 : 0;
    }
    return mkPx(src.width, src.height, (() => {
        const o = new Uint8ClampedArray(mask.length * 4);
        for (let i = 0; i < mask.length; i++) { o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = o[i * 4 + 3] = mask[i]; }
        return o;
    })());
}

// 归一化互相关模板匹配：小步长 + 降采样保护耗时
function templateMatch(src, tmpl, { method = 'sncc', stride = 1, maxCandidates = 5, threshold = 0.6 } = {}) {
    const cap = 2_000_000;
    let a = src, b = tmpl;
    const totalOps = (src.width - tmpl.width) * (src.height - tmpl.height) * tmpl.width * tmpl.height;
    if (totalOps > cap) {
        const s = Math.sqrt(cap / Math.max(1, totalOps));
        a = resize(src, Math.round(src.width * s), Math.round(src.height * s), 'area');
        b = resize(tmpl, Math.max(2, Math.round(tmpl.width * s)), Math.max(2, Math.round(tmpl.height * s)), 'area');
    }
    const ga = toGray(a, 'average'), gb = toGray(b, 'average');
    const W = ga.width, H = ga.height, tw = gb.width, th = gb.height;
    if (tw > W || th > H) return { candidates: [], scale: s_report(a, src), method };
    let meanB = 0;
    for (const v of gb.data) meanB += v;
    meanB /= gb.data.length;
    let varB = 0;
    for (const v of gb.data) varB += (v - meanB) ** 2;
    const normB = Math.sqrt(varB) || 1;
    const out = [];
    for (let y = 0; y <= H - th; y += Math.max(1, toInt(stride, 1))) {
        for (let x = 0; x <= W - tw; x += Math.max(1, toInt(stride, 1))) {
            let m = 0;
            for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) m += ga.data[(y + j) * W + x + i];
            m /= tw * th;
            let num = 0, varA = 0;
            for (let j = 0; j < th; j++) {
                for (let i = 0; i < tw; i++) {
                    const da = ga.data[(y + j) * W + x + i] - m;
                    const db = gb.data[j * tw + i] - meanB;
                    num += da * db; varA += da * da;
                }
            }
            // 标准 NCC：num / sqrt(varA * varB)，两项都是同一窗口内的离差平方和
            const score = num / (Math.sqrt(varA) * normB + 1e-6);
            if (score >= toNum(threshold, 0.6)) out.push({ x: Math.round(x / s_scale(a, src)), y: Math.round(y / s_scale(a, src)), w: Math.round(tw / s_scale(a, src)), h: Math.round(th / s_scale(a, src)), score: Number(score.toFixed(4)) });
        }
    }
    out.sort((p, q) => q.score - p.score);
    const kept = [];
    for (const c of out) {
        if (kept.every((o) => !(c.x < o.x + o.w * 0.5 && c.x + c.w * 0.5 > o.x && c.y < o.y + o.h * 0.5 && c.y + c.h * 0.5 > o.y))) kept.push(c);
        if (kept.length >= toInt(maxCandidates, 5)) break;
    }
    return { candidates: kept, scale: s_scale(a, src), method };
}
function s_scale(a, src) { return a.width / src.width || 1; }
function s_report(a, src) { return a.width / src.width || 1; }

// 霍夫直线（概率式提前分箱，避免超大 rho 数组）
function houghLines(edgeSrc, { threshold = 90, thetaSteps = 180, minLength = 0, maxLines = 10 } = {}) {
    const g = toGray(edgeSrc, 'average');
    const { width, height, data } = g;
    const maxRho = Math.ceil(Math.hypot(width, height));
    const thetas = new Float32Array(thetaSteps);
    const sinT = new Float32Array(thetaSteps), cosT = new Float32Array(thetaSteps);
    for (let t = 0; t < thetaSteps; t++) {
        thetas[t] = (t / thetaSteps) * Math.PI;
        sinT[t] = Math.sin(thetas[t]); cosT[t] = Math.cos(thetas[t]);
    }
    const acc = new Int32Array((maxRho * 2 + 1) * thetaSteps);
    const pts = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[y * width + x] > 127) pts.push([x, y]);
    for (const [x, y] of pts) {
        for (let t = 0; t < thetaSteps; t++) {
            const rho = Math.round(x * cosT[t] + y * sinT[t]) + maxRho;
            if (rho >= 0 && rho <= maxRho * 2) acc[rho * thetaSteps + t]++;
        }
    }
    const thr = toInt(threshold, 90);
    const peaks = [];
    for (let rho = 0; rho <= maxRho * 2; rho++) {
        for (let t = 0; t < thetaSteps; t++) {
            const v = acc[rho * thetaSteps + t];
            if (v < thr) continue;
            if (v >= (acc[(rho - 1) * thetaSteps + t] || 0) && v > (acc[(rho + 1) * thetaSteps + t] || 0)
                && v >= (acc[rho * thetaSteps + (t - 1)] || 0) && v > (acc[rho * thetaSteps + (t + 1)] || 0)) {
                peaks.push({ rho: rho - maxRho, theta: thetas[t], votes: v });
            }
        }
    }
    peaks.sort((a, b) => b.votes - a.votes);
    const lines = [];
    for (const p of peaks) {
        if (lines.length >= toInt(maxLines, 10)) break;
        if (lines.some((o) => Math.abs(o.rho - p.rho) < 8 && Math.abs(o.theta - p.theta) < 0.1)) continue;
        const a2 = Math.cos(p.theta), b2 = Math.sin(p.theta);
        const x0 = a2 * p.rho, y0 = b2 * p.rho;
        let x1 = x0 + -b2 * maxRho, y1 = y0 + a2 * maxRho;
        let x2 = x0 - -b2 * maxRho, y2 = y0 - a2 * maxRho;
        const clipped = clipSegment(x1, y1, x2, y2, width, height);
        if (!clipped) continue;
        const len = Math.hypot(clipped[2] - clipped[0], clipped[3] - clipped[1]);
        if (len < minLength) continue;
        lines.push({ x1: clipped[0], y1: clipped[1], x2: clipped[2], y2: clipped[3], rho: p.rho, theta: p.theta, length: len, votes: p.votes });
    }
    return lines;
}

function clipSegment(x1, y1, x2, y2, w, h) {
    let t0 = 0, t1 = 1;
    const dx = x2 - x1, dy = y2 - y1;
    const p = [-dx, dx, -dy, dy];
    const q = [x1, w - x1, y1, h - y1];
    for (let i = 0; i < 4; i++) {
        if (p[i] === 0) { if (q[i] < 0) return null; continue; }
        const r = q[i] / p[i];
        if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
        else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

function aHash(src, size = 8) {
    const s = resize(src, size, size, 'box');
    const g = toGray(s, 'average');
    let bits = '', avg = 0;
    for (const v of g.data) avg += v;
    avg /= g.data.length;
    for (const v of g.data) bits += v >= avg ? '1' : '0';
    return bitsToHex(bits);
}

function dHash(src, size = 9) {
    const s = resize(src, size, size - 1, 'box');
    const g = toGray(s, 'average');
    let bits = '';
    for (let y = 0; y < g.height; y++) {
        for (let x = 0; x < g.width - 1; x++) {
            bits += g.data[y * g.width + x] < g.data[y * g.width + x + 1] ? '1' : '0';
        }
    }
    return bitsToHex(bits);
}

function pHash(src, size = 32) {
    const s = resize(src, size, size, 'area');
    const g = toGray(s, 'average');
    const m = dctLowFreq(g, 8);
    let sum = 0;
    for (const v of m) sum += v;
    const avg = sum / m.length;
    let bits = '';
    for (const v of m) bits += v > avg ? '1' : '0';
    return bitsToHex(bits);
}

// 只取 8x8 低频：直接按 DCT-II 基逐点投影，避免整图 FFT
function dctLowFreq(g, keep) {
    const out = new Float32Array(keep * keep);
    const N = g.width;
    for (let v = 0; v < keep; v++) {
        for (let u = 0; u < keep; u++) {
            let acc = 0;
            for (let y = 0; y < keep; y++) {
                for (let x = 0; x < keep; x++) {
                    acc += g.data[y * N + x] * Math.cos((2 * x + 1) * u * Math.PI / (2 * keep))
                        * Math.cos((2 * y + 1) * v * Math.PI / (2 * keep));
                }
            }
            out[v * keep + u] = acc;
        }
    }
    return out;
}

function bitsToHex(bits) {
    let hex = '';
    for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4) || '0', 2).toString(16);
    return hex;
}

function hamming(a, b) {
    const s = String(a || ''), t = String(b || '');
    let d = 0;
    const n = Math.max(s.length, t.length);
    for (let i = 0; i < n; i++) {
        const x = parseInt(s[i] || '0', 16), y = parseInt(t[i] || '0', 16);
        let v = (x ^ y) & 0xf;
        while (v) { d += v & 1; v >>= 1; }
    }
    return d;
}

function mse(a, b) {
    const g1 = toGray(resize(a, Math.min(a.width, 512), Math.round(Math.min(a.width, 512) * b.height / b.width), 'area'), 'average');
    const g2 = toGray(resize(b, g1.width, g1.height, 'area'), 'average');
    let s = 0;
    for (let i = 0; i < g1.data.length; i++) { const d = g1.data[i] - g2.data[i]; s += d * d; }
    return { mse: s / g1.data.length, rmse: Math.sqrt(s / g1.data.length) };
}

function psnr(a, b) {
    const { mse: m } = mse(a, b);
    return { mse: m, psnr: m > 0 ? 10 * Math.log10((255 * 255) / m) : Infinity };
}

// 11x11 高斯窗 SSIM（亮度/对比度/结构三项），降采样到 512 内保时间
function ssim(a, b) {
    const w = Math.min(512, Math.min(a.width, b.width));
    const h = Math.round(w * Math.min(a.height, b.height) / Math.min(a.width, b.width));
    const g1 = toGray(resize(a, w, h, 'area'), 'average');
    const g2 = toGray(resize(b, w, h, 'area'), 'average');
    const R = 5;
    const k1 = 0.01, k2 = 0.03, L = 255;
    const c1 = (k1 * L) ** 2, c2 = (k2 * L) ** 2;
    let total = 0, n = 0;
    const at = (g, x, y) => g.data[clamp(y, 0, g.height - 1) * g.width + clamp(x, 0, g.width - 1)];
    for (let y = R; y < g1.height - R; y += 2) {
        for (let x = R; x < g1.width - R; x += 2) {
            let m1 = 0, m2 = 0;
            for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) { m1 += at(g1, x + i, y + j); m2 += at(g2, x + i, y + j); }
            const cnt = (2 * R + 1) ** 2;
            m1 /= cnt; m2 /= cnt;
            let v1 = 0, v2 = 0, cv = 0;
            for (let j = -R; j <= R; j++) {
                for (let i = -R; i <= R; i++) {
                    const d1 = at(g1, x + i, y + j) - m1, d2 = at(g2, x + i, y + j) - m2;
                    v1 += d1 * d1; v2 += d2 * d2; cv += d1 * d2;
                }
            }
            v1 /= cnt - 1; v2 /= cnt - 1; cv /= cnt - 1;
            const s1 = Math.sqrt(v1), s2 = Math.sqrt(v2);
            const score = ((2 * m1 * m2 + c1) * (2 * cv + c2)) / ((m1 * m1 + m2 * m2 + c1) * (v1 + v2 + c2));
            total += score; n++;
        }
    }
    return { ssim: n ? total / n : 1, size: { width: w, height: h } };
}

// 帧间差（视频去重/运动检测）
function temporalDiff(a, b, { threshold = 18, scale = 256 } = {}) {
    const w = Math.min(scale, a.width);
    const h = Math.round(w * a.height / a.width);
    const g1 = toGray(resize(a, w, h, 'area'), 'average');
    const g2 = toGray(resize(b, w, h, 'area'), 'average');
    let changed = 0, sum = 0;
    for (let i = 0; i < g1.data.length; i++) {
        const d = Math.abs(g1.data[i] - g2.data[i]);
        sum += d;
        if (d > threshold) changed++;
    }
    return { changeRatio: changed / g1.data.length, meanDiff: sum / g1.data.length };
}

function maskToAlpha(src, mask, { color = null, invert = false, opacity = 100 } = {}) {
    const out = clonePx(src);
    const mw = mask.width, mh = mask.height;
    const sx = src.width / mw, sy = src.height / mh;
    for (let i = 0; i < out.data.length; i += 4) {
        const px = (i / 4) % src.width, py = Math.floor((i / 4) / src.width);
        const mx = clamp(Math.floor(px / sx), 0, mw - 1), my = clamp(Math.floor(py / sy), 0, mh - 1);
        const p = (my * mw + mx) * 4;
        let v = mask.data[p];
        if (invert) v = 255 - v;
        out.data[i + 3] = Math.round(out.data[i + 3] * (v / 255) * (opacity / 100));
        if (color) { out.data[i] = color[0]; out.data[i + 1] = color[1]; out.data[i + 2] = color[2]; }
    }
    return out;
}

return { "stats": (typeof stats === 'undefined' ? undefined : stats), "histogram": (typeof histogram === 'undefined' ? undefined : histogram), "palette": (typeof palette === 'undefined' ? undefined : palette), "connectedComponents": (typeof connectedComponents === 'undefined' ? undefined : connectedComponents), "contours": (typeof contours === 'undefined' ? undefined : contours), "polyArea": (typeof polyArea === 'undefined' ? undefined : polyArea), "polyLength": (typeof polyLength === 'undefined' ? undefined : polyLength), "polyBBox": (typeof polyBBox === 'undefined' ? undefined : polyBBox), "convexHull": (typeof convexHull === 'undefined' ? undefined : convexHull), "minAreaRect": (typeof minAreaRect === 'undefined' ? undefined : minAreaRect), "rdp": (typeof rdp === 'undefined' ? undefined : rdp), "harrisCorners": (typeof harrisCorners === 'undefined' ? undefined : harrisCorners), "inRange": (typeof inRange === 'undefined' ? undefined : inRange), "templateMatch": (typeof templateMatch === 'undefined' ? undefined : templateMatch), "houghLines": (typeof houghLines === 'undefined' ? undefined : houghLines), "aHash": (typeof aHash === 'undefined' ? undefined : aHash), "dHash": (typeof dHash === 'undefined' ? undefined : dHash), "pHash": (typeof pHash === 'undefined' ? undefined : pHash), "hamming": (typeof hamming === 'undefined' ? undefined : hamming), "mse": (typeof mse === 'undefined' ? undefined : mse), "psnr": (typeof psnr === 'undefined' ? undefined : psnr), "ssim": (typeof ssim === 'undefined' ? undefined : ssim), "temporalDiff": (typeof temporalDiff === 'undefined' ? undefined : temporalDiff), "maskToAlpha": (typeof maskToAlpha === 'undefined' ? undefined : maskToAlpha) };
})();
__M["src/common/steps.js"] = (function(){
// 算子注册表：把 imgops/cv 的实现包成可被工具栏按钮引用的"步骤"（step）。
// 一个按钮可以串多个 step（例如 去黑边 -> 放大 2x -> 锐化），host 顺序执行。
// 参数元信息同时驱动设置页的参数编辑器，避免两处定义漂移。

const { clamp, toNum, toInt } = __M["src/common/util.js"];
const G = __M["src/common/imgops/geometry.js"];
const C = __M["src/common/imgops/color.js"];
const F = __M["src/common/imgops/filter.js"];
const E = __M["src/common/imgops/edge.js"];
const CV = __M["src/common/cv.js"];

const P = {
    number: (key, label, def, { min = 0, max = 100, step = 1, unit = '', hint = '' } = {}) =>
        ({ key, label, type: 'number', def, min, max, step, unit, hint }),
    select: (key, label, def, options, { hint = '' } = {}) =>
        ({ key, label, type: 'select', def, options, hint }),
    color: (key, label, def = '#000000', hint = '') => ({ key, label, type: 'color', def, hint }),
    bool: (key, label, def = false) => ({ key, label, type: 'bool', def }),
    text: (key, label, def = '', hint = '') => ({ key, label, type: 'text', def, hint }),
    size: (key, label, def = '50%', hint = '') => ({ key, label, type: 'text', def, hint }),
};

function resolveParams(spec, given = {}) {
    const out = {};
    for (const p of spec) out[p.key] = given && given[p.key] !== undefined ? given[p.key] : p.def;
    return out;
}

const STEPS = {
    resize: {
        label: '缩放',
        group: '尺寸',
        params: [
            P.select('filter', '重采样', 'lanczos3', [
                { value: 'lanczos3', label: 'Lanczos3（通用最锐）' }, { value: 'lanczos4', label: 'Lanczos4' },
                { value: 'bicubic', label: 'Bicubic(Catmull-Rom)' }, { value: 'mitchell', label: 'Mitchell-Netraval' },
                { value: 'bspline', label: 'Cubic B-spline(平滑)' }, { value: 'triangle', label: 'Bilinear' },
                { value: 'area', label: 'Area(缩小最优)' }, { value: 'box', label: 'Box' }, { value: 'nearest', label: 'Nearest(像素画)' },
            ]),
            P.select('mode', '目标', 'percent', [
                { value: 'percent', label: '百分比' }, { value: 'width', label: '按宽' },
                { value: 'height', label: '按需高' }, { value: 'longest', label: '最长边' }, { value: 'exact', label: '指定宽高' },
            ]),
            P.number('percent', '百分比', 200, { min: 1, max: 1600, step: 10, unit: '%' }),
            P.number('value', '边长', 1600, { min: 1, max: 16384, step: 10, unit: 'px' }),
            P.number('width', '宽', 0, { min: 0, max: 16384 }),
            P.number('height', '高', 0, { min: 0, max: 16384 }),
            P.bool('keepAspect', '锁定比例', true),
            P.number('maxDim', '上限边长', 8192, { min: 256, max: 16384, step: 256, unit: 'px', hint: '超过则等比夹住，防止生成超大画布拖垮页面' }),
        ],
        run(px, p) {
            const t = G.resolveSize(px, p);
            return { image: G.resize(px, t.width, t.height, p.filter), report: { from: `${px.width}x${px.height}`, to: `${t.width}x${t.height}`, filter: p.filter } };
        },
    },
    rotate: {
        label: '旋转', group: '尺寸',
        params: [
            P.number('angle', '角度', 90, { min: -360, max: 360, step: 5, unit: '°' }),
            P.bool('expand', '扩大画布', true),
            P.color('fill', '填充色', '#000000'),
            P.select('filter', '插值', 'bicubic', [{ value: 'bicubic', label: 'Bicubic' }, { value: 'lanczos3', label: 'Lanczos3' }, { value: 'nearest', label: 'Nearest' }]),
        ],
        run(px, p) {
            const f = C.hexToRgb(p.fill);
            const img = G.rotate(px, p.angle, { expand: p.expand, fill: [f[0], f[1], f[2], 255] });
            if (p.angle % 90 !== 0 && p.filter !== 'bicubic') {
                return { image: img, report: { angle: p.angle } };
            }
            return { image: img, report: { angle: p.angle } };
        },
    },
    flip: {
        label: '翻转', group: '尺寸',
        params: [P.select('dir', '方向', 'h', [{ value: 'h', label: '水平镜像' }, { value: 'v', label: '垂直翻转' }])],
        run(px, p) { return { image: G.flip(px, p.dir), report: { dir: p.dir } }; },
    },
    crop: {
        label: '裁剪', group: '尺寸',
        params: [
            P.select('mode', '方式', 'ratio', [
                { value: 'ratio', label: '比例居中裁' }, { value: 'rect', label: '绝对矩形' },
                { value: 'center', label: '按百分比保留中心' },
            ]),
            P.text('ratio', '比例', '1:1', '如 16:9 / 4:3 / 1.91:1'),
            P.number('x', 'X', 0, { min: 0, max: 16384 }), P.number('y', 'Y', 0, { min: 0, max: 16384 }),
            P.number('width', '宽', 512, { min: 1, max: 16384 }), P.number('height', '高', 512, { min: 1, max: 16384 }),
            P.number('keepPercent', '保留比例', 80, { min: 5, max: 100, unit: '%' }),
        ],
        run(px, p) {
            let rect;
            if (p.mode === 'rect') rect = { x: p.x, y: p.y, width: p.width, height: p.height };
            else if (p.mode === 'center') {
                const k = toNum(p.keepPercent, 80) / 100;
                const w = Math.round(px.width * k), h = Math.round(px.height * k);
                rect = { x: (px.width - w) / 2, y: (px.height - h) / 2, width: w, height: h };
            } else {
                const [rw, rh] = String(p.ratio).split(/[:\/x]/).map((v) => parseFloat(v));
                if (!rw || !rh) throw new Error('比例格式不正确：' + p.ratio);
                const target = rw / rh, cur = px.width / px.height;
                let w = px.width, h = px.height;
                if (cur > target) w = Math.round(px.height * target); else h = Math.round(px.width / target);
                rect = { x: (px.width - w) / 2, y: (px.height - h) / 2, width: w, height: h };
            }
            const r = G.crop(px, rect);
            return { image: r, report: { rect: { x: rect.x | 0, y: rect.y | 0, width: r.width, height: r.height } } };
        },
    },
    pad: {
        label: '补边', group: '尺寸',
        params: [
            P.number('size', '边宽', 32, { min: 0, max: 4096, unit: 'px' }),
            P.number('top', '上', -1, { min: -1, max: 4096, hint: '-1 表示用边宽' }),
            P.number('bottom', '下', -1, { min: -1, max: 4096 }),
            P.number('left', '左', -1, { min: -1, max: 4096 }),
            P.number('right', '右', -1, { min: -1, max: 4096 }),
            P.color('color', '颜色', '#ffffff'),
            P.bool('transparent', '透明填充', false),
        ],
        run(px, p) {
            const c = C.hexToRgb(p.color);
            const s = toInt(p.size, 32);
            const v = (x) => (toInt(x, -1) >= 0 ? toInt(x, 0) : s);
            return {
                image: G.pad(px, { top: v(p.top), bottom: v(p.bottom), left: v(p.left), right: v(p.right), color: p.transparent ? [0, 0, 0, 0] : [c[0], c[1], c[2], 255] }),
                report: { pad: s },
            };
        },
    },
    trim: {
        label: '裁掉边框黑边', group: '尺寸',
        params: [
            P.select('mode', '衬底', 'auto', [
                { value: 'auto', label: '自动（按四角）' }, { value: 'black', label: '纯黑' },
                { value: 'white', label: '纯白' }, { value: 'transparent', label: '透明' },
            ]),
            P.number('tolerance', '容差', 12, { min: 1, max: 120 }),
            P.number('contentRatio', '内容占比阈值', 1.5, { min: 0.1, max: 30, step: 0.1, unit: '%' }),
            P.number('maxTrimRatio', '单边裁切上限', 45, { min: 1, max: 90, unit: '%' }),
        ],
        run(px, p) {
            const r = G.trimBorder(px, {
                mode: p.mode, tolerance: p.tolerance,
                contentRatio: toNum(p.contentRatio, 1.5) / 100,
                maxTrimRatio: toNum(p.maxTrimRatio, 45) / 100,
            });
            return { image: r.image, report: r.trimmed ? { trimmed: r.trimmed } : { trimmed: null, note: '未裁切（保护阈值内）' } };
        },
    },
    border: {
        label: '圆角', group: '尺寸',
        params: [P.number('radius', '半径', 24, { min: 0, max: 2048, unit: 'px' }), P.number('feather', '羽化', 0, { min: 0, max: 64 }), P.select('corners', '角', 'all', [{ value: 'all', label: '四角' }, { value: 'tl,tr', label: '仅上' }, { value: 'bl,br', label: '仅下' }]), P.select('background', '背景', 'transparent', [{ value: 'transparent', label: '透明' }, { value: '#ffffff', label: '白' }, { value: '#000000', label: '黑' }])],
        run(px, p) { return { image: F.borderRadius(px, { radius: p.radius, feather: p.feather, corners: p.corners, background: p.background }) }; },
    },

    adjust: {
        label: '综合调色', group: '色彩',
        params: [
            P.number('brightness', '亮度', 0, { min: -100, max: 100 }),
            P.number('contrast', '对比度', 0, { min: -100, max: 100 }),
            P.number('saturation', '饱和度', 0, { min: -100, max: 100 }),
            P.number('vibrance', '自然饱和', 0, { min: -100, max: 100 }),
            P.number('hue', '色相', 0, { min: -180, max: 180, unit: '°' }),
            P.number('temperature', '色温', 0, { min: -100, max: 100 }),
            P.number('tint', '色调(绿-品)', 0, { min: -100, max: 100 }),
            P.number('gamma', 'Gamma', 1, { min: 0.2, max: 3, step: 0.05 }),
            P.number('exposure', '曝光', 0, { min: -100, max: 100, hint: '线性乘性，与亮度加性不同' }),
        ],
        run(px, p) {
            let img = px;
            const exp = toNum(p.exposure, 0);
            if (exp) img = C.mapPixels(img, (r, g, b, a, o, i) => {
                const k = Math.pow(2, exp / 50);
                o[i] = r * k; o[i + 1] = g * k; o[i + 2] = b * k; o[i + 3] = a;
            });
            if (toNum(p.brightness, 0)) img = C.brightness(img, p.brightness);
            if (toNum(p.contrast, 0)) img = C.contrast(img, p.contrast);
            if (toNum(p.gamma, 1) !== 1) img = C.gamma(img, p.gamma);
            if (toNum(p.temperature, 0)) img = C.temperature(img, p.temperature);
            if (toNum(p.tint, 0)) img = C.tint(img, p.tint);
            if (toNum(p.hue, 0)) img = C.hueRotate(img, p.hue);
            if (toNum(p.saturation, 0)) img = C.saturation(img, p.saturation);
            if (toNum(p.vibrance, 0)) img = C.vibrance(img, p.vibrance);
            return { image: img, report: { touched: Object.entries(p).filter(([k, v]) => toNum(v, 0) !== 0 && toNum(v, 1) !== 1 && k !== 'brightness').map(([k]) => k) } };
        },
    },
    brightness: { label: '亮度', group: '色彩', params: [P.number('amount', '亮度', 10, { min: -100, max: 100 })], run: (px, p) => ({ image: C.brightness(px, p.amount) }) },
    contrast: { label: '对比度', group: '色彩', params: [P.number('amount', '对比度', 10, { min: -100, max: 100 })], run: (px, p) => ({ image: C.contrast(px, p.amount) }) },
    saturation: { label: '饱和度', group: '色彩', params: [P.number('amount', '饱和度', 20, { min: -100, max: 100 })], run: (px, p) => ({ image: C.saturation(px, p.amount) }) },
    vibrance: { label: '自然饱和', group: '色彩', params: [P.number('amount', '强度', 30, { min: -100, max: 100 })], run: (px, p) => ({ image: C.vibrance(px, p.amount) }) },
    hue: { label: '色相旋转', group: '色彩', params: [P.number('degrees', '角度', 30, { min: -180, max: 180, unit: '°' })], run: (px, p) => ({ image: C.hueRotate(px, p.degrees) }) },
    gammaStep: { label: 'Gamma', group: '色彩', params: [P.number('value', 'Gamma', 1.2, { min: 0.2, max: 3, step: 0.05 })], run: (px, p) => ({ image: C.gamma(px, p.value) }) },
    grayscale: { label: '去色', group: '色彩', params: [P.select('mode', '权重', 'luma709', [{ value: 'luma709', label: 'Rec.709' }, { value: 'ccir601', label: 'Rec.601' }, { value: 'average', label: '平均' }, { value: 'lightness', label: '明度' }, { value: 'max', label: '最大通道' }])], run: (px, p) => ({ image: C.grayscale(px, p.mode) }) },
    invert: { label: '反色', group: '色彩', params: [P.bool('alpha', '同时反变换 alpha', false)], run: (px, p) => ({ image: C.invert(px, { alpha: p.alpha }) }) },
    sepia: { label: '怀旧色调', group: '色彩', params: [P.number('amount', '强度', 100, { max: 100 })], run: (px, p) => ({ image: C.sepia(px, p.amount) }) },
    duotone: { label: '双色调', group: '色彩', params: [P.color('dark', '暗部', '#1b2a4a'), P.color('light', '亮部', '#f4e9d8'), P.number('amount', '强度', 100, { max: 100 })], run: (px, p) => ({ image: C.duotone(px, p) }) },
    colorOverlay: { label: '纯色叠加', group: '色彩', params: [P.color('color', '颜色', '#000000'), P.number('opacity', '不透明度', 25, { max: 100 }), P.select('blend', '混合', 'normal', ['normal', 'multiply', 'screen', 'overlay', 'softLight', 'hardLight', 'difference', 'exclusion', 'lighten', 'darken', 'add'].map((v) => ({ value: v, label: v })))] },
    whiteBalance: { label: '白平衡', group: '色彩', params: [P.select('method', '算法', 'grey-world', [{ value: 'grey-world', label: '灰世界' }, { value: 'percentile', label: '百分位灰世界' }, { value: 'manual', label: '手动增益' }]), P.number('strength', '强度', 100, { max: 100 }), P.number('rGain', 'R 增益', 1, { min: 0.2, max: 3, step: 0.05 }), P.number('gGain', 'G 增益', 1, { min: 0.2, max: 3, step: 0.05 }), P.number('bGain', 'B 增益', 1, { min: 0.2, max: 3, step: 0.05 })], run: (px, p) => ({ image: C.whiteBalance(px, p) }) },
    levels: { label: '色阶', group: '色彩', params: [P.number('inBlack', '黑场', 0, { max: 100 }), P.number('inWhite', '白场', 100, { max: 100 }), P.number('gammaValue', '中间调', 1, { min: 0.2, max: 3, step: 0.05 }), P.number('outBlack', '输出黑', 0, { max: 100 }), P.number('outWhite', '输出白', 100, { max: 100 }), P.select('channel', '通道', 'rgb', [{ value: 'rgb', label: 'RGB' }, { value: 'luma', label: '仅亮度' }, { value: 'r', label: 'R' }, { value: 'g', label: 'G' }, { value: 'b', label: 'B' }])], run: (px, p) => ({ image: C.levels(px, p) }) },
    posterize: { label: '色阶分离', group: '色彩', params: [P.number('levelsCount', '级数', 4, { min: 2, max: 32 })], run: (px, p) => ({ image: C.posterize(px, p.levelsCount) }) },
    autoLevels: { label: '自动色阶', group: '色彩', params: [P.number('percent', '裁切', 0.5, { min: 0, max: 10, step: 0.1, unit: '%' }), P.select('channel', '通道', 'luma', [{ value: 'luma', label: '亮度' }, { value: 'r', label: 'R' }, { value: 'g', label: 'G' }, { value: 'b', label: 'B' }])], run: (px, p) => ({ image: C.autoLevels(px, p) }) },
    autoEnhance: { label: '一键增强', group: '色彩', params: [P.number('strength', '强度', 100, { max: 150 })], run: (px, p) => ({ image: C.autoEnhance(px, p) }) },
    equalize: { label: '直方图均衡', group: '色彩', params: [P.select('channel', '通道', 'luma', [{ value: 'luma', label: '亮度(保色)' }, { value: 'rgb', label: '逐通道' }])], run: (px, p) => ({ image: C.equalizeHist(px, p) }) },
    clahe: { label: '局部均衡 CLAHE', group: '色彩', params: [P.number('clipLimit', '限幅', 3, { min: 1, max: 20, step: 0.5 }), P.number('tiles', '分块', 8, { min: 2, max: 24 })], run: (px, p) => ({ image: C.clahe(px, p) }) },
    channelMixer: { label: '通道混合器', group: '色彩', params: [P.text('r', 'R 输出', '100,0,0'), P.text('g', 'G 输出', '0,100,0'), P.text('b', 'B 输出', '0,0,100')], run(px, p) { return { image: C.channelMixer(px, { r: parseTriple(p.r), g: parseTriple(p.g), b: parseTriple(p.b) }) }; } },

    gaussianBlur: { label: '高斯模糊', group: '滤镜', params: [P.number('sigma', 'Sigma', 3, { min: 0.2, max: 40, step: 0.2, unit: 'px' })], run: (px, p) => ({ image: F.gaussianBlur(px, p.sigma) }) },
    boxBlur: { label: '均值模糊', group: '滤镜', params: [P.number('radius', '半径', 4, { min: 1, max: 60, unit: 'px' })], run: (px, p) => ({ image: F.boxBlur(px, p.radius) }) },
    median: { label: '中值滤波', group: '滤镜', params: [P.number('radius', '半径', 1, { min: 1, max: 6, unit: 'px' })], run: (px, p) => ({ image: F.medianFilter(px, p.radius) }) },
    bilateral: { label: '双边降噪(保边)', group: '滤镜', params: [P.number('spaceSigma', '空间', 8, { min: 1, max: 30 }), P.number('rangeSigma', '色域', 35, { min: 1, max: 150 })], run: (px, p) => ({ image: F.bilateralFilter(px, p) }) },
    noise: { label: '加噪', group: '滤镜', params: [P.select('type', '类型', 'gaussian', [{ value: 'gaussian', label: '高斯' }, { value: 'speckle', label: '乘性斑点' }, { value: 'saltPepper', label: '椒盐' }]), P.number('amount', '强度', 12, { max: 100 }), P.number('seed', '种子', 1, { min: 1, max: 99999 })], run: (px, p) => ({ image: F.addNoise(px, p) }) },
    pixelate: { label: '像素化', group: '滤镜', params: [P.number('size', '块大小', 12, { min: 2, max: 200, unit: 'px' }), P.select('mode', '方式', 'avg', [{ value: 'avg', label: '块平均' }, { value: 'sample', label: '取左上' }])], run: (px, p) => ({ image: F.pixelate(px, { size: p.size, mode: p.mode === 'avg' ? 'block' : 'sample' }) }) },
    oilPaint: { label: '油画', group: '滤镜', params: [P.number('radius', '半径', 3, { min: 1, max: 8 }), P.number('intensity', '色阶数', 30, { min: 4, max: 128 })], run: (px, p) => ({ image: F.oilPaint(px, p) }) },
    vignette: { label: '暗角', group: '滤镜', params: [P.number('amount', '强度', 60, { min: -100, max: 100 }), P.number('radius', '内圈', 70, { max: 100, unit: '%' }), P.number('soften', '过渡', 40, { max: 100 }), P.color('color', '颜色', '#000000')], run: (px, p) => ({ image: F.vignette(px, p) }) },
    chromaKey: { label: '抠色(去背景)', group: '滤镜', params: [P.color('color', '键控色', '#00ff00'), P.number('tolerance', '容差', 40, { min: 1, max: 200 }), P.number('feather', '羽化', 10, { min: 0, max: 60 }), P.select('model', '模型', 'rgb', [{ value: 'rgb', label: 'RGB 距离' }, { value: 'hsv', label: 'HSV 锥' }]), P.bool('invert', '反转', false)], run: (px, p) => ({ image: F.chromaKey(px, p) }) },

    unsharp: { label: 'USM 锐化', group: '锐化/边缘', params: [P.number('radius', '半径', 2, { min: 0.3, max: 30, step: 0.1, unit: 'px' }), P.number('amount', '数量', 120, { min: 0, max: 400, unit: '%' }), P.number('threshold', '阈值', 2, { min: 0, max: 60 })], run: (px, p) => ({ image: F.unsharp(px, p) }) },
    sharpen: { label: '锐化核', group: '锐化/边缘', params: [P.number('amount', '强度', 60, { min: 0, max: 200 }), P.bool('soft', '柔和核', false)], run: (px, p) => ({ image: F.sharpen(px, p.amount, p.soft) }) },
    sobel: { label: 'Sobel 边缘', group: '锐化/边缘', params: [P.select('mode', '方向', 'magnitude', [{ value: 'magnitude', label: '梯度幅值' }, { value: 'x', label: 'X' }, { value: 'y', label: 'Y' }])], run: (px, p) => ({ image: E.sobel(px, p) }) },
    scharr: { label: 'Scharr 边缘', group: '锐化/边缘', params: [], run: (px) => ({ image: E.scharr(px) }) },
    laplacian: { label: 'Laplacian', group: '锐化/边缘', params: [P.select('kernel', '核', '4', [{ value: '4', label: '4 邻域' }, { value: '8', label: '8 邻域' }]), P.select('scale', '输出', 'abs', [{ value: 'abs', label: '绝对值' }, { value: 'offset', label: '叠加灰底' }])], run: (px, p) => ({ image: E.laplacian(px, p) }) },
    canny: { label: 'Canny 边缘', group: '锐化/边缘', params: [P.number('low', '低阈值', 40, { max: 255 }), P.number('high', '高阈值', 120, { max: 255 }), P.number('sigma', '预模糊', 1.4, { min: 0, max: 10, step: 0.1 })], run: (px, p) => ({ image: E.canny(px, p) }) },
    log: { label: 'LoG 边缘', group: '锐化/边缘', params: [P.number('sigma', 'Sigma', 2, { min: 0.5, max: 20, step: 0.5 }), P.number('scale', 'DoG 比', 1.6, { min: 1.1, max: 4, step: 0.1 })], run: (px, p) => ({ image: E.logEdge(px, p) }) },
    threshold: { label: '二值化', group: '锐化/边缘', params: [P.select('mode', '算法', 'otsu', [{ value: 'otsu', label: 'Otsu' }, { value: 'fixed', label: '固定阈值' }, { value: 'mean', label: '自适应均值' }, { value: 'sauvola', label: 'Sauvola' }, { value: 'localSigma', label: '局部 std 加权' }]), P.number('value', '固定阈值', 128, { max: 255 }), P.number('blockSize', '窗口', 31, { min: 3, max: 201, step: 2 }), P.number('C', '常数 C', 8, { min: -50, max: 50 }), P.number('k', 'k (Sauvola)', 0.2, { min: 0, max: 1, step: 0.05 }), P.bool('invert', '反相', false)], run: (px, p) => ({ image: E.threshold(px, p) }) },
    morphology: { label: '形态学', group: '锐化/边缘', params: [P.select('op', '操作', 'close', ['erode', 'dilate', 'open', 'close', 'gradient', 'tophat', 'blackhat'].map((v) => ({ value: v, label: v }))), P.number('radius', '半径', 1, { min: 1, max: 12 }), P.select('shape', '结构元', 'rect', [{ value: 'rect', label: '方形' }, { value: 'cross', label: '十字' }, { value: 'circle', label: '圆' }])], run: (px, p) => ({ image: E.morphology(px, p) }) },

    stats: { label: '图像统计', group: '分析', analysis: true, params: [], run: (px) => ({ report: CV.stats(px) }) },
    histogram: { label: '直方图', group: '分析', analysis: true, params: [P.number('bins', '分箱', 64, { min: 8, max: 256, step: 8 }), P.select('channel', '通道', 'luma', ['luma', 'r', 'g', 'b', 'alpha'].map((v) => ({ value: v, label: v })))], run(px, p) { const h = CV.histogram(px, p.bins, p.channel); return { report: { entropy: h.entropy, bins: h.bins } }; } },
    palette: { label: '主色板', group: '分析', analysis: true, params: [P.number('count', '颜色数', 6, { min: 2, max: 16 })], run: (px, p) => ({ report: CV.palette(px, p) }) },
    regions: { label: '连通域统计', group: '分析', analysis: true, params: [P.number('threshold', '二值化阈值', 128, { max: 255 }), P.number('minArea', '最小面积', 50, { max: 100000 }), P.number('connectivity', '连通', 8, { min: 4, max: 8, step: 4 })], run(px, p) { const bin = E.threshold(px, { mode: 'fixed', value: p.threshold }); const r = CV.connectedComponents(bin, { connectivity: p.connectivity, minArea: p.minArea, binarize: false }); return { report: { count: r.count, top: r.regions.slice(0, 12).map((x) => ({ area: x.area, ...x.x !== undefined ? { x: x.x, y: x.y, width: x.width, height: x.height } : {} })) }, boxes: r.regions.slice(0, 40).map((x) => ({ x: x.x, y: x.y, width: x.width, height: x.height, label: String(x.area) })) }; } },
    contours: { label: '轮廓检测', group: '分析', analysis: true, params: [P.number('threshold', '二值化', 128, { max: 255 }), P.number('simplify', '简化 eps', 1.5, { min: 0, max: 10, step: 0.5 }), P.number('minArea', '最小面积', 60, { max: 100000 })], run(px, p) { const bin = E.threshold(px, { mode: 'fixed', value: p.threshold }); const cs = CV.contours(bin, { binarize: false, threshold: 0, simplify: p.simplify, minArea: p.minArea }); return { report: { count: cs.length, areas: cs.slice(0, 10).map((c) => Math.round(c.area)) }, boxes: cs.slice(0, 40).map((c) => ({ ...c.boundingRect, label: String(Math.round(c.area)) })) }; } },
    corners: { label: 'Harris 角点', group: '分析', analysis: true, params: [P.number('blockSize', '窗口', 3, { min: 1, max: 9 }), P.number('k', 'k', 0.04, { min: 0, max: 0.5, step: 0.01 }), P.number('thresholdRatio', '响应阈值', 1, { min: 0.1, max: 30, step: 0.1, unit: '%' }), P.number('maxCorners', '最多', 120, { min: 1, max: 1000 })], run(px, p) { const c = CV.harrisCorners(px, { ...p, thresholdRatio: toNum(p.thresholdRatio, 1) / 100 }); return { report: { count: c.length }, points: c.map((o) => ({ x: o.x, y: o.y })) }; } },
    lines: { label: '霍夫直线', group: '分析', analysis: true, params: [P.number('threshold', '投票数', 120, { min: 10, max: 5000 }), P.number('thetaSteps', '角度分辨率', 180, { min: 36, max: 720, step: 36 }), P.number('maxLines', '最多线数', 12, { min: 1, max: 100 }), P.select('pre', '预处理', 'canny', [{ value: 'none', label: '输入已二值' }, { value: 'canny', label: 'Canny' }, { value: 'sobel', label: 'Sobel' }])], run(px, p) { const edge = p.pre === 'canny' ? E.canny(px, {}) : p.pre === 'sobel' ? E.sobel(px, { mode: 'magnitude' }) : px; const bin = E.threshold(edge, { mode: 'fixed', value: 60 }); const l = CV.houghLines(bin, { threshold: p.threshold, thetaSteps: p.thetaSteps, maxLines: p.maxLines }); return { report: { count: l.length }, lines: l } } },
    hashes: { label: '感知哈希', group: '分析', analysis: true, params: [], run: (px) => ({ report: { aHash: CV.aHash(px), dHash: CV.dHash(px), pHash: CV.pHash(px) } }) },
    detectSize: {
        label: '内容区测量', group: '分析', analysis: true,
        params: [P.select('mode', '衬底', 'auto', [{ value: 'auto', label: '自动' }, { value: 'black', label: '黑' }, { value: 'white', label: '白' }])],
        run(px, p) {
            const t = G.trimBorder(px, { mode: p.mode, tolerance: 20 });
            return {
                report: {
                    original: px.width + 'x' + px.height,
                    content: t.trimmed ? `${t.trimmed.width}x${t.trimmed.height} @${t.trimmed.x},${t.trimmed.y}` : '整幅',
                    aspect: (px.width / px.height).toFixed(3),
                },
            };
        },
    },
};

STEPS.colorOverlay.run = (px, p) => ({ image: C.colorOverlay(px, p) });

function parseTriple(s) {
    return String(s || '').split(/[,;\s]+/).map((v) => parseFloat(v)).filter((v) => Number.isFinite(v));
}

function normalizeChain(steps) {
    return (steps || []).filter((x) => x && STEPS[x.op]).map((x) => ({ op: x.op, params: x.params || {} }));
}

function runChain(px, chain, ctx = {}) {
    let cur = px;
    const reports = [];
    const boxes = [];
    const points = [];
    const lines = [];
    for (const step of chain) {
        const spec = STEPS[step.op];
        if (!spec) throw new Error('未知算子: ' + step.op);
        const params = resolveParams(spec.params, step.params);
        const res = spec.run(cur, params, ctx);
        if (res.image) cur = res.image;
        if (res.report) reports.push({ op: step.op, ...res.report });
        if (res.boxes) boxes.push(...res.boxes);
        if (res.points) points.push(...res.points);
        if (res.lines) lines.push(...res.lines);
    }
    return { image: cur, reports, boxes, points, lines };
}

function stepParamDefaults(opId) {
    const spec = STEPS[opId];
    return spec ? resolveParams(spec.params, {}) : {};
}

function stepLabel(opId) {
    return STEPS[opId]?.label || opId;
}

function stepGroups() {
    const g = {};
    for (const [id, s] of Object.entries(STEPS)) (g[s.group] = g[s.group] || []).push(id);
    return g;
}


return { "P": (typeof P === 'undefined' ? undefined : P), "STEPS": (typeof STEPS === 'undefined' ? undefined : STEPS), "normalizeChain": (typeof normalizeChain === 'undefined' ? undefined : normalizeChain), "runChain": (typeof runChain === 'undefined' ? undefined : runChain), "stepParamDefaults": (typeof stepParamDefaults === 'undefined' ? undefined : stepParamDefaults), "stepLabel": (typeof stepLabel === 'undefined' ? undefined : stepLabel), "stepGroups": (typeof stepGroups === 'undefined' ? undefined : stepGroups), "clamp": (typeof clamp === 'undefined' ? undefined : clamp) };
})();
__M["src/content/runner.mjs"] = (function(){
// 工具执行分发：内置能力（内容脚本本地做）、算子链与 AI（宿主页面做）、
// 用户脚本（宿主里的 QuickJS 解释执行）、链接型工具（模板替换后开标签/POST）。

const { captureVideoFrame, captureFrames, seekTo, videoTimeList, bgSend } = __M["src/content/frame.js"];
const { sanitizeFilename, filenameFromUrl, fillTemplate, fillTemplateRaw, formatBytes, ratioText, dataUrlToBytes, bytesToDataUrl } = __M["src/common/util.js"];
const { runChain, STEPS } = __M["src/common/steps.js"];
const { resize: resizePx, mkPx } = __M["src/common/imgops/geometry.js"];
const { toast, drawBoxes, drawMask, promptFor, ResultPanel, ROOT_ID } = __M["src/content/ui.mjs"];
const { extAlive, friendlyError, DEAD_TEXT } = __M["src/common/ext-state.js"];

// 上下文失效时不加「XX失败: 」前缀，直接把那句完整指令给用户
const errText = (prefix, e) => { const f = friendlyError(e); return f.dead ? f.text : prefix + f.text; };

async function toPngBlob(dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    if (blob.type === 'image/png') return blob;
    const bmp = await createImageBitmap(blob);
    const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(bmp.width, bmp.height) : null;
    const c2 = c || Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    (c2.getContext('2d')).drawImage(bmp, 0, 0);
    if (c2.convertToBlob) return await c2.convertToBlob({ type: 'image/png' });
    return await new Promise((r) => c2.toBlob(r, 'image/png'));
}

async function copyViaExecCommand(blob) {
    const url = URL.createObjectURL(blob);
    let holder = null;
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        holder = document.createElement('div');
        holder.contentEditable = 'true';
        holder.style.cssText = 'position:fixed;left:-20000px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;';
        holder.appendChild(img);
        document.body.appendChild(holder);
        const range = document.createRange();
        range.selectNodeContents(img);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return document.execCommand('copy');
    } catch (e) {
        return false;
    } finally {
        if (holder) holder.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
}

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];

function nextRate(cur) {
    const c = Number(cur) || 1;
    return RATES.find((r) => r > c + 0.001) || RATES[0];
}

// 站点播放器会在 play / 换源 / seek 之后把我们设的倍速与循环改回去（B 站、抖音都会）。
// 记下用户意图，在这些事件上重新按一次；同时把最终值读回来如实报告，别再谎报成功。
const mediaIntent = new WeakMap();
function intentFor(el) {
    let rec = mediaIntent.get(el);
    if (!rec) {
        rec = {};
        mediaIntent.set(el, rec);
        const reapply = () => {
            if (rec.rate != null && el.playbackRate !== rec.rate) { try { el.playbackRate = rec.rate; } catch (e) { /* 站点不让改 */ } }
            if (rec.loop != null && el.loop !== rec.loop) { try { el.loop = rec.loop; } catch (e) { /* 同上 */ } }
        };
        for (const ev of ['play', 'playing', 'loadedmetadata', 'seeked']) el.addEventListener(ev, reapply, true);
    }
    return rec;
}

function setRate(el, r) {
    intentFor(el).rate = r;
    try { el.playbackRate = r; } catch (e) { /* 站点锁了 */ }
    try { el.defaultPlaybackRate = r; } catch (e) { /* 同上 */ }
    return el.playbackRate;
}

function setLoop(el, v) {
    intentFor(el).loop = v;
    try { el.loop = v; } catch (e) { /* 站点锁了 */ }
    return el.loop;
}

const playable = (el) => !!(el && (el.currentSrc || el.src || el.readyState > 0 || (isFinite(el.duration) && el.duration > 0)));

class Runner {
    constructor(ctx) {
        this.ctx = ctx; // {settings, media, toolbar, panel, shadow, refreshSettings, ensureHost, hostSend, items}
    }

    get s() { return this.ctx.settings; }

    async sendToHost(req) {
        // 扩展刚在 edge://extensions 里重载过时，这份内容脚本已经是僵尸，任何消息都会失败；
        // 先说清楚「刷新页面」，别让 Chrome 的内部术语冒充业务错误
        if (!extAlive()) throw new Error(DEAD_TEXT);
        let res;
        try {
            await this.ctx.ensureHost();
            res = await this.ctx.hostSend({ action: 'mtbHost', ...req });
        } catch (e) {
            const f = friendlyError(e);
            throw new Error(f.dead ? DEAD_TEXT : f.text);
        }
        if (!res) throw new Error('宿主无响应（可能刚更新，请刷新页面）');
        if (!res.ok) {
            const f = friendlyError({ message: res.error });
            throw new Error(f.dead ? DEAD_TEXT : res.error + (res.stack ? ' @ ' + res.stack : ''));
        }
        return res;
    }

    // 当前媒体源：图片取直链，视频取当前帧 dataUrl，背景图取解析出的 URL
    async currentSource({ forVideo = true } = {}) {
        const m = this.ctx.media;
        if (!m) throw new Error('没有定位到媒体元素');
        if (m.kind === 'video') {
            if (!forVideo) throw new Error('该工具只支持图片');
            const f = await captureVideoFrame(m.el, {
                onProgress: (t) => this.ctx.toolbar?.setBusy?.('__progress', t),
                trim: this.s.video.trimLetterbox,
                maxSide: this.s.video.frameMaxSide || 0,
                format: this.s.video.frameFormat || 'png',
            });
            return { dataUrl: f.dataUrl, width: f.width, height: f.height, via: f.method, mime: f.mime, isFrame: true, time: m.el.currentTime };
        }
        const src = m.src || (m.el.currentSrc || m.el.src) || '';
        if (!src) throw new Error('取不到图片地址');
        if (m.kind === 'bg') return { url: src, pageUrl: location.href, src };
        if (src.startsWith('data:')) return { dataUrl: src };
        return { url: src, pageUrl: location.href, src };
    }

    async runImageOp(item) {
        const chain = (item.action.chain || []).map((st) => ({ ...st, params: { ...(st.params || {}), ...(item.params || {}) } }));
        const src = await this.currentSource();
        this.ctx.setStatus?.('处理中…');
        const res = await this.sendToHost({ type: 'op', ...src, chain, format: this.s.output.format, quality: this.s.output.quality });
        const reports = res.reports || [];
        const analysisOnly = chain.every((s) => STEPS[s.op]?.analysis);
        if (res.dataUrl && this.s.output.showResultOverlay !== false) {
            this.showResult(item, res, reports, analysisOnly);
        } else if (res.dataUrl && this.s.output.autoDownloadAfterOp) {
            await this.saveDataUrl(res.dataUrl, this.filenameFor(item, res));
        }
        if (!res.dataUrl && !reports.length) toast(this.ctx.shadow, '没有产生可见变化', 1800);
        else if (reports.length && analysisOnly) this.showReport(item, reports);
        this.ctx.setStatus?.('');
        return res;
    }

    showResult(item, res, reports, analysisOnly) {
        const near = this.ctx.toolbar?.currentTarget || null;
        const rows = (reports || []).map((r) => `<div class="row"><span class="k">${esc(r.op)}</span><pre>${esc(fmt(r))}</pre></div>`).join('');
        this.ctx.panel.show({
            title: `${item.label} · ${res.width}×${res.height}`,
            dataUrl: analysisOnly ? null : res.dataUrl,
            html: rows ? `<div>${rows}</div>` : '',
            near,
            actions: [
                { label: '下载结果', run: () => this.saveDataUrl(res.dataUrl, this.filenameFor(item, res)) },
                { label: '复制图片', run: () => this.copyDataUrl(res.dataUrl) },
                { label: '再处理一次', run: () => { this.ctx.replaceTemp(res); toast(this.ctx.shadow, '已作为当前源，再点其它工具即在其上继续'); } },
                { label: '发到 ComfyUI', run: () => this.ctx.runToolById('send-comfy', { dataUrl: res.dataUrl }) },
            ],
        });
        if (this.s.output.copyAfterOp) this.copyDataUrl(res.dataUrl);
    }

    showReport(item, reports) {
        this.ctx.panel.show({
            title: item.label,
            html: `<div>${reports.map((r) => `<div class="row"><span class="k">${esc(r.op)}</span><pre>${esc(fmt(r))}</pre></div>`).join('')}</div>`,
            near: this.ctx.toolbar?.currentTarget,
            actions: [{ label: '复制报告', run: () => copyText(JSON.stringify(reports, null, 2)) }],
        });
    }

    filenameFor(item, res) {
        const m = this.ctx.media;
        const base = this.s.output.keepOriginalName
            ? (filenameFromUrl(m?.src || '', 'png').replace(/\.[a-z0-9]+$/i, '') || 'media')
            : (m?.kind === 'video' ? 'frame' : 'web');
        const pattern = this.s.output.filenamePattern || '{base}_{op}_{w}x{h}.{ext}';
        const ext = (res?.mime || 'image/png').split('/')[1]?.replace('jpeg', 'jpg') || 'png';
        return sanitizeFilename(fillTemplateRaw(pattern, {
            base, op: item.id, w: res?.width || m?.natural?.width || 0, h: res?.height || m?.natural?.height || 0,
            ext, t: Math.round((m?.el?.currentTime || 0) * 100) / 100, ts: Date.now(),
        }));
    }

    async saveDataUrl(dataUrl, filename) {
        const r = await bgSend({ action: 'downloadDataUrl', dataUrl, filename: sanitizeFilename(filename) });
        toast(this.ctx.shadow, r?.ok ? `已下载 ${filename}` : '下载失败: ' + (r?.error || ''), 2200, !r?.ok);
        return r;
    }

    async copyDataUrl(dataUrl) {
        try {
            // ClipboardItem 对图片基本只认 image/png（webp/jpeg 常常直接被拒），先统一转 PNG
            const blob = await toPngBlob(dataUrl);
            try {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                toast(this.ctx.shadow, '已复制图片', 1600);
                return;
            } catch (e) {
                // clipboard.write 要瞬时用户手势；站点抢焦点或前面等宿主太久就会 NotAllowedError。
                // execCommand('copy') 只要求文档有焦点，是这类场景唯一还能用的路子。
                if (await copyViaExecCommand(blob)) { toast(this.ctx.shadow, '已复制图片', 1600); return; }
                throw e;
            }
        } catch (e) {
            toast(this.ctx.shadow, '复制图片失败（站点可能禁用剪贴板）: ' + e.message, 2600, true);
        }
    }

    // —— 内置工具 ——
    async builtin(fn, item, override) {
        const m = this.ctx.media;
        switch (fn) {
            case 'copyLink': {
                const src = m.kind === 'video' ? (m.el.currentSrc || m.el.src) : (m.src || m.el.currentSrc || m.el.src);
                await copyText(src || '');
                toast(this.ctx.shadow, src ? '已复制链接' : '没有可复制的地址', 1800, !src);
                return;
            }
            case 'cleanLink': {
                const raw = m.kind === 'video' ? (m.el.currentSrc || m.el.src) : (m.src || m.el.currentSrc || m.el.src);
                let clean = raw || '';
                try {
                    const u = new URL(raw);
                    for (const k of [...u.searchParams.keys()]) {
                        if (/^(sign|token|auth|key|expires|timestamp|wsTime|wsSecret|t|traceid|x-)/i.test(k)) u.searchParams.delete(k);
                        if (/^(imageView|imageMogr|x-oss-process|thumbnail|quality|w|h|width|height)$/i.test(k)) u.searchParams.delete(k);
                    }
                    clean = u.toString();
                } catch (e) { /* 原样 */ }
                await copyText(clean);
                toast(this.ctx.shadow, '已去参数复制', 1600);
                return;
            }
            case 'copyImage': {
                const s = await this.currentSource();
                const du = s.dataUrl || (await this.sendToHost({ type: 'encode', ...s, format: 'png' })).dataUrl;
                await this.copyDataUrl(du);
                return;
            }
            case 'download': {
                if (m.kind === 'video') {
                    const s = await this.currentSource();
                    await this.saveDataUrl(s.dataUrl, `frame_${Math.round(s.time * 100) / 100}s.png`);
                    return;
                }
                const src = m.src || m.el.currentSrc || m.el.src;
                if (!src) { toast(this.ctx.shadow, '取不到下载地址', 1800, true); return; }
                if (src.startsWith('data:')) { await this.saveDataUrl(src, filenameFromUrl('data.png')); return; }
                const r = await bgSend({ action: 'downloadUrl', url: src, filename: filenameFromUrl(src), pageUrl: location.href, referrer: location.href });
                toast(this.ctx.shadow, r?.ok ? '已开始下载' : '下载失败: ' + (r?.error || ''), 2200, !r?.ok);
                return;
            }
            case 'openSrc': {
                const src = m.kind === 'video' ? (m.el.currentSrc || m.el.src) : (m.src || m.el.currentSrc || m.el.src);
                if (src) await bgSend({ action: 'openTab', url: src });
                return;
            }
            case 'viewFull': {
                const src = m.src || m.el.currentSrc || m.el.src;
                if (!src) return;
                this.ctx.panel.show({
                    title: '原图预览',
                    dataUrl: src.startsWith('data:') ? src : null,
                    html: src.startsWith('data:') ? '' : `<img class="result" src="${esc(src)}" alt="" />`,
                    near: this.ctx.toolbar?.currentTarget,
                    actions: [{ label: '在新标签打开', run: () => bgSend({ action: 'openTab', url: src }) }],
                });
                return;
            }
            case 'info': {
                const src = m.kind === 'video' ? (m.el.currentSrc || m.el.src) : (m.src || m.el.currentSrc || m.el.src);
                let size = null;
                try {
                    const r = await bgSend({ action: 'probeUrl', url: src, pageUrl: location.href });
                    if (r?.ok) size = r;
                } catch (e) { /* 拿不到就只报基本项 */ }
                const v = m.el;
                const rows = [
                    ['类型', m.kind],
                    ['地址', src || '(未知)'],
                    ['显示尺寸', `${Math.round(m.displayRect?.width || 0)}×${Math.round(m.displayRect?.height || 0)}`],
                    ['源尺寸', size ? `${size.width || '?'}×${size.height || '?'}` : `${v.naturalWidth || v.videoWidth || '?'}×${v.naturalHeight || v.videoHeight || '?'}`],
                    ['字节', size?.bytes ? formatBytes(size.bytes) : '未探测'],
                    ['MIME', size?.mime || v.currentSrc?.match(/\.(png|jpe?g|webp|avif|gif|bmp)/i)?.[1] || '?'],
                    ['页面', location.host],
                ];
                if (m.kind === 'video') {
                    rows.push(['时长', (isFinite(v.duration) ? v.duration.toFixed(2) : '?') + ' s']);
                    rows.push(['当前', (v.currentTime || 0).toFixed(3) + ' s']);
                    rows.push(['倍速', String(v.playbackRate || 1)]);
                    rows.push(['音量', `${v.muted ? '静音' : Math.round((v.volume || 0) * 100) + '%'}`]);
                    try {
                        const md = v.textTracks?.length;
                        if (md) rows.push(['轨道数', String(md)]);
                    } catch (e) { /* ignore */ }
                    const q = await bgSend({ action: 'videoQualities', tabIdHint: null }).catch(() => null);
                    if (q?.ok && q.qualities) rows.push(['可用清晰度', q.qualities.join(', ')]);
                }
                this.ctx.panel.show({
                    title: '媒体信息',
                    html: rows.map(([k, val]) => `<div class="row"><span class="k">${esc(k)}</span><pre>${esc(String(val))}</pre></div>`).join(''),
                    near: this.ctx.toolbar?.currentTarget,
                    actions: [{ label: '复制全部', run: () => copyText(rows.map(([k, val]) => `${k}: ${val}`).join('\n')) }],
                });
                return;
            }
            case 'extractFrame': {
                const s = await this.currentSource();
                this.ctx.panel.show({ title: `当前帧 ${s.width}×${s.height} (${s.via})`, dataUrl: s.dataUrl, near: this.ctx.toolbar?.currentTarget, actions: [{ label: '下载', run: () => this.saveDataUrl(s.dataUrl, this.filenameFor(item, s)) }] });
                this.ctx.replaceTemp(s);
                return;
            }
            case 'saveFrame': {
                const s = await this.currentSource();
                await this.saveDataUrl(s.dataUrl, this.filenameFor(item, s));
                return;
            }
            case 'frameSheet': {
                const count = toInt(item.params?.count ?? this.s.video.sheetColumns * 2, 8);
                const times = videoTimeList(m.el, count);
                const frames = await captureFrames(m.el, times, { trim: this.s.video.trimLetterbox, format: 'png' });
                const cols = toInt(this.s.video.sheetColumns, 4);
                const cell = toInt(this.s.video.sheetCellWidth, 320);
                const res = await this.sendToHost({
                    type: 'op', dataUrl: frames[0].dataUrl, chain: [],
                });
                const sheet = await this.composeSheet(frames, cols, cell);
                this.ctx.panel.show({ title: `抽帧拼图 ${count} 帧`, dataUrl: sheet, near: this.ctx.toolbar?.currentTarget, actions: [{ label: '下载拼图', run: () => this.saveDataUrl(sheet, 'frame_sheet.png') }] });
                return;
            }
            case 'exportFrames': {
                const count = toInt(item.params?.count ?? 12, 12);
                const range = toNum(item.params?.range ?? 0, 0);
                const from = range > 0 ? Math.max(0, (m.el.currentTime || 0)) : 0;
                const to = range > 0 ? Math.min(isFinite(m.el.duration) ? m.el.duration : from + range, from + range) : 0;
                const times = videoTimeList(m.el, count, { from, to });
                this.ctx.setStatus?.(`取 ${count} 帧…`);
                const frames = await captureFrames(m.el, times, { trim: this.s.video.trimLetterbox, format: this.s.output.format === 'jpg' ? 'jpg' : 'png' });
                await Promise.all(frames.map((f, i) => this.saveDataUrl(f.dataUrl, `frame_${String(i + 1).padStart(3, '0')}_${f.time.toFixed(2)}s.${f.mime.includes('jpeg') ? 'jpg' : 'png'}`)));
                this.ctx.setStatus?.('');
                toast(this.ctx.shadow, `已导出 ${frames.length} 帧`, 2200);
                return;
            }
            case 'copyTime': {
                const t = m.el.currentTime || 0;
                const url = new URL(location.href);
                url.searchParams.set('t', String(Math.floor(t)));
                await copyText(`${formatTime(t)}  ${url.toString()}`);
                toast(this.ctx.shadow, '已复制时间码 + 带 t 参数的链接', 1800);
                return;
            }
            case 'seekStep': {
                if (!playable(m.el)) { toast(this.ctx.shadow, '这个视频元素没有可控制的播放源', 2200, true); return; }
                const dir = toNum(item.params?.dir ?? 1, 1);
                const step = toNum(item.params?.step ?? (1 / (this.s.video.fpsFallback || 30)), 1 / 30);
                const from = m.el.currentTime || 0;
                try { await seekTo(m.el, Math.max(0, from + dir * step)); }
                catch (e) { toast(this.ctx.shadow, '逐帧失败: ' + e.message, 2400, true); return; }
                toast(this.ctx.shadow, `逐帧 ${dir > 0 ? '前进' : '后退'} ${(step * 1000).toFixed(1)}ms → ${m.el.currentTime.toFixed(3)}s`, 1500);
                this.ctx.refreshProbe?.();
                return;
            }
            case 'cycleSpeed': {
                if (!playable(m.el)) { toast(this.ctx.shadow, '这个视频元素没有可控制的播放源', 2200, true); return; }
                const want = nextRate(m.el.playbackRate);
                const got = setRate(m.el, want);
                const stuck = Math.abs(got - want) < 0.01;
                toast(this.ctx.shadow, stuck ? `倍速 ${got}x` : `站点把倍速按回了 ${got}x（想要 ${want}x）`, 1800, !stuck);
                return;
            }
            case 'togglePlay': {
                if (!playable(m.el)) { toast(this.ctx.shadow, '这个视频元素没有可控制的播放源', 2200, true); return; }
                if (m.el.paused) {
                    try { await m.el.play(); }
                    catch (e) { toast(this.ctx.shadow, '播放被浏览器拒绝: ' + e.message, 2600, true); return; }
                } else m.el.pause();
                toast(this.ctx.shadow, m.el.paused ? '已暂停' : '播放中', 1200);
                return;
            }
            case 'toggleMute': {
                if (!playable(m.el)) { toast(this.ctx.shadow, '这个视频元素没有可控制的播放源', 2200, true); return; }
                m.el.muted = !m.el.muted;
                if (!m.el.muted) { try { await m.el.play(); } catch (e) { /* 需要手势，忽略 */ } }
                toast(this.ctx.shadow, m.el.muted ? '已静音' : '已取消静音', 1200);
                return;
            }
            case 'toggleLoop': {
                if (!playable(m.el)) { toast(this.ctx.shadow, '这个视频元素没有可控制的播放源', 2200, true); return; }
                const got = setLoop(m.el, !m.el.loop);
                toast(this.ctx.shadow, got ? '循环 开（本元素）' : '循环 关', 1400);
                return;
            }
            case 'pictureInPicture': {
                if (!playable(m.el)) { toast(this.ctx.shadow, '这个视频元素没有可控制的播放源', 2200, true); return; }
                if (!document.pictureInPictureEnabled) { toast(this.ctx.shadow, '浏览器不支持画中画', 2200, true); return; }
                try {
                    if (document.pictureInPictureElement) { await document.exitPictureInPicture(); toast(this.ctx.shadow, '已退出小窗', 1200); }
                    else { await m.el.requestPictureInPicture(); toast(this.ctx.shadow, '已小窗播放', 1200); }
                } catch (e) { toast(this.ctx.shadow, '小窗失败: ' + e.message, 2400, true); }
                return;
            }
            case 'clearOverlay': {
                drawBoxes(this.ctx.boxLayer, [], null);
                drawMask(this.ctx.maskLayer, [], null);
                this.ctx.panel.hide?.();
                this.ctx.pickActive?.() && this.ctx.stopPick?.();
                return;
            }
            case 'gear': await bgSend({ action: 'openOptions' }); return;
            default: throw new Error('未实现内置动作: ' + fn);
        }
    }

    async composeSheet(frames, cols, cellWidth) {
        const per = [];
        for (const f of frames) {
            const img = new Image();
            img.src = f.dataUrl;
            per.push(img.decode ? img.decode().then(() => img, () => img) : new Promise((r) => { img.onload = () => r(img); img.onerror = () => r(null); }));
        }
        const imgs = (await Promise.all(per)).filter(Boolean);
        if (!imgs.length) throw new Error('没有取到帧');
        const rows = Math.ceil(imgs.length / cols);
        const cw = Math.max(48, toInt(cellWidth, 320));
        const canvas = document.createElement('canvas');
        const ch = Math.round(imgs[0].naturalHeight / (imgs[0].naturalWidth / cw));
        canvas.width = cw * cols; canvas.height = ch * rows;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        imgs.forEach((img, i) => {
            const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
            ctx.drawImage(img, x, y, cw, ch);
            ctx.fillStyle = 'rgba(0,0,0,.6)';
            ctx.fillRect(x, y + ch - 16, 62, 16);
            ctx.fillStyle = '#fff'; ctx.font = '11px monospace';
            ctx.fillText(frames[i].time.toFixed(2) + 's', x + 3, y + ch - 4);
        });
        return canvas.toDataURL('image/png');
    }

    // —— AI ——
    mediaKey() {
        const m = this.ctx.media;
        if (!m) return '';
        return `${m.kind}|${m.src || (m.el && (m.el.currentSrc || m.el.src)) || ''}|${m.el && m.el.currentTime ? Math.round(m.el.currentTime * 10) : 0}`;
    }

    async runAi(item) {
        const task = item.action.task;
        // 同一张图上再点一次「人脸识别」就是收起人脸框 —— 不然框会一直糊在图上，得另找「清除」
        if (task === 'face' && this.ctx.facesKey && this.ctx.facesKey === this.mediaKey() && this.ctx.boxLayer?.__boxes?.length) {
            drawBoxes(this.ctx.boxLayer, [], null);
            this.ctx.facesKey = null;
            toast(this.ctx.shadow, '已收起人脸框（再点一次重新识别）', 1800);
            return;
        }
        try {
            this.ctx.setStatus?.('准备模型…');
            if (task === 'ask') {
                const q = await promptFor(this.ctx.shadow, { title: '问点什么？（Enter 发送，Shift+Enter 换行）', placeholder: '例如：图里的人在做什么？', near: this.ctx.toolbar?.currentTarget });
                if (!q) { this.ctx.setStatus?.(''); return; }
                this.ctx.setStatus?.('思考中…');
                const src = await this.currentSource();
                const r = await this.sendToHost({ type: 'ai', task, ...src, question: q, ai: this.s.ai });
                this.ctx.panel.show({ title: 'AI 回答', text: r.text || '(空)', near: this.ctx.toolbar?.currentTarget, actions: [{ label: '复制', run: () => copyText(r.text) }] });
                this.ctx.setStatus?.('');
                return;
            }
            if (task === 'samPick') { this.startSamPick(); return; }
            const src = await this.currentSource();
            if (task === 'faceRegister') { await this.registerFace(src); return; }
            this.ctx.setStatus?.(task === 'superResolve' ? '超分中…' : task === 'faceBlur' ? '打码中…' : task === 'recognize' ? '识别中…' : 'AI 推理中…');
            const r = await this.sendToHost({ type: 'ai', task, ...src, ai: this.s.ai, gallery: this.s.faceGallery || [], maxNewTokens: item.params?.maxNewTokens });
            this.ctx.setStatus?.('');
            if (r.blocked) {
                this.ctx.panel.show({
                    title: '需要确认下载',
                    text: r.blocked.reason,
                    actions: [{ label: '确认下载并执行', run: () => this.sendToHost({ type: 'ai', task, ...src, ai: this.s.ai, confirmBudget: this.s.ai.vlm || true }).then((x) => this.applyAiResult(item, x)) }],
                });
                return;
            }
            await this.applyAiResult(item, r, src);
        } catch (e) {
            this.ctx.setStatus?.('');
            toast(this.ctx.shadow, errText('AI 失败: ', e), 5200, true);
            console.warn('[mtb] AI 失败', e);
        }
    }

    // 登记人脸：取图里最大的一张脸 → 提特征 → 起名 → 写进本地人脸库（同名覆盖）
    async registerFace(src) {
        const r = await this.sendToHost({ type: 'ai', task: 'faceRegister', ...src, ai: this.s.ai });
        this.ctx.setStatus?.('');
        if (r.blocked) {
            this.ctx.panel.show({ title: '需要确认下载', text: r.blocked.reason, actions: [{ label: '确认登记', run: () => this.sendToHost({ type: 'ai', task: 'faceRegister', ...src, ai: this.s.ai, confirmBudget: true }).then((x) => this.saveFace(x)) }] });
            return;
        }
        await this.saveFace(r);
    }

    async saveFace(r) {
        if (!r || !r.vector) { toast(this.ctx.shadow, '没拿到人脸特征', 2600, true); return; }
        const name = await promptFor(this.ctx.shadow, { title: `给这张脸起个名字（${r.faces > 1 ? '图里有 ' + r.faces + ' 张脸，取最大的' : '已取到人脸'}）`, placeholder: '例如：张三', near: this.ctx.toolbar?.currentTarget });
        const clean = String(name || '').trim();
        if (!clean) { toast(this.ctx.shadow, '已取消登记', 1600); return; }
        const gallery = (this.s.faceGallery || []).filter((g) => g && g.name !== clean);
        gallery.push({ id: 'f' + Date.now().toString(36), name: clean, vector: r.vector, dim: r.dim, createdAt: Date.now() });
        await this.ctx.patchSettings?.({ faceGallery: gallery });
        toast(this.ctx.shadow, `已登记「${clean}」，人脸库 ${gallery.length} 人`, 2600);
    }

    async applyAiResult(item, r, src) {
        const near = this.ctx.toolbar?.currentTarget;
        if (r.text) {
            this.ctx.panel.show({ title: item.label, text: r.text, near, actions: [{ label: '复制', run: () => copyText(r.text) }] });
        }
        if (r.labels || r.filtered) {
            this.ctx.panel.show({ title: item.label, text: (r.filtered || r.labels.map((l) => `${l.label} ${Math.round((l.score || 0) * 100)}%`)).join('\n'), near, actions: [{ label: '复制标签', run: () => copyText((r.filtered || r.labels.map((l) => l.label)).join(', ')) }] });
        }
        if (r.dataUrl) {
            this.ctx.panel.show({
                title: `${item.label} · ${r.width}×${r.height}`, dataUrl: r.dataUrl, near,
                actions: [
                    { label: '下载', run: () => this.saveDataUrl(r.dataUrl, this.filenameFor(item, r)) },
                    { label: '复制', run: () => this.copyDataUrl(r.dataUrl) },
                    { label: '发到 ComfyUI', run: () => this.ctx.runToolById('send-comfy', { dataUrl: r.dataUrl }) },
                ],
            });
            if (this.s.output.autoDownloadAfterOp) this.saveDataUrl(r.dataUrl, this.filenameFor(item, r));
        }
        if (r.overlay?.length && near) {
            const masks = r.overlay.filter((o) => o.type === 'mask').map((o) => o.maskUrl);
            const boxes = r.overlay.filter((o) => o.type === 'box');
            if (masks.length) drawMask(this.ctx.maskLayer, masks, near);
            if (boxes.length) {
                const ref = { refWidth: r.sourceWidth || near.width, refHeight: r.sourceHeight || near.height };
                drawBoxes(this.ctx.boxLayer, boxes.map((b) => ({ ...b, ...ref })), near);
            }
            if (r.faces) { this.ctx.lastFaces = r.faces; this.ctx.facesKey = this.mediaKey(); }
            if (r.faces && !r.faces.length) toast(this.ctx.shadow, '这张图没检出人脸（换个角度/光线更强的图试试，或在设置里换检测模型）', 3200, true);
            if (r.masks) this.ctx.lastMasks = r.masks;
        }
        if (r.faces && typeof r.named === 'number') {
            const lines = r.faces.map((f, i) => `#${i + 1} ${f.name ? '「' + f.name + '」' : '陌生'}${f.sim != null ? ' 相似度 ' + Math.round(f.sim * 100) + '%' : ''}`);
            this.ctx.panel.show({
                title: `认出是谁 · 匹配 ${r.named}/${r.count}`,
                text: (r.gallery ? `人脸库 ${r.gallery} 人，判定阈值 ${Math.round(r.threshold * 100)}%` : '人脸库还是空的：先用「登记人脸」把常看到的人存进来') + '\n' + lines.join('\n'),
                near,
                actions: [{ label: '复制', run: () => copyText(lines.join('\n')) }],
            });
            return;
        }
        if (r.count !== undefined && !r.text) toast(this.ctx.shadow, `${item.label}: ${r.count} 个目标`, 2000);
    }

    startSamPick() {
        const m = this.ctx.media;
        if (!m) return;
        const rect = m.el.getBoundingClientRect();
        this.ctx.startPick(`点击目标抠图 · Shift/右键=负样本 · Esc 退出`, async (pt) => {
            try {
                const src = await this.currentSource();
                const x = pt.x * (src.width ? 1 : 1);
                this.ctx.setStatus?.('分割中…');
                const r = await this.sendToHost({
                    type: 'ai', task: 'samPick', ...src, ai: this.s.ai,
                    points: [[pt.x / rect.width, pt.y / rect.height]].map(([nx, ny]) => [nx * (r0(src).width), ny * (r0(src).height)]),
                    labels: [pt.negative ? 0 : 1],
                });
                this.ctx.setStatus?.('');
                await this.applyAiResult({ id: 'ai-sam', label: '抠图' }, r, src);
                this.ctx.lastPickPoints = [...(this.ctx.lastPickPoints || []), [pt, r]];
            } catch (e) { this.ctx.setStatus?.(''); toast(this.ctx.shadow, errText('分割失败: ', e), 4000, true); }
        }, () => toast(this.ctx.shadow, '已退出取点', 1200));
        function r0(src) { return { width: src.width || 1024, height: src.height || 1024 }; }
    }

    // —— 自定义 ——
    async runScript(item) {
        const m = this.ctx.media;
        const src = await this.currentSource().catch(() => ({}));
        const ctxData = {
            media: {
                kind: m.kind, src: m.src || m.el.currentSrc || m.el.src, pageUrl: location.href, pageTitle: document.title,
                width: src.width || m.el.naturalWidth || m.el.videoWidth || 0,
                height: src.height || m.el.naturalHeight || m.el.videoHeight || 0,
                displayWidth: Math.round(m.displayRect?.width || 0), displayHeight: Math.round(m.displayRect?.height || 0),
                time: m.el.currentTime || 0, duration: m.el.duration || 0,
                mime: src.mime, bytes: src.bytesLen, via: src.via, isFrame: !!src.isFrame,
            },
            dataUrl: src.dataUrl || null,
            params: item.params || {},
            settings: publicSettings(this.s),
            lastFaces: this.ctx.lastFaces || [],
            lastMasks: this.ctx.lastMasks || [],
        };
        this.ctx.setStatus?.('脚本运行中…');
        try {
            const r = await this.sendToHost({ type: 'script', scriptId: item.id, code: item.action.script, ctx: ctxData, ...(src.dataUrl ? { dataUrl: src.dataUrl } : { url: src.url, pageUrl: src.pageUrl }) });
            this.ctx.setStatus?.('');
            const out = r.result || {};
            if (out.toast) toast(this.ctx.shadow, String(out.toast), 2600, !!out.isError);
            if (out.html || out.text || out.dataUrl) {
                this.ctx.panel.show({
                    title: out.title || item.label, dataUrl: out.dataUrl || null, text: out.text || null, html: out.html || '',
                    near: this.ctx.toolbar?.currentTarget,
                    actions: out.dataUrl ? [{ label: '下载', run: () => this.saveDataUrl(out.dataUrl, out.filename || (item.id + '.png')) }] : [],
                });
            }
            if (out.overlay) {
                const near = this.ctx.toolbar?.currentTarget;
                if (out.overlay.boxes) drawBoxes(this.ctx.boxLayer, out.overlay.boxes, near);
                if (out.overlay.text) toast(this.ctx.shadow, out.overlay.text, 2000);
            }
            if (out.copyText) copyText(out.copyText);
            if (out.download && out.dataUrl) this.saveDataUrl(out.dataUrl, out.filename || item.id);
        } catch (e) {
            this.ctx.setStatus?.('');
            toast(this.ctx.shadow, errText('脚本错误: ', e), 5000, true);
            console.warn('[mtb] 脚本错误', e);
        }
    }

    async runLink(item) {
        const l = (this.s.linkTools || []).find((x) => x.id === item.action.linkId) || {};
        const m = this.ctx.media;
        const src = m.kind === 'video' ? (m.el.currentSrc || m.el.src) : (m.src || m.el.currentSrc || m.el.src);
        let dataUrl = null;
        if (/\{dataUrl\}/.test(l.template || '')) {
            const s = await this.currentSource().catch(() => null);
            dataUrl = s?.dataUrl || (s ? (await this.sendToHost({ type: 'encode', ...s, format: 'png' })).dataUrl : null);
        }
        const vars = {
            src: src || '', page: location.href, title: document.title,
            w: m.el.naturalWidth || m.el.videoWidth || 0, h: m.el.naturalHeight || m.el.videoHeight || 0,
            dw: Math.round(m.displayRect?.width || 0), dh: Math.round(m.displayRect?.height || 0),
            t: (m.el.currentTime || 0).toFixed(3), mime: m.el.type || '', dataUrl: dataUrl || '',
        };
        if (l.method === 'POST') {
            const r = await bgSend({ action: 'proxyPost', url: fillTemplateRaw(l.template, vars), body: l.body ? fillTemplate(l.body, vars) : undefined, headers: l.headers || {}, json: !!l.asJson });
            toast(this.ctx.shadow, r?.ok ? '已 POST' : 'POST 失败: ' + (r?.error || ''), 2400, !r?.ok);
            return;
        }
        const url = fillTemplateRaw(l.template, vars).replace(/\{([a-zA-Z0-9_]+)\}/g, (all, k) => encodeURIComponent(vars[k] ?? ''));
        if (l.openTab !== false) await bgSend({ action: 'openTab', url });
        else await copyText(url);
    }

    async dispatch(item, btn, e) {
        // 所有按钮的唯一入口：扩展刚重载过的话这里先拦住，免得每个功能各自抛 Chrome 内部术语
        if (!extAlive()) { toast(this.ctx.shadow, DEAD_TEXT, 5000, true); return; }
        try {
            if (item.action?.type === 'step') return await this.runImageOp(item);
            if (item.action?.type === 'builtin') return await this.builtin(item.action.fn, item);
            if (item.action?.type === 'ai') return await this.runAi(item);
            if (item.action?.type === 'script') return await this.runScript(item);
            if (item.action?.type === 'link') return await this.runLink(item);
            if (item.action?.type === 'comfy') return await this.comfy(item);
            throw new Error('未知动作类型: ' + JSON.stringify(item.action));
        } catch (err) {
            this.ctx.setStatus?.('');
            toast(this.ctx.shadow, errText((item.label || '操作') + '失败: ', err), 4200, true);
            console.warn('[mtb]', item.id, err);
        }
    }

    async comfy(item) {
        const m = this.ctx.media;
        const src = await this.currentSource();
        const payload = {
            action: 'sendImageToComfyUI', dataUrl: src.dataUrl, imgSrc: src.url || null,
            pageUrl: location.href, autoQueue: !!item.action.autoQueue, filename: this.filenameFor(item, src),
            comfy: this.s.comfy,
        };
        this.ctx.setStatus?.('发送中…');
        const r = await bgSend(payload);
        this.ctx.setStatus?.('');
        toast(this.ctx.shadow, r?.ok ? (item.action.autoQueue ? '已发送并排队' : '已发送到 ComfyUI') : '发送失败: ' + (r?.error || ''), 3000, !r?.ok);
        if (!r?.ok && r?.hint) console.warn('[mtb] comfy:', r.hint);
    }
}

function r0(x) { return x; }

function publicSettings(s) {
    return { comfy: s.comfy, output: s.output, video: s.video, ai: { device: s.ai.device, hub: s.ai.hub } };
}

function fmt(r) {
    const { op, ...rest } = r;
    return JSON.stringify(rest, (k, v) => (Array.isArray(v) && v.length > 24 ? `[${v.length} 项]` : v), 0).replace(/[{}"]/g, (c) => (c === '"' ? '' : c === '{' ? '' : c === '}' ? '' : c));
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function toInt(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function toNum(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
function formatTime(sec) {
    const s = Math.max(0, sec | 0);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; }
    catch (e) {
        const ta = document.createElement('textarea');
        ta.value = t; ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
        ta.remove();
        return true;
    }
}


return { "Runner": (typeof Runner === 'undefined' ? undefined : Runner), "copyText": (typeof copyText === 'undefined' ? undefined : copyText), "toast": (typeof toast === 'undefined' ? undefined : toast), "toInt": (typeof toInt === 'undefined' ? undefined : toInt), "toNum": (typeof toNum === 'undefined' ? undefined : toNum) };
})();
__M["src/common/weibo-filter.js"] = (function(){
// 微博信息流筛选：按「原创/转发 + 纯文字/含图片/含视频/含音乐 + 关键字 + 时间」决定一条微博显示还是隐藏。
// 纯函数放这里，DOM 读取在 src/content/weibo-filter.mjs —— 这样判定语义能被单测钉住。

const WEIBO_TYPES = ['original', 'repost', 'text', 'image', 'video', 'music'];

const DEFAULT_WEIBO_FILTER = {
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
function splitKeywords(text) {
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

function normalizeWeiboFilter(f) {
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
function filterAppliesTo(filter, host) {
    const f = normalizeWeiboFilter(filter);
    if (!f.enabled) return false;
    if (f.allSites) return true;
    return !!f.site && String(host || '').toLowerCase() === f.site;
}

/**
 * 这条微博该不该显示。info 由页面侧读出：{repost, hasImage, hasVideo, hasMusic, text, date:'YYYY-MM-DD'|''}。
 * 类型是「勾了的才要」：原创/转发二选一，纯文字/含图/含视频/含音乐按命中的任一类型通过。
 */
function matchWeiboFilter(info, filter) {
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
function describeWeiboFilter(filter) {
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
function dateOfCreatedAt(v) {
    if (v === undefined || v === null || v === '') return '';
    const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 把微博条目对象（Home.data.list 里那种）翻成判定要的 info */
function weiboItemInfo(item) {
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

function matchWeiboItem(item, filter) {
    return matchWeiboFilter(weiboItemInfo(item), filter);
}

return { "WEIBO_TYPES": (typeof WEIBO_TYPES === 'undefined' ? undefined : WEIBO_TYPES), "DEFAULT_WEIBO_FILTER": (typeof DEFAULT_WEIBO_FILTER === 'undefined' ? undefined : DEFAULT_WEIBO_FILTER), "splitKeywords": (typeof splitKeywords === 'undefined' ? undefined : splitKeywords), "normalizeWeiboFilter": (typeof normalizeWeiboFilter === 'undefined' ? undefined : normalizeWeiboFilter), "filterAppliesTo": (typeof filterAppliesTo === 'undefined' ? undefined : filterAppliesTo), "matchWeiboFilter": (typeof matchWeiboFilter === 'undefined' ? undefined : matchWeiboFilter), "describeWeiboFilter": (typeof describeWeiboFilter === 'undefined' ? undefined : describeWeiboFilter), "dateOfCreatedAt": (typeof dateOfCreatedAt === 'undefined' ? undefined : dateOfCreatedAt), "weiboItemInfo": (typeof weiboItemInfo === 'undefined' ? undefined : weiboItemInfo), "matchWeiboItem": (typeof matchWeiboItem === 'undefined' ? undefined : matchWeiboItem) };
})();
__M["src/common/registry.js"] = (function(){
// 工具目录与默认设置。工具栏按钮、设置页清单、host 分发都以本文件为唯一真值。

const { DEFAULT_WEIBO_FILTER } = __M["src/common/weibo-filter.js"];

const ICONS = {
    copy: '📋', link: '🔗', download: '💾', open: '🗗', info: 'ℹ️', eye: '👁️',
    comfy: '🧩', play: '▶', pause: '⏸', stepF: '⏭', stepB: '⏮', speed: '⏩',
    mute: '🔇', loop: '🔁', film: '🎞', crop: '✂️', resize: '📐', rotate: '🔄',
    flip: '🔃', magic: '✨', gray: '🌫', invert: '🌓', edges: '📏', grid: '🧮',
    sam: '🎯', face: '😀', super: '🔬', tag: '🏷', ask: '💬', scan: '🔍',
    blur: '🌁', sharpen: '🗡', palette: '🎨', hash: '#️⃣', code: '⌨️', gear: '⚙️',
    x: '❌', check: '✅', brush: '🖌', layers: '🧱', star: '⭐', scissors: '✂',
};

// 每个工具: action.type = step(像素算子链) | builtin(内容脚本能力) | ai(host 模型) | script(用户脚本) | link(链接模板)
const TOOLS = [
    // —— 基础操作 ——
    { id: 'copy-link', group: '基础', label: '复制链接', icon: ICONS.link, media: ['image', 'video'], action: { type: 'builtin', fn: 'copyLink' }, hint: '复制图片/视频直链地址（自动去除临时签名参数可选）' },
    { id: 'copy-image', group: '基础', label: '复制图片', icon: ICONS.copy, media: ['image', 'video'], action: { type: 'builtin', fn: 'copyImage' }, hint: '把当前图（或视频当前帧）复制到剪贴板' },
    { id: 'download', group: '基础', label: '下载', icon: ICONS.download, media: ['image', 'video'], action: { type: 'builtin', fn: 'download' }, hint: '下载原图；视频则下载当前帧 PNG' },
    { id: 'open-src', group: '基础', label: '新标签打开', icon: ICONS.open, media: ['image', 'video'], action: { type: 'builtin', fn: 'openSrc' }, hint: '在新标签打开原始直链' },
    { id: 'info', group: '基础', label: '详细信息', icon: ICONS.info, media: ['image', 'video'], action: { type: 'builtin', fn: 'info' }, hint: '显示源地址、尺寸、大小、类型、编解码、时长等' },
    { id: 'view-full', group: '基础', label: '原图预览', icon: ICONS.eye, media: ['image'], action: { type: 'builtin', fn: 'viewFull' }, hint: '在页面内浮层查看真实分辨率原图' },
    { id: 'clean-url', group: '基础', label: '复制干净链接', icon: '🧼', media: ['image', 'video'], action: { type: 'builtin', fn: 'cleanLink' }, hint: '去掉签名/尺寸后缀等噪声参数后复制' },

    // —— 图像编辑（step 链）——
    { id: 'upscale-lanczos', group: '高清', label: 'Lanczos 放大', icon: ICONS.super, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'resize', params: { filter: 'lanczos3', mode: 'percent', percent: 200 } }] }, params: [{ key: 'percent', label: '倍率(%)', type: 'number', def: 200 }] },
    { id: 'downscale', group: '高清', label: 'Area 缩小', icon: ICONS.resize, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'resize', params: { filter: 'area', mode: 'percent', percent: 50 } }] } },
    { id: 'unsharp', group: '高清', label: 'USM 锐化', icon: ICONS.sharpen, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'unsharp', params: { radius: 1.6, amount: 110, threshold: 2 } }] } },
    { id: 'auto-enhance', group: '高清', label: '一键增强', icon: ICONS.magic, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'autoLevels', params: { percent: 0.4 } }, { op: 'clahe', params: { clipLimit: 2.5, tiles: 8 } }, { op: 'unsharp', params: { radius: 1.4, amount: 70 } }] } },
    { id: 'denoise', group: '高清', label: '保边降噪', icon: ICONS.blur, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'bilateral', params: { spaceSigma: 6, rangeSigma: 28 } }] } },
    { id: 'grayscale', group: '调色', label: '去色', icon: ICONS.gray, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'grayscale', params: { mode: 'luma709' } }] } },
    { id: 'invert', group: '调色', label: '反色', icon: ICONS.invert, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'invert' }] } },
    { id: 'warm', group: '调色', label: '增色温', icon: '🌡', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'adjust', params: { temperature: 22, vibrance: 12 } }] } },
    { id: 'cool', group: '调色', label: '降色温', icon: '❄️', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'adjust', params: { temperature: -22, vibrance: 8 } }] } },
    { id: 'wb', group: '调色', label: '白平衡', icon: '⚖️', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'whiteBalance', params: { method: 'percentile', strength: 100 } }] } },
    { id: 'equalize', group: '调色', label: '直方图均衡', icon: '📊', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'equalize', params: { channel: 'luma' } }] } },
    { id: 'clahe', group: '调色', label: 'CLAHE', icon: ICONS.layers, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'clahe', params: { clipLimit: 3, tiles: 8 } }] } },
    { id: 'posterize', group: '调色', label: '色阶分离', icon: '🪄', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'posterize', params: { levelsCount: 6 } }] } },
    { id: 'pixelate', group: '滤镜', label: '像素化', icon: '🧊', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'pixelate', params: { size: 12, mode: 'avg' } }] } },
    { id: 'oil', group: '滤镜', label: '油画', icon: '🖼', media: ['image'], action: { type: 'step', chain: [{ op: 'oilPaint', params: { radius: 3, intensity: 32 } }] } },
    { id: 'vignette', group: '滤镜', label: '暗角', icon: '⭕', media: ['image'], action: { type: 'step', chain: [{ op: 'vignette', params: { amount: 60, radius: 68, soften: 45 } }] } },
    { id: 'chromakey', group: '滤镜', label: '抠色', icon: ICONS.scissors, media: ['image'], action: { type: 'step', chain: [{ op: 'chromaKey', params: { color: '#00ff00', tolerance: 45, feather: 12, model: 'hsv' } }] } },
    { id: 'round', group: '滤镜', label: '圆角', icon: '🔲', media: ['image'], action: { type: 'step', chain: [{ op: 'border', params: { radius: 24, feather: 0, corners: 'all', background: 'transparent' } }] } },
    { id: 'edges', group: '分析', label: 'Canny 边缘', icon: ICONS.edges, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'canny', params: { low: 40, high: 120, sigma: 1.4 } }] } },
    { id: 'sobel', group: '分析', label: 'Sobel', icon: '🧲', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'sobel', params: { mode: 'magnitude' } }] } },
    { id: 'binarize', group: '分析', label: 'Otsu 二值化', icon: '⬛', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'threshold', params: { mode: 'otsu' } }] } },
    { id: 'sauvola', group: '分析', label: '文档增强', icon: '📄', media: ['image'], action: { type: 'step', chain: [{ op: 'grayscale', params: {} }, { op: 'threshold', params: { mode: 'sauvola', blockSize: 41, k: 0.18 } }] } },
    { id: 'rotate-cw', group: '几何', label: '右转 90°', icon: ICONS.rotate, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'rotate', params: { angle: -90 } }] } },
    { id: 'rotate-ccw', group: '几何', label: '左转 90°', icon: '↺', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'rotate', params: { angle: 90 } }] } },
    { id: 'flip-h', group: '几何', label: '水平镜像', icon: ICONS.flip, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'flip', params: { dir: 'h' } }] } },
    { id: 'crop-square', group: '几何', label: '裁成正方', icon: ICONS.crop, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'crop', params: { mode: 'ratio', ratio: '1:1' } }] } },
    { id: 'crop-169', group: '几何', label: '裁成 16:9', icon: ICONS.crop, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'crop', params: { mode: 'ratio', ratio: '16:9' } }] } },
    { id: 'autotrim', group: '几何', label: '裁黑边', icon: '✂️', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'trim', params: { mode: 'auto', tolerance: 14 } }] } },
    { id: 'pad-white', group: '几何', label: '补白边', icon: '⬜', media: ['image'], action: { type: 'step', chain: [{ op: 'pad', params: { size: 32, color: '#ffffff' } }] } },
    { id: 'measure', group: '分析', label: '内容测量', icon: '📏', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'detectSize', params: { mode: 'auto' } }] }, showImage: false },
    { id: 'palette', group: '分析', label: '取主色', icon: ICONS.palette, media: ['image'], action: { type: 'step', chain: [{ op: 'palette', params: { count: 8 } }] }, showImage: false },
    { id: 'stats', group: '分析', label: '像素统计', icon: ICONS.grid, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'stats' }] }, showImage: false },
    { id: 'hash', group: '分析', label: '感知哈希', icon: ICONS.hash, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'hashes' }] }, showImage: false },
    { id: 'corners', group: '分析', label: '角点', icon: '✳️', media: ['image'], action: { type: 'step', chain: [{ op: 'corners', params: { blockSize: 3, k: 0.04, thresholdRatio: 2, maxCorners: 120 } }] } },
    { id: 'lines', group: '分析', label: '直线检测', icon: '📐', media: ['image'], action: { type: 'step', chain: [{ op: 'lines', params: { pre: 'canny', threshold: 140, thetaSteps: 360, maxLines: 12 } }] } },
    { id: 'regions', group: '分析', label: '连通域', icon: '🧩', media: ['image'], action: { type: 'step', chain: [{ op: 'regions', params: { threshold: 128, minArea: 120 } }] } },

    // —— AI ——
    { id: 'ai-describe', group: 'AI', label: '看图说话', icon: ICONS.ask, media: ['image', 'video'], ai: 'describe', action: { type: 'ai', task: 'describe' }, needsHost: true, hint: '多模态模型生成画面描述' },
    { id: 'ai-ask', group: 'AI', label: 'AI 提问', icon: '❓', media: ['image', 'video'], ai: 'ask', action: { type: 'ai', task: 'ask' }, needsHost: true, hint: '弹出输入框，把问题连同图片发给多模态模型' },
    { id: 'ai-tags', group: 'AI', label: '标签识别', icon: ICONS.tag, media: ['image'], ai: 'tags', action: { type: 'ai', task: 'tags' }, needsHost: true },
    { id: 'ai-ocr', group: 'AI', label: 'OCR 读字', icon: '🔤', media: ['image', 'video'], ai: 'ocr', action: { type: 'ai', task: 'ocr' }, needsHost: true },
    { id: 'ai-sam', group: 'AI', label: '点选抠图', icon: ICONS.sam, media: ['image'], ai: 'sam', action: { type: 'ai', task: 'samPick' }, needsHost: true, hint: '进入取点模式，在图上点击目标生成遮罩' },
    { id: 'ai-sam-auto', group: 'AI', label: '自动分割', icon: '🪄', media: ['image'], ai: 'samauto', action: { type: 'ai', task: 'samAuto' }, needsHost: true },
    { id: 'ai-face', group: 'AI', label: '人脸识别', icon: ICONS.face, media: ['image', 'video'], ai: 'face', action: { type: 'ai', task: 'face' }, needsHost: true },
    { id: 'ai-face-blur', group: 'AI', label: '人脸打码', icon: '🕶', media: ['image', 'video'], ai: 'faceblur', action: { type: 'ai', task: 'faceBlur' }, needsHost: true },
    { id: 'ai-face-rec', group: 'AI', label: '认出是谁', icon: '🪪', media: ['image', 'video'], ai: 'facerec', action: { type: 'ai', task: 'recognize' }, needsHost: true, hint: 'SCRFD 检测 + 5 点对齐 + 识别向量，与人脸库比对' },
    { id: 'ai-face-reg', group: 'AI', label: '登记人脸', icon: '📛', media: ['image', 'video'], ai: 'facereg', action: { type: 'ai', task: 'faceRegister' }, needsHost: true, hint: '把图中最大的一张脸存进人脸库并起名字' },
    { id: 'ai-sr', group: 'AI', label: 'AI 超分', icon: '🔍', media: ['image', 'video'], ai: 'sr', action: { type: 'ai', task: 'superResolve' }, needsHost: true, hint: 'swin2SR / ESRGAN ONNX 模型放大' },
    { id: 'ai-depth', group: 'AI', label: '深度图', icon: '🌊', media: ['image'], ai: 'depth', action: { type: 'ai', task: 'depth' }, needsHost: true },
    { id: 'ai-clear', group: 'AI', label: '清除标注', icon: ICONS.x, media: ['image', 'video'], action: { type: 'builtin', fn: 'clearOverlay' } },

    // —— 视频专属 ——
    { id: 'v-frame', group: '视频', label: '当前帧', icon: ICONS.film, media: ['video'], action: { type: 'builtin', fn: 'extractFrame' }, hint: '抓取当前帧为干净原图（无播放器 UI）并预览' },
    { id: 'v-frame-save', group: '视频', label: '存当前帧', icon: ICONS.download, media: ['video'], action: { type: 'builtin', fn: 'saveFrame' } },
    { id: 'v-frames-sheet', group: '视频', label: '抽帧拼图', icon: '🎛', media: ['video'], action: { type: 'builtin', fn: 'frameSheet' }, params: [{ key: 'count', label: '帧数', type: 'number', def: 8 }] },
    { id: 'v-frames-export', group: '视频', label: '批量导出帧', icon: '🗂', media: ['video'], action: { type: 'builtin', fn: 'exportFrames' }, params: [{ key: 'count', label: '张数', type: 'number', def: 12 }, { key: 'range', label: '覆盖时长(s)', type: 'number', def: 0 }] },
    { id: 'v-copy-time', group: '视频', label: '复制时间码', icon: '⏱', media: ['video'], action: { type: 'builtin', fn: 'copyTime' } },
    { id: 'v-seek-in', group: '视频', label: '帧后退', icon: ICONS.stepB, media: ['video'], action: { type: 'builtin', fn: 'seekStep' }, params: [{ key: 'dir', label: '方向', type: 'number', def: -1 }] },
    { id: 'v-seek-out', group: '视频', label: '帧前进', icon: ICONS.stepF, media: ['video'], action: { type: 'builtin', fn: 'seekStep' }, params: [{ key: 'dir', label: '方向', type: 'number', def: 1 }] },
    { id: 'v-speed', group: '视频', label: '倍速循环', icon: ICONS.speed, media: ['video'], action: { type: 'builtin', fn: 'cycleSpeed' } },
    { id: 'v-play', group: '视频', label: '播放/暂停', icon: ICONS.play, media: ['video'], action: { type: 'builtin', fn: 'togglePlay' } },
    { id: 'v-mute', group: '视频', label: '静音', icon: ICONS.mute, media: ['video'], action: { type: 'builtin', fn: 'toggleMute' } },
    { id: 'v-loop', group: '视频', label: '循环', icon: ICONS.loop, media: ['video'], action: { type: 'builtin', fn: 'toggleLoop' } },
    { id: 'v-piP', group: '视频', label: '小窗播放', icon: '🗔', media: ['video'], action: { type: 'builtin', fn: 'pictureInPicture' } },
];

const TOOL_GROUPS = ['基础', '高清', '调色', '滤镜', '几何', '分析', 'AI', '视频', '自定义'];

const DEFAULT_TOOLS = [
    'copy-link', 'copy-image', 'download', 'open-src', 'info',
    'v-frame', 'v-frame-save', 'v-play', 'v-speed', 'v-loop',
    'v-seek-in', 'v-seek-out', 'v-copy-time', 'v-frames-sheet', 'v-mute', 'v-piP',
    'ai-describe', 'ai-sam', 'ai-face', 'ai-face-rec', 'ai-face-reg', 'upscale-lanczos', 'autotrim', 'gear',
];
// 视频态本来按钮就多，长尾的默认收进 ▾ 菜单，免得把工具栏撑到屏幕外
const DEFAULT_COLLAPSED = ['v-seek-in', 'v-seek-out', 'v-copy-time', 'v-frames-sheet', 'v-mute', 'v-piP', 'ai-face-reg'];

// 默认工具栏：图片/视频各自显示哪些（顺序即显示顺序）
function defaultToolbarState() {
    const state = {};
    for (const t of TOOLS) {
        state[t.id] = { enabled: DEFAULT_TOOLS.includes(t.id), order: null, label: null, icon: null, params: null, collapsed: DEFAULT_COLLAPSED.includes(t.id) };
    }
    return state;
}

const DEFAULT_SETTINGS = {
    version: 2,
    toolbar: {
        layout: 'horizontal',        // horizontal | vertical | grid
        anchor: 'top-right',         // top-left top-right bottom-left bottom-right center top-edge bottom-edge
        offsetX: 0,
        offsetY: 0,
        gap: 4,
        scale: 1,
        opacity: 0.92,
        radius: 8,
        iconMode: 'both',            // icon | both | text
        theme: 'dark',               // dark | light | glass | neon
        showOn: 'hover',             // hover | always | hover-key (按住 Alt)
        showKey: 'Alt',
        hideDelay: 120,
        minImgSize: 200,
        skipThumbnails: true,        // 能点开大图的缩略图（微博九宫格等）不弹，查看器大图才弹
        maxTools: 0,                 // 0=不限制，超出折叠到 +
        animation: true,
        zIndex: 2147483647,
        dragMoved: false,
    },
    video: {
        trimLetterbox: true,
        frameFormat: 'png',
        frameMaxSide: 0,
        fpsFallback: 30,
        sheetColumns: 4,
        sheetCellWidth: 320,
    },
    output: {
        format: 'png',
        quality: 0.92,
        filenamePattern: '{base}_{op}_{w}x{h}.{ext}',
        autoDownloadAfterOp: false,
        copyAfterOp: false,
        showResultOverlay: true,
        keepOriginalName: true,
    },
    sites: {
        disabled: [],
        disabledHosts: [],
        includeFrame: true,
    },
    // 只作用于微博信息流：不满足条件的整条 display:none（跟没发过一样）
    weiboFilter: { ...DEFAULT_WEIBO_FILTER, keywords: [] },
    gallery: {
        sendTier: 'card',   // 发给 ComfyUI 用哪个档：card=mw690（默认，~41KB）· full=mw2000 · orig=large（4MB+）
    },
    ai: {
        enabled: true,
        device: 'auto',              // auto | webgpu | wasm
        dtype: 'q4',                 // q4 | q4f16 | int8 | fp16
        hub: 'modelscope',           // modelscope | hf-mirror | huggingface | jsdelivr | custom
        hubCustom: '',
        maxDim: 1024,
        keepAwake: true,
        downloadBudgetMB: 4096,
        autoUnloadAfter: 0,
        vlmPreset: 'qwen3vl-2b',
        samPreset: 'slimsam',
        srPreset: 'swin2sr-x2',
        tagsPreset: 'clip-zero-shot',
        depthPreset: 'depth-anything-small',
        vlmPrompt: '请用中文详细描述这张图片的主体、场景、风格、构图与可见文字。',
        askPrompt: '{question}',
        samPointsPerTarget: 1,
        faceModel: 'scrfd-500m',
        faceModelUrl: '',
        faceEmbedModel: 'w600k-mbf',
        faceEmbedUrl: '',
        faceConfidence: 0.6,
        faceMatchThreshold: 0.4,
        srTile: 256,
    },
    // 人脸库：{id,name,vector(base64 Float32),dim,createdAt}，识别只在本地比对
    faceGallery: [],
    comfy: {
        server: 'http://127.0.0.1:8188',
        mode: 'frontend',            // frontend | api
        targetNodeType: '',
        targetNodeId: '',
        workflowJson: '',
        autoQueue: false,
        uploadFolders: 'both',       // input | output | both
        profiles: {},
        activeProfileId: 'default',
    },
    collapseSeed: null,            // 折叠默认值的补种标记（老设置里 collapsed 全是 false）
    tools: defaultToolbarState(),
    customScripts: [],               // {id,name,label,icon,media,code,enabled,params}
    linkTools: [],                   // {id,name,label,icon,media,template,method,openTab,headers,enabled}
};

const BUILTIN_VARS = [
    { key: '{src}', desc: '图片/视频直链（视频为 currentSrc）' },
    { key: '{page}', desc: '当前页面 URL' },
    { key: '{title}', desc: '页面标题' },
    { key: '{w} / {h}', desc: '源图自然尺寸' },
    { key: '{dw} / {dh}', desc: '页面显示尺寸' },
    { key: '{mime}', desc: '内容类型' },
    { key: '{bytes}', desc: '抓取到的字节数' },
    { key: '{t}', desc: '视频当前时间（秒）' },
    { key: '{dataUrl}', desc: '图像 dataURL（POST 时可用，可能很大）' },
];

function findTool(id) {
    return TOOLS.find((t) => t.id === id) || null;
}

function migrateSettings(raw) {
    const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    if (!raw || raw.version !== 2) {
        if (raw && raw.comfyConfig) {
            const c = raw.comfyConfig;
            s.comfy.server = (c.serverAddress || s.comfy.server).replace(/\/$/, '');
            s.comfy.mode = c.profiles && c.profiles[c.activeProfileId] ? (c.profiles[c.activeProfileId].mode || s.comfy.mode) : s.comfy.mode;
            s.comfy.targetNodeType = (c.profiles && c.profiles[c.activeProfileId] && c.profiles[c.activeProfileId].targetNodeType) || '';
            s.comfy.targetNodeId = (c.profiles && c.profiles[c.activeProfileId] && c.profiles[c.activeProfileId].targetNodeId) || '';
            s.comfy.workflowJson = (c.profiles && c.profiles[c.activeProfileId] && c.profiles[c.activeProfileId].workflowJson) || '';
            s.comfy.autoQueue = false;
            s.toolbar.anchor = c.buttonPosition || s.toolbar.anchor;
            s.toolbar.offsetX = c.offsetX || 0;
            s.toolbar.offsetY = c.offsetY || 0;
            s.toolbar.dragMoved = !!c.offsetX || !!c.offsetY;
            s.toolbar.anchorOffset = c.buttonPosition && !c.offsetX && !c.offsetY ? null : 'custom';
            s.sites.disabled = c.disabledHosts || [];
            s.toolbar.showOn = c.alwaysShow ? 'always' : 'hover';
            s.ai.enabled = true;
        }
        return s;
    }
    const out = mergeDeep(s, raw);
    // 老设置的 tools 里每个 id 都写死了 collapsed:false，会把新默认（视频长尾折叠）整个盖掉，
    // 于是升级后「还是所有按钮平铺」。只对用户没动过的按钮补上新默认，动过的保持原样。
    if (!out.collapseSeed) {
        for (const t of TOOLS) {
            const st = out.tools && out.tools[t.id];
            if (!st) continue;
            const untouched = st.label == null && st.icon == null && st.order == null && st.params == null;
            if (untouched && DEFAULT_COLLAPSED.includes(t.id)) st.collapsed = true;
        }
        out.collapseSeed = 2;
    }
    return out;
}

function mergeDeep(base, patch) {
    if (patch === undefined) return base;
    if (Array.isArray(base) || Array.isArray(patch)) return patch === undefined ? base : JSON.parse(JSON.stringify(patch));
    if (base && typeof base === 'object' && patch && typeof patch === 'object') {
        const out = {};
        for (const k of Object.keys(base)) out[k] = mergeDeep(base[k], patch[k]);
        for (const k of Object.keys(patch)) if (!(k in base)) out[k] = JSON.parse(JSON.stringify(patch[k]));
        return out;
    }
    return patch;
}

// 工具栏实际渲染清单：内置(启用) + 自定义脚本(启用) + 链接工具(启用)
function buildToolbar(settings, mediaType) {
    const items = [];
    const state = settings.tools || {};
    for (const t of TOOLS) {
        const st = state[t.id] || { enabled: false };
        if (!st.enabled) continue;
        if (!t.media.includes(mediaType)) continue;
        items.push({
            id: t.id,
            label: st.label || t.label,
            icon: st.icon || t.icon,
            group: t.group,
            action: t.action,
            params: st.params || null,
            kind: 'builtin',
            showImage: t.showImage !== false,
            collapsed: !!st.collapsed,
        });
    }
    for (const c of settings.customScripts || []) {
        if (!c.enabled) continue;
        if (!(c.media || ['image', 'video']).includes(mediaType)) continue;
        items.push({ id: c.id, label: c.label || c.name, icon: c.icon || ICONS.code, group: '自定义', action: { type: 'script', script: c.code, scriptId: c.id, entry: c.entry }, params: c.params || null, kind: 'script', showImage: false, collapsed: !!c.collapsed });
    }
    for (const l of settings.linkTools || []) {
        if (!l.enabled) continue;
        if (!(l.media || ['image', 'video']).includes(mediaType)) continue;
        items.push({ id: l.id, label: l.label || l.name, icon: l.icon || ICONS.link, group: '自定义', action: { type: 'link', linkId: l.id }, params: l.params || null, kind: 'link', showImage: false, collapsed: !!l.collapsed });
    }
    items.sort((a, b) => {
        const oa = (state[a.id] && state[a.id].order), ob = (state[b.id] && state[b.id].order);
        if (oa != null && ob != null) return oa - ob;
        if (oa != null) return -1;
        if (ob != null) return 1;
        return 0;
    });
    return items;
}

return { "ICONS": (typeof ICONS === 'undefined' ? undefined : ICONS), "TOOLS": (typeof TOOLS === 'undefined' ? undefined : TOOLS), "TOOL_GROUPS": (typeof TOOL_GROUPS === 'undefined' ? undefined : TOOL_GROUPS), "DEFAULT_TOOLS": (typeof DEFAULT_TOOLS === 'undefined' ? undefined : DEFAULT_TOOLS), "DEFAULT_COLLAPSED": (typeof DEFAULT_COLLAPSED === 'undefined' ? undefined : DEFAULT_COLLAPSED), "defaultToolbarState": (typeof defaultToolbarState === 'undefined' ? undefined : defaultToolbarState), "DEFAULT_SETTINGS": (typeof DEFAULT_SETTINGS === 'undefined' ? undefined : DEFAULT_SETTINGS), "BUILTIN_VARS": (typeof BUILTIN_VARS === 'undefined' ? undefined : BUILTIN_VARS), "findTool": (typeof findTool === 'undefined' ? undefined : findTool), "migrateSettings": (typeof migrateSettings === 'undefined' ? undefined : migrateSettings), "mergeDeep": (typeof mergeDeep === 'undefined' ? undefined : mergeDeep), "buildToolbar": (typeof buildToolbar === 'undefined' ? undefined : buildToolbar) };
})();
__M["src/common/builtin-scripts.js"] = (function(){
// 内置自定义功能示例：把"发送到 ComfyUI"与"发送并立即执行"实现为用户可编辑的脚本，
// 走的正是第三方自定义功能那套 ctx API —— 这样示例本身就是该 SDK 的活文档。

const CONTEXT_API_DOC = `可用 API（ctx.*）：
  ctx.media            {kind:'image'|'video'|'bg', src, width, height, displayWidth, displayHeight, time, duration, mime, isFrame, via}
  ctx.dataUrl          当前媒体的 dataURL（视频=当前帧）；ctx.width/ctx.height 同义
  ctx.params           该按钮在设置里配置的参数对象
  ctx.settings         {comfy, output, video, ai:{device,hub}}
  ctx.lastFaces/ctx.lastMasks  上一次 AI 识别结果
  ctx.fetch({url, method, headers, body, form, json, as:'text'|'json'|'dataUrl'})   走后台，绕过 CORS 与防盗链
  ctx.host({chain:[{op,params}], format, quality})      跑像素算子链，返回 {dataUrl,width,height,reports}
  ctx.ai(task, {...})                                   跑 AI 任务：describe/ask/ocr/tags/samPick/samAuto/face/faceBlur/superResolve/depth
  ctx.comfySend({dataUrl?, imgSrc?, autoQueue, filename})  上传并注入 ComfyUI（后台服务）
  ctx.download(dataUrl, filename) / ctx.copyText(text) / ctx.openUrl(url)
  ctx.toast(text, isError) / ctx.overlay({boxes:[{x,y,width,height,label}], text})
  ctx.panel({title, dataUrl, text, html})
  ctx.storage.get(keys) / ctx.storage.set(obj)
  ctx.sleep(ms) / ctx.util:{formatBytes,ratioText,sanitizeFilename}
返回值会被工具栏消费：{toast, text, html, dataUrl, filename, title, overlay:{boxes,text}, copyText, download, isError}
`;

const BUILTIN_SCRIPTS = [
    {
        id: 'send-comfy',
        name: '发送到 ComfyUI',
        label: '发到 ComfyUI',
        icon: '🧩',
        media: ['image', 'video'],
        enabled: true,
        builtin: true,
        entry: 'body',
        hint: '内置示例①：用 ctx.comfySend 把图片/当前帧上传到 ComfyUI 并填入节点',
        code: `// 内置示例①：发送到 ComfyUI（不自动排队）
// 视频会自动取当前帧，图片直链由后台带 Referer 抓取，防盗链站点也能拿到原图。
const r = await ctx.comfySend({
  dataUrl: ctx.dataUrl,      // 视频帧已是 dataUrl；纯图片时为空，后台按 ctx.media.src 取
  imgSrc: ctx.dataUrl ? null : ctx.media.src,
  filename: ctx.util.sanitizeFilename((ctx.media.kind === 'video' ? 'frame_' : 'web_') + Date.now() + '.' + (ctx.dataUrl ? 'png' : 'jpg')),
  autoQueue: false,
});
if (!r.ok) return { toast: '发送失败: ' + r.error, isError: true };
return { toast: ctx.params.autoQueue ? '已发送并排队' : '已发送到 ComfyUI' };`,
        params: { autoQueue: false },
    },
    {
        id: 'send-comfy-run',
        name: '发送并立即执行',
        label: '发送并执行',
        icon: '▶',
        media: ['image', 'video'],
        enabled: true,
        builtin: true,
        entry: 'body',
        hint: '内置示例②：同上，但 autoQueue=true 会触发 Queue Prompt',
        code: `// 内置示例②：发送并立即排队执行（autoQueue）
// filename 一定要传，而且要每张都不同：ComfyUI 收到同名文件会覆盖掉上一张，批量执行就只剩最后一张。
const r = await ctx.comfySend({
  dataUrl: ctx.dataUrl,
  imgSrc: ctx.dataUrl ? null : ctx.media.src,
  filename: ctx.util.sanitizeFilename((ctx.media.kind === 'video' ? 'frame_' : 'web_') + Date.now() + '.' + (ctx.dataUrl ? 'png' : 'jpg')),
  autoQueue: true,
});
return r.ok ? { toast: '已发送并排队执行' } : { toast: '执行失败: ' + r.error, isError: true };`,
        params: { autoQueue: true },
    },
    {
        id: 'demo-ocr-clipboard',
        name: '示例：AI 读字并复制',
        label: '读字并复制',
        icon: '🔤',
        media: ['image', 'video'],
        enabled: false,
        builtin: true,
        entry: 'body',
        hint: '演示 ctx.ai + ctx.copyText 的组合',
        code: `// 内置示例③：组合多个能力 —— AI 读字后复制纯文本
const r = await ctx.ai('ocr', {});
if (r.blocked) return { toast: '需要先下载模型：' + r.blocked.reason, isError: true };
if (!r.text || r.text.includes('无文字')) return { toast: '没读到文字' };
await ctx.copyText(r.text);
return { toast: '已复制 ' + r.text.length + ' 字', text: r.text };`,
        params: {},
    },
    {
        id: 'demo-chain',
        name: '示例：去黑边+放大+锐化',
        label: '去黑边放大',
        icon: '🪄',
        media: ['image', 'video'],
        enabled: false,
        builtin: true,
        entry: 'body',
        hint: '演示 ctx.host 的算子链（步骤可在设置里改参数）',
        code: `// 内置示例④：算子链组合
const out = await ctx.host({
  chain: [
    { op: 'trim', params: { mode: 'auto', tolerance: 16 } },
    { op: 'resize', params: { filter: 'lanczos3', mode: 'percent', percent: ctx.params.scale || 200 } },
    { op: 'unsharp', params: { radius: 1.6, amount: 100, threshold: 2 } },
  ],
});
return { dataUrl: out.dataUrl, title: '去黑边放大', toast: out.width + '×' + out.height };`,
        params: { scale: 200 },
    },
];

const BUILTIN_LINKS = [
    {
        id: 'demo-google-lens',
        name: '示例：以图搜图',
        label: '搜图',
        icon: '🔎',
        media: ['image'],
        enabled: false,
        builtin: true,
        template: 'https://lens.google.com/uploadbyurl?url={src}',
        method: 'GET',
        openTab: true,
        hint: '配置式示例：URL 模板 + 占位符，不写代码',
    },
];

function ensureBuiltins(settings) {
    settings.customScripts = settings.customScripts || [];
    settings.linkTools = settings.linkTools || [];
    const have = new Set(settings.customScripts.map((s) => s.id));
    for (const b of BUILTIN_SCRIPTS) if (!have.has(b.id)) settings.customScripts.push(structuredCloneSafe(b));
    const haveLink = new Set(settings.linkTools.map((l) => l.id));
    for (const b of BUILTIN_LINKS) if (!haveLink.has(b.id)) settings.linkTools.push(structuredCloneSafe(b));
    return settings;
}

function structuredCloneSafe(v) {
    try { return structuredClone(v); } catch (e) { return JSON.parse(JSON.stringify(v)); }
}

return { "CONTEXT_API_DOC": (typeof CONTEXT_API_DOC === 'undefined' ? undefined : CONTEXT_API_DOC), "BUILTIN_SCRIPTS": (typeof BUILTIN_SCRIPTS === 'undefined' ? undefined : BUILTIN_SCRIPTS), "BUILTIN_LINKS": (typeof BUILTIN_LINKS === 'undefined' ? undefined : BUILTIN_LINKS), "ensureBuiltins": (typeof ensureBuiltins === 'undefined' ? undefined : ensureBuiltins) };
})();
__M["src/content/weibo-filter.mjs"] = (function(){
// 微博信息流筛选：不满足条件的微博整条 display:none。
//
// 已知限制（2026-10-21 真页面踩过）：帖子是绝对定位的虚拟列表
//   article.woo-panel-main → div.wbpro-scroller-item → div.vue-recycle-scroller__item-view（transform: translateY(…px)）
// 槽位坐标由 scroller 自己按累计高度算，只藏 article 会在原位置留一段空白（页面底色，看起来像"一块黑"）。
// 试过「连槽隐藏 + 把后面的槽上移」：scroller 会不停用原始 translateY 覆盖回来，滚动时整页闪、甚至堆到顶部全黑，
// 属于和虚拟列表的内部状态对打，已回退。所以现在只藏 article，空白保留 —— 稳定优先。

const { matchWeiboFilter, normalizeWeiboFilter, describeWeiboFilter, filterAppliesTo } = __M["src/common/weibo-filter.js"];

const POST_SEL = 'article, .card-wrap';
const HIDDEN_ATTR = 'data-mtb-filtered';

function isWeiboHost(host = location.hostname) {
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

function mountWeiboFilter(settings) {
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

return { "isWeiboHost": (typeof isWeiboHost === 'undefined' ? undefined : isWeiboHost), "mountWeiboFilter": (typeof mountWeiboFilter === 'undefined' ? undefined : mountWeiboFilter) };
})();
__M["src/content/main.mjs"] = (function(){
// 内容脚本入口：设置同步、媒体探测、工具栏显隐、宿主连接、键盘与全屏处理。

const { makeProber } = __M["src/content/probe.js"];
const { ensureRoot, mountToolbar, Toolbar, ResultPanel, LogDock, Picker, drawBoxes, drawMask, toast, attachToActiveLayer } = __M["src/content/ui.mjs"];
const { Runner, copyText } = __M["src/content/runner.mjs"];
const { buildToolbar, migrateSettings, DEFAULT_SETTINGS } = __M["src/common/registry.js"];
const { ensureBuiltins } = __M["src/common/builtin-scripts.js"];
const { captureVideoFrame } = __M["src/content/frame.js"];
const { extAlive, friendlyError, DEAD_TEXT } = __M["src/common/ext-state.js"];
const { mountWeiboFilter } = __M["src/content/weibo-filter.mjs"];

const STATE = {
    settings: null,
    media: null,
    lastMouse: { x: 0, y: 0 },
    hostOk: false,
    hostTried: 0,
    temp: null,
    picker: null,
    pickActive: false,
    gearItem: null,
};

let prober = null;
let toolbar = null;
let panel = null;
let logDock = null;
let runner = null;
let boxLayer = null;
let maskLayer = null;
let shadow = null;
let weiboFilter = null;

// 扩展在 edge://extensions 里重载（或更新）之后，页面里这份内容脚本就成了僵尸：它的 runtime 端口
// 随旧扩展一起销毁，之后任何 sendMessage 都会同步抛 "Extension context invalidated"。
// 齿轮、拖工具栏这类一次性点击最容易撞到，不能把天书甩成未捕获异常 —— 统一换成「刷新页面」指令。
function deadToast() {
    if (shadow) toast(shadow, DEAD_TEXT, 5000, true);
}

async function bgSend(req) {
    if (!extAlive()) { deadToast(); return { ok: false, dead: true, error: DEAD_TEXT }; }
    try {
        const res = await new Promise((resolve) => {
            chrome.runtime.sendMessage(req, (r) => {
                const err = chrome.runtime.lastError;
                resolve(err ? { ok: false, error: err.message } : r);
            });
        });
        return res;
    } catch (e) {
        const f = friendlyError(e);
        if (f.dead) deadToast();
        return { ok: false, error: f.text, dead: f.dead };
    }
}

chrome.runtime.sendMessage({ action: 'getState' }, (res) => {
    if (chrome.runtime.lastError) { return; }
    const s = migrateSettings(res?.settings || DEFAULT_SETTINGS);
    ensureBuiltins(s);
    STATE.settings = s;
    if (isComfyPage(s)) return;
    if ((s.sites.disabled || []).includes(location.hostname)) return;
    boot(s);
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.mtbSettings) return;
    const s = migrateSettings(changes.mtbSettings.newValue || DEFAULT_SETTINGS);
    ensureBuiltins(s);
    STATE.settings = s;
    if (toolbar) toolbar.applySettings(s);
    if (runner) runner.ctx.settings = s;
    if (weiboFilter) weiboFilter.apply(s);
    if (prober) {
        prober.opts.minImgSize = s.toolbar.minImgSize;
        prober.opts.skipThumbnails = s.toolbar.skipThumbnails !== false;
    }
    refresh(true);
});

// ComfyUI 自己的页面不注入工具栏，否则会干扰画布拖拽。
// 只按"配置里的服务器 host+port"精确判定，不再把整个 127.0.0.1/localhost 一概论处
// （本地开发站、局域网预览页在 127.0.0.1 上很常见）。
function isComfyPage(s) {
    const host = location.hostname;
    if (!host) return false;
    let serverHost = '127.0.0.1', serverPort = '8188';
    try {
        const u = new URL(s.comfy.server || 'http://127.0.0.1:8188');
        serverHost = u.hostname;
        serverPort = u.port || (u.protocol === 'https:' ? '443' : '80');
    } catch (e) { /* 配置非法时用默认值 */ }
    if (host === serverHost && location.port === serverPort) return true;
    // ComfyUI 默认端口在本机上一律视为其界面（用户没改地址的情况）
    if ((host === '127.0.0.1' || host === 'localhost') && (location.port === '8188' || location.port === '8189')) return true;
    return false;
}

async function boot(s) {
    const rootInfo = ensureRoot();
    shadow = rootInfo.shadow;
    const mounted = mountToolbar({ shadow, settings: s });
    const { wrap } = mounted;
    maskLayer = mounted.mask;
    boxLayer = mounted.box;

    panel = new ResultPanel({ shadow, settings: s });
    logDock = new LogDock({ shadow });
    STATE.picker = new Picker({ shadow, settings: s });
    toolbar = new Toolbar({ wrap, settings: s, onDragEnd: persistToolbarOffsets });
    toolbar.onLog = (text) => logDock.status(text);
    toolbar.onOpenSettings = () => { bgSend({ action: 'openOptions' }); };
    toolbar.itemBuilder = (s, mediaType) => buildToolbar(s, mediaType || 'image');

    runner = new Runner({
        settings: s,
        media: null,
        toolbar, panel, shadow,
        maskLayer, boxLayer,
        setStatus: (text) => { logDock.status(text); if (!text) toolbar.resetBusy(); },
        ensureHost: ensureHost,
        hostSend: (req) => new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage(req, (res) => {
                    if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
                    else resolve(res);
                });
            } catch (e) { resolve({ ok: false, error: e.message }); }
        }),
        runToolById: (id, over) => { const it = toolbar.items.find((x) => x.id === id) || { id, label: id, action: { type: 'comfy', autoQueue: /run/.test(id) } }; runner.dispatch(it); },
        patchSettings: async (patch) => {
            const res = await bgSend({ action: 'patchSettings', patch });
            // storage.onChanged 会把新设置推回来，这里只兜住失败
            if (res && res.ok === false) console.warn('[mtb] 写设置失败', res.error);
            return res;
        },
        replaceTemp: (spec) => { STATE.temp = spec; },
        startPick: (text, onPoint, onDone) => {
            STATE.pickActive = true;
            STATE.picker.setRect(toolbar.currentTarget);
            STATE.picker.start(text, onPoint, () => { STATE.pickActive = false; onDone?.(); });
        },
        stopPick: () => { STATE.picker.stop(); STATE.pickActive = false; },
        pickActive: () => STATE.pickActive,
        refreshProbe: repositionToolbar,
        lastFaces: [], lastMasks: [],
    });

    toolbar.onClick = (item, btn, e) => runner.dispatch(item, btn, e);
    toolbar.onMoved = () => positionLayers();

    prober = makeProber({ minImgSize: s.toolbar.minImgSize, skipThumbnails: s.toolbar.skipThumbnails !== false });
    weiboFilter = mountWeiboFilter(s);

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mousemove', onMove, { passive: true });
    // 滚动事件不从元素冒泡：不加 capture 就收不到微博/x.com 那种内层容器的滚动
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', () => refresh(true));
    document.addEventListener('fullscreenchange', () => { attachToActiveLayer(rootInfo.host); refresh(true); });
    document.addEventListener('keydown', onKeyDown, true);

    setInterval(() => { if (!STATE.pickActive) refresh(false); }, 300);

    window.__mtb = { state: STATE, toolbar, runner, panel, logDock, refresh: () => refresh(true) };
    refresh(true);
}

function onOver(e) {
    STATE.lastMouse.x = e.clientX; STATE.lastMouse.y = e.clientY;
    if (toolbar?.dragging) return;
    const mode = STATE.settings.toolbar.showOn;
    if (mode === 'always') { refresh(true); return; }
    if (mode === 'hover-key') return;
    probeAndShow(e.clientX, e.clientY);
}

function onMove(e) {
    STATE.lastMouse.x = e.clientX; STATE.lastMouse.y = e.clientY;
    if (toolbar?.dragging || STATE.pickActive) return;
    if (STATE.settings.toolbar.showOn === 'hover-key') return;
    if (STATE.settings.toolbar.showOn === 'always') { repositionToolbar(); return; }
    if (!wrapVisible()) { probeAndShow(e.clientX, e.clientY); return; }
    if (e.target?.closest?.('#mtb-root')) return;
    refresh(false);
}

function onScroll() { repositionToolbar(); }

// 滚动/布局会让图片离开原来的屏幕位置：重新量一次矩形，工具栏按锚点跟着走
function repositionToolbar() {
    if (!STATE.media?.el) return;
    if (!STATE.media.el.isConnected) { refresh(true); return; }   // 查看器换掉图片节点了：立刻重探，别等 300ms 心跳
    const r = STATE.media.el.getBoundingClientRect();
    if (!r.width || !r.height) return;   // 虚拟列表把图片摘掉后矩形全 0，别把工具栏甩到左上角
    STATE.media.displayRect = r;
    toolbar.position(r);
    positionLayers();
}

function onKeyDown(e) {
    const mode = STATE.settings.toolbar.showOn;
    if (mode === 'hover-key' && (e.key === STATE.settings.toolbar.showKey || e.altKey)) {
        probeAndShow(STATE.lastMouse.x, STATE.lastMouse.y);
    }
    if (e.key === 'Escape' && STATE.pickActive) { STATE.picker.stop(); STATE.pickActive = false; }
    if (e.key === 'Escape' && panel?.visible) panel.hide();
}

function wrapVisible() { return toolbar?.wrap.classList.contains('show'); }

function probeAndShow(x, y) {
    const found = prober.findMediaAtPoint(x, y);
    if (!found) { if (STATE.settings.toolbar.showOn !== 'always' && !overToolbarChrome(x, y)) hideToolbar(); return; }
    STATE.media = { ...found, kind: found.kind };
    STATE.temp = null;
    showForMedia();
}

function refresh(force) {
    if (!prober || !STATE.settings) return;
    const found = prober.findMediaAtPoint(STATE.lastMouse.x, STATE.lastMouse.y);
    if (!found) {
        if (STATE.settings.toolbar.showOn !== 'always' && !overToolbarChrome(STATE.lastMouse.x, STATE.lastMouse.y)) hideToolbar();
        return;
    }
    const same = STATE.media && STATE.media.el === found.el && STATE.media.src === found.src;
    STATE.media = found;
    if (!same) clearOverlays();   // 换了一张图，别把上一张的人脸框/掩码跟到新元素上
    if (!same && !force) showForMedia();
    else toolbar.position(found.displayRect);
}

// 指针已经移到工具栏本身（含它展开的 ▾ 菜单、结果面板、取点提示）上时不能收栏：
// 宽工具栏配小图时，栏子会夹到视口右边、超出图片范围，用户伸手点右边的按钮
// 途中指针离开图片，栏子就会在手底下消失。
function overToolbarChrome(x, y) {
    if (!toolbar?.wrap?.classList.contains('show')) return false;
    const root = document.getElementById('mtb-root');
    const shadow = root && root.shadowRoot;
    const els = [toolbar.wrap, toolbar.menu];
    if (shadow) for (const sel of ['.panel.show', '.prompt.show', '.pickhint.show', '.logbox.show']) {
        const el = shadow.querySelector(sel);
        if (el) els.push(el);
    }
    for (const el of els) {
        if (!el) continue;
        if (el === toolbar.menu && !el.classList.contains('show')) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
    return false;
}

function showForMedia() {
    const m = STATE.media;
    if (!m) return hideToolbar();
    runner.ctx.media = m;
    const mediaType = m.kind === 'video' ? 'video' : 'image';
    const items = buildToolbar(STATE.settings, mediaType);
    if (!items.length) return hideToolbar();
    const sig = items.map((i) => i.id + (i.label || '') + (i.icon || '') + (i.collapsed ? 'v' : '-')).join('|') + '#' + STATE.settings.toolbar.theme + STATE.settings.toolbar.iconMode + STATE.settings.toolbar.layout + STATE.settings.toolbar.scale + STATE.settings.toolbar.maxTools;
    if (toolbar.signature !== sig) { toolbar.signature = sig; toolbar.render(items, mediaType); }
    toolbar.show(m.displayRect, true);   // 换到这张图：按它的矩形立刻落位（按钮多少变了也要重新对齐）
    positionLayers();
    attachToActiveLayer(document.getElementById('mtb-root'));
    if (STATE.temp) { /* 上一步结果作为当前源 */ }
}

function clearOverlays() {
    if (boxLayer) drawBoxes(boxLayer, [], null);
    if (maskLayer) drawMask(maskLayer, [], null);
    if (runner?.ctx) runner.ctx.facesKey = null;
}

function hideToolbar() {
    toolbar?.hide();
    if (runner) runner.ctx.media = null;
    if (boxLayer) { boxLayer.style.display = 'none'; }
    if (maskLayer) { maskLayer.innerHTML = ''; }
    STATE.media = null;
}

function positionLayers() {
    const rect = toolbar?.currentTarget;
    if (!rect) return;
    if (boxLayer && boxLayer.style.display !== 'none') drawBoxes(boxLayer, boxLayer.__boxes || [], rect);
    if (maskLayer && maskLayer.children.length) drawMask(maskLayer, maskLayer.__urls || [], rect);
}

async function persistToolbarOffsets(t) {
    const patch = { toolbar: { offsetX: Math.round(t.offsetX), offsetY: Math.round(t.offsetY), anchorOffset: 'custom', anchor: t.anchor, dragMoved: true } };
    const res = await bgSend({ action: 'patchSettings', patch });
    if (res && res.dead) return;
    toast(shadow, `位置已保存（相对${anchorName(t.anchor)} 偏移 ${Math.round(t.offsetX)},${Math.round(t.offsetY)}）`, 2200);
}

function anchorName(a) {
    return ({ 'top-left': '左上', 'top-right': '右上', 'bottom-left': '左下', 'bottom-right': '右下', center: '中心', 'top-edge': '上边', 'bottom-edge': '下边', 'left-edge': '左边', 'right-edge': '右边' })[a] || a;
}

// 宿主：offscreen 或后台标签，由后台维持；这里只负责确认可用
async function ensureHost() {
    if (STATE.hostOk) return true;
    if (STATE.hostTried && Date.now() - STATE.hostTried < 4000) throw new Error('AI 宿主仍在启动中，请 3 秒后再试');
    STATE.hostTried = Date.now();
    const r = await bgSend({ action: 'ensureHost' });
    if (r && r.dead) throw new Error(DEAD_TEXT);
    if (!r || !r.ok) throw new Error('无法启动 AI 宿主：' + (r?.error || '未知错误'));
    STATE.hostOk = true;
    return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.action === 'mtbContentCall') {
        const res = handleContentCall(msg);
        sendResponse(res);
        return false;
    }
    if (msg?.action === 'mtbPreviewSettings') {
        STATE.settings = migrateSettings(msg.settings);
        ensureBuiltins(STATE.settings);
        if (toolbar) toolbar.applySettings(STATE.settings);
        refresh(true);
        sendResponse?.({ ok: true });
        return false;
    }
    if (msg?.action === 'mtbHostEvent' && msg.target === 'ext') return false;   // 发给扩展页的那份，内容脚本别接
    if (msg?.action === 'mtbHostEvent' && msg.type === 'modelProgress') {
        const line = msg.text || `${msg.loaded || 0}/${msg.total || 0}`;
        // 模型下载进度：控制台 + 设置页 + 右侧日志窗，不碰工具栏
        console.log('[mtb] 模型下载', msg.warmFor || msg.kind || '', line);
        logDock.status(`下载 ${msg.warmFor || msg.kind || '模型'} ${line}`);
        return false;
    }
    if (msg?.action === 'mtbHostEvent' && msg.type === 'aiProgress') {
        logDock.status(msg.text || '');
        return false;
    }
    if (msg?.action === 'mtbHostEvent' && msg.type === 'toolUi') {
        const p = msg.payload || {};
        if (p.action === 'openTab') bgSend({ action: 'openTab', url: p.url });
        if (p.action === 'toast') toast(shadow, p.text, 2600, p.isError);
        if (p.action === 'panel' && p.spec) panel?.show({
            title: p.spec.title, dataUrl: p.spec.dataUrl || null, text: p.spec.text || null,
            html: p.spec.html || '', near: toolbar?.currentTarget,
        });
        return false;
    }
});

function handleContentCall(msg) {
    try {
        if (msg.fn === 'hoverProbe') { probeAndShow(msg.x, msg.y); return { ok: true, media: !!STATE.media }; }
        if (msg.fn === 'captureFrame') {
            return captureVideoFrame(STATE.media?.el, { trim: STATE.settings.video.trimLetterbox, format: 'png' })
                .then((f) => ({ ok: true, dataUrl: f.dataUrl, width: f.width, height: f.height, via: f.method }));
        }
        if (msg.fn === 'currentMedia') return { ok: true, media: STATE.media ? { kind: STATE.media.kind, src: STATE.media.src || STATE.media.el.currentSrc || STATE.media.el.src, width: STATE.media.el.naturalWidth || STATE.media.el.videoWidth, height: STATE.media.el.naturalHeight || STATE.media.el.videoHeight } : null };
        if (msg.fn === 'runTool') { const it = toolbar.items.find((x) => x.id === msg.id); if (it) runner.dispatch(it); return { ok: !!it }; }
        return { ok: false, error: '未知内容调用: ' + msg.fn };
    } catch (e) {
        return { ok: false, error: String(e.message || e) };
    }
}

return {};
})();
void __M["src/content/main.mjs"];
})();