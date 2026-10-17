// 媒体命中检测：从旧实现迁移，保留全部踩坑结论（遮挡剔除、shadow DOM、
// pointer-events:none 的轮播分页、background-image 衬底、模糊副本优先取清晰原图）。

export function makeProber({ minImgSize = 200, wrapSelector = '#mtb-root' } = {}) {
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

export function frameOffsetInTop() {
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
