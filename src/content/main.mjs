// 内容脚本入口：设置同步、媒体探测、工具栏显隐、宿主连接、键盘与全屏处理。

import { makeProber } from './probe.js';
import { ensureRoot, mountToolbar, Toolbar, ResultPanel, LogDock, Picker, drawBoxes, drawMask, toast, attachToActiveLayer } from './ui.mjs';
import { Runner, copyText } from './runner.mjs';
import { buildToolbar, migrateSettings, DEFAULT_SETTINGS } from '../common/registry.js';
import { ensureBuiltins } from '../common/builtin-scripts.js';
import { captureVideoFrame } from './frame.js';

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
    toolbar.onOpenSettings = () => chrome.runtime.sendMessage({ action: 'openOptions' });
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
            const res = await chrome.runtime.sendMessage({ action: 'patchSettings', patch });
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
        refreshProbe: () => { if (STATE.media) toolbar.position(STATE.media.displayRect); },
        lastFaces: [], lastMasks: [],
    });

    toolbar.onClick = (item, btn, e) => runner.dispatch(item, btn, e);
    toolbar.onMoved = () => positionLayers();

    prober = makeProber({ minImgSize: s.toolbar.minImgSize });

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
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
    if (STATE.settings.toolbar.showOn === 'always') { if (STATE.media) toolbar.position(STATE.media.displayRect); return; }
    if (!wrapVisible()) { probeAndShow(e.clientX, e.clientY); return; }
    if (e.target?.closest?.('#mtb-root')) return;
    refresh(false);
}

function onScroll() { if (STATE.media) { STATE.media.displayRect = STATE.media.el.getBoundingClientRect(); toolbar.position(STATE.media.displayRect); positionLayers(); } }

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
    toolbar.show(m.displayRect);
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
    await chrome.runtime.sendMessage({ action: 'patchSettings', patch });
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
    const r = await chrome.runtime.sendMessage({ action: 'ensureHost' });
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
        if (p.action === 'openTab') chrome.runtime.sendMessage({ action: 'openTab', url: p.url });
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
