// 悬浮工具栏 UI：Shadow DOM 宿主、按钮渲染、拖拽定位、结果面板、标注遮罩。

const ROOT_ID = 'mtb-root';
const NS = 'mtb';

export const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: "Segoe UI Variable","Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif; }
.wrap { position: absolute; z-index: 2147483647; display: none; pointer-events: auto; --scale:1; --gap:4px; --radius:8px; --opacity:.92; }
.wrap.show { display: flex; }
.wrap.vertical { flex-direction: column; }
.wrap.grid { display: none; }
.wrap.grid.show { display: grid; }
.bar { display: flex; gap: var(--gap); align-items: center; }
button.btn {
  background: rgba(28,28,28,.86); backdrop-filter: blur(12px) saturate(180%); -webkit-backdrop-filter: blur(12px) saturate(180%);
  color: rgba(255,255,255,.95); border: 1px solid rgba(255,255,255,.16);
  padding: calc(4px * var(--scale)) calc(10px * var(--scale)); border-radius: var(--radius); cursor: pointer;
  font-size: calc(12px * var(--scale)); font-weight: 500; box-shadow: 0 4px 12px rgba(0,0,0,.18);
  transition: background .18s cubic-bezier(.16,1,.3,1), transform .12s, box-shadow .18s;
  display: inline-flex; align-items: center; gap: calc(5px * var(--scale)); white-space: nowrap; line-height: 1.25;
}
button.btn:hover { background: rgba(48,48,48,.96); border-color: rgba(255,255,255,.32); box-shadow: 0 6px 18px rgba(0,0,0,.24); }
button.btn:active { transform: scale(.96); }
button.btn[disabled] { opacity: .45; cursor: progress; }
button.btn .ic { font-size: calc(13px * var(--scale)); }
button.btn.icon .tx { display: none; }
button.btn.text .ic { display: none; }
.wrap[data-theme="light"] button.btn { background: rgba(250,250,250,.9); color: rgba(20,20,20,.92); border-color: rgba(0,0,0,.12); }
.wrap[data-theme="light"] button.btn:hover { background: #fff; }
.wrap[data-theme="neon"] button.btn { background: rgba(16,18,32,.85); border-color: rgba(120,220,255,.5); color: #d8f6ff; box-shadow: 0 0 12px rgba(80,190,255,.35); }
.wrap[data-theme="glass"] button.btn { background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.35); }
.draghandle { width: calc(10px * var(--scale)); height: calc(20px * var(--scale)); cursor: grab; opacity: .35; display:flex; align-items:center; justify-content:center; font-size: calc(11px * var(--scale)); user-select:none; }
.draghandle:hover { opacity: .9; }
.dragging .draghandle { cursor: grabbing; }
.dragging { outline: 1px dashed rgba(120,220,255,.8); }
.menu {
  position: absolute; left: 0; z-index: 2147483647; display: none; pointer-events: auto;
  min-width: 168px; max-width: min(300px, 88vw); max-height: 62vh; overflow: auto;
  background: rgba(22,22,24,.97); border: 1px solid rgba(255,255,255,.18); border-radius: 10px;
  box-shadow: 0 12px 34px rgba(0,0,0,.5); padding: 4px;
}
.menu.show { display: block; }
.menu .mi { display:flex; align-items:center; gap:8px; padding:7px 9px; border-radius:7px; cursor:pointer; white-space:nowrap; font-size:calc(12.5px * var(--scale)); color:#f2f2f2; }
.menu .mi:hover { background: rgba(255,255,255,.14); }
.menu .mi .ic { width: 1.3em; text-align: center; flex: none; }
.menu .mi.busy { opacity: .5; pointer-events: none; }
.menu .hint { padding: 4px 9px 6px; font-size: 10.5px; color: #8ea3b5; }
.btn.more .caret { opacity: .65; margin-left: 2px; }
.logbox {
  position: fixed; z-index: 2147483647; right: 16px; top: 96px; display: none; pointer-events: auto;
  width: min(340px, 40vw); max-height: 46vh; overflow: hidden; color: #dbe6ef;
  background: rgba(18,20,24,.93); border: 1px solid rgba(255,255,255,.16); border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,.4); backdrop-filter: blur(14px) saturate(160%); -webkit-backdrop-filter: blur(14px) saturate(160%);
}
.logbox.show { display: block; }
.logbox header { display:flex; align-items:center; gap:8px; padding:6px 9px; border-bottom:1px solid rgba(255,255,255,.12); font-weight:600; font-size:12px; cursor:move; }
.logbox header .sp { flex:1; }
.logbox header .act { cursor:pointer; opacity:.7; font-size:11.5px; } .logbox header .act:hover { opacity:1; }
.logbox .lines { max-height: calc(46vh - 32px); overflow:auto; padding:6px 9px 8px; font-family: ui-monospace,Consolas,monospace; font-size:11.5px; line-height:1.5; }
.logbox .ln { display:flex; gap:7px; white-space:pre-wrap; word-break:break-word; }
.logbox .ln .ts { color:#6f8497; flex:none; }
.logbox .ln.err { color:#ff8a8a; }
.logbox .ln.busy { color:#9fe8c8; }
.logbox .ln.busy .tx::before { content:''; display:inline-block; width:7px; height:7px; margin-right:6px; border-radius:50%; background:#5ce08a; animation: mtb-pulse 1s infinite ease-in-out; }
@keyframes mtb-pulse { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
.panel {
  position: absolute; z-index: 2147483647; display: none; max-width: min(560px, 92vw); pointer-events: auto;
  background: rgba(22,22,24,.94); backdrop-filter: blur(16px) saturate(180%); -webkit-backdrop-filter: blur(16px) saturate(180%);
  color: #f2f2f2; border: 1px solid rgba(255,255,255,.16); border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0,0,0,.45); font-size: 12.5px; line-height: 1.5; overflow: hidden;
}
.panel.show { display: block; }
.panel header { display:flex; align-items:center; gap:8px; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,.12); font-weight: 600; cursor: move; }
.panel header .sp { flex: 1; }
.panel .body { padding: 10px; max-height: 62vh; overflow: auto; }
.panel .row { display:flex; gap:6px; align-items:center; flex-wrap: wrap; margin: 4px 0; }
.panel .k { color:#9fb4c7; min-width: 92px; display:inline-block; }
.panel pre { margin:0; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace,Consolas,monospace; font-size: 12px; }
.panel button.act { background: rgba(255,255,255,.12); border:1px solid rgba(255,255,255,.2); color:#fff; border-radius:6px; padding:4px 9px; cursor:pointer; font-size:12px; }
.panel button.act:hover { background: rgba(255,255,255,.22); }
.panel img.result { max-width: 100%; max-height: 46vh; display:block; border-radius:6px; border:1px solid rgba(255,255,255,.18); }
.panel .thumbs { display:flex; gap:6px; flex-wrap:wrap; }
.panel .thumbs figure { margin:0; width: 92px; }
.panel .thumbs img { width:92px; height: auto; display:block; border-radius:4px; border:1px solid rgba(255,255,255,.2); }
.panel .thumbs figcaption { font-size:10.5px; color:#9fb4c7; text-align:center; }
.panel .close { cursor:pointer; opacity:.7; } .panel .close:hover { opacity:1; }
.masklayer { position:absolute; pointer-events:none; left:0; top:0; }
.masklayer canvas { position:absolute; left:0; top:0; width:100%; height:100%; }
.boxlayer { position:absolute; pointer-events:none; inset:0; }
.box { position:absolute; border:2px solid var(--bc, #5ce08a); box-shadow: 0 0 0 1px rgba(0,0,0,.5) inset; }
.box .tag { position:absolute; left:0; top:-16px; background: var(--bc,#5ce08a); color:#04121a; font-size:10px; padding:0 4px; border-radius:3px; white-space:nowrap; font-weight:700; }
.pt { position:absolute; width:7px; height:7px; margin:-3.5px; border-radius:50%; background:#ff5c7a; box-shadow:0 0 0 1px #000; }
.toast { position:absolute; z-index:2147483647; left:50%; transform:translateX(-50%); bottom:24px; pointer-events:auto;
  background:rgba(20,20,22,.95); color:#fff; padding:8px 14px; border-radius:8px; font-size:13px;
  border:1px solid rgba(255,255,255,.18); box-shadow:0 8px 24px rgba(0,0,0,.4); display:none; max-width:80vw; }
.toast.show { display:block; }
.toast.err { border-color:#ff6b6b; }
.pickhint { position:absolute; z-index:2147483647; left:50%; transform:translateX(-50%); top:12px; pointer-events:auto; background:rgba(10,30,20,.92);
  color:#bfffd8; border:1px solid rgba(120,255,180,.5); padding:6px 12px; border-radius:8px; font-size:12.5px; display:none; }
.pickhint.show { display:block; }
.prompt { position:absolute; z-index:2147483647; display:none; pointer-events:auto; background:rgba(22,22,24,.96); border:1px solid rgba(255,255,255,.2);
  border-radius:10px; padding:10px; width: min(420px, 90vw); box-shadow:0 12px 40px rgba(0,0,0,.5); }
.prompt.show { display:block; }
.prompt textarea { width:100%; height:64px; background:#111; color:#eee; border:1px solid rgba(255,255,255,.2); border-radius:6px; padding:6px; font-size:12.5px; resize:vertical; }
.prompt .row { display:flex; gap:6px; justify-content:flex-end; margin-top:8px; }
.prompt button { background:rgba(255,255,255,.12); border:1px solid rgba(255,255,255,.2); color:#fff; border-radius:6px; padding:4px 10px; cursor:pointer; font-size:12px; }
.prompt button.primary { background:#0a84ff; border-color:#0a84ff; }
`;

export function ensureRoot() {
    let host = document.getElementById(ROOT_ID);
    if (host) return { host, shadow: host.shadowRoot };
    host = document.createElement('div');
    host.id = ROOT_ID;
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483647;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    document.documentElement.appendChild(host);
    return { host, shadow };
}

export function mountToolbar({ shadow, settings }) {
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.setAttribute('data-theme', settings.toolbar.theme);
    shadow.appendChild(wrap);
    const mask = document.createElement('div');
    mask.className = 'masklayer';
    shadow.appendChild(mask);
    const box = document.createElement('div');
    box.className = 'boxlayer';
    box.style.cssText = 'display:none;position:absolute;';
    shadow.appendChild(box);
    return { wrap, mask, box };
}

export class Toolbar {
    constructor({ wrap, settings, onDragEnd }) {
        this.wrap = wrap;
        this.settings = settings;
        this.onDragEnd = onDragEnd;
        this.items = [];
        this.buttons = new Map();
        this.dragging = false;
        this.pointer = { x: 0, y: 0 };
        this.bindDrag();
    }

    applySettings(settings) {
        this.settings = settings;
        const t = settings.toolbar;
        this.wrap.style.setProperty('--scale', String(t.scale));
        this.wrap.style.setProperty('--gap', t.gap + 'px');
        this.wrap.style.setProperty('--radius', t.radius + 'px');
        this.wrap.style.opacity = String(t.opacity);
        this.wrap.setAttribute('data-theme', t.theme);
        this.wrap.classList.toggle('vertical', t.layout === 'vertical');
        this.wrap.classList.toggle('grid', t.layout === 'grid');
        if (t.layout === 'grid') this.wrap.style.setProperty('--cols', String(t.gridColumns || 3));
        // 用新设置重建清单：直接渲染旧的 this.items 会让「常驻/折叠」改动拖到下次悬停才生效
        const items = this.itemBuilder ? this.itemBuilder(settings, this.mediaType || 'image') : this.items;
        this.render(items, this.mediaType);
    }

    render(items, mediaType) {
        this.items = items;
        this.mediaType = mediaType;
        this.buttons.clear();
        this.wrap.innerHTML = '';
        this.menu = null; // wrap 被清空，菜单节点也随之作废，必须重建
        this.menuOpen = false;
        const handle = document.createElement('div');
        handle.className = 'draghandle';
        handle.textContent = '⠿';
        handle.title = '拖动可改变工具栏位置';
        this.wrap.appendChild(handle);
        const limit = this.settings.toolbar.maxTools | 0;
        const capped = limit > 0 ? items.slice(0, limit) : items;
        const overflow = limit > 0 ? items.slice(limit) : [];
        // 常驻的直接排开，折叠的（加上超出 maxTools 的）收进 ▾ 下拉
        const pinned = capped.filter((it) => !it.collapsed);
        const folded = capped.filter((it) => it.collapsed).concat(overflow);
        for (const it of pinned) this.wrap.appendChild(this.makeButton(it));
        this.menuItems = folded;
        this.moreBtn = null;
        this.closeMenu();
        if (folded.length) {
            const more = document.createElement('button');
            more.className = 'btn more';
            more.innerHTML = `<span class="ic">⋯</span><span class="tx">更多</span><span class="caret">▾</span>`;
            more.title = `${folded.length} 个折叠的按钮`;
            more.dataset.tool = '__more';
            more.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.toggleMenu(); };
            this.wrap.appendChild(more);
            this.moreBtn = more;
            this.renderMenu();
        }
        const gear = document.createElement('button');
        gear.className = 'btn';
        gear.innerHTML = '<span class="ic">⚙️</span>';
        gear.title = '打开设置（可在设置里勾选要显示的按钮）';
        gear.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.onOpenSettings?.(); };
        this.wrap.appendChild(gear);
    }

    ensureMenu() {
        if (!this.menu) {
            const m = document.createElement('div');
            m.className = 'menu';
            this.wrap.appendChild(m);
            this.menu = m;
        }
        if (!this._docBound) {
            this._docBound = true;
            // 页面里很多组件会 stopPropagation，用捕获阶段才收得到「点了别处」；
            // shadow 里的目标在 document 上会被重定向，所以必须看 composedPath。
            // 监听只挂一次，内部一律读 this.menu（节点会随 render 重建）
            document.addEventListener('pointerdown', (e) => {
                if (!this.menuOpen || !this.menu) return;
                const path = e.composedPath ? e.composedPath() : [e.target];
                if (path.includes(this.menu) || (this.moreBtn && path.includes(this.moreBtn))) return;
                this.closeMenu();
            }, true);
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeMenu(); }, true);
        }
        return this.menu;
    }

    renderMenu() {
        const m = this.ensureMenu();
        m.innerHTML = '';
        const tip = document.createElement('div');
        tip.className = 'hint';
        tip.textContent = '折叠的功能（在设置里可改回常驻）';
        m.appendChild(tip);
        for (const it of this.menuItems || []) {
            const row = document.createElement('div');
            row.className = 'mi';
            row.innerHTML = `<span class="ic">${escapeHtml(it.icon || '•')}</span><span class="tx">${escapeHtml(it.label)}</span>`;
            row.title = it.hint || it.label;
            row.dataset.tool = it.id;
            row.onclick = (e) => {
                e.preventDefault(); e.stopPropagation();
                this.closeMenu();
                this.onClick?.(it, row, e);
            };
            this.buttons.set(it.id, row);
            m.appendChild(row);
        }
    }

    placeMenu() {
        const m = this.menu;
        if (!m) return;
        m.style.bottom = 'auto'; m.style.top = 'auto'; m.style.left = 'auto'; m.style.right = 'auto';
        const r = this.wrap.getBoundingClientRect();
        const h = m.offsetHeight;
        if (r.bottom + h + 10 > window.innerHeight && r.top - h - 10 > 0) {
            m.style.bottom = '100%';
            m.style.marginBottom = '4px';
        } else {
            m.style.top = '100%';
            m.style.marginTop = '4px';
        }
        // 菜单跟着「⋯ 更多」按钮走：CSS 里 .menu 是 left:0，会贴到整条工具栏的左端，
        // 按钮在右边时看着就像"菜单飘在别处"。这里按按钮对齐，并保证不出视口。
        const btn = (this.moreBtn ? this.moreBtn.getBoundingClientRect() : r);
        const w = m.offsetWidth || 168;
        let x = btn.left;
        if (x + w > window.innerWidth - 4) x = btn.right - w;
        x = Math.max(4, Math.min(x, window.innerWidth - w - 4));
        m.style.left = `${Math.round(x - r.left)}px`;
    }

    openMenu() {
        if (!this.menuItems || !this.menuItems.length) return;
        const m = this.ensureMenu();
        m.classList.add('show');
        this.menuOpen = true;
        this.placeMenu();
    }

    toggleMenu() { if (this.menuOpen) this.closeMenu(); else this.openMenu(); }

    closeMenu() {
        this.menuOpen = false;
        if (this.menu) this.menu.classList.remove('show');
    }

    makeButton(item) {
        const b = document.createElement('button');
        const mode = this.settings.toolbar.iconMode;
        b.className = 'btn' + (mode === 'icon' ? ' icon' : mode === 'text' ? ' text' : '');
        b.innerHTML = `<span class="ic">${escapeHtml(item.icon || '•')}</span><span class="tx">${escapeHtml(item.label)}</span>`;
        b.title = item.hint || item.label;
        b.dataset.tool = item.id;
        b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.onClick?.(item, b, e); };
        this.buttons.set(item.id, b);
        return b;
    }

    setBusy(id, text) {
        const b = this.buttons.get(id);
        if (!b) { this.onLog?.(text || ''); return; }   // '__progress' 这类没有对应按钮的，交给日志窗
        b.disabled = !!text;
        b.classList.toggle('busy', !!text);
        if (text) this.onLog?.(text);
    }

    resetBusy() {
        for (const b of this.buttons.values()) {
            b.disabled = false;
            b.classList.remove('busy');
        }
    }

    bindDrag() {
        let start = null;
        const onDown = (e) => {
            if (!e.target.classList.contains('draghandle')) return;
            e.preventDefault(); e.stopPropagation();
            this.dragging = true;
            this.wrap.classList.add('dragging');
            // 拖动基准是「当前已经落位的屏幕坐标」：位置是锁住的，不能从媒体矩形重算
            start = {
                x: e.clientX, y: e.clientY,
                placed: { ...(this.placed || this.lock || { x: 0, y: 0 }) },
                off: { ...this.settings.toolbar },
            };
            window.addEventListener('pointermove', onMove, true);
            window.addEventListener('pointerup', onUp, true);
        };
        const onMove = (e) => {
            if (!this.dragging) return;
            e.preventDefault();
            this.lock = { x: start.placed.x + (e.clientX - start.x), y: start.placed.y + (e.clientY - start.y) };
            this.placeAt(this.lock.x, this.lock.y);
        };
        const onUp = async () => {
            if (!this.dragging) return;
            this.dragging = false;
            this.wrap.classList.remove('dragging');
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
            // 只累加「真正移动了多少」：拖到屏幕边上被夹住时不会把偏移量算多，
            // 下次重新锚定（换图后首次弹出）才能落在拖过的位置
            const dx = Math.round((this.placed?.x ?? 0) - start.placed.x);
            const dy = Math.round((this.placed?.y ?? 0) - start.placed.y);
            const next = { ...this.settings.toolbar, offsetX: Math.round((start.off.offsetX || 0) + dx), offsetY: Math.round((start.off.offsetY || 0) + dy), anchorOffset: 'custom', dragMoved: true };
            this.settings.toolbar = next;
            await this.onDragEnd?.(next);
        };
        this.wrap.addEventListener('pointerdown', onDown, true);
        // 在窗口外松手 / 系统打断手势时 pointerup 会丢，拖拽状态卡住就一直残留
        const abort = () => {
            if (!this.dragging) return;
            this.dragging = false;
            this.wrap.classList.remove('dragging');
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
        };
        window.addEventListener('pointercancel', abort, true);
        window.addEventListener('blur', abort, true);
    }

    // 按 anchor+offset 算出工具栏应落在的屏幕坐标（视口系）
    anchorPoint(rect) {
        const t = this.settings.toolbar;
        const w = this.wrap.offsetWidth, h = this.wrap.offsetHeight;
        const m = 8;
        let top, left;
        switch (t.anchor) {
            case 'top-left': top = rect.top + m; left = rect.left + m; break;
            case 'bottom-right': top = rect.bottom - h - m; left = rect.right - w - m; break;
            case 'bottom-left': top = rect.bottom - h - m; left = rect.left + m; break;
            case 'center': top = rect.top + (rect.height - h) / 2; left = rect.left + (rect.width - w) / 2; break;
            case 'top-edge': top = rect.top + m; left = rect.left + (rect.width - w) / 2; break;
            case 'bottom-edge': top = rect.bottom - h - m; left = rect.left + (rect.width - w) / 2; break;
            case 'left-edge': top = rect.top + (rect.height - h) / 2; left = rect.left + m; break;
            case 'right-edge': top = rect.top + (rect.height - h) / 2; left = rect.right - w - m; break;
            default: top = rect.top + m; left = rect.right - w - m;
        }
        return { x: left + (t.offsetX || 0), y: top + (t.offsetY || 0) };
    }

    // 视口夹取：按钮多到比视口还宽时 Math.max 兜底的下界优先，保证不会被推出屏幕
    placeAt(x, y) {
        const host = this.wrap.getRootNode().host;
        const hr = host ? host.getBoundingClientRect() : null;
        const ox = hr ? hr.left : 0, oy = hr ? hr.top : 0;
        const vw = hr && hr.width ? hr.width : window.innerWidth;
        const vh = hr && hr.height ? hr.height : window.innerHeight;
        const w = this.wrap.offsetWidth, h = this.wrap.offsetHeight;
        // 宿主是铺满视口的 fixed 层，绝对定位的坐标原点就是宿主左上角。
        // 旧写法额外加 window.scrollX/Y，页面一滚动工具栏就跟着往下飞
        const cx = Math.max(4, Math.min(x - ox, Math.max(4, vw - w - 4)));
        const cy = Math.max(4, Math.min(y - oy, Math.max(4, vh - h - 4)));
        this.wrap.style.left = cx + 'px';
        this.wrap.style.top = cy + 'px';
        this.placed = { x: cx + ox, y: cy + oy };
    }

    // rect = 媒体元素在视口中的矩形。位置只在「首次显示」与「手动拖拽」时定，
    // 已经显示着的时候换图、滚动、探测刷新都不会让它自己挪。
    position(rect, force = false) {
        if (!rect) return;
        this.currentTarget = rect;
        if (force || !this.lock) this.lock = this.anchorPoint(rect);
        this.placeAt(this.lock.x, this.lock.y);
        if (this.menuOpen) this.placeMenu();
        if (this.onMoved) this.onMoved(rect);
    }

    show(rect) {
        if (!this.wrap.classList.contains('show')) this.lock = null;   // 重新弹出才按当前媒体锚定
        this.wrap.classList.add('show');
        this.position(rect);
    }

    hide() {
        this.wrap.classList.remove('show');
        this.currentTarget = null;
        this.lock = null;
        this.placed = null;
    }
}

export class ResultPanel {
    constructor({ shadow, settings }) {
        this.shadow = shadow;
        this.el = document.createElement('div');
        this.el.className = 'panel';
        this.el.innerHTML = `<header><span class="tt">结果</span><span class="sp"></span><span class="act export">导出</span><span class="act copy">复制</span><span class="close">✕</span></header><div class="body"></div>`;
        shadow.appendChild(this.el);
        this.tt = this.el.querySelector('.tt');
        this.body = this.el.querySelector('.body');
        this.el.querySelector('.close').onclick = () => this.hide();
        this.bindDrag();
        this.current = null;
    }

    bindDrag() {
        const header = this.el.querySelector('header');
        let s = null;
        header.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.act') || e.target.closest('.close')) return;
            s = { x: e.clientX, y: e.clientY, top: parseFloat(this.el.style.top), left: parseFloat(this.el.style.left) };
            header.setPointerCapture(e.pointerId);
        });
        header.addEventListener('pointermove', (e) => {
            if (!s) return;
            this.el.style.left = (s.left + e.clientX - s.x) + 'px';
            this.el.style.top = (s.top + e.clientY - s.y) + 'px';
        });
        header.addEventListener('pointerup', () => { s = null; });
    }

    show({ title = '结果', html = '', dataUrl = null, text = null, actions = [], near = null, thumbs = null }) {
        this.tt.textContent = title;
        const parts = [];
        if (dataUrl) parts.push(`<img class="result" src="${dataUrl}" alt="结果" />`);
        if (thumbs?.length) parts.push('<div class="thumbs">' + thumbs.map((t) => `<figure><img src="${t.dataUrl}"/><figcaption>${escapeHtml(t.caption || '')}</figcaption></figure>`).join('') + '</div>');
        if (text) parts.push(`<pre>${escapeHtml(text)}</pre>`);
        if (html) parts.push(html);
        this.body.innerHTML = parts.join('');
        const row = document.createElement('div');
        row.className = 'row';
        for (const a of actions) {
            const b = document.createElement('button');
            b.className = 'act';
            b.textContent = a.label;
            b.onclick = () => a.run();
            row.appendChild(b);
        }
        if (row.childNodes.length) this.body.appendChild(row);
        this.current = { dataUrl, text };
        this.el.classList.add('show');
        this.el.querySelector('.export').style.display = dataUrl ? '' : 'none';
        this.el.querySelector('.copy').style.display = (text || dataUrl) ? '' : 'none';
        this.place(near);
        return this;
    }

    place(near) {
        const w = this.el.offsetWidth, h = this.el.offsetHeight;
        // 日志窗占着右边，结果面板别再压上去
        const dock = this.shadow && this.shadow.querySelector('.logbox.show');
        const reserve = dock ? dock.offsetWidth + 28 : 16;
        let left = near ? near.right + 12 : innerWidth - w - reserve;
        if (left + w > innerWidth - reserve || !near) left = Math.max(8, innerWidth - w - reserve);
        const top = near ? Math.max(8, Math.min(near.top, innerHeight - h - 12)) : 40;
        this.el.style.left = left + 'px';
        this.el.style.top = top + 'px';
        this.el.style.position = 'fixed';
    }

    hide() { this.el.classList.remove('show'); }
    get visible() { return this.el.classList.contains('show'); }
}

/** 右侧悬浮日志窗：推理中/取帧/失败这类过程信息都进这里，不再挤在工具栏按钮旁边 */
export class LogDock {
    constructor({ shadow, autoHideMs = 10000, max = 120 }) {
        const el = document.createElement('div');
        el.className = 'logbox';
        el.innerHTML = `<header><span class="tt">日志</span><span class="sp"></span><span class="act clear">清空</span><span class="act close">✕</span></header><div class="lines"></div>`;
        shadow.appendChild(el);
        this.el = el;
        this.lines = el.querySelector('.lines');
        this.max = max;
        this.autoHideMs = autoHideMs;
        this.busy = null;
        this.timer = 0;
        el.querySelector('.close').onclick = () => this.hide();
        el.querySelector('.clear').onclick = () => { this.lines.innerHTML = ''; this.busy = null; this.hide(); };
        this.bindDrag();
        el.__log = (text, err) => this.line(text, { err });
    }

    line(text, { err = false } = {}) {
        const t = String(text || '').trim();
        if (!t) return null;
        this.endBusy();
        const row = this.append(t, { err });
        this.open();
        this.scheduleHide();
        return row;
    }

    // 进行中的任务原地刷同一行（准备模型… → 推理中…），传空串表示结束并补上耗时
    status(text) {
        const t = String(text || '').trim();
        if (!t) { this.endBusy(); this.scheduleHide(); return; }
        const err = /失败|错误|异常/.test(t);
        if (this.busy) {
            if (this.busy.text !== t) { this.busy.text = t; this.busy.row.querySelector('.tx').textContent = t; }
            this.busy.row.classList.toggle('err', err);
            clearTimeout(this.timer);
        } else {
            this.busy = { row: this.append(t, { err, busy: true }), text: t, at: Date.now() };
            this.open();
        }
        return this;
    }

    endBusy() {
        if (!this.busy) return;
        const { row, at, text } = this.busy;
        const secs = (Date.now() - at) / 1000;
        row.querySelector('.tx').textContent = `${text} · ${secs >= 1 ? secs.toFixed(1) + 's' : Math.round(secs * 1000) + 'ms'}`;
        row.classList.remove('busy');
        this.busy = null;
    }

    append(text, { err = false, busy = false } = {}) {
        const row = document.createElement('div');
        row.className = 'ln' + (err ? ' err' : '') + (busy ? ' busy' : '');
        const ts = document.createElement('span');
        ts.className = 'ts';
        ts.textContent = clockTime();
        const tx = document.createElement('span');
        tx.className = 'tx';
        tx.textContent = text;
        row.append(ts, tx);
        this.lines.appendChild(row);
        while (this.lines.children.length > this.max) this.lines.removeChild(this.lines.firstChild);
        this.lines.scrollTop = this.lines.scrollHeight;
        return row;
    }

    open() { this.el.classList.add('show'); }
    hide() { this.endBusy(); this.el.classList.remove('show'); }
    get visible() { return this.el.classList.contains('show'); }
    scheduleHide() { clearTimeout(this.timer); this.timer = setTimeout(() => this.hide(), this.autoHideMs); }

    bindDrag() {
        const header = this.el.querySelector('header');
        let s = null;
        header.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.act')) return;
            const r = this.el.getBoundingClientRect();
            s = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
            header.setPointerCapture(e.pointerId);
        });
        header.addEventListener('pointermove', (e) => {
            if (!s) return;
            this.el.style.right = 'auto';
            this.el.style.left = Math.max(4, s.left + e.clientX - s.x) + 'px';
            this.el.style.top = Math.max(4, Math.min(s.top + e.clientY - s.y, innerHeight - 40)) + 'px';
        });
        header.addEventListener('pointerup', () => { s = null; });
        header.addEventListener('pointercancel', () => { s = null; });
    }
}

function clockTime() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export class Picker {
    constructor({ shadow, settings }) {
        this.el = document.createElement('div');
        this.el.className = 'pickhint';
        shadow.appendChild(this.el);
        this.active = false;
        this.handler = null;
    }

    start(text, onPoint, onDone) {
        this.active = true;
        this.el.textContent = text;
        this.el.classList.add('show');
        this.onPoint = onPoint;
        this.onDone = onDone;
        this.handler = (e) => {
            if (!this.active) return;
            if (e.key === 'Escape') { this.stop(); onDone?.(null); return; }
            if (e.type !== 'mousedown') return;
            const t = e.target;
            if (t.closest && t.closest('#' + ROOT_ID)) return;
            e.preventDefault(); e.stopPropagation();
            const rect = this.rect || document.body.getBoundingClientRect();
            onPoint?.({ clientX: e.clientX, clientY: e.clientY, x: e.clientX - rect.left, y: e.clientY - rect.top, negative: e.button === 2 || e.shiftKey });
            if (e.button === 2) this.stop(), onDone?.('cancel');
        };
        window.addEventListener('mousedown', this.handler, true);
        window.addEventListener('keydown', this.handler, true);
        // 屏蔽页面自身对该次点击的响应
        const blocker = (e) => { if (this.active) { e.stopPropagation(); } };
        this.blocker = blocker;
        for (const type of ['mousedown', 'mouseup', 'click']) window.addEventListener(type, blocker, true);
    }

    stop() {
        this.active = false;
        this.el.classList.remove('show');
        if (this.handler) { window.removeEventListener('mousedown', this.handler, true); window.removeEventListener('keydown', this.handler, true); }
        if (this.blocker) for (const type of ['mousedown', 'mouseup', 'click']) window.removeEventListener(type, this.blocker, true);
    }

    setRect(rect) { this.rect = rect; }
}

export function drawBoxes(layer, boxes, rect) {
    if (!layer) return;
    layer.innerHTML = '';
    if (!boxes || !boxes.length || !rect) { layer.style.display = 'none'; return; }
    layer.style.display = 'block';
    layer.style.left = rect.left + window.scrollX + 'px';
    layer.style.top = rect.top + window.scrollY + 'px';
    layer.style.width = rect.width + 'px';
    layer.style.height = rect.height + 'px';
    const kx = rect.width, ky = rect.height;
    boxes.forEach((b, i) => {
        const d = document.createElement('div');
        d.className = 'box';
        const colors = ['#5ce08a', '#ff6b8a', '#5cc8ff', '#ffd166', '#c77dff'];
        d.style.setProperty('--bc', b.color || colors[i % colors.length]);
        d.style.left = (b.x / (b.refWidth || kx) * 100) + '%';
        d.style.top = (b.y / (b.refHeight || ky) * 100) + '%';
        d.style.width = ((b.width || 10) / (b.refWidth || kx) * 100) + '%';
        d.style.height = ((b.height || 10) / (b.refHeight || ky) * 100) + '%';
        if (b.label) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = b.label; d.appendChild(t); }
        layer.appendChild(d);
    });
    for (const p of (boxes.points || [])) {
        const dot = document.createElement('div');
        dot.className = 'pt';
        dot.style.left = (p.x / kx * 100) + '%';
        dot.style.top = (p.y / ky * 100) + '%';
        layer.appendChild(dot);
    }
}

export function drawMask(layer, maskUrls, rect, { color = 'rgba(90,220,140,.45)' } = {}) {
    if (!layer) return;
    layer.innerHTML = '';
    if (!rect) return;
    layer.style.left = rect.left + window.scrollX + 'px';
    layer.style.top = rect.top + window.scrollY + 'px';
    layer.style.width = rect.width + 'px';
    layer.style.height = rect.height + 'px';
    (maskUrls || []).forEach((url) => {
        const c = document.createElement('canvas');
        const img = new Image();
        img.onload = () => {
            c.width = img.width; c.height = img.height;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const id = ctx.getImageData(0, 0, c.width, c.height);
            for (let i = 0; i < id.data.length; i += 4) {
                const on = id.data[i] > 127;
                id.data[i] = on ? 90 : 0; id.data[i + 1] = on ? 220 : 0; id.data[i + 2] = on ? 140 : 0;
                id.data[i + 3] = on ? 115 : 0;
            }
            ctx.putImageData(id, 0, 0);
        };
        img.src = url;
        layer.appendChild(c);
    });
}

export function toast(shadow, text, ms = 2600, isError = false) {
    let el = shadow.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; shadow.appendChild(el); }
    el.textContent = text;
    el.classList.toggle('err', !!isError);
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), ms);
    const dock = shadow.querySelector('.logbox');
    if (dock && dock.__log) dock.__log(text, !!isError);   // 一闪而过的提示在日志窗里留个底
    return el;
}

export function promptFor(shadow, { title = '输入', placeholder = '', value = '', near = null } = {}) {
    return new Promise((resolve) => {
        let el = shadow.querySelector('.prompt');
        if (!el) {
            el = document.createElement('div');
            el.className = 'prompt';
            el.innerHTML = `<div class="t"></div><textarea></textarea><div class="row"><button class="c">取消</button><button class="primary ok">确定</button></div>`;
            shadow.appendChild(el);
        }
        el.querySelector('.t').textContent = title;
        const ta = el.querySelector('textarea');
        ta.value = value;
        el.classList.add('show');
        el.style.position = 'fixed';
        el.style.left = (near ? Math.min(near.left, innerWidth - 440) : innerWidth / 2 - 210) + 'px';
        el.style.top = (near ? Math.max(10, near.top) : innerHeight / 3) + 'px';
        const done = (v) => { el.classList.remove('show'); el.querySelector('.ok').onclick = null; el.querySelector('.c').onclick = null; resolve(v); };
        el.querySelector('.ok').onclick = () => done(ta.value.trim());
        el.querySelector('.c').onclick = () => done(null);
        ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(ta.value.trim()); } if (e.key === 'Escape') done(null); };
        setTimeout(() => ta.focus(), 30);
    });
}

export function attachToActiveLayer(host) {
    const fs = document.fullscreenElement;
    const target = fs && !['VIDEO', 'AUDIO', 'CANVAS', 'IMG', 'PICTURE'].includes(fs.tagName) ? fs : document.documentElement;
    if (host.parentNode !== target) target.appendChild(host);
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export { escapeHtml, ROOT_ID };
