// 媒体命中检测：从旧实现迁移，保留全部踩坑结论（遮挡剔除、shadow DOM、
// pointer-events:none 的轮播分页、background-image 衬底、模糊副本优先取清晰原图）。

export function makeProber({ minImgSize = 200, wrapSelector = '#mtb-root' } = {}) {
    const opts = { minImgSize };

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
        if (el.tagName === 'VIDEO') return true;
        if (el.tagName === 'IMG' && (el.currentSrc || el.src)) return true;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
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

    function bgImageOf(el) {
        const bgi = getComputedStyle(el).backgroundImage;
        if (!bgi || bgi === 'none') return null;
        let m = bgi.match(/url\(["']?(https?:[^"')]+)["']?\)/);
        if (m) return m[1];
        // SVG data URI 背景里也可能藏着 raster data URL
        m = bgi.match(/url\(["']?(data:image\/[a-z+]+;base64,[^"')]+)["']?\)/i);
        return m ? m[1] : null;
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
            if (rect.width < opts.minImgSize || rect.height < opts.minImgSize) return;
            const src = media.currentSrc || media.src || media.getAttribute('src') || '';
            if (media.tagName === 'IMG' && !src) return;
            seen.add(media);
            candidates.push({
                el: media, srcOverride: null, stackIdx, hostEl,
                kind: media.tagName === 'VIDEO' ? 2 : 0,
                blurred: isBlurred(media),
                dataSrc: media.tagName === 'IMG' && src.startsWith('data:'),
                area: rect.width * rect.height,
                natural: { width: media.naturalWidth || media.videoWidth || 0, height: media.naturalHeight || media.videoHeight || 0 },
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
                if (rect.width >= opts.minImgSize && rect.height >= opts.minImgSize && isElementVisible(el)) {
                    const url = bgImageOf(el);
                    if (url) {
                        candidates.push({
                            el, srcOverride: url, stackIdx, hostEl, kind: 1,
                            blurred: isBlurred(el), dataSrc: false,
                            area: rect.width * rect.height,
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
                if (occluderFlags[j] && !(stack[j].contains && stack[j].contains(ref))) return false;
            }
            return true;
        });
        if (!visible.length) return null;

        for (const c of visible) if (c.kind === undefined) c.kind = 0;
        visible.sort((a, b) => (a.blurred - b.blurred) || (a.dataSrc - b.dataSrc) || (a.kind - b.kind)
            || (a.stackIdx - b.stackIdx) || (b.area - a.area));
        const best = visibleCandidatesPick(visible);
        return {
            el: best.el,
            src: best.srcOverride,
            kind: best.kind === 2 ? 'video' : (best.srcOverride ? 'bg' : 'image'),
            natural: best.natural,
            displayRect: best.el.getBoundingClientRect(),
        };
    }

    // 同分时偏向"真正在显示的那张"：视频 > 真实 <img> > 背景图容器
    function visibleCandidatesPick(list) {
        return list[0];
    }

    return { findMediaAtPoint, isElementVisible, isOpaqueOccluder, isBlurred, opts };
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
