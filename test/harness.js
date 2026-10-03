// img2comfy 测试装载器：不依赖已安装的扩展，把 content.js 直接以页面脚本方式运行。
// 用法：测试页里在 /content.js 之前先引入本文件。
// - 桩掉 chrome.storage / chrome.runtime.sendMessage（captureVisibleTab 用纯色 PNG 模拟截图，
//   sendImageToComfyUI 直接记为成功并把 payload 记录到 window.__comfyTestLog）
// - 劫持 alert，失败信息同样进 __comfyTestLog，避免阻塞自动化
// - 顶层窗口提供 __collectComfyLogs()：汇总所有 iframe 的日志（跨源 iframe 靠 postMessage 回传）
(function() {
    window.__comfyTestLog = [];

    const tinyPng = (function() {
        const c = document.createElement('canvas');
        c.width = 64; c.height = 64;
        const g = c.getContext('2d');
        g.fillStyle = '#ff00ff';
        g.fillRect(0, 0, 64, 64);
        return c.toDataURL('image/png');
    })();

    function record(entry) {
        window.__comfyTestLog.push(entry);
        try { console.log('[TESTLOG] ' + JSON.stringify(entry)); } catch (e) {}
    }

    window.chrome = window.chrome || {};
    window.chrome.storage = {
        local: { get: (keys, cb) => cb({}) },
        onChanged: { addListener: function() {} }
    };
    window.chrome.runtime = {
        sendMessage: function(payload, cb) {
            if (payload && payload.action === 'captureVisibleTab') {
                if (cb) cb({ success: true, dataUrl: tinyPng });
                return;
            }
            // 只把真正的发送记为测试结果；allowDirectMediaFetch 等辅助消息静默成功
            if (payload && payload.action === 'sendImageToComfyUI') {
                record({ time: new Date().toISOString(), payload: payload });
            } else {
                try { console.log('[TESTSTUB] ' + (payload && payload.action)); } catch (e) {}
            }
            if (cb) setTimeout(() => cb({ success: true }), 0);
        }
    };
    window.alert = function(m) {
        record({ time: new Date().toISOString(), alert: String(m) });
    };

    if (window.top === window) {
        window.__collectComfyLogs = function() {
            return new Promise(function(resolve) {
                const out = [{ frameHref: location.href, log: window.__comfyTestLog }];
                const onMsg = function(ev) {
                    if (ev.data && ev.data.__comfyFrameLog) out.push(ev.data.__comfyFrameLog);
                };
                window.addEventListener('message', onMsg);
                const broadcast = function(w) {
                    for (let i = 0; i < w.length; i++) {
                        try {
                            w[i].postMessage({ __comfyReqLog: 1 }, '*');
                            broadcast(w[i]);
                        } catch (e) {}
                    }
                };
                broadcast(window);
                setTimeout(function() {
                    window.removeEventListener('message', onMsg);
                    resolve(out);
                }, 500);
            });
        };
    } else {
        window.addEventListener('message', function(ev) {
            if (ev.data && ev.data.__comfyReqLog) {
                let diag = null;
                try {
                    const wrap = document.getElementById('comfyui-extension-wrap');
                    const vids = Array.from(document.querySelectorAll('video')).map(v => ({
                        id: v.id, ready: v.readyState, w: v.videoWidth, h: v.videoHeight
                    }));
                    diag = {
                        wrapExists: !!wrap,
                        wrapDisplay: wrap ? wrap.style.display : null,
                        videos: vids,
                        centerStack: document.elementsFromPoint(innerWidth / 2, innerHeight / 2).slice(0, 5).map(n => n.tagName + (n.id ? '#' + n.id : ''))
                    };
                } catch (e) { diag = String(e); }
                try {
                    ev.source.postMessage({ __comfyFrameLog: { frameHref: location.href, log: window.__comfyTestLog, diag: diag } }, '*');
                } catch (e) {}
            }
            if (ev.data && ev.data.__comfyGetWrapBtn) {
                // 回传悬浮按钮在本 frame 视口中的矩形（跨源 iframe 里顶层无法直接读，CDP 点击要用）
                try {
                    const wrap = document.getElementById('comfyui-extension-wrap');
                    const b = wrap ? wrap.querySelector('button') : null;
                    const r = b ? b.getBoundingClientRect() : null;
                    let hit = null;
                    if (r && r.width > 0) {
                        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                        hit = at ? at.tagName + (at.className && typeof at.className === 'string' ? '.' + at.className.split('.').join('.') : '') : 'none';
                    }
                    ev.source.postMessage({
                        __comfyWrapBtn: (r && r.width > 0) ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null,
                        display: wrap ? wrap.style.display : 'no-wrap',
                        hit,
                    }, '*');
                } catch (e) {
                    ev.source.postMessage({ __comfyWrapBtn: null, display: 'err', hit: String(e) }, '*');
                }
            }
        });
    }

    // 测试页若部署在非 localhost 源上，用户浏览器里真实安装的 img2comfy 扩展也会注入，
    // 产生第二个同 id 的按钮。本 harness 的 content.js 在解析期先建好 wrap（第一个出现的），
    // 之后 document_idle 才出现的重复 wrap 一律移除，保证自动化只点到受桩控制的那个
    if (document.body) {
        let firstWrap = null;
        const guard = new MutationObserver(function(muts) {
            for (const m of muts) {
                for (const n of m.addedNodes) {
                    if (n.id === 'comfyui-extension-wrap') {
                        if (!firstWrap) firstWrap = n;
                        else if (n !== firstWrap) n.remove();
                    }
                }
            }
        });
        guard.observe(document.body, { childList: true, subtree: false });
    }
})();
