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

        // 当前悬浮的媒体元素（<img>、<video> 或带 background-image 的元素）
        let currentImg = null;
        // 当媒体是以 background-image 形式展示时，其图片地址存放在这里（此时 currentImg 上没有 src）
        let currentSrcOverride = null;
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

            const scrollY = window.scrollY;
            const scrollX = window.scrollX;

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

        // 抖音等站点会在 <img>/<video> 上方覆盖透明的交互层（播放器控制层、图文滑动切换层等），
        // 鼠标事件的 target 是覆盖层而不是媒体元素本身，
        // 因此用 elementsFromPoint 穿透整层元素栈向下查找真正的媒体元素
        function findMediaAtPoint(x, y) {
            const stack = document.elementsFromPoint(x, y);
            for (const el of stack) {
                if (!el.closest) continue;
                if (el.closest('#comfyui-extension-wrap')) continue;

                const media = el.closest('img, video');
                if (media) {
                    return { el: media, src: null };
                }

                // 部分站点用 background-image 展示图片，没有 <img> 可悬浮，
                // 只有足够大的背景图才认定为内容图片（避免小图标层抢先命中）
                if (el instanceof HTMLElement) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width >= minImgSize && rect.height >= minImgSize) {
                        const bg = getComputedStyle(el).backgroundImage;
                        if (bg && bg !== 'none') {
                            const m = bg.match(/url\(["']?(https?:[^"')]+)["']?\)/);
                            if (m) {
                                return { el: el, src: m[1] };
                            }
                        }
                    }
                }
            }
            return null;
        }

        // 鼠标悬浮移入图片/视频
        document.addEventListener('mouseover', (e) => {
            const found = findMediaAtPoint(e.clientX, e.clientY);
            if (!found) return;
            currentImg = found.el;
            currentSrcOverride = found.src;
            wrap.style.display = 'flex';
            btn.innerHTML = originalTitle;
            btn.disabled = false;
            playBtn.disabled = false;
            updateBtnPosition();
        });

        // 鼠标移出媒体区域及按钮后隐藏。
        // 不能像旧版那样用 e.target !== currentImg 判断（媒体上方常有覆盖层，target 永远不是媒体元素），
        // 改用几何位置判断鼠标是否仍在媒体矩形内
        document.addEventListener('mousemove', (e) => {
            if (wrap.style.display === 'flex' && !alwaysShow) {
                if (wrap.contains(e.target)) return;
                if (currentImg) {
                    const r = currentImg.getBoundingClientRect();
                    if (e.clientX >= r.left && e.clientX <= r.right &&
                        e.clientY >= r.top && e.clientY <= r.bottom) {
                        return;
                    }
                }
                wrap.style.display = 'none';
                currentImg = null;
                currentSrcOverride = null;
            }
        });

        // 保持滚动和改变大小时按钮跟随
        window.addEventListener('scroll', updateBtnPosition);
        window.addEventListener('resize', updateBtnPosition);

        // 将标签页截图按视频在页面中的位置裁剪出当前帧（截图是物理像素，需乘 devicePixelRatio）
        function cropScreenshot(dataUrl, rect) {
            const dpr = window.devicePixelRatio || 1;
            const left = Math.max(rect.left, 0);
            const top = Math.max(rect.top, 0);
            const right = Math.min(rect.right, window.innerWidth);
            const bottom = Math.min(rect.bottom, window.innerHeight);
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
                    resolve(canvas.toDataURL('image/png'));
                };
                img.onerror = () => reject(new Error('标签页截图解析失败'));
                img.src = dataUrl;
            });
        }

        // 抓取视频当前帧
        async function captureVideoFrame(video) {
            if (!video.videoWidth || !video.videoHeight) {
                throw new Error('视频画面尚未加载，请稍候再试');
            }
            // 优先直接从 video 画布取帧：抖音等基于 MSE 的播放器，画面数据由页面脚本注入，
            // 画布不会被跨域污染，可以拿到不带播放器 UI 的干净原图帧
            try {
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                return canvas.toDataURL('image/png');
            } catch (err) {
                // 画布被跨域污染（直链视频且无 CORS 头）时，降级为截取当前标签页画面并按视频位置裁剪。
                // 注意：此降级路径可能把播放器进度条等 UI 一起截进去
                wrap.style.visibility = 'hidden';
                let shot = null;
                try {
                    shot = await new Promise((resolve) => {
                        chrome.runtime.sendMessage({ action: 'captureVisibleTab' }, (res) => {
                            if (chrome.runtime.lastError) resolve(null);
                            else resolve(res && res.success ? res.dataUrl : null);
                        });
                    });
                } finally {
                    wrap.style.visibility = 'visible';
                }
                if (!shot) throw new Error('无法截取标签页画面（视频画布受跨域保护且截图失败）');
                return cropScreenshot(shot, video.getBoundingClientRect());
            }
        }

        function handleSend(e, autoQueue) {
            e.preventDefault();
            e.stopPropagation();
            if(!currentImg) return;

            const isVideo = currentImg.tagName === 'VIDEO';
            const media = currentImg;
            const imgSrc = isVideo ? null : (currentSrcOverride || media.currentSrc || media.src);
            const pageUrl = window.location.href;

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
                // 视频：先在页面里抓取当前帧，再把帧数据交给后台上传
                captureVideoFrame(media).then((dataUrl) => {
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
