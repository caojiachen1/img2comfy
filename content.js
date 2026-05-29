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

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.comfyConfig) {
                btnPosition = changes.comfyConfig.newValue?.buttonPosition || 'top-right';
                offsetX = parseInt(changes.comfyConfig.newValue?.offsetX) || 0;
                offsetY = parseInt(changes.comfyConfig.newValue?.offsetY) || 0;
                updateBtnPosition();
            }
        });

        const btn = document.createElement('button');
    btn.id = 'comfyui-send-extension-btn';
    btn.innerHTML = '发送到 ComfyUI';
    document.body.appendChild(btn);

    let currentImg = null;
    let originalTitle = btn.innerHTML;

    // 更新按钮位置使其贴附在图片右上角
    function updateBtnPosition() {
        if (!currentImg) return;
        const rect = currentImg.getBoundingClientRect();
        
        // 忽略太细小的图标或底图，防止干扰
        if (rect.width < 100 || rect.height < 100) {
            btn.style.display = 'none';
            return;
        }
        
        const scrollY = window.scrollY;
        const scrollX = window.scrollX;
        
        if (btnPosition === 'top-left') {
            btn.style.top = (scrollY + rect.top + 10 + offsetY) + 'px';
            btn.style.left = (scrollX + rect.left + 10 + offsetX) + 'px';
        } else if (btnPosition === 'bottom-right') {
            btn.style.top = (scrollY + rect.bottom - btn.offsetHeight - 10 + offsetY) + 'px';
            btn.style.left = (scrollX + rect.right - btn.offsetWidth - 10 + offsetX) + 'px';
        } else if (btnPosition === 'bottom-left') {
            btn.style.top = (scrollY + rect.bottom - btn.offsetHeight - 10 + offsetY) + 'px';
            btn.style.left = (scrollX + rect.left + 10 + offsetX) + 'px';
        } else if (btnPosition === 'center') {
            btn.style.top = (scrollY + rect.top + (rect.height - btn.offsetHeight) / 2 + offsetY) + 'px';
            btn.style.left = (scrollX + rect.left + (rect.width - btn.offsetWidth) / 2 + offsetX) + 'px';
        } else {
            // 默认右上角
            btn.style.top = (scrollY + rect.top + 10 + offsetY) + 'px';
            btn.style.left = (scrollX + rect.right - btn.offsetWidth - 10 + offsetX) + 'px';
        }
    }

    // 鼠标悬浮移入图片
    document.addEventListener('mouseover', (e) => {
        if (e.target.tagName && e.target.tagName.toLowerCase() === 'img') {
            currentImg = e.target;
            btn.style.display = 'block';
            btn.innerHTML = originalTitle;
            btn.disabled = false;
            updateBtnPosition();
        }
    });

    // 鼠标移出图片及按钮
    document.addEventListener('mousemove', (e) => {
        if (btn.style.display === 'block') {
            if (e.target !== btn && e.target !== currentImg) {
                btn.style.display = 'none';
                currentImg = null;
            }
        }
    });

    // 保持滚动和改变大小时按钮跟随
    window.addEventListener('scroll', updateBtnPosition);
    window.addEventListener('resize', updateBtnPosition);

    // 点击事件处理
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if(!currentImg) return;

        const imgSrc = currentImg.src;
        const pageUrl = window.location.href;

        btn.innerHTML = '⏳ 发送中...';
        btn.disabled = true;

        // 发送消息给后台任务
        try {
            chrome.runtime.sendMessage({
                action: 'sendImageToComfyUI',
                imgSrc: imgSrc,
                pageUrl: pageUrl
            }, (response) => {
                if (chrome.runtime.lastError) {
                     btn.innerHTML = '🔄 请刷新网页';
                     alert("插件已更新或断开连接，请刷新当前网页后再试。\n" + chrome.runtime.lastError.message);
                     btn.disabled = false;
                     return;
                }
                if (response && response.success) {
                    btn.innerHTML = '✅ 已发送';
                } else {
                    console.error("ComfyUI 插件错误:", response?.error);
                    btn.innerHTML = '❌ 发送失败';
                    alert("发送失败: " + (response?.error || '未知错误'));
                }
                
                setTimeout(() => {
                    btn.style.display = 'none';
                    btn.innerHTML = originalTitle;
                    currentImg = null;
                }, 2500);
            });
        } catch (err) {
            if (err.message.includes("Extension context invalidated")) {
                 btn.innerHTML = '🔄 请刷新网页';
                 alert("插件底层已重新加载，请按 F5 刷新当前所在的图片网页以恢复按钮功能！");
            } else {
                 btn.innerHTML = '❌ 发生错误';
                 alert("错误: " + err.message);
            }
        }
    });
    }
})();
