(function() {
    // 检测当前页面是否是 ComfyUI，如果是则完全不激活此 content script 的悬浮按钮逻辑，
    // 避免干扰 ComfyUI 内部画布的拖拽行为（如手动拖拽图片到 LoadImage 节点）
    chrome.storage.local.get(['comfyConfig'], (data) => {
        let isComfyUIPage = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";

        if (data.comfyConfig) {
            // 检查当前网站是否被用户禁用
            if (data.comfyConfig.disabledHosts && data.comfyConfig.disabledHosts.includes(window.location.hostname)) {
                return; // 被禁用，不注入按钮
            }

            if (data.comfyConfig.serverAddress) {
                try {
                    // 判断当前页面是否通过配置的远程地址打开
                    const url = new URL(data.comfyConfig.serverAddress);
                    if (window.location.hostname === url.hostname && window.location.port === url.port) {
                        isComfyUIPage = true;
                    }
                } catch(e) {}
            }
        }

        if (isComfyUIPage) {
            return; // 在 ComfyUI 页面直接退出，不注入按钮
        }
        initExtensionButton(data.comfyConfig || {});
    });

    function initExtensionButton(config) {
        let btnPosition = config.buttonPosition || 'top-right';
        let offsetX = parseInt(config.offsetX) || 0;
        let offsetY = parseInt(config.offsetY) || 0;
        let minImgSize = config.minImgSize !== undefined ? parseInt(config.minImgSize) : 200;
        let alwaysShow = config.alwaysShow || false;

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.comfyConfig) {
                btnPosition = changes.comfyConfig.newValue?.buttonPosition || 'top-right';
                offsetX = parseInt(changes.comfyConfig.newValue?.offsetX) || 0;
                offsetY = parseInt(changes.comfyConfig.newValue?.offsetY) || 0;
                minImgSize = changes.comfyConfig.newValue?.minImgSize !== undefined ? parseInt(changes.comfyConfig.newValue?.minImgSize) : 200;
                alwaysShow = changes.comfyConfig.newValue?.alwaysShow || false;
                updateBtnPosition();
            }
        });

        const wrap = document.createElement('div');
        wrap.id = 'comfyui-extension-wrap';

        const btn = document.createElement('button');
        btn.className = 'comfyui-extension-btn';
        btn.innerHTML = '发送到 ComfyUI';
        btn.title = '将图片/视频画面发送到 ComfyUI';

        const playBtn = document.createElement('button');
        playBtn.className = 'comfyui-extension-btn';
        playBtn.innerHTML = '▶';
        playBtn.title = '发送图片并立即执行工作流 (Queue Prompt)';
        playBtn.style.padding = '4px 8px';

        wrap.appendChild(btn);
        wrap.appendChild(playBtn);
        document.body.appendChild(wrap);

        // 探测结果（始终反映"鼠标位置下当前可见的媒体"，不做跨时机缓存——
        // 轮播切图不会触发 mouseover，任何缓存到点击时刻都可能是过期的第一张）
        let currentImg = null;
        // 当媒体是以 background-image 形式展示时，其图片地址存放在这里（此时 currentImg 上没有 src）
        let currentSrcOverride = null;
        const lastMouse = { x: 0, y: 0 };
        let originalTitle = btn.innerHTML;

        // 更新按钮位置使其贴附在图片右上角
        function updateBtnPosition() {
            if (!currentImg) return;
            const rect = currentImg.getBoundingClientRect();

            // 忽略太细小的图标或底图，防止干扰（可通过配置的 minImgSize 过滤掉九宫格等未放大的缩略图）
            if (rect.width < minImgSize || rect.height < minImgSize) {
                wrap.style.display = 'none';
                return;
            }

            // 全屏元素是铺满视口的 position:fixed 容器（也是 wrap 现在的包含块），
            // 其内绝对定位直接使用视口坐标，不能再叠加页面滚动量
            const inFullscreen = !!(document.fullscreenElement && document.fullscreenElement.contains(wrap));
            const scrollY = inFullscreen ? 0 : window.scrollY;
            const scrollX = inFullscreen ? 0 : window.scrollX;

            if (btnPosition === 'top-left') {
                wrap.style.top = (scrollY + rect.top + 10 + offsetY) + 'px';
                wrap.style.left = (scrollX + rect.left + 10 + offsetX) + 'px';
            } else if (btnPosition === 'bottom-right') {
                wrap.style.top = (scrollY + rect.bottom - wrap.offsetHeight - 10 + offsetY) + 'px';
                wrap.style.left = (scrollX + rect.right - wrap.offsetWidth - 10 + offsetX) + 'px';
            } else if (btnPosition === 'bottom-left') {
                wrap.style.top = (scrollY + rect.bottom - wrap.offsetHeight - 10 + offsetY) + 'px';
                wrap.style.left = (scrollX + rect.left + 10 + offsetX) + 'px';
            } else if (btnPosition === 'center') {
                wrap.style.top = (scrollY + rect.top + (rect.height - wrap.offsetHeight) / 2 + offsetY) + 'px';
                wrap.style.left = (scrollX + rect.left + (rect.width - wrap.offsetWidth) / 2 + offsetX) + 'px';
            } else {
                // 默认右上角
                wrap.style.top = (scrollY + rect.top + 10 + offsetY) + 'px';
                wrap.style.left = (scrollX + rect.right - wrap.offsetWidth - 10 + offsetX) + 'px';
            }
        }

        // 抖音等站点用 blur 滤镜的同图副本做全屏衬底，命中时必须避开，优先取清晰原图
        function isBlurred(el) {
            let node = el, hops = 0;
            while (node && hops < 5) {
                const f = getComputedStyle(node).filter;
                if (f && f.includes('blur')) return true;
                node = node.parentElement;
                hops++;
            }
            return false;
        }

        // 轮播图（如抖音图文）把各分页图片叠放在同一位置切换显隐，而 opacity:0 的元素
        // 依然可以被 elementsFromPoint 命中，必须按计算样式过滤掉不可见的，
        // 才能选到当前实际展示的那一张
        function isElementVisible(el) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            // 逐层祖先检查，覆盖用容器类名控制分页显隐的情况
            let node = el.parentElement;
            while (node && node !== document.body) {
                const s = getComputedStyle(node);
                if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
                node = node.parentElement;
            }
            return true;
        }

        // 判断元素是否为"不透明遮挡物"：信息流会把下一个视频/图文的封面预载在当前图层
        // 下方（位置重叠、计算样式上"可见"），必须结合绘制层级把它们剔除。
        // 渐变遮罩（可透出内容）与小图标不算遮挡
        function isOpaqueOccluder(el) {
            if (!el || !el.getBoundingClientRect) return false;
            const rect = el.getBoundingClientRect();
            if (rect.width < minImgSize || rect.height < minImgSize) return false;
            if (el.tagName === 'VIDEO') return true;
            if (el.tagName === 'IMG' && (el.currentSrc || el.src)) return true;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
            const bgc = cs.backgroundColor;
            if (bgc && bgc !== 'transparent') {
                const m = bgc.match(/rgba?\(([^)]+)\)/);
                if (m) {
                    const parts = m[1].split(/[\s,/]+/).filter(s => s !== '').map(parseFloat);
                    const alpha = parts.length >= 4 ? parts[3] : 1;
                    if (alpha >= 0.9) return true;
                } else {
                    return true;
                }
            }
            const bgi = cs.backgroundImage;
            if (bgi && bgi !== 'none' && !bgi.includes('gradient')) return true;
            return false;
        }

        // 抖音等站点会在 <img>/<video> 上方覆盖透明的交互层（播放器控制层、图文滑动切换层等），
        // 鼠标事件的 target 是覆盖层而不是媒体元素本身，因此用 elementsFromPoint 穿透元素栈查找。
        // 更关键的是：抖音图文的分页大图本身带 pointer-events:none（手势交给上层容器），
        // 根本不会出现在 elementsFromPoint 结果里——已实测确认，必须对栈内容器做后代扫描才能找到，
        // 且要从模糊衬底图（filter:blur 的同图副本）和 data:URI 覆盖图标中选出真正展示的那张。
        // 通用化补充：文档级命中测试遇到 open shadow root 只能拿到 host 元素，媒体藏在 shadow tree
        // 里（不少自研/组件化播放器如此），需要递归进入 shadowRoot.elementsFromPoint 继续探测
        function findMediaAtPoint(x, y) {
            const stack = document.elementsFromPoint(x, y);
            const candidates = [];
            const seen = new Set();

            // hostEl：媒体所在的 open shadow root 的文档侧 host（媒体直接在文档树里时为 null）。
            // shadow 内元素不在文档树中，遮挡判定的 contains 检查必须落到 host 上
            const consider = (media, stackIdx, hostEl) => {
                if (!media || seen.has(media)) return;
                if (!(media.tagName === 'IMG' || media.tagName === 'VIDEO')) return;
                if (!isElementVisible(media)) return;
                const rect = media.getBoundingClientRect();
                // 只认与探测点实际交叠的媒体（轮播平移出视口的分页、相邻图被排除）
                if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
                if (rect.width < minImgSize || rect.height < minImgSize) return;
                const src = media.currentSrc || media.src || '';
                // 尚未加载内容的占位 img 没有可下载的地址
                if (media.tagName === 'IMG' && !src) return;
                seen.add(media);
                candidates.push({
                    el: media,
                    srcOverride: null,
                    stackIdx,
                    hostEl,
                    blurred: isBlurred(media),
                    dataSrc: media.tagName === 'IMG' && src.startsWith('data:'),
                    area: rect.width * rect.height,
                });
            };

            // 处理命中栈里的单个元素：直接命中的媒体（pointer-events 正常）、
            // 容器后代扫描（pointer-events:none 的媒体不在命中栈里，但容器在）、
            // 以及 background-image 展示的图片容器
            const processHitEl = (el, stackIdx, hostEl) => {
                if (!el || !el.closest) return;
                if (!hostEl && el.closest('#comfyui-extension-wrap')) return;

                const direct = el.closest('img, video');
                if (direct) consider(direct, stackIdx, hostEl);

                if (el.querySelectorAll) {
                    for (const m of el.querySelectorAll('img, video')) consider(m, stackIdx, hostEl);
                }

                // 部分站点用 background-image 展示图片，没有 <img> 可悬浮，
                // 只有足够大且可见的背景图才认定为内容图片（避免隐藏分页/小图标层抢先命中）
                if (el instanceof HTMLElement) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width >= minImgSize && rect.height >= minImgSize && isElementVisible(el)) {
                        const bg = getComputedStyle(el).backgroundImage;
                        if (bg && bg !== 'none') {
                            const m = bg.match(/url\(["']?(https?:[^"')]+)["']?\)/);
                            if (m) {
                                candidates.push({
                                    el: el,
                                    srcOverride: m[1],
                                    stackIdx,
                                    hostEl,
                                    blurred: isBlurred(el),
                                    dataSrc: false,
                                    kind: 1,
                                    area: rect.width * rect.height,
                                });
                            }
                        }
                    }
                }
            };

            // 递归探测 open shadow root（closed root 无法访问，只能放弃）。
            // shadow 内容绘制在 host 的渲染层之上，栈序直接继承 host 的索引：
            // 文档栈中压在 host 之上的不透明元素同样压住 shadow 内的媒体
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

            if (candidates.length === 0) return null;

            // 剔除被上层不透明内容压住的候选：绘制在候选之上（栈序更靠前）、
            // 与探测点重叠、且不是候选自身（或其 shadow host）祖先的不透明元素都算遮挡
            const maxIdx = Math.max(...candidates.map(c => c.stackIdx));
            const occluderFlags = [];
            for (let j = 0; j < maxIdx; j++) {
                occluderFlags[j] = isOpaqueOccluder(stack[j]);
            }
            const visibleCandidates = candidates.filter(c => {
                const occlRef = c.hostEl || c.el;
                for (let j = 0; j < c.stackIdx; j++) {
                    if (occluderFlags[j] && !(stack[j].contains && stack[j].contains(occlRef))) return false;
                }
                return true;
            });
            if (visibleCandidates.length === 0) return null;

            // 排序：非模糊衬底 > 真实图片URL（data:URI 通常是覆盖图标）> 真实媒体优先于背景图容器
            // > 栈序靠前（绘制在上层，即用户看到的那张）> 面积大者优先
            for (const c of visibleCandidates) if (c.kind === undefined) c.kind = 0;
            visibleCandidates.sort((a, b) =>
                (a.blurred - b.blurred) ||
                (a.dataSrc - b.dataSrc) ||
                (a.kind - b.kind) ||
                (a.stackIdx - b.stackIdx) ||
                (b.area - a.area));
            const best = visibleCandidates[0];
            return { el: best.el, src: best.srcOverride };
        }

        // 按给定坐标重新探测并写回 currentImg，返回探测到的媒体元素（没有则 null）。
        // 这是唯一为 currentImg 赋值的入口
        function probeAt(x, y) {
            const found = findMediaAtPoint(x, y);
            if (found) {
                currentImg = found.el;
                currentSrcOverride = found.src;
                return found.el;
            }
            return null;
        }

        function showWrap() {
            wrap.style.display = 'flex';
            btn.innerHTML = originalTitle;
            btn.disabled = false;
            playBtn.disabled = false;
            updateBtnPosition();
        }

        function hideWrap() {
            wrap.style.display = 'none';
            currentImg = null;
            currentSrcOverride = null;
        }

        document.addEventListener('mouseover', (e) => {
            lastMouse.x = e.clientX;
            lastMouse.y = e.clientY;
            if (probeAt(e.clientX, e.clientY)) showWrap();
        });

        // 鼠标每动一次就按当前位置重新探测：悬浮目标始终跟随"此刻鼠标下可见的媒体"，
        // 轮播切图后移回图内会立刻指向新分页；移出媒体区域则隐藏。
        // 不能用 e.target !== currentImg 判断（媒体上方常有覆盖层，target 永远不是媒体元素）
        document.addEventListener('mousemove', (e) => {
            lastMouse.x = e.clientX;
            lastMouse.y = e.clientY;
            if (wrap.style.display !== 'flex' || alwaysShow) return;
            if (wrap.contains(e.target)) return;
            if (probeAt(e.clientX, e.clientY)) {
                updateBtnPosition();
            } else {
                hideWrap();
            }
        });

        // 兜底：轮播自动播放/切页动画结束等不产生鼠标事件的切换，
        // 按最后鼠标位置周期性重新探测，保证点击发送时目标不会停留在旧分页。
        // 探测失败时不隐藏（那是 mousemove 的职责），只保持现状
        setInterval(() => {
            if (wrap.style.display !== 'flex') return;
            if (probeAt(lastMouse.x, lastMouse.y)) updateBtnPosition();
        }, 300);

        // 保持滚动和改变大小时按钮跟随
        window.addEventListener('scroll', updateBtnPosition);
        window.addEventListener('resize', updateBtnPosition);

        // 全屏时只有全屏元素的子树会被渲染，按钮挂在 body 上不可见，必须迁入全屏元素；
        // 退出时迁回 body。注意 video/img 等替换元素全屏时其子节点不渲染，无解，只能不显示
        function attachWrapToActiveLayer() {
            const fs = document.fullscreenElement;
            const target = (fs && !['VIDEO', 'AUDIO', 'CANVAS', 'IMG', 'PICTURE'].includes(fs.tagName)) ? fs : document.body;
            if (wrap.parentNode !== target) target.appendChild(wrap);
            updateBtnPosition();
        }
        document.addEventListener('fullscreenchange', attachWrapToActiveLayer);

        // 计算当前 frame 视口相对顶层页面视口的偏移（截图降级取帧用）。
        // frameElement 只有在父子同源时可访问，跨源 iframe 链会拿到 null —— 此时无法定位，只能报错
        function frameOffsetInTop() {
            let dx = 0, dy = 0;
            let w = window;
            try {
                while (w !== w.top) {
                    const fe = w.frameElement;
                    if (!fe) return null;
                    const r = fe.getBoundingClientRect();
                    dx += r.left;
                    dy += r.top;
                    w = w.parent;
                }
            } catch (e) {
                return null;
            }
            return { dx, dy, vw: w.innerWidth, vh: w.innerHeight };
        }

        // 将标签页截图按视频在页面中的位置裁剪出当前帧（截图以顶层视口为基准，物理像素需乘 devicePixelRatio）。
        // 视频在嵌套 iframe 中时 rect 是本 frame 视口坐标，必须叠加 frame 在顶层视口中的偏移。
        // 返回 canvas 交由调用方继续做黑边裁剪
        function cropScreenshot(dataUrl, rect) {
            const off = frameOffsetInTop();
            if (!off) {
                return Promise.reject(new Error('视频位于跨域 iframe 中且画面受跨域保护，无法通过截图取帧'));
            }
            const dpr = window.devicePixelRatio || 1;
            const left = Math.max(rect.left + off.dx, 0);
            const top = Math.max(rect.top + off.dy, 0);
            const right = Math.min(rect.right + off.dx, off.vw);
            const bottom = Math.min(rect.bottom + off.dy, off.vh);
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    const sw = Math.round((right - left) * dpr);
                    const sh = Math.round((bottom - top) * dpr);
                    if (sw <= 0 || sh <= 0) {
                        reject(new Error('视频不在可视区域内，无法截图取帧'));
                        return;
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = sw;
                    canvas.height = sh;
                    canvas.getContext('2d').drawImage(img, Math.round(left * dpr), Math.round(top * dpr), sw, sh, 0, 0, sw, sh);
                    resolve(canvas);
                };
                img.onerror = () => reject(new Error('标签页截图解析失败'));
                img.src = dataUrl;
            });
        }

        function bgSend(msg) {
            return new Promise((resolve) => {
                try {
                    chrome.runtime.sendMessage(msg, (res) => {
                        if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
                        else resolve(res);
                    });
                } catch (e) {
                    resolve({ success: false, error: e.message });
                }
            });
        }

        // 裁掉画面四周的纯黑边：源视频自带的上下/左右黑边，或截图路径里播放器容器的留边。
        // 黑边特征是接近纯黑（亮度阈值内），按行/列统计亮像素占比来判定，逐边推进到内容为止。
        // 带三重防误裁：单边最多裁 45%、裁后任一维度不足 30%（暗场景误判）或小于 32px 就放弃。
        // 用 480px 降采样副本做分析，1080p 帧也只有约 26 万像素的扫描量
        function trimLetterbox(canvas) {
            try {
                const W = canvas.width, H = canvas.height;
                if (W < 64 || H < 64) return canvas;
                const scale = Math.min(1, 480 / Math.max(W, H));
                const aw = Math.max(8, Math.round(W * scale));
                const ah = Math.max(8, Math.round(H * scale));
                const ac = document.createElement('canvas');
                ac.width = aw;
                ac.height = ah;
                const actx = ac.getContext('2d', { willReadFrequently: true });
                actx.drawImage(canvas, 0, 0, aw, ah);
                const d = actx.getImageData(0, 0, aw, ah).data;
                const BLACK = 30;              // 黑边允许的亮度上限（压缩噪点容忍）
                const CONTENT = 0.015;         // 一行/列中亮像素超过 1.5% 才算内容
                const rowContent = new Array(ah).fill(0);
                const colContent = new Array(aw).fill(0);
                for (let y = 0; y < ah; y++) {
                    const rowBase = y * aw * 4;
                    for (let x = 0; x < aw; x++) {
                        const i = rowBase + x * 4;
                        if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] > BLACK) {
                            rowContent[y]++;
                            colContent[x]++;
                        }
                    }
                }
                const isContentRow = (y) => rowContent[y] > aw * CONTENT;
                const isContentCol = (x) => colContent[x] > ah * CONTENT;
                const maxTrimY = Math.floor(ah * 0.45), maxTrimX = Math.floor(aw * 0.45);
                let top = 0, bottom = ah - 1, left = 0, right = aw - 1;
                while (top < maxTrimY && !isContentRow(top)) top++;
                while (bottom > ah - 1 - maxTrimY && !isContentRow(bottom)) bottom--;
                while (left < maxTrimX && !isContentCol(left)) left++;
                while (right > aw - 1 - maxTrimX && !isContentCol(right)) right--;
                const nx = Math.round(left / scale), ny = Math.round(top / scale);
                const nw = Math.round((right - left + 1) / scale);
                const nh = Math.round((bottom - top + 1) / scale);
                if (nw >= W && nh >= H) return canvas;
                if (nw < W * 0.3 || nh < H * 0.3 || nw < 32 || nh < 32) return canvas;
                const out = document.createElement('canvas');
                out.width = nw;
                out.height = nh;
                out.getContext('2d').drawImage(canvas, nx, ny, nw, nh, 0, 0, nw, nh);
                return out;
            } catch (e) {
                return canvas;
            }
        }

        // 直链跨域视频的干净取帧（微博等）：画布被污染时，请后台临时给该 URL 放行 CORS
        // 后在本 frame 内 fetch 视频字节，用同源 blob 重建 video 并 seek 到同一时刻画帧。
        // 产出的依然是无播放器 UI 的干净帧，且不受 iframe 跨源截图坐标的限制。
        // blob 按 src 缓存（上限 3 个），重复发送同一视频时不再重新下载；
        // 进行中的下载也放入缓存，连点/重试共享同一次下载而不是各拉一份
        const refetchCache = new Map();
        // 内部取帧的文件大小上限：大文件也要帧，但要有度（74MB 级短视频完全没问题）。
        // 用流式读取边下边查，超限立即中止连接，不会白下载整个文件
        const MEDIA_FETCH_CAP = 500 * 1024 * 1024;

        async function fetchMediaBlob(src, onProgress) {
            await bgSend({ action: 'allowDirectMediaFetch', url: src, pageUrl: location.href });
            try {
                let res;
                try {
                    // 必须 no-store：页面自己以 no-cors 方式（媒体元素）缓存过的响应不带 CORS 头，
                    // 默认缓存模式会让 fetch 复用该条目后过不了 CORS 检查（实测 ERR_FAILED）
                    res = await fetch(src, { credentials: 'include', cache: 'no-store' });
                } catch (e) {
                    // 带 cookie 的取回可能被服务端 CORS 策略拒绝（如响应 ACAO:*），退回不带凭证再试
                    res = await fetch(src, { credentials: 'omit', cache: 'no-store' });
                }
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const total = parseInt(res.headers.get('Content-Length') || '0', 10);
                if (total > MEDIA_FETCH_CAP) {
                    if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
                    throw new Error('视频文件过大（' + Math.round(total / 1048576) + 'MB），超出内部取帧上限');
                }
                let blob;
                if (res.body && res.body.getReader) {
                    const reader = res.body.getReader();
                    const chunks = [];
                    let received = 0;
                    let lastShown = '';
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                        received += value.length;
                        if (received > MEDIA_FETCH_CAP) {
                            reader.cancel().catch(() => {});
                            throw new Error('视频文件过大（超过 ' + Math.round(MEDIA_FETCH_CAP / 1048576) + 'MB），超出内部取帧上限');
                        }
                        if (onProgress) {
                            const text = total
                                ? '⏳ ' + Math.min(99, Math.round((received / total) * 100)) + '%'
                                : '⏳ ' + (received / 1048576).toFixed(1) + 'MB';
                            if (text !== lastShown) { lastShown = text; onProgress(text); }
                        }
                    }
                    blob = new Blob(chunks, { type: res.headers.get('Content-Type') || 'video/mp4' });
                } else {
                    blob = await res.blob();
                    if (blob.size > MEDIA_FETCH_CAP) throw new Error('视频文件过大，超出内部取帧上限');
                }
                return blob;
            } finally {
                bgSend({ action: 'removeDirectMediaFetch' });
            }
        }

        // 直链跨域视频的"免整包下载"取帧：请后台放行该 URL 的 CORS 后，
        // 用带 crossorigin 的克隆 video 直接指向原 URL 加载——CORS 模式的媒体不污染画布，
        // 且浏览器媒体栈按需拉取（moov 索引 + 目标时刻附近的字节区间），通常只传 MB 级数据。
        // use-credentials 配合后台注入的 ACAO=源 + ACAC:true，需要 cookie 的 CDN 也能过。
        // 克隆元素按 src 缓存（≤3），重复发送只做 seek 不再联网
        const corsCloneCache = new Map();

        async function captureViaCorsClone(video, src, onProgress) {
            await bgSend({ action: 'allowDirectMediaFetch', url: src, pageUrl: location.href });
            try {
                if (!corsCloneCache.has(src)) {
                    const p = (async () => {
                        const v2 = document.createElement('video');
                        v2.crossOrigin = 'use-credentials';
                        v2.muted = true;
                        v2.preload = 'metadata';
                        v2.src = src;
                        try {
                            await new Promise((resolve, reject) => {
                                const to = setTimeout(() => reject(new Error('CORS 克隆加载超时')), 15000);
                                v2.addEventListener('loadedmetadata', () => { clearTimeout(to); resolve(); }, { once: true });
                                v2.addEventListener('error', () => { clearTimeout(to); reject(new Error('CORS 克隆加载失败')); }, { once: true });
                            });
                            return v2;
                        } catch (e) {
                            corsCloneCache.delete(src);
                            v2.removeAttribute('src');
                            v2.load();
                            throw e;
                        }
                    })();
                    corsCloneCache.set(src, p);
                    if (corsCloneCache.size > 3) {
                        const oldestKey = corsCloneCache.keys().next().value;
                        if (oldestKey !== src) {
                            Promise.resolve(corsCloneCache.get(oldestKey))
                                .then((v) => { v.removeAttribute('src'); v.load(); }).catch(() => {});
                            corsCloneCache.delete(oldestKey);
                        }
                    }
                }
                const v2 = await corsCloneCache.get(src);
                if (onProgress) onProgress('⏳ 解码中');
                const t = video.currentTime || 0;
                const clamped = (isFinite(v2.duration) && v2.duration > 0) ? Math.max(0, Math.min(t, v2.duration - 0.05)) : t;
                await new Promise((resolve, reject) => {
                    const to = setTimeout(() => reject(new Error('CORS 克隆 seek 超时')), 15000);
                    v2.addEventListener('seeked', () => { clearTimeout(to); resolve(); }, { once: true });
                    v2.currentTime = clamped;
                });
                if (!v2.videoWidth || !v2.videoHeight) throw new Error('CORS 克隆画面未就绪');
                const canvas = document.createElement('canvas');
                canvas.width = v2.videoWidth;
                canvas.height = v2.videoHeight;
                canvas.getContext('2d').drawImage(v2, 0, 0, canvas.width, canvas.height);
                canvas.getContext('2d').getImageData(0, 0, 1, 1); // 污染检查（CORS 模式不应污染）
                return canvas;
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
                    const oldestKey = refetchCache.keys().next().value;
                    if (oldestKey !== src) {
                        Promise.resolve(refetchCache.get(oldestKey))
                            .then((en) => URL.revokeObjectURL(en.url)).catch(() => {});
                        refetchCache.delete(oldestKey);
                    }
                }
            }
            const entry = await refetchCache.get(src); // 拒绝时抛出原始错误（如文件过大）
            if (onProgress) onProgress('⏳ 解码中');
            const v2 = document.createElement('video');
            v2.muted = true;
            v2.playsInline = true;
            v2.preload = 'auto';
            v2.src = entry.url;
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
            const canvas = document.createElement('canvas');
            canvas.width = v2.videoWidth;
            canvas.height = v2.videoHeight;
            canvas.getContext('2d').drawImage(v2, 0, 0, canvas.width, canvas.height);
            canvas.getContext('2d').getImageData(0, 0, 1, 1); // 触发污染检查（正常不应污染）
            return canvas;
        }

        // 抓取视频当前帧，按优先级：
        // 1) 直接从 video 画布取帧——MSE 播放器（抖音等）、同源或带 CORS 的直链画布不被污染，
        //    拿到的是不带播放器 UI 的干净原图帧
        // 2) 直链跨域视频（微博等，画布被污染）——CORS 克隆取帧，浏览器按需拉取几乎不下载（见 captureViaCorsClone）
        // 3) CORS 克隆失败（如 CDN 拒绝带 Origin 的请求）——整包 fetch 字节重建后取帧（见 captureViaRefetch）
        // 4) 兜底：截取标签页画面按视频位置裁剪——会带上播放器 UI；
        //    跨源 iframe 中无法换算截图坐标时直接报错
        async function captureVideoFrame(video, onProgress) {
            if (!video.videoWidth || !video.videoHeight) {
                throw new Error('视频画面尚未加载，请稍候再试');
            }
            let canvas = null;
            try {
                canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                canvas.getContext('2d').getImageData(0, 0, 1, 1); // 读取即触发跨域污染检查
            } catch (err) {
                canvas = null;
            }
            if (!canvas) {
                const src = video.currentSrc || video.src || '';
                if (/^https?:/i.test(src)) {
                    try {
                        canvas = await captureViaCorsClone(video, src, onProgress);
                    } catch (e) {
                        console.debug('[ComfyUI Sender] 免下载取帧失败，尝试整包取帧:', e && e.message);
                    }
                    if (!canvas) {
                        try {
                            canvas = await captureViaRefetch(video, src, onProgress);
                        } catch (e) {
                            console.debug('[ComfyUI Sender] 内部取帧失败，降级为截图:', e && e.message);
                        }
                    }
                }
            }
            if (canvas) {
                return trimLetterbox(canvas).toDataURL('image/png');
            }
            wrap.style.visibility = 'hidden';
            let shot = null;
            try {
                const res = await bgSend({ action: 'captureVisibleTab' });
                shot = res && res.success ? res.dataUrl : null;
                if (!shot && res && res.error) {
                    // 连续点击会撞上 Chrome 的每秒截图配额，给出可操作的提示
                    if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(res.error)) {
                        throw new Error('截图接口限流（连续点击过快），请等 1 秒再试');
                    }
                    console.debug('[ComfyUI Sender] 截图失败:', res.error);
                }
            } finally {
                wrap.style.visibility = 'visible';
            }
            if (!shot) throw new Error('无法截取标签页画面（视频画布受跨域保护且截图失败）');
            const cropped = await cropScreenshot(shot, video.getBoundingClientRect());
            return trimLetterbox(cropped).toDataURL('image/png');
        }

        function handleSend(e, autoQueue) {
            e.preventDefault();
            e.stopPropagation();

            // 发送瞬间以"点击位置下实际可见的媒体"为准重新探测。
            // 轮播切图（点箭头/拖拽/自动播放）都不触发 mouseover，且旧分页元素可能被平移、
            // 重建或置为 opacity:0，任何此前缓存的 currentImg 都可能还是第一张
            if (!probeAt(e.clientX, e.clientY) && !currentImg) return;

            const media = currentImg;
            const isVideo = media.tagName === 'VIDEO';
            const imgSrc = isVideo ? null : (currentSrcOverride || media.currentSrc || media.src);
            const pageUrl = window.location.href;
            console.debug('[ComfyUI Sender] 发送目标:', isVideo ? '视频当前帧' : imgSrc);

            const targetBtn = autoQueue ? playBtn : btn;
            targetBtn.innerHTML = '⏳';
            btn.disabled = true;
            playBtn.disabled = true;

            const resetLater = () => {
                setTimeout(() => {
                    wrap.style.display = 'none';
                    btn.innerHTML = originalTitle;
                    playBtn.innerHTML = '▶';
                    currentImg = null;
                    currentSrcOverride = null;
                }, 2500);
            };

            const doSend = (payload) => {
                // 发送消息给后台任务
                try {
                    chrome.runtime.sendMessage(payload, (response) => {
                        if (chrome.runtime.lastError) {
                             targetBtn.innerHTML = '🔄';
                             alert("插件已更新或断开连接，请刷新当前网页后再试。\n" + chrome.runtime.lastError.message);
                             btn.disabled = false;
                             playBtn.disabled = false;
                             return;
                        }
                        if (response && response.success) {
                            targetBtn.innerHTML = '✅';
                        } else {
                            console.error("ComfyUI 插件错误:", response?.error);
                            targetBtn.innerHTML = '❌';
                            alert("发送失败: " + (response?.error || '未知错误'));
                        }
                        resetLater();
                    });
                } catch (err) {
                    if (err.message.includes("Extension context invalidated")) {
                         targetBtn.innerHTML = '🔄';
                         alert("插件底层已重新加载，请按 F5 刷新当前所在的图片网页以恢复按钮功能！");
                    } else {
                         targetBtn.innerHTML = '❌';
                         alert("错误: " + err.message);
                    }
                }
            };

            if (isVideo) {
                // 视频：先在页面里抓取当前帧，再把帧数据交给后台上传。
                // 大视频内部取帧要下载字节，把进度实时刷在按钮上
                captureVideoFrame(media, (text) => { targetBtn.innerHTML = text; }).then((dataUrl) => {
                    doSend({
                        action: 'sendImageToComfyUI',
                        dataUrl: dataUrl,
                        filename: 'video_frame_' + Date.now() + '.png',
                        pageUrl: pageUrl,
                        autoQueue: autoQueue
                    });
                }).catch((err) => {
                    targetBtn.innerHTML = '❌';
                    alert("视频取帧失败: " + err.message);
                    resetLater();
                });
            } else {
                doSend({
                    action: 'sendImageToComfyUI',
                    imgSrc: imgSrc,
                    pageUrl: pageUrl,
                    autoQueue: autoQueue
                });
            }
        }

        // 点击事件处理
        btn.addEventListener('click', (e) => handleSend(e, false));
        playBtn.addEventListener('click', (e) => handleSend(e, true));
    }
})();
