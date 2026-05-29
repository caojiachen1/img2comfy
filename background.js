chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'sendImageToComfyUI') {
        processImage(request.imgSrc, request.pageUrl)
            .then(() => sendResponse({ success: true }))
            .catch((err) => sendResponse({ success: false, error: err.message }));
        return true; // 保持异步返回通道
    }
});

async function processImage(imgSrc, pageUrl) {
    const isHttp = imgSrc.startsWith('http');
    const ruleId = 1;
    
    // 获取配置
    const data = await chrome.storage.local.get(['comfyConfig']);
    let comfyuiUrl = 'http://127.0.0.1:8188';
    let profile = { mode: 'frontend' };
    
    if (data.comfyConfig) {
        if (data.comfyConfig.serverAddress) {
            comfyuiUrl = data.comfyConfig.serverAddress.replace(/\/$/, "");
        }
        if (data.comfyConfig.activeProfileId && data.comfyConfig.profiles) {
            profile = data.comfyConfig.profiles[data.comfyConfig.activeProfileId] || profile;
        }
    }
    
    // 1. 如果是外网图片，动态添加请求头修改规则（针对微博等网站防盗链，伪装Referer）
    if (isHttp) {
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [ruleId],
            addRules: [{
                id: ruleId,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: [
                        { header: 'Referer', operation: 'set', value: pageUrl }
                    ]
                },
                condition: {
                    urlFilter: imgSrc,
                    resourceTypes: ['xmlhttprequest'] // 背景 fetch 使用的 type
                }
            }]
        });
    }

    try {
        // 2. 将突破防盗链限制的图片下载至后台
        const imgRes = await fetch(imgSrc);
        if (!imgRes.ok) throw new Error(`背景下载图片失败: 状态码 ${imgRes.status}`);
        const blob = await imgRes.blob();

        // 3. 构建表单准备提交给本地 ComfyUI API
        const formData = new FormData();
        let filename = 'web_image_' + Date.now() + '.png';
        
        try {
            const url = new URL(imgSrc);
            const pathParts = url.pathname.split('/');
            const pathName = pathParts[pathParts.length - 1];
            if (pathName && pathName.includes('.')) {
                filename = pathName;
            }
        } catch(e) {}
        
        // 4. 调用本地 ComfyUI 上传接口 (将图片同时存入 input 和 output 确保对任意不同类型的图像节点都能生效)
        // 第一份发给 Input 文件夹（给常规 LoadImage 用）
        const formInput = new FormData();
        formInput.append('image', blob, filename);
        formInput.append('type', 'input');
        formInput.append('overwrite', 'true');
        await fetch(`${comfyuiUrl}/upload/image`, { method: 'POST', body: formInput });
        
        // 第二份发给 Output 文件夹（给你的 LoadImageOutput 用）
        const formOutput = new FormData();
        formOutput.append('image', blob, filename);
        formOutput.append('type', 'output');
        formOutput.append('overwrite', 'true');
        const uploadRes = await fetch(`${comfyuiUrl}/upload/image`, { method: 'POST', body: formOutput });
        
        if (!uploadRes.ok) {
            throw new Error(`无法直连 ComfyUI，请检查地址是否正确: ${comfyuiUrl}`);
        }
        
        const uploadData = await uploadRes.json();
        const uploadedFilename = uploadData.name;

        // 5. 根据模式执行
        await executeProfile(uploadedFilename, profile, comfyuiUrl);
    } finally {
        // 清理我们刚配置的伪装规则以便下一次干净运行
        if (isHttp) {
            await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
        }
    }
}

async function executeProfile(filename, profile, comfyuiUrl) {
    if (profile.mode === 'api') {
        // API 模式：读取 JSON 并通过 API 触发
        if (!profile.workflowJson) throw new Error("API 模式下必须配置工作流 JSON 内容");
        
        let workflow;
        try {
            workflow = JSON.parse(profile.workflowJson);
        } catch (e) {
            throw new Error("API 模式下配置的工作流 JSON 格式错误: " + e.message);
        }

        const nodeId = profile.targetNodeId;
        if (!nodeId || !workflow[nodeId]) {
            throw new Error(`找不到配置的节点 ID: ${nodeId || '空'}`);
        }

        if (workflow[nodeId].inputs) {
            workflow[nodeId].inputs.image = filename;
        }

        const res = await fetch(`${comfyuiUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: workflow })
        });
        
        if (!res.ok) {
            const err = await res.text();
            throw new Error('API 模式触发工作流失败: ' + err);
        }
        return;
    }

    // 前端模式：向打开的标签页注入代码
    // 匹配 ComfyUI 页面
    const allTabs = await chrome.tabs.query({});
    const tabs = allTabs.filter(t => t.url && t.url.startsWith(comfyuiUrl));
    
    if (tabs.length === 0) {
        throw new Error(`没有找到在浏览器中打开的 ComfyUI 标签页 (${comfyuiUrl})\n如果想在后台静默运行，请在配置中切换到 API 模式。`);
    }

    const comfyTabId = tabs[0].id;
    const targetNodeType = profile.targetNodeType || "";

    await chrome.scripting.executeScript({
        target: { tabId: comfyTabId },
        world: "MAIN", 
        func: (newFilename, targetNodeType) => {
            if (!window.app || !window.app.graph) {
                alert("未检测到 ComfyUI 视图 (app/graph)，其可能尚未加载完毕。");
                return;
            }

            let targetNode = null;
            let selectedNodes = Object.keys(window.app.canvas.selected_nodes || {}).map(k => window.app.canvas.selected_nodes[k]);

            if (targetNodeType) {
                // 如果用户指定了节点名称，尝试通过标题或类型精确寻找
                const nodes = window.app.graph._nodes;
                targetNode = nodes.find(n => n.title === targetNodeType || n.type === targetNodeType || n.comfyClass === targetNodeType);
            } else {
                // 1. 优先寻找用户当前“鼠标点击选中”的包含 image 属性的节点
                targetNode = selectedNodes.find(n => n.widgets && n.widgets.some(w => w.name === "image"));

                // 2. 降级去全局寻找
                if (!targetNode) {
                    const nodes = window.app.graph._nodes;
                    targetNode = nodes.find(n => n.type === "LoadImageOutput" || n.comfyClass === "LoadImageOutput");
                    if (!targetNode) {
                        targetNode = nodes.find(n => n.type === "LoadImage" || n.comfyClass === "LoadImage");
                    }
                }
            }

            if (targetNode) {
                const imgWidget = targetNode.widgets.find(w => w.name === "image" && w.type !== "button");
                if (imgWidget) {
                    let finalValue = newFilename;
                    const isOutputNode = targetNode.type === "LoadImageOutput" || targetNode.comfyClass === "LoadImageOutput";
                    if (isOutputNode) {
                        finalValue = newFilename + " [output]";
                    }
                    
                    if (imgWidget.options && Array.isArray(imgWidget.options.values)) {
                        if (!imgWidget.options.values.includes(finalValue)) {
                            imgWidget.options.values.push(finalValue);
                        }
                    }
                    imgWidget.value = finalValue;
                    
                    if (typeof imgWidget.callback === "function") {
                        try {
                            imgWidget.callback(finalValue);
                        } catch (e) {
                            console.warn("Widget callback 调用失败:", e);
                        }
                    }

                    targetNode.setDirtyCanvas(true, true);
                    if (window.app.api && typeof window.app.api.dispatchEvent === "function") {
                        const folderType = isOutputNode ? "output" : "input";
                        window.app.api.dispatchEvent(new CustomEvent("b_preview", { detail: { image: newFilename, type: folderType } }));
                    }

                    window.app.graph.setDirtyCanvas(true, true);
                    console.log("成功应用图像并触发刷新 =", finalValue);
                } else {
                    alert('找到了节点，但节点中丢失了对应的 "image" 输入框');
                }
            } else {
                alert("未在画布中找到图像加载节点。\n请在配置中填入正确的节点类型名称，或在画布中用鼠标左键单击选中您想要传送的节点！");
            }
        },
        args: [filename, targetNodeType]
    });
}
