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

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.comfyConfig) {
                btnPosition = changes.comfyConfig.newValue?.buttonPosition || 'top-right';
                offsetX = parseInt(changes.comfyConfig.newValue?.offsetX) || 0;
                offsetY = parseInt(changes.comfyConfig.newValue?.offsetY) || 0;
                minImgSize = changes.comfyConfig.newValue?.minImgSize !== undefined ? parseInt(changes.comfyConfig.newValue?.minImgSize) : 200;
                updateBtnPosition();
            }
        });

        const wrap = document.createElement('div');
        wrap.id = 'comfyui-extension-wrap';
        
        const btn = document.createElement('button');
        btn.className = 'comfyui-extension-btn';
        btn.innerHTML = '发送到 ComfyUI';
        btn.title = '将图片发送到 ComfyUI';
        
        const playBtn = document.createElement('button');
        playBtn.className = 'comfyui-extension-btn';
        playBtn.innerHTML = '▶';
        playBtn.title = '发送图片并立即执行工作流 (Queue Prompt)';
        playBtn.style.padding = '4px 8px';
        
        wrap.appendChild(btn);
        wrap.appendChild(playBtn);
        document.body.appendChild(wrap);

        let currentImg = null;
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

        // 鼠标悬浮移入图片
        document.addEventListener('mouseover', (e) => {
            if (e.target.tagName && e.target.tagName.toLowerCase() === 'img') {
                currentImg = e.target;
                wrap.style.display = 'flex';
                btn.innerHTML = originalTitle;
                btn.disabled = false;
                playBtn.disabled = false;
                updateBtnPosition();
            }
        });

        // 鼠标移出图片及按钮
        document.addEventListener('mousemove', (e) => {
            if (wrap.style.display === 'flex') {
                if (!wrap.contains(e.target) && e.target !== currentImg) {
                    wrap.style.display = 'none';
                    currentImg = null;
                }
            }
        });

        // 保持滚动和改变大小时按钮跟随
        window.addEventListener('scroll', updateBtnPosition);
        window.addEventListener('resize', updateBtnPosition);

        function handleSend(e, autoQueue) {
            e.preventDefault();
            e.stopPropagation();
            if(!currentImg) return;

            const imgSrc = currentImg.src;
            const pageUrl = window.location.href;

            const targetBtn = autoQueue ? playBtn : btn;
            const originalBtnText = targetBtn.innerHTML;
            targetBtn.innerHTML = '⏳';
            btn.disabled = true;
            playBtn.disabled = true;

            // 发送消息给后台任务
            try {
                chrome.runtime.sendMessage({
                    action: 'sendImageToComfyUI',
                    imgSrc: imgSrc,
                    pageUrl: pageUrl,
                    autoQueue: autoQueue
                }, (response) => {
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
                    
                    setTimeout(() => {
                        wrap.style.display = 'none';
                        btn.innerHTML = originalTitle;
                        playBtn.innerHTML = '▶';
                        currentImg = null;
                    }, 2500);
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
        }

        // 点击事件处理
        btn.addEventListener('click', (e) => handleSend(e, false));
        playBtn.addEventListener('click', (e) => handleSend(e, true));
    }
})();
