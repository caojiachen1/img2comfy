// 工具执行分发：内置能力（内容脚本本地做）、算子链与 AI（宿主页面做）、
// 用户脚本（宿主里的 QuickJS 解释执行）、链接型工具（模板替换后开标签/POST）。

import { captureVideoFrame, captureFrames, seekTo, videoTimeList, bgSend } from './frame.js';
import { sanitizeFilename, filenameFromUrl, fillTemplate, fillTemplateRaw, formatBytes, ratioText, dataUrlToBytes, bytesToDataUrl } from '../common/util.js';
import { runChain, STEPS } from '../common/steps.js';
import { resize as resizePx, mkPx } from '../common/imgops/geometry.js';
import { toast, drawBoxes, drawMask, promptFor, ResultPanel, ROOT_ID } from './ui.mjs';
import { extAlive, friendlyError, DEAD_TEXT } from '../common/ext-state.js';
import { LLM_TASKS, normalizeLlm } from '../common/ai/llm-api.js';

// 上下文失效时不加「XX失败: 」前缀，直接把那句完整指令给用户
const errText = (prefix, e) => { const f = friendlyError(e); return f.dead ? f.text : prefix + f.text; };

async function toPngBlob(dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    if (blob.type === 'image/png') return blob;
    const bmp = await createImageBitmap(blob);
    const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(bmp.width, bmp.height) : null;
    const c2 = c || Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    (c2.getContext('2d')).drawImage(bmp, 0, 0);
    if (c2.convertToBlob) return await c2.convertToBlob({ type: 'image/png' });
    return await new Promise((r) => c2.toBlob(r, 'image/png'));
}

async function copyViaExecCommand(blob) {
    const url = URL.createObjectURL(blob);
    let holder = null;
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        holder = document.createElement('div');
        holder.contentEditable = 'true';
        holder.style.cssText = 'position:fixed;left:-20000px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;';
        holder.appendChild(img);
        document.body.appendChild(holder);
        const range = document.createRange();
        range.selectNodeContents(img);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return document.execCommand('copy');
    } catch (e) {
        return false;
    } finally {
        if (holder) holder.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
}

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];

function nextRate(cur) {
    const c = Number(cur) || 1;
    return RATES.find((r) => r > c + 0.001) || RATES[0];
}

// 站点播放器会在 play / 换源 / seek 之后把我们设的倍速与循环改回去（B 站、抖音都会）。
// 记下用户意图，在这些事件上重新按一次；同时把最终值读回来如实报告，别再谎报成功。
const mediaIntent = new WeakMap();
function intentFor(el) {
    let rec = mediaIntent.get(el);
    if (!rec) {
        rec = {};
        mediaIntent.set(el, rec);
        const reapply = () => {
            if (rec.rate != null && el.playbackRate !== rec.rate) { try { el.playbackRate = rec.rate; } catch (e) { /* 站点不让改 */ } }
            if (rec.loop != null && el.loop !== rec.loop) { try { el.loop = rec.loop; } catch (e) { /* 同上 */ } }
        };
        for (const ev of ['play', 'playing', 'loadedmetadata', 'seeked']) el.addEventListener(ev, reapply, true);
    }
    return rec;
}

function setRate(el, r) {
    intentFor(el).rate = r;
    try { el.playbackRate = r; } catch (e) { /* 站点锁了 */ }
    try { el.defaultPlaybackRate = r; } catch (e) { /* 同上 */ }
    return el.playbackRate;
}

function setLoop(el, v) {
    intentFor(el).loop = v;
    try { el.loop = v; } catch (e) { /* 站点锁了 */ }
    return el.loop;
}

const playable = (el) => !!(el && (el.currentSrc || el.src || el.readyState > 0 || (isFinite(el.duration) && el.duration > 0)));

export class Runner {
    constructor(ctx) {
        this.ctx = ctx; // {settings, media, toolbar, panel, shadow, refreshSettings, ensureHost, hostSend, items}
    }

    get s() { return this.ctx.settings; }

    async sendToHost(req) {
        // 扩展刚在 edge://extensions 里重载过时，这份内容脚本已经是僵尸，任何消息都会失败；
        // 先说清楚「刷新页面」，别让 Chrome 的内部术语冒充业务错误
        if (!extAlive()) throw new Error(DEAD_TEXT);
        let res;
        try {
            await this.ctx.ensureHost();
            res = await this.ctx.hostSend({ action: 'mtbHost', ...req });
        } catch (e) {
            const f = friendlyError(e);
            throw new Error(f.dead ? DEAD_TEXT : f.text);
        }
        if (!res) throw new Error('宿主无响应（可能刚更新，请刷新页面）');
        if (!res.ok) {
            const f = friendlyError({ message: res.error });
            throw new Error(f.dead ? DEAD_TEXT : res.error + (res.stack ? ' @ ' + res.stack : ''));
        }
        return res;
    }

    // 当前媒体源：图片取直链，视频取当前帧 dataUrl，背景图取解析出的 URL
    async currentSource({ forVideo = true } = {}) {
        const m = this.ctx.media;
        if (!m) throw new Error('没有定位到媒体元素');
        if (m.kind === 'video') {
            if (!forVideo) throw new Error('该工具只支持图片');
            const f = await captureVideoFrame(m.el, {
                onProgress: (t) => this.ctx.toolbar?.setBusy?.('__progress', t),
                trim: this.s.video.trimLetterbox,
                maxSide: this.s.video.frameMaxSide || 0,
                format: this.s.video.frameFormat || 'png',
            });
            return { dataUrl: f.dataUrl, width: f.width, height: f.height, via: f.method, mime: f.mime, isFrame: true, time: m.el.currentTime };
        }
        const src = m.src || (m.el.currentSrc || m.el.src) || '';
        if (!src) throw new Error('取不到图片地址');
        if (m.kind === 'bg') return { url: src, pageUrl: location.href, src };
        if (src.startsWith('data:')) return { dataUrl: src };
        return { url: src, pageUrl: location.href, src };
    }

    async runImageOp(item) {
        const chain = (item.action.chain || []).map((st) => ({ ...st, params: { ...(st.params || {}), ...(item.params || {}) } }));
        const src = await this.currentSource();
        this.ctx.setStatus?.('处理中…');
        const res = await this.sendToHost({ type: 'op', ...src, chain, format: this.s.output.format, quality: this.s.output.quality });
        const reports = res.reports || [];
        const analysisOnly = chain.every((s) => STEPS[s.op]?.analysis);
        if (res.dataUrl && this.s.output.showResultOverlay !== false) {
            this.showResult(item, res, reports, analysisOnly);
        } else if (res.dataUrl && this.s.output.autoDownloadAfterOp) {
            await this.saveDataUrl(res.dataUrl, this.filenameFor(item, res));
        }
        if (!res.dataUrl && !reports.length) toast(this.ctx.shadow, '没有产生可见变化', 1800);
        else if (reports.length && analysisOnly) this.showReport(item, reports);
        this.ctx.setStatus?.('');
        return res;
    }

    showResult(item, res, reports, analysisOnly) {
        const near = this.ctx.toolbar?.currentTarget || null;
        const rows = (reports || []).map((r) => `<div class="row"><span class="k">${esc(r.op)}</span><pre>${esc(fmt(r))}</pre></div>`).join('');
        this.ctx.panel.show({
            title: `${item.label} · ${res.width}×${res.height}`,
            dataUrl: analysisOnly ? null : res.dataUrl,
            html: rows ? `<div>${rows}</div>` : '',
            near,
            actions: [
                { label: '下载结果', run: () => this.saveDataUrl(res.dataUrl, this.filenameFor(item, res)) },
                { label: '复制图片', run: () => this.copyDataUrl(res.dataUrl) },
                { label: '再处理一次', run: () => { this.ctx.replaceTemp(res); toast(this.ctx.shadow, '已作为当前源，再点其它工具即在其上继续'); } },
                { label: '发到 ComfyUI', run: () => this.ctx.runToolById('send-comfy', { dataUrl: res.dataUrl }) },
            ],
        });
        if (this.s.output.copyAfterOp) this.copyDataUrl(res.dataUrl);
    }

    showReport(item, reports) {
        this.ctx.panel.show({
            title: item.label,
            html: `<div>${reports.map((r) => `<div class="row"><span class="k">${esc(r.op)}</span><pre>${esc(fmt(r))}</pre></div>`).join('')}</div>`,
            near: this.ctx.toolbar?.currentTarget,
            actions: [{ label: '复制报告', run: () => copyText(JSON.stringify(reports, null, 2)) }],
        });
    }

    filenameFor(item, res) {
        const m = this.ctx.media;
        const base = this.s.output.keepOriginalName
            ? (filenameFromUrl(m?.src || '', 'png').replace(/\.[a-z0-9]+$/i, '') || 'media')
            : (m?.kind === 'video' ? 'frame' : 'web');
        const pattern = this.s.output.filenamePattern || '{base}_{op}_{w}x{h}.{ext}';
        const ext = (res?.mime || 'image/png').split('/')[1]?.replace('jpeg', 'jpg') || 'png';
        return sanitizeFilename(fillTemplateRaw(pattern, {
            base, op: item.id, w: res?.width || m?.natural?.width || 0, h: res?.height || m?.natural?.height || 0,
            ext, t: Math.round((m?.el?.currentTime || 0) * 100) / 100, ts: Date.now(),
        }));
    }

    async saveDataUrl(dataUrl, filename) {
        const r = await bgSend({ action: 'downloadDataUrl', dataUrl, filename: sanitizeFilename(filename) });
        toast(this.ctx.shadow, r?.ok ? `已下载 ${filename}` : '下载失败: ' + (r?.error || ''), 2200, !r?.ok);
        return r;
    }

    async copyDataUrl(dataUrl) {
        try {
            // ClipboardItem 对图片基本只认 image/png（webp/jpeg 常常直接被拒），先统一转 PNG
            const blob = await toPngBlob(dataUrl);
            try {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                toast(this.ctx.shadow, '已复制图片', 1600);
                return;
            } catch (e) {
                // clipboard.write 要瞬时用户手势；站点抢焦点或前面等宿主太久就会 NotAllowedError。
                // execCommand('copy') 只要求文档有焦点，是这类场景唯一还能用的路子。
                if (await copyViaExecCommand(blob)) { toast(this.ctx.shadow, '已复制图片', 1600); return; }
                throw e;
            }
        } catch (e) {
            toast(this.ctx.shadow, '复制图片失败（站点可能禁用剪贴板）: ' + e.message, 2600, true);
        }
    }

    // —— 内置工具 ——
    async builtin(fn, item, override) {
        const m = this.ctx.media;
        switch (fn) {
            case 'copyLink': {
                const src = m.kind === 'video' ? (m.el.currentSrc || m.el.src) : (m.src || m.el.currentSrc || m.el.src);
                await copyText(src || '');
                toast(this.ctx.shadow, src ? '已复制链接' : '没有可复制的地址', 1800, !src);
                return;
            }
            case 'cleanLink': {
                const raw = m.kind === 'video' ? (m.el.currentSrc || m.el.src) : (m.src || m.el.currentSrc || m.el.src);
                let clean = raw || '';
                try {
                    const u = new URL(raw);
                    for (const k of [...u.searchParams.keys()]) {
                        if (/^(sign|token|auth|key|expires|timestamp|wsTime|wsSecret|t|traceid|x-)/i.test(k)) u.searchParams.delete(k);
                        if (/^(imageView|imageMogr|x-oss-process|thumbnail|quality|w|h|width|height)$/i.test(k)) u.searchParams.delete(k);
                    }
                    clean = u.toString();
                } catch (e) { /* 原样 */ }
                await copyText(clean);
                toast(this.ctx.shadow, '已去参数复制', 1600);
                return;
            }
            case 'copyImage': {
                const s = await this.currentSource();
                const du = s.dataUrl || (await this.sendToHost({ type: 'encode', ...s, format: 'png' })).dataUrl;
                await this.copyDataUrl(du);
                return;
            }
            case 'download': {
                if (m.kind === 'video') {
                    const s = await this.currentSource();
                    await this.saveDataUrl(s.dataUrl, `frame_${Math.round(s.time * 100) / 100}s.png`);
                    return;
                }
                const src = m.src || m.el.currentSrc || m.el.src;
                if (!src) { toast(this.ctx.shadow, '取不到下载地址', 1800, true); return; }
                if (src.startsWith('data:')) { await this.saveDataUrl(src, filenameFromUrl('data.png')); return; }
                const r = await bgSend({ action: 'downloadUrl', url: src, filename: filenameFromUrl(src), pageUrl: location.href, referrer: location.href });
                toast(this.ctx.shadow, r?.ok ? '已开始下载' : '下载失败: ' + (r?.error || ''), 2200, !r?.ok);
                return;
            }
            case 'openSrc': {
                const src = m.kind === 'video' ? (m.el.currentSrc || m.el.src) : (m.src || m.el.currentSrc || m.el.src);
                if (src) await bgSend({ action: 'openTab', url: src });
                return;
            }
            case 'viewFull': {
                const src = m.src || m.el.currentSrc || m.el.src;
                if (!src) return;
                this.ctx.panel.show({
                    title: '原图预览',
                    dataUrl: src.startsWith('data:') ? src : null,
                    html: src.startsWith('data:') ? '' : `<img class="result" src="${esc(src)}" alt="" />`,
                    near: this.ctx.toolbar?.currentTarget,
                    actions: [{ label: '在新标签打开', run: () => bgSend({ action: 'openTab', url: src }) }],
                });
                return;
            }
            case 'info': {
                const src = m.kind === 'video' ? (m.el.currentSrc || m.el.src) : (m.src || m.el.currentSrc || m.el.src);
                let size = null;
                try {
                    const r = await bgSend({ action: 'probeUrl', url: src, pageUrl: location.href });
                    if (r?.ok) size = r;
                } catch (e) { /* 拿不到就只报基本项 */ }
                const v = m.el;
                const rows = [
                    ['类型', m.kind],
                    ['地址', src || '(未知)'],
                    ['显示尺寸', `${Math.round(m.displayRect?.width || 0)}×${Math.round(m.displayRect?.height || 0)}`],
                    ['源尺寸', size ? `${size.width || '?'}×${size.height || '?'}` : `${v.naturalWidth || v.videoWidth || '?'}×${v.naturalHeight || v.videoHeight || '?'}`],
                    ['字节', size?.bytes ? formatBytes(size.bytes) : '未探测'],
                    ['MIME', size?.mime || v.currentSrc?.match(/\.(png|jpe?g|webp|avif|gif|bmp)/i)?.[1] || '?'],
                    ['页面', location.host],
                ];
                if (m.kind === 'video') {
                    rows.push(['时长', (isFinite(v.duration) ? v.duration.toFixed(2) : '?') + ' s']);
                    rows.push(['当前', (v.currentTime || 0).toFixed(3) + ' s']);
                    rows.push(['倍速', String(v.playbackRate || 1)]);
                    rows.push(['音量', `${v.muted ? '静音' : Math.round((v.volume || 0) * 100) + '%'}`]);
                    try {
                        const md = v.textTracks?.length;
                        if (md) rows.push(['轨道数', String(md)]);
                    } catch (e) { /* ignore */ }
                    const q = await bgSend({ action: 'videoQualities', tabIdHint: null }).catch(() => null);
                    if (q?.ok && q.qualities) rows.push(['可用清晰度', q.qualities.join(', ')]);
                }
                this.ctx.panel.show({
                    title: '媒体信息',
                    html: rows.map(([k, val]) => `<div class="row"><span class="k">${esc(k)}</span><pre>${esc(String(val))}</pre></div>`).join(''),
                    near: this.ctx.toolbar?.currentTarget,
                    actions: [{ label: '复制全部', run: () => copyText(rows.map(([k, val]) => `${k}: ${val}`).join('\n')) }],
                });
                return;
            }
            case 'extractFrame': {
                const s = await this.currentSource();
                this.ctx.panel.show({ title: `当前帧 ${s.width}×${s.height} (${s.via})`, dataUrl: s.dataUrl, near: this.ctx.toolbar?.currentTarget, actions: [{ label: '下载', run: () => this.saveDataUrl(s.dataUrl, this.filenameFor(item, s)) }] });
                this.ctx.replaceTemp(s);
                return;
            }
            case 'saveFrame': {
                const s = await this.currentSource();
                await this.saveDataUrl(s.dataUrl, this.filenameFor(item, s));
                return;
            }
            case 'frameSheet': {
                const count = toInt(item.params?.count ?? this.s.video.sheetColumns * 2, 8);
                const times = videoTimeList(m.el, count);
                const frames = await captureFrames(m.el, times, { trim: this.s.video.trimLetterbox, format: 'png' });
                const cols = toInt(this.s.video.sheetColumns, 4);
                const cell = toInt(this.s.video.sheetCellWidth, 320);
                const res = await this.sendToHost({
                    type: 'op', dataUrl: frames[0].dataUrl, chain: [],
                });
                const sheet = await this.composeSheet(frames, cols, cell);
                this.ctx.panel.show({ title: `抽帧拼图 ${count} 帧`, dataUrl: sheet, near: this.ctx.toolbar?.currentTarget, actions: [{ label: '下载拼图', run: () => this.saveDataUrl(sheet, 'frame_sheet.png') }] });
                return;
            }
            case 'exportFrames': {
                const count = toInt(item.params?.count ?? 12, 12);
                const range = toNum(item.params?.range ?? 0, 0);
                const from = range > 0 ? Math.max(0, (m.el.currentTime || 0)) : 0;
                const to = range > 0 ? Math.min(isFinite(m.el.duration) ? m.el.duration : from + range, from + range) : 0;
                const times = videoTimeList(m.el, count, { from, to });
                this.ctx.setStatus?.(`取 ${count} 帧…`);
                const frames = await captureFrames(m.el, times, { trim: this.s.video.trimLetterbox, format: this.s.output.format === 'jpg' ? 'jpg' : 'png' });
                await Promise.all(frames.map((f, i) => this.saveDataUrl(f.dataUrl, `frame_${String(i + 1).padStart(3, '0')}_${f.time.toFixed(2)}s.${f.mime.includes('jpeg') ? 'jpg' : 'png'}`)));
                this.ctx.setStatus?.('');
                toast(this.ctx.shadow, `已导出 ${frames.length} 帧`, 2200);
                return;
            }
            case 'copyTime': {
                const t = m.el.currentTime || 0;
                const url = new URL(location.href);
                url.searchParams.set('t', String(Math.floor(t)));
                await copyText(`${formatTime(t)}  ${url.toString()}`);
                toast(this.ctx.shadow, '已复制时间码 + 带 t 参数的链接', 1800);
                return;
            }
            case 'seekStep': {
                if (!playable(m.el)) { toast(this.ctx.shadow, '这个视频元素没有可控制的播放源', 2200, true); return; }
                const dir = toNum(item.params?.dir ?? 1, 1);
                const step = toNum(item.params?.step ?? (1 / (this.s.video.fpsFallback || 30)), 1 / 30);
                const from = m.el.currentTime || 0;
                try { await seekTo(m.el, Math.max(0, from + dir * step)); }
                catch (e) { toast(this.ctx.shadow, '逐帧失败: ' + e.message, 2400, true); return; }
                toast(this.ctx.shadow, `逐帧 ${dir > 0 ? '前进' : '后退'} ${(step * 1000).toFixed(1)}ms → ${m.el.currentTime.toFixed(3)}s`, 1500);
                this.ctx.refreshProbe?.();
                return;
            }
            case 'cycleSpeed': {
                if (!playable(m.el)) { toast(this.ctx.shadow, '这个视频元素没有可控制的播放源', 2200, true); return; }
                const want = nextRate(m.el.playbackRate);
                const got = setRate(m.el, want);
                const stuck = Math.abs(got - want) < 0.01;
                toast(this.ctx.shadow, stuck ? `倍速 ${got}x` : `站点把倍速按回了 ${got}x（想要 ${want}x）`, 1800, !stuck);
                return;
            }
            case 'togglePlay': {
                if (!playable(m.el)) { toast(this.ctx.shadow, '这个视频元素没有可控制的播放源', 2200, true); return; }
                if (m.el.paused) {
                    try { await m.el.play(); }
                    catch (e) { toast(this.ctx.shadow, '播放被浏览器拒绝: ' + e.message, 2600, true); return; }
                } else m.el.pause();
                toast(this.ctx.shadow, m.el.paused ? '已暂停' : '播放中', 1200);
                return;
            }
            case 'toggleMute': {
                if (!playable(m.el)) { toast(this.ctx.shadow, '这个视频元素没有可控制的播放源', 2200, true); return; }
                m.el.muted = !m.el.muted;
                if (!m.el.muted) { try { await m.el.play(); } catch (e) { /* 需要手势，忽略 */ } }
                toast(this.ctx.shadow, m.el.muted ? '已静音' : '已取消静音', 1200);
                return;
            }
            case 'toggleLoop': {
                if (!playable(m.el)) { toast(this.ctx.shadow, '这个视频元素没有可控制的播放源', 2200, true); return; }
                const got = setLoop(m.el, !m.el.loop);
                toast(this.ctx.shadow, got ? '循环 开（本元素）' : '循环 关', 1400);
                return;
            }
            case 'pictureInPicture': {
                if (!playable(m.el)) { toast(this.ctx.shadow, '这个视频元素没有可控制的播放源', 2200, true); return; }
                if (!document.pictureInPictureEnabled) { toast(this.ctx.shadow, '浏览器不支持画中画', 2200, true); return; }
                try {
                    if (document.pictureInPictureElement) { await document.exitPictureInPicture(); toast(this.ctx.shadow, '已退出小窗', 1200); }
                    else { await m.el.requestPictureInPicture(); toast(this.ctx.shadow, '已小窗播放', 1200); }
                } catch (e) { toast(this.ctx.shadow, '小窗失败: ' + e.message, 2400, true); }
                return;
            }
            case 'clearOverlay': {
                drawBoxes(this.ctx.boxLayer, [], null);
                drawMask(this.ctx.maskLayer, [], null);
                this.ctx.panel.hide?.();
                this.ctx.pickActive?.() && this.ctx.stopPick?.();
                return;
            }
            case 'gear': await bgSend({ action: 'openOptions' }); return;
            default: throw new Error('未实现内置动作: ' + fn);
        }
    }

    async composeSheet(frames, cols, cellWidth) {
        const per = [];
        for (const f of frames) {
            const img = new Image();
            img.src = f.dataUrl;
            per.push(img.decode ? img.decode().then(() => img, () => img) : new Promise((r) => { img.onload = () => r(img); img.onerror = () => r(null); }));
        }
        const imgs = (await Promise.all(per)).filter(Boolean);
        if (!imgs.length) throw new Error('没有取到帧');
        const rows = Math.ceil(imgs.length / cols);
        const cw = Math.max(48, toInt(cellWidth, 320));
        const canvas = document.createElement('canvas');
        const ch = Math.round(imgs[0].naturalHeight / (imgs[0].naturalWidth / cw));
        canvas.width = cw * cols; canvas.height = ch * rows;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        imgs.forEach((img, i) => {
            const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
            ctx.drawImage(img, x, y, cw, ch);
            ctx.fillStyle = 'rgba(0,0,0,.6)';
            ctx.fillRect(x, y + ch - 16, 62, 16);
            ctx.fillStyle = '#fff'; ctx.font = '11px monospace';
            ctx.fillText(frames[i].time.toFixed(2) + 's', x + 3, y + ch - 4);
        });
        return canvas.toDataURL('image/png');
    }

    // —— AI ——
    mediaKey() {
        const m = this.ctx.media;
        if (!m) return '';
        return `${m.kind}|${m.src || (m.el && (m.el.currentSrc || m.el.src)) || ''}|${m.el && m.el.currentTime ? Math.round(m.el.currentTime * 10) : 0}`;
    }

    async runAi(item) {
        const task = item.action.task;
        // 同一张图上再点一次「人脸识别」就是收起人脸框 —— 不然框会一直糊在图上，得另找「清除」
        if (task === 'face' && this.ctx.facesKey && this.ctx.facesKey === this.mediaKey() && this.ctx.boxLayer?.__boxes?.length) {
            drawBoxes(this.ctx.boxLayer, [], null);
            this.ctx.facesKey = null;
            toast(this.ctx.shadow, '已收起人脸框（再点一次重新识别）', 1800);
            return;
        }
        try {
            // 看图说话/提问/OCR 现在只是「把图发给一个 HTTP 接口」：没填端点就别去敲宿主，直接说清去哪儿配
            if (LLM_TASKS.has(task) && !normalizeLlm(this.s.ai?.llm).endpoint) {
                this.ctx.setStatus?.('');
                this.ctx.panel.show({
                    title: '还没接 LLM API',
                    text: '「看图说话 / AI 提问 / OCR 读字」是把你设置的 OpenAI 兼容接口（端点 + 密钥 + 模型名）。\n设置 → AI → 看图说话/提问/OCR（接 LLM API）。',
                    near: this.ctx.toolbar?.currentTarget,
                    actions: [{ label: '打开设置', run: () => bgSend({ action: 'openOptions' }) }],
                });
                return;
            }
            this.ctx.setStatus?.(LLM_TASKS.has(task) ? '发给模型…' : '准备模型…');
            if (task === 'ask') {
                const q = await promptFor(this.ctx.shadow, { title: '问点什么？（Enter 发送，Shift+Enter 换行）', placeholder: '例如：图里的人在做什么？', near: this.ctx.toolbar?.currentTarget });
                if (!q) { this.ctx.setStatus?.(''); return; }
                this.ctx.setStatus?.('思考中…');
                const src = await this.currentSource();
                const r = await this.sendToHost({ type: 'ai', task, ...src, question: q, ai: this.s.ai });
                this.ctx.panel.show({ title: 'AI 回答', text: r.text || '(空)', near: this.ctx.toolbar?.currentTarget, actions: [{ label: '复制', run: () => copyText(r.text) }] });
                this.ctx.setStatus?.('');
                return;
            }
            if (task === 'samPick') { this.startSamPick(); return; }
            const src = await this.currentSource();
            if (task === 'faceRegister') { await this.registerFace(src); return; }
            this.ctx.setStatus?.(task === 'superResolve' ? '超分中…' : task === 'faceBlur' ? '打码中…' : task === 'recognize' ? '识别中…' : LLM_TASKS.has(task) ? '等待模型回答…' : 'AI 推理中…');
            const r = await this.sendToHost({ type: 'ai', task, ...src, ai: this.s.ai, gallery: this.s.faceGallery || [], maxNewTokens: item.params?.maxNewTokens });
            this.ctx.setStatus?.('');
            if (r.blocked) {
                this.ctx.panel.show({
                    title: '需要确认下载',
                    text: r.blocked.reason,
                    actions: [{ label: '确认下载并执行', run: () => this.sendToHost({ type: 'ai', task, ...src, ai: this.s.ai, confirmBudget: true }).then((x) => this.applyAiResult(item, x)) }],
                });
                return;
            }
            await this.applyAiResult(item, r, src);
        } catch (e) {
            this.ctx.setStatus?.('');
            toast(this.ctx.shadow, errText('AI 失败: ', e), 5200, true);
            console.warn('[mtb] AI 失败', e);
        }
    }

    // 登记人脸：取图里最大的一张脸 → 提特征 → 起名 → 写进本地人脸库（同名覆盖）
    async registerFace(src) {
        const r = await this.sendToHost({ type: 'ai', task: 'faceRegister', ...src, ai: this.s.ai });
        this.ctx.setStatus?.('');
        if (r.blocked) {
            this.ctx.panel.show({ title: '需要确认下载', text: r.blocked.reason, actions: [{ label: '确认登记', run: () => this.sendToHost({ type: 'ai', task: 'faceRegister', ...src, ai: this.s.ai, confirmBudget: true }).then((x) => this.saveFace(x)) }] });
            return;
        }
        await this.saveFace(r);
    }

    async saveFace(r) {
        if (!r || !r.vector) { toast(this.ctx.shadow, '没拿到人脸特征', 2600, true); return; }
        const name = await promptFor(this.ctx.shadow, { title: `给这张脸起个名字（${r.faces > 1 ? '图里有 ' + r.faces + ' 张脸，取最大的' : '已取到人脸'}）`, placeholder: '例如：张三', near: this.ctx.toolbar?.currentTarget });
        const clean = String(name || '').trim();
        if (!clean) { toast(this.ctx.shadow, '已取消登记', 1600); return; }
        const gallery = (this.s.faceGallery || []).filter((g) => g && g.name !== clean);
        gallery.push({ id: 'f' + Date.now().toString(36), name: clean, vector: r.vector, dim: r.dim, createdAt: Date.now() });
        await this.ctx.patchSettings?.({ faceGallery: gallery });
        toast(this.ctx.shadow, `已登记「${clean}」，人脸库 ${gallery.length} 人`, 2600);
    }

    async applyAiResult(item, r, src) {
        const near = this.ctx.toolbar?.currentTarget;
        if (r.text) {
            this.ctx.panel.show({ title: item.label, text: r.text, near, actions: [{ label: '复制', run: () => copyText(r.text) }] });
        }
        if (r.labels || r.filtered) {
            this.ctx.panel.show({ title: item.label, text: (r.filtered || r.labels.map((l) => `${l.label} ${Math.round((l.score || 0) * 100)}%`)).join('\n'), near, actions: [{ label: '复制标签', run: () => copyText((r.filtered || r.labels.map((l) => l.label)).join(', ')) }] });
        }
        if (r.dataUrl) {
            this.ctx.panel.show({
                title: `${item.label} · ${r.width}×${r.height}`, dataUrl: r.dataUrl, near,
                actions: [
                    { label: '下载', run: () => this.saveDataUrl(r.dataUrl, this.filenameFor(item, r)) },
                    { label: '复制', run: () => this.copyDataUrl(r.dataUrl) },
                    { label: '发到 ComfyUI', run: () => this.ctx.runToolById('send-comfy', { dataUrl: r.dataUrl }) },
                ],
            });
            if (this.s.output.autoDownloadAfterOp) this.saveDataUrl(r.dataUrl, this.filenameFor(item, r));
        }
        if (r.overlay?.length && near) {
            const masks = r.overlay.filter((o) => o.type === 'mask').map((o) => o.maskUrl);
            const boxes = r.overlay.filter((o) => o.type === 'box');
            if (masks.length) drawMask(this.ctx.maskLayer, masks, near);
            if (boxes.length) {
                const ref = { refWidth: r.sourceWidth || near.width, refHeight: r.sourceHeight || near.height };
                drawBoxes(this.ctx.boxLayer, boxes.map((b) => ({ ...b, ...ref })), near);
            }
            if (r.faces) { this.ctx.lastFaces = r.faces; this.ctx.facesKey = this.mediaKey(); }
            if (r.faces && !r.faces.length) toast(this.ctx.shadow, '这张图没检出人脸（换个角度/光线更强的图试试，或在设置里换检测模型）', 3200, true);
            if (r.masks) this.ctx.lastMasks = r.masks;
        }
        if (r.faces && typeof r.named === 'number') {
            const lines = r.faces.map((f, i) => `#${i + 1} ${f.name ? '「' + f.name + '」' : '陌生'}${f.sim != null ? ' 相似度 ' + Math.round(f.sim * 100) + '%' : ''}`);
            this.ctx.panel.show({
                title: `认出是谁 · 匹配 ${r.named}/${r.count}`,
                text: (r.gallery ? `人脸库 ${r.gallery} 人，判定阈值 ${Math.round(r.threshold * 100)}%` : '人脸库还是空的：先用「登记人脸」把常看到的人存进来') + '\n' + lines.join('\n'),
                near,
                actions: [{ label: '复制', run: () => copyText(lines.join('\n')) }],
            });
            return;
        }
        if (r.count !== undefined && !r.text) toast(this.ctx.shadow, `${item.label}: ${r.count} 个目标`, 2000);
    }

    startSamPick() {
        const m = this.ctx.media;
        if (!m) return;
        const rect = m.el.getBoundingClientRect();
        this.ctx.startPick(`点击目标抠图 · Shift/右键=负样本 · Esc 退出`, async (pt) => {
            try {
                const src = await this.currentSource();
                const x = pt.x * (src.width ? 1 : 1);
                this.ctx.setStatus?.('分割中…');
                const r = await this.sendToHost({
                    type: 'ai', task: 'samPick', ...src, ai: this.s.ai,
                    points: [[pt.x / rect.width, pt.y / rect.height]].map(([nx, ny]) => [nx * (r0(src).width), ny * (r0(src).height)]),
                    labels: [pt.negative ? 0 : 1],
                });
                this.ctx.setStatus?.('');
                await this.applyAiResult({ id: 'ai-sam', label: '抠图' }, r, src);
                this.ctx.lastPickPoints = [...(this.ctx.lastPickPoints || []), [pt, r]];
            } catch (e) { this.ctx.setStatus?.(''); toast(this.ctx.shadow, errText('分割失败: ', e), 4000, true); }
        }, () => toast(this.ctx.shadow, '已退出取点', 1200));
        function r0(src) { return { width: src.width || 1024, height: src.height || 1024 }; }
    }

    // —— 自定义 ——
    async runScript(item) {
        const m = this.ctx.media;
        const src = await this.currentSource().catch(() => ({}));
        const ctxData = {
            media: {
                kind: m.kind, src: m.src || m.el.currentSrc || m.el.src, pageUrl: location.href, pageTitle: document.title,
                width: src.width || m.el.naturalWidth || m.el.videoWidth || 0,
                height: src.height || m.el.naturalHeight || m.el.videoHeight || 0,
                displayWidth: Math.round(m.displayRect?.width || 0), displayHeight: Math.round(m.displayRect?.height || 0),
                time: m.el.currentTime || 0, duration: m.el.duration || 0,
                mime: src.mime, bytes: src.bytesLen, via: src.via, isFrame: !!src.isFrame,
            },
            dataUrl: src.dataUrl || null,
            params: item.params || {},
            settings: publicSettings(this.s),
            lastFaces: this.ctx.lastFaces || [],
            lastMasks: this.ctx.lastMasks || [],
        };
        this.ctx.setStatus?.('脚本运行中…');
        try {
            const r = await this.sendToHost({ type: 'script', scriptId: item.id, code: item.action.script, ctx: ctxData, ...(src.dataUrl ? { dataUrl: src.dataUrl } : { url: src.url, pageUrl: src.pageUrl }) });
            this.ctx.setStatus?.('');
            const out = r.result || {};
            if (out.toast) toast(this.ctx.shadow, String(out.toast), 2600, !!out.isError);
            if (out.html || out.text || out.dataUrl) {
                this.ctx.panel.show({
                    title: out.title || item.label, dataUrl: out.dataUrl || null, text: out.text || null, html: out.html || '',
                    near: this.ctx.toolbar?.currentTarget,
                    actions: out.dataUrl ? [{ label: '下载', run: () => this.saveDataUrl(out.dataUrl, out.filename || (item.id + '.png')) }] : [],
                });
            }
            if (out.overlay) {
                const near = this.ctx.toolbar?.currentTarget;
                if (out.overlay.boxes) drawBoxes(this.ctx.boxLayer, out.overlay.boxes, near);
                if (out.overlay.text) toast(this.ctx.shadow, out.overlay.text, 2000);
            }
            if (out.copyText) copyText(out.copyText);
            if (out.download && out.dataUrl) this.saveDataUrl(out.dataUrl, out.filename || item.id);
        } catch (e) {
            this.ctx.setStatus?.('');
            toast(this.ctx.shadow, errText('脚本错误: ', e), 5000, true);
            console.warn('[mtb] 脚本错误', e);
        }
    }

    async runLink(item) {
        const l = (this.s.linkTools || []).find((x) => x.id === item.action.linkId) || {};
        const m = this.ctx.media;
        const src = m.kind === 'video' ? (m.el.currentSrc || m.el.src) : (m.src || m.el.currentSrc || m.el.src);
        let dataUrl = null;
        if (/\{dataUrl\}/.test(l.template || '')) {
            const s = await this.currentSource().catch(() => null);
            dataUrl = s?.dataUrl || (s ? (await this.sendToHost({ type: 'encode', ...s, format: 'png' })).dataUrl : null);
        }
        const vars = {
            src: src || '', page: location.href, title: document.title,
            w: m.el.naturalWidth || m.el.videoWidth || 0, h: m.el.naturalHeight || m.el.videoHeight || 0,
            dw: Math.round(m.displayRect?.width || 0), dh: Math.round(m.displayRect?.height || 0),
            t: (m.el.currentTime || 0).toFixed(3), mime: m.el.type || '', dataUrl: dataUrl || '',
        };
        if (l.method === 'POST') {
            const r = await bgSend({ action: 'proxyPost', url: fillTemplateRaw(l.template, vars), body: l.body ? fillTemplate(l.body, vars) : undefined, headers: l.headers || {}, json: !!l.asJson });
            toast(this.ctx.shadow, r?.ok ? '已 POST' : 'POST 失败: ' + (r?.error || ''), 2400, !r?.ok);
            return;
        }
        const url = fillTemplateRaw(l.template, vars).replace(/\{([a-zA-Z0-9_]+)\}/g, (all, k) => encodeURIComponent(vars[k] ?? ''));
        if (l.openTab !== false) await bgSend({ action: 'openTab', url });
        else await copyText(url);
    }

    async dispatch(item, btn, e) {
        // 所有按钮的唯一入口：扩展刚重载过的话这里先拦住，免得每个功能各自抛 Chrome 内部术语
        if (!extAlive()) { toast(this.ctx.shadow, DEAD_TEXT, 5000, true); return; }
        try {
            if (item.action?.type === 'step') return await this.runImageOp(item);
            if (item.action?.type === 'builtin') return await this.builtin(item.action.fn, item);
            if (item.action?.type === 'ai') return await this.runAi(item);
            if (item.action?.type === 'script') return await this.runScript(item);
            if (item.action?.type === 'link') return await this.runLink(item);
            if (item.action?.type === 'comfy') return await this.comfy(item);
            throw new Error('未知动作类型: ' + JSON.stringify(item.action));
        } catch (err) {
            this.ctx.setStatus?.('');
            toast(this.ctx.shadow, errText((item.label || '操作') + '失败: ', err), 4200, true);
            console.warn('[mtb]', item.id, err);
        }
    }

    async comfy(item) {
        const m = this.ctx.media;
        const src = await this.currentSource();
        const payload = {
            action: 'sendImageToComfyUI', dataUrl: src.dataUrl, imgSrc: src.url || null,
            pageUrl: location.href, autoQueue: !!item.action.autoQueue, filename: this.filenameFor(item, src),
            comfy: this.s.comfy,
        };
        this.ctx.setStatus?.('发送中…');
        const r = await bgSend(payload);
        this.ctx.setStatus?.('');
        toast(this.ctx.shadow, r?.ok ? (item.action.autoQueue ? '已发送并排队' : '已发送到 ComfyUI') : '发送失败: ' + (r?.error || ''), 3000, !r?.ok);
        if (!r?.ok && r?.hint) console.warn('[mtb] comfy:', r.hint);
    }
}

function r0(x) { return x; }

function publicSettings(s) {
    return { comfy: s.comfy, output: s.output, video: s.video, ai: { device: s.ai.device, hub: s.ai.hub } };
}

function fmt(r) {
    const { op, ...rest } = r;
    return JSON.stringify(rest, (k, v) => (Array.isArray(v) && v.length > 24 ? `[${v.length} 项]` : v), 0).replace(/[{}"]/g, (c) => (c === '"' ? '' : c === '{' ? '' : c === '}' ? '' : c));
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function toInt(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function toNum(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
function formatTime(sec) {
    const s = Math.max(0, sec | 0);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; }
    catch (e) {
        const ta = document.createElement('textarea');
        ta.value = t; ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
        ta.remove();
        return true;
    }
}

export { copyText, toast, toInt, toNum };
