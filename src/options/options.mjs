// 设置页主逻辑：状态读写、标签切换、工具栏表单、实时预览（含拖拽）、按钮管理。
// AI / 自定义 / 站点 / 导入导出 在 panels.mjs 里。

import { TOOLS, TOOL_GROUPS, DEFAULT_SETTINGS, migrateSettings, buildToolbar, findTool } from '../common/registry.js';
import { STEPS, stepParamDefaults, stepGroups } from '../common/steps.js';
import { CONTEXT_API_DOC, BUILTIN_SCRIPTS, ensureBuiltins } from '../common/builtin-scripts.js';
import { uid, formatBytes } from '../common/util.js';
import { CSS as MTB_CSS } from '../content/ui.mjs';
import { initPanels, renderAiPanel, renderCustomPanel, renderSitesPanel, bindOutputPanel } from './panels.mjs';

export const S = { settings: null, dirty: false, selTool: null, selScript: null, selLink: null };
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const store = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));
const read = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));

let previewItems = [];

export function toast(msg, isErr = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), isErr ? 4200 : 2000);
}

export async function save(patchOnly = false) {
    S.settings.version = 2;
    await store({ mtbSettings: S.settings });
    S.dirty = false;
    $('#saveStatus')?.remove();
    toast('已保存，页面即时生效');
}

export function markDirty() {
    S.dirty = true;
    scheduleSave();
}
let saveTimer = null;
function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(true), 450);
}

// ---------------------------------------------------------------- 绑定
const BINDINGS = [
    ['toolbar.showOn', 'showOn'], ['toolbar.showKey', 'showKey'], ['toolbar.layout', 'layout'],
    ['toolbar.iconMode', 'iconMode'], ['toolbar.theme', 'theme'], ['toolbar.anchor', 'anchor'],
    ['toolbar.offsetX', 'offsetX', 'num'], ['toolbar.offsetY', 'offsetY', 'num'],
    ['toolbar.maxTools', 'maxTools', 'num'], ['toolbar.minImgSize', 'minImgSize', 'num'],
    ['toolbar.hideDelay', 'hideDelay', 'num'], ['toolbar.gap', 'gap', 'num'], ['toolbar.radius', 'radius', 'num'],
    ['toolbar.scale', 'scale', 'num'], ['toolbar.opacity', 'opacity', 'num'],
];

function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, val) {
    const keys = path.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]] = (o[keys[i]] || {});
    o[keys[keys.length - 1]] = val;
}

export function syncForm() {
    for (const [path, id, kind] of BINDINGS) {
        const el = $('#' + id);
        if (!el) continue;
        const v = getPath(S.settings, path);
        el.value = kind === 'num' ? String(v ?? '') : (v ?? '');
    }
    $('#scaleV').textContent = Number(S.settings.toolbar.scale).toFixed(2) + 'x';
    $('#opacityV').textContent = Math.round(S.settings.toolbar.opacity * 100) + '%';
    $('#gapV').textContent = S.settings.toolbar.gap + 'px';
    $('#radiusV').textContent = S.settings.toolbar.radius + 'px';
    $('#posHint').textContent = `锚点 ${anchorName(S.settings.toolbar.anchor)}，偏移 ${S.settings.toolbar.offsetX},${S.settings.toolbar.offsetY}${S.settings.toolbar.dragMoved ? '（含手动拖拽）' : ''}`;
    $$('#anchorPad button').forEach((b) => b.classList.toggle('on', b.dataset.a === S.settings.toolbar.anchor));
    renderPreviewToolbar();
}

function bindFormEvents() {
    for (const [path, id, kind] of BINDINGS) {
        const el = $('#' + id);
        if (!el) continue;
        const h = () => {
            let v = el.value;
            if (kind === 'num') v = parseFloat(v) || 0;
            setPath(S.settings, path, v);
            if (path === 'toolbar.anchor') { setPath(S.settings, 'toolbar.anchorOffset', null); }
            markDirty();
            syncForm();
        };
        el.addEventListener('input', h);
        el.addEventListener('change', h);
    }
    $$('#anchorPad button').forEach((b) => b.onclick = () => { S.settings.toolbar.anchor = b.dataset.a; S.settings.toolbar.anchorOffset = null; markDirty(); syncForm(); });
    $('#btnRecenter').onclick = () => {
        S.settings.toolbar.offsetX = 0; S.settings.toolbar.offsetY = 0;
        S.settings.toolbar.anchorOffset = null; S.settings.toolbar.dragMoved = false;
        markDirty(); syncForm(); toast('已清除自定义偏移');
    };
}

export function anchorName(a) {
    return ({ 'top-left': '左上', 'top-right': '右上', 'bottom-left': '左下', 'bottom-right': '右下', center: '正中', 'top-edge': '上边', 'bottom-edge': '下边', 'left-edge': '左边', 'right-edge': '右边' })[a] || a;
}

// ---------------------------------------------------------------- 预览
let previewMedia = 'image';

export async function mountToolbarIntoSlot() {
    const slot = $('#toolbarSlot');
    slot.innerHTML = '';
    const host = document.createElement('div');
    host.id = 'mtb-root';
    host.style.cssText = 'all:initial;position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = MTB_CSS;
    shadow.appendChild(style);
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    shadow.appendChild(wrap);
    slot.appendChild(host);
    return { host, shadow, wrap };
}

let previewRef = null;

export async function renderPreviewToolbar() {
    const slot = $('#toolbarSlot');
    if (!slot) return;
    if (!previewRef) previewRef = await mountToolbarIntoSlot();
    const { wrap, shadow, host } = previewRef;
    const t = S.settings.toolbar;
    previewItems = buildToolbar(S.settings, previewMedia);
    wrap.className = 'wrap show' + (t.layout === 'vertical' ? ' vertical' : '') + (t.layout === 'grid' ? ' grid' : '');
    wrap.dataset.theme = t.theme;
    wrap.style.setProperty('--scale', String(t.scale));
    wrap.style.setProperty('--gap', t.gap + 'px');
    wrap.style.setProperty('--radius', t.radius + 'px');
    wrap.style.opacity = String(t.opacity);
    wrap.innerHTML = '';
    const handle = document.createElement('div');
    handle.className = 'draghandle';
    handle.textContent = '⠿';
    handle.title = '拖这里摆放位置';
    wrap.appendChild(handle);
    const limit = t.maxTools | 0;
    const capped = limit > 0 ? previewItems.slice(0, limit) : previewItems;
    const overflow = limit > 0 ? previewItems.slice(limit) : [];
    const pinned = capped.filter((i) => !i.collapsed);
    const folded = capped.filter((i) => i.collapsed).concat(overflow);
    for (const it of pinned) {
        const b = document.createElement('button');
        b.className = 'btn' + (t.iconMode === 'icon' ? ' icon' : t.iconMode === 'text' ? ' text' : '');
        b.innerHTML = `<span class="ic">${escapeHtml(it.icon || '•')}</span><span class="tx">${escapeHtml(it.label)}</span>`;
        b.title = (it.hint || '') + '\n' + it.id;
        b.onclick = () => { $('#stageLog').textContent = `点了「${it.label}」(${it.id}) —— 预览里不执行真实操作`; };
        wrap.appendChild(b);
    }
    if (folded.length) {
        const more = document.createElement('button');
        more.className = 'btn more';
        more.innerHTML = '<span class="ic">⋯</span><span class="tx">更多</span><span class="caret">▾</span>';
        let menu = null;
        more.onclick = () => {
            if (menu) { menu.classList.toggle('show'); return; }
            menu = document.createElement('div');
            menu.className = 'menu show';
            menu.style.left = '0'; menu.style.top = '100%'; menu.style.marginTop = '4px';
            const tip = document.createElement('div');
            tip.className = 'hint';
            tip.textContent = `${folded.length} 个折叠的按钮`;
            menu.appendChild(tip);
            for (const it of folded) {
                const row = document.createElement('div');
                row.className = 'mi';
                row.innerHTML = `<span class="ic">${escapeHtml(it.icon || '•')}</span><span class="tx">${escapeHtml(it.label)}</span>`;
                row.onclick = () => { $('#stageLog').textContent = `点了「${it.label}」(${it.id}) —— 折叠项，预览里不执行`; };
                menu.appendChild(row);
            }
            wrap.appendChild(menu);
        };
        wrap.appendChild(more);
    }
    const gear = document.createElement('button');
    gear.className = 'btn';
    gear.innerHTML = '<span class="ic">⚙️</span>';
    gear.onclick = () => { $('#stageLog').textContent = '⚙️ 打开设置（真实页面里会跳设置页）'; };
    wrap.appendChild(gear);
    positionPreview();
    bindPreviewDrag(host, wrap);
    $('#stageLog').textContent = `常驻 ${pinned.length} 个 · 折叠 ${folded.length} 个 · 共 ${previewItems.length} 个按钮（${previewMedia === 'video' ? '视频' : '图片'}态）`;
}

function positionPreview() {
    const wrap = previewRef?.wrap;
    const media = previewMedia === 'video' ? $('#sampleVideo') : $('#sampleImg');
    if (!wrap || !media) return;
    const t = S.settings.toolbar;
    const mr = media.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const w = wr.width || 220, h = wr.height || 30;
    const m = 8;
    let top, left;
    switch (t.anchor) {
        case 'top-left': top = m; left = m; break;
        case 'bottom-right': top = mr.height - h - m; left = mr.width - w - m; break;
        case 'bottom-left': top = mr.height - h - m; left = m; break;
        case 'center': top = (mr.height - h) / 2; left = (mr.width - w) / 2; break;
        case 'top-edge': top = m; left = (mr.width - w) / 2; break;
        case 'bottom-edge': top = mr.height - h - m; left = (mr.width - w) / 2; break;
        case 'left-edge': top = (mr.height - h) / 2; left = m; break;
        case 'right-edge': top = (mr.height - h) / 2; left = mr.width - w - m; break;
        default: top = m; left = mr.width - w - m;
    }
    wrap.style.left = (left + (t.offsetX | 0)) + 'px';
    wrap.style.top = (top + (t.offsetY | 0)) + 'px';
}

let dragBound = false;
function bindPreviewDrag(host, wrap) {
    if (dragBound) return;
    dragBound = true;
    let s = null;
    host.addEventListener('pointerdown', (e) => {
        if (!e.target.classList.contains('draghandle')) return;
        e.preventDefault();
        const slotBox = $('#toolbarSlot').getBoundingClientRect();
        s = { x: e.clientX, y: e.clientY, l: parseFloat(wrap.style.left) || 0, t: parseFloat(wrap.style.top) || 0, slot: slotBox };
        wrap.classList.add('dragging');
        wrap.setPointerCapture?.(e.pointerId);
    });
    host.addEventListener('pointermove', (e) => {
        if (!s) return;
        wrap.style.left = (s.l + e.clientX - s.x) + 'px';
        wrap.style.top = (s.t + e.clientY - s.y) + 'px';
    });
    host.addEventListener('pointerup', (e) => {
        if (!s) return;
        const media = previewMedia === 'video' ? $('#sampleVideo') : $('#sampleImg');
        const mr = media.getBoundingClientRect();
        const wr = wrap.getBoundingClientRect();
        const t = S.settings.toolbar;
        // 把拖到的位置反解成 anchor + offset，与真实页面的计算方式一致
        const base = basePos(t.anchor, mr, wr);
        S.settings.toolbar.offsetX = Math.round(wr.left - base.left);
        S.settings.toolbar.offsetY = Math.round(wr.top - base.top);
        S.settings.toolbar.dragMoved = true;
        S.settings.toolbar.anchorOffset = 'custom';
        wrap.classList.remove('dragging');
        s = null;
        markDirty();
        syncForm();
        toast(`位置：${anchorName(t.anchor)} + 偏移 ${S.settings.toolbar.offsetX},${S.settings.toolbar.offsetY}`);
    });
}

function basePos(anchor, mr, wr) {
    const m = 8, w = wr.width, h = wr.height;
    const map = {
        'top-left': [mr.left + m, mr.top + m],
        'top-right': [mr.right - w - m, mr.top + m],
        'bottom-left': [mr.left + m, mr.bottom - h - m],
        'bottom-right': [mr.right - w - m, mr.bottom - h - m],
        center: [mr.left + (mr.width - w) / 2, mr.top + (mr.height - h) / 2],
        'top-edge': [mr.left + (mr.width - w) / 2, mr.top + m],
        'bottom-edge': [mr.left + (mr.width - w) / 2, mr.bottom - h - m],
        'left-edge': [mr.left + m, mr.top + (mr.height - h) / 2],
        'right-edge': [mr.right - w - m, mr.top + (mr.height - h) / 2],
    };
    const [l, t] = map[anchor] || map['top-right'];
    return { left: l, top: t };
}

async function setupPreviewMedia() {
    const img = $('#sampleImg');
    img.src = sampleImageSvg();
    $$('.stagebar .mt[data-media]').forEach((b) => {
        b.onclick = async () => {
            previewMedia = b.dataset.media;
            $$('.stagebar .mt[data-media]').forEach((x) => x.classList.toggle('active', x === b));
            $('#sampleImg').style.display = previewMedia === 'image' ? 'block' : 'none';
            $('#sampleVideo').style.display = previewMedia === 'video' ? 'block' : 'none';
            if (previewMedia === 'video') await ensureSampleVideo();
            await renderPreviewToolbar();
        };
    });
    $('#btnScrollDemo').onclick = () => {
        const sc = $('#scroller');
        sc.scrollTo({ top: sc.scrollTop + 120, behavior: 'smooth' });
        $('#stageLog').textContent = '滚动时工具栏跟随图片（真实页面用 scroll 事件重算位置）';
    };
    $('#btnHideAll').onclick = () => {
        previewRef.wrap.classList.toggle('show');
        $('#stageLog').textContent = '预览显隐切换';
    };
}

let videoReady = false;
async function ensureSampleVideo() {
    if (videoReady) return;
    const v = $('#sampleVideo');
    for (const url of ['test/media/sample.mp4', 'media/sample.mp4']) {
        try {
            const r = await fetch(url);
            if (!r.ok) continue;
            const blob = await r.blob();
            v.src = URL.createObjectURL(blob);
            v.muted = true; v.loop = true;
            await v.play().catch(() => {});
            videoReady = true;
            return;
        } catch (e) { /* 试下一个 */ }
    }
    v.poster = sampleImageSvg();
    $('#stageLog').textContent = '没有找到示例视频（test/media/sample.mp4），视频态预览用海报图代替';
    videoReady = true;
}

export function sampleImageSvg() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="330">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#2a4d97"/><stop offset=".5" stop-color="#d96b3c"/><stop offset="1" stop-color="#f0e0a8"/>
      </linearGradient></defs>
      <rect width="520" height="330" fill="url(#g)"/>
      <circle cx="120" cy="90" r="46" fill="#fff8" />
      <path d="M0 250 Q120 170 240 240 T520 210 V330 H0Z" fill="#1b2a3a88"/>
      <text x="18" y="312" font-family="Segoe UI" font-size="17" fill="#ffffffcc">示例图片 · 悬停即出工具栏</text>
    </svg>`;
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
}

// ---------------------------------------------------------------- 按钮管理
export function renderToolList() {
    const list = $('#toolList');
    const q = ($('#toolSearch').value || '').trim().toLowerCase();
    const group = $('#toolGroup').value;
    list.innerHTML = '';
    const state = S.settings.tools;
    const ordered = TOOLS.slice().sort((a, b) => {
        const oa = state[a.id]?.order, ob = state[b.id]?.order;
        if (oa != null && ob != null) return oa - ob;
        if (oa != null) return -1;
        if (ob != null) return 1;
        return 0;
    });
    for (const t of ordered) {
        if (group && t.group !== group) continue;
        if (q && !((t.label + t.id + t.group + (t.hint || '')).toLowerCase().includes(q))) continue;
        const st = state[t.id] || (state[t.id] = { enabled: false, order: null, label: null, icon: null, params: null });
        const row = document.createElement('div');
        row.className = 'item' + (S.selTool === t.id ? ' sel' : '');
        row.draggable = true;
        row.dataset.id = t.id;
        const chainInfo = t.action?.type === 'step' ? (t.action.chain || []).map((s) => s.op).join('→') : '';
        row.innerHTML = `<span class="grip" title="拖拽排序">⠿</span>
          <input type="checkbox" ${st.enabled ? 'checked' : ''} title="显示/隐藏">
          <span class="icn">${escapeHtml(st.icon || t.icon || '•')}</span>
          <span class="nm">${escapeHtml(st.label || t.label)}</span>
          <span class="grp">${t.group}</span>
          ${t.action?.type === 'ai' ? '<span class="flags">AI</span>' : ''}
          ${st.collapsed ? '<span class="flags" title="已收进 ▾ 菜单">折叠 ▾</span>' : ''}
          ${chainInfo ? `<span class="flags" title="算子链">${escapeHtml(chainInfo)}</span>` : ''}
          <button class="mini edit" title="改名换图标">✎</button>
          <button class="mini cfg" title="编辑参数">⚙</button>`;
        row.querySelector('input').onchange = (e) => { st.enabled = e.target.checked; markDirty(); renderToolList(); renderPreviewToolbar(); };
        row.querySelector('.edit').onclick = () => editLabelIcon(t, st, row);
        row.querySelector('.cfg').onclick = () => { S.selTool = t.id; renderToolList(); renderParamEditor(); };
        row.onclick = (e) => { if (e.target.closest('button,input,select')) return; S.selTool = t.id; renderToolList(); renderParamEditor(); };
        attachRowDrag(row, ordered, state);
        list.appendChild(row);
    }
    const setVis = (id, v) => {
        const st = state[id];
        if (!st) return;
        st.enabled = v !== 'off';
        st.collapsed = v === 'menu';
    };
    $('#btnEnableAll').onclick = () => {
        $$('#toolList .item').forEach((r) => { const st = state[r.dataset.id]; if (st) { st.enabled = true; st.collapsed = false; } const c = r.querySelector('input'); if (c) c.checked = true; });
        markDirty(); renderToolList(); renderPreviewToolbar();
    };
    $('#btnDisableAll').onclick = () => {
        $$('#toolList .item').forEach((r) => { const st = state[r.dataset.id]; if (st) st.enabled = false; const c = r.querySelector('input'); if (c) c.checked = false; });
        markDirty(); renderToolList(); renderPreviewToolbar();
    };
    const btnCollapse = $('#btnCollapseExtra');
    if (btnCollapse && !btnCollapse._bound) {
        btnCollapse._bound = true;
        btnCollapse.onclick = () => {
            // 把当前启用但排在最前 6 个之后的按钮一次性折叠，试效果用
            const on = TOOLS.filter((t) => state[t.id] && state[t.id].enabled).map((t) => t.id);
            on.slice(6).forEach((id) => setVis(id, 'menu'));
            on.slice(0, 6).forEach((id) => setVis(id, 'pin'));
            markDirty(); renderToolList(); renderPreviewToolbar();
            toast('已把第 7 个之后的按钮收进 ▾ 下拉（在按钮行的 ⚙ 里可逐个改回）');
        };
    }
}

function editLabelIcon(t, st, row) {
    const nm = row.querySelector('.nm');
    const ic = row.querySelector('.icn');
    const oldName = nm.textContent, oldIc = ic.textContent;
    nm.contentEditable = 'true'; ic.contentEditable = 'true';
    nm.focus();
    document.getSelection().selectAllChildren(nm);
    const done = () => {
        nm.contentEditable = 'false'; ic.contentEditable = 'false';
        st.label = nm.textContent.trim() || t.label;
        st.icon = ic.textContent.trim() || t.icon;
        markDirty(); renderPreviewToolbar();
    };
    nm.onblur = ic.onblur = done;
    nm.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); nm.blur(); } };
}

function attachRowDrag(row, ordered, state) {
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', row.dataset.id); e.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('dragOver'); });
    row.addEventListener('dragleave', () => row.classList.remove('dragOver'));
    row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('dragOver');
        const from = e.dataTransfer.getData('text/plain');
        const to = row.dataset.id;
        if (from === to) return;
        const ids = $$('#toolList .item').map((r) => r.dataset.id);
        const fi = ids.indexOf(from), ti = ids.indexOf(to);
        ids.splice(ti, 0, ids.splice(fi, 1)[0]);
        ids.forEach((id, i) => { state[id] = state[id] || {}; state[id].order = i; });
        // 未显示的按钮没在列表里，order 设为 null 保持目录顺序
        for (const t of TOOLS) if (!ids.includes(t.id)) state[t.id] = { ...(state[t.id] || {}), order: null };
        markDirty(); renderToolList(); renderPreviewToolbar();
    });
}

export function renderParamEditor() {
    const box = $('#paramEditor');
    const id = S.selTool;
    if (!id) { box.innerHTML = '<p class="hint">选中一个按钮后在这里编辑它的默认参数。</p>'; return; }
    const t = findTool(id);
    const st = S.settings.tools[id] || (S.settings.tools[id] = {});
    if (!t) { box.innerHTML = '<p class="hint">工具不存在</p>'; return; }
    const chains = t.action?.type === 'step' ? (t.action.chain || []) : [];
    let html = `<h3>${escapeHtml(t.label)} <small>${t.id} · ${t.group}</small></h3>`;
    if (t.hint) html += `<p class="note">${escapeHtml(t.hint)}</p>`;
    if (t.action?.type === 'ai') html += `<p class="note">AI 工具：模型与设备在「AI 与模型」标签里配置。</p>`;
    if (!chains.length && !t.params && t.action?.type !== 'ai') html += `<p class="note">这个按钮没有可调参数。</p>`;
    box.innerHTML = html;
    const mkRow = (label, input, hint) => {
        const d = document.createElement('label');
        d.innerHTML = `${escapeHtml(label)}${hint ? ` <span class="hint">${escapeHtml(hint)}</span>` : ''}`;
        d.appendChild(input);
        box.appendChild(d);
        return d;
    };
    // 常驻/折叠放在这里（行内只留显示与否的勾选框），和参数一起改
    const visSel = document.createElement('select');
    visSel.appendChild(new Option('常驻显示', 'pin'));
    visSel.appendChild(new Option('折叠进 ▾ 菜单', 'menu'));
    visSel.value = st.collapsed ? 'menu' : 'pin';
    visSel.onchange = () => {
        st.collapsed = visSel.value === 'menu';
        if (!st.enabled) st.enabled = true; // 折叠了却没启用等于不显示，这里顺手补齐
        markDirty(); renderToolList(); renderPreviewToolbar();
    };
    mkRow('显示位置', visSel, '折叠后收在工具栏末尾的「⋯ 更多 」里');
    for (const step of chains) {
        const spec = STEPS[step.op];
        if (!spec) continue;
        const head = document.createElement('h3');
        head.innerHTML = `${escapeHtml(spec.label)} <small>${escapeHtml(step.op)}</small>`;
        box.appendChild(head);
        step.params = step.params || {};
        for (const p of spec.params) {
            const wrap = document.createElement('div');
            const input = buildInput(p, step.params[p.key] ?? p.def);
            input.onchange = () => {
                step.params[p.key] = readInput(p, input);
                markDirty(); renderPreviewToolbar();
            };
            wrap.appendChild(labelFor(p, input));
            box.appendChild(wrap);
        }
    }
    if (t.params) {
        const head = document.createElement('h3');
        head.textContent = '按钮参数';
        box.appendChild(head);
        st.params = st.params || {};
        for (const p of t.params) {
            const input = buildInput({ ...p, type: p.type === 'number' ? 'number' : p.type }, st.params[p.key] ?? p.def);
            input.onchange = () => { st.params[p.key] = readInput(p, input); markDirty(); };
            box.appendChild(labelFor(p, input));
        }
    }
    const reset = document.createElement('button');
    reset.textContent = '恢复该按钮默认参数';
    reset.className = 'mini';
    reset.onclick = () => {
        for (const step of chains) step.params = { ...stepParamDefaults(step.op) };
        if (t.params) st.params = {};
        markDirty(); renderParamEditor(); renderPreviewToolbar();
    };
    box.appendChild(document.createElement('div'));
    box.appendChild(reset);
}

function labelFor(p, input) {
    const d = document.createElement('label');
    d.textContent = p.label + (p.unit ? ` (${p.unit})` : '');
    d.appendChild(input);
    return d;
}

function buildInput(p, val) {
    if (p.type === 'select') {
        const s = document.createElement('select');
        for (const o of (p.options || [])) {
            const opt = document.createElement('option');
            opt.value = o.value ?? o; opt.textContent = o.label ?? o;
            s.appendChild(opt);
        }
        s.value = String(val);
        return s;
    }
    if (p.type === 'color') {
        const i = document.createElement('input');
        i.type = 'color';
        i.value = /^#[0-9a-f]{6}$/i.test(String(val)) ? String(val) : '#000000';
        return i;
    }
    if (p.type === 'bool') {
        const i = document.createElement('input');
        i.type = 'checkbox';
        i.checked = !!val;
        return i;
    }
    const i = document.createElement('input');
    if (p.type === 'number') { i.type = 'number'; i.value = Number(val) || 0; if (p.min != null) i.min = p.min; if (p.max != null) i.max = p.max; if (p.step) i.step = p.step; }
    else { i.type = 'text'; i.value = val == null ? '' : String(val); }
    return i;
}

function readInput(p, input) {
    if (p.type === 'bool') return input.checked;
    if (p.type === 'number') return parseFloat(input.value) || 0;
    return input.value;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- 启动
(async function main() {
    const data = await read(['mtbSettings', 'comfyConfig']);
    S.settings = ensureBuiltins(migrateSettings(data.mtbSettings || data.comfyConfig || DEFAULT_SETTINGS));
    if (!S.settings.tools || Object.keys(S.settings.tools).length < TOOLS.length) {
        const { defaultToolbarState } = await import('../common/registry.js');
        S.settings.tools = { ...defaultToolbarState(), ...(S.settings.tools || {}) };
    }
    const groups = $('#toolGroup');
    for (const g of TOOL_GROUPS) { const o = document.createElement('option'); o.value = g; o.textContent = g; groups.appendChild(o); }
    $$('#tabs button').forEach((b) => {
        b.onclick = () => {
            $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
            $$('main section').forEach((s) => s.classList.toggle('active', s.dataset.panel === b.dataset.tab));
            if (b.dataset.tab === 'ai') renderAiPanel(S, { toast, save, markDirty });
            if (b.dataset.tab === 'custom') renderCustomPanel(S, { toast, save, markDirty });
            if (b.dataset.tab === 'sites') renderSitesPanel(S, { toast, save, markDirty });
            if (b.dataset.tab === 'buttons') renderToolList();
            setTimeout(positionPreview, 30);
        };
    });
    bindFormEvents();
    bindOutputPanel(S, { toast, save, markDirty });
    initPanels(S, { toast, save, markDirty, escapeHtml, $, $$ });
    $('#toolSearch').addEventListener('input', renderToolList);
    $('#toolGroup').addEventListener('change', renderToolList);
    $('#btnSave').onclick = () => save();
    $('#apiDoc pre').textContent = CONTEXT_API_DOC + '\n\n内置脚本模板：\n' + BUILTIN_SCRIPTS[0].code;
    $('#btnCurrentSite') && ($('#btnCurrentSite').onclick = () => toast('请在地址栏右侧的扩展弹窗里切换当前站点'));
    await setupPreviewMedia();
    syncForm();
    renderToolList();
    renderParamEditor();
    window.addEventListener('resize', () => positionPreview());
    $('#sampleImg').addEventListener('load', () => renderPreviewToolbar());
    document.addEventListener('visibilitychange', async () => { if (!document.hidden) { const d = await read(['mtbSettings']); if (d.mtbSettings?.version === 2 && !S.dirty) { S.settings = ensureBuiltins(migrateSettings(d.mtbSettings)); syncForm(); renderToolList(); } } });
    toast('设置已载入 · 改动自动保存');
})();

export function previewItemsRef() { return previewItems; }

export { escapeHtml, $, $$, read, store, positionPreview };
