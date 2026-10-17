// 内置自定义功能示例：把"发送到 ComfyUI"与"发送并立即执行"实现为用户可编辑的脚本，
// 走的正是第三方自定义功能那套 ctx API —— 这样示例本身就是该 SDK 的活文档。

export const CONTEXT_API_DOC = `可用 API（ctx.*）：
  ctx.media            {kind:'image'|'video'|'bg', src, width, height, displayWidth, displayHeight, time, duration, mime, isFrame, via}
  ctx.dataUrl          当前媒体的 dataURL（视频=当前帧）；ctx.width/ctx.height 同义
  ctx.params           该按钮在设置里配置的参数对象
  ctx.settings         {comfy, output, video, ai:{device,hub}}
  ctx.lastFaces/ctx.lastMasks  上一次 AI 识别结果
  ctx.fetch({url, method, headers, body, form, json, as:'text'|'json'|'dataUrl'})   走后台，绕过 CORS 与防盗链
  ctx.host({chain:[{op,params}], format, quality})      跑像素算子链，返回 {dataUrl,width,height,reports}
  ctx.ai(task, {...})                                   跑 AI 任务：describe/ask/ocr/tags/samPick/samAuto/face/faceBlur/superResolve/depth
  ctx.comfySend({dataUrl?, imgSrc?, autoQueue, filename})  上传并注入 ComfyUI（后台服务）
  ctx.download(dataUrl, filename) / ctx.copyText(text) / ctx.openUrl(url)
  ctx.toast(text, isError) / ctx.overlay({boxes:[{x,y,width,height,label}], text})
  ctx.panel({title, dataUrl, text, html})
  ctx.storage.get(keys) / ctx.storage.set(obj)
  ctx.sleep(ms) / ctx.util:{formatBytes,ratioText,sanitizeFilename}
返回值会被工具栏消费：{toast, text, html, dataUrl, filename, title, overlay:{boxes,text}, copyText, download, isError}
`;

export const BUILTIN_SCRIPTS = [
    {
        id: 'send-comfy',
        name: '发送到 ComfyUI',
        label: '发到 ComfyUI',
        icon: '🧩',
        media: ['image', 'video'],
        enabled: true,
        builtin: true,
        entry: 'body',
        hint: '内置示例①：用 ctx.comfySend 把图片/当前帧上传到 ComfyUI 并填入节点',
        code: `// 内置示例①：发送到 ComfyUI（不自动排队）
// 视频会自动取当前帧，图片直链由后台带 Referer 抓取，防盗链站点也能拿到原图。
const r = await ctx.comfySend({
  dataUrl: ctx.dataUrl,      // 视频帧已是 dataUrl；纯图片时为空，后台按 ctx.media.src 取
  imgSrc: ctx.dataUrl ? null : ctx.media.src,
  filename: ctx.util.sanitizeFilename((ctx.media.kind === 'video' ? 'frame_' : 'web_') + Date.now() + '.' + (ctx.dataUrl ? 'png' : 'jpg')),
  autoQueue: false,
});
if (!r.ok) return { toast: '发送失败: ' + r.error, isError: true };
return { toast: ctx.params.autoQueue ? '已发送并排队' : '已发送到 ComfyUI' };`,
        params: { autoQueue: false },
    },
    {
        id: 'send-comfy-run',
        name: '发送并立即执行',
        label: '发送并执行',
        icon: '▶',
        media: ['image', 'video'],
        enabled: true,
        builtin: true,
        entry: 'body',
        hint: '内置示例②：同上，但 autoQueue=true 会触发 Queue Prompt',
        code: `// 内置示例②：发送并立即排队执行（autoQueue）
const r = await ctx.comfySend({
  dataUrl: ctx.dataUrl,
  imgSrc: ctx.dataUrl ? null : ctx.media.src,
  autoQueue: true,
});
return r.ok ? { toast: '已发送并排队执行' } : { toast: '执行失败: ' + r.error, isError: true };`,
        params: { autoQueue: true },
    },
    {
        id: 'demo-ocr-clipboard',
        name: '示例：AI 读字并复制',
        label: '读字并复制',
        icon: '🔤',
        media: ['image', 'video'],
        enabled: false,
        builtin: true,
        entry: 'body',
        hint: '演示 ctx.ai + ctx.copyText 的组合',
        code: `// 内置示例③：组合多个能力 —— AI 读字后复制纯文本
const r = await ctx.ai('ocr', {});
if (r.blocked) return { toast: '需要先下载模型：' + r.blocked.reason, isError: true };
if (!r.text || r.text.includes('无文字')) return { toast: '没读到文字' };
await ctx.copyText(r.text);
return { toast: '已复制 ' + r.text.length + ' 字', text: r.text };`,
        params: {},
    },
    {
        id: 'demo-chain',
        name: '示例：去黑边+放大+锐化',
        label: '去黑边放大',
        icon: '🪄',
        media: ['image', 'video'],
        enabled: false,
        builtin: true,
        entry: 'body',
        hint: '演示 ctx.host 的算子链（步骤可在设置里改参数）',
        code: `// 内置示例④：算子链组合
const out = await ctx.host({
  chain: [
    { op: 'trim', params: { mode: 'auto', tolerance: 16 } },
    { op: 'resize', params: { filter: 'lanczos3', mode: 'percent', percent: ctx.params.scale || 200 } },
    { op: 'unsharp', params: { radius: 1.6, amount: 100, threshold: 2 } },
  ],
});
return { dataUrl: out.dataUrl, title: '去黑边放大', toast: out.width + '×' + out.height };`,
        params: { scale: 200 },
    },
];

export const BUILTIN_LINKS = [
    {
        id: 'demo-google-lens',
        name: '示例：以图搜图',
        label: '搜图',
        icon: '🔎',
        media: ['image'],
        enabled: false,
        builtin: true,
        template: 'https://lens.google.com/uploadbyurl?url={src}',
        method: 'GET',
        openTab: true,
        hint: '配置式示例：URL 模板 + 占位符，不写代码',
    },
];

export function ensureBuiltins(settings) {
    settings.customScripts = settings.customScripts || [];
    settings.linkTools = settings.linkTools || [];
    const have = new Set(settings.customScripts.map((s) => s.id));
    for (const b of BUILTIN_SCRIPTS) if (!have.has(b.id)) settings.customScripts.push(structuredCloneSafe(b));
    const haveLink = new Set(settings.linkTools.map((l) => l.id));
    for (const b of BUILTIN_LINKS) if (!haveLink.has(b.id)) settings.linkTools.push(structuredCloneSafe(b));
    return settings;
}

function structuredCloneSafe(v) {
    try { return structuredClone(v); } catch (e) { return JSON.parse(JSON.stringify(v)); }
}
