// 工具目录与默认设置。工具栏按钮、设置页清单、host 分发都以本文件为唯一真值。

export const ICONS = {
    copy: '📋', link: '🔗', download: '💾', open: '🗗', info: 'ℹ️', eye: '👁️',
    comfy: '🧩', play: '▶', pause: '⏸', stepF: '⏭', stepB: '⏮', speed: '⏩',
    mute: '🔇', loop: '🔁', film: '🎞', crop: '✂️', resize: '📐', rotate: '🔄',
    flip: '🔃', magic: '✨', gray: '🌫', invert: '🌓', edges: '📏', grid: '🧮',
    sam: '🎯', face: '😀', super: '🔬', tag: '🏷', ask: '💬', scan: '🔍',
    blur: '🌁', sharpen: '🗡', palette: '🎨', hash: '#️⃣', code: '⌨️', gear: '⚙️',
    x: '❌', check: '✅', brush: '🖌', layers: '🧱', star: '⭐', scissors: '✂',
};

// 每个工具: action.type = step(像素算子链) | builtin(内容脚本能力) | ai(host 模型) | script(用户脚本) | link(链接模板)
export const TOOLS = [
    // —— 基础操作 ——
    { id: 'copy-link', group: '基础', label: '复制链接', icon: ICONS.link, media: ['image', 'video', 'bg'], action: { type: 'builtin', fn: 'copyLink' }, hint: '复制图片/视频直链地址（自动去除临时签名参数可选）' },
    { id: 'copy-image', group: '基础', label: '复制图片', icon: ICONS.copy, media: ['image', 'video'], action: { type: 'builtin', fn: 'copyImage' }, hint: '把当前图（或视频当前帧）复制到剪贴板' },
    { id: 'download', group: '基础', label: '下载', icon: ICONS.download, media: ['image', 'video'], action: { type: 'builtin', fn: 'download' }, hint: '下载原图；视频则下载当前帧 PNG' },
    { id: 'open-src', group: '基础', label: '新标签打开', icon: ICONS.open, media: ['image', 'video', 'bg'], action: { type: 'builtin', fn: 'openSrc' }, hint: '在新标签打开原始直链' },
    { id: 'info', group: '基础', label: '详细信息', icon: ICONS.info, media: ['image', 'video', 'bg'], action: { type: 'builtin', fn: 'info' }, hint: '显示源地址、尺寸、大小、类型、编解码、时长等' },
    { id: 'view-full', group: '基础', label: '原图预览', icon: ICONS.eye, media: ['image'], action: { type: 'builtin', fn: 'viewFull' }, hint: '在页面内浮层查看真实分辨率原图' },
    { id: 'clean-url', group: '基础', label: '复制干净链接', icon: '🧼', media: ['image', 'video'], action: { type: 'builtin', fn: 'cleanLink' }, hint: '去掉签名/尺寸后缀等噪声参数后复制' },

    // —— 图像编辑（step 链）——
    { id: 'upscale-lanczos', group: '高清', label: 'Lanczos 放大', icon: ICONS.super, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'resize', params: { filter: 'lanczos3', mode: 'percent', percent: 200 } }] }, params: [{ key: 'percent', label: '倍率(%)', type: 'number', def: 200 }] },
    { id: 'downscale', group: '高清', label: 'Area 缩小', icon: ICONS.resize, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'resize', params: { filter: 'area', mode: 'percent', percent: 50 } }] } },
    { id: 'unsharp', group: '高清', label: 'USM 锐化', icon: ICONS.sharpen, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'unsharp', params: { radius: 1.6, amount: 110, threshold: 2 } }] } },
    { id: 'auto-enhance', group: '高清', label: '一键增强', icon: ICONS.magic, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'autoLevels', params: { percent: 0.4 } }, { op: 'clahe', params: { clipLimit: 2.5, tiles: 8 } }, { op: 'unsharp', params: { radius: 1.4, amount: 70 } }] } },
    { id: 'denoise', group: '高清', label: '保边降噪', icon: ICONS.blur, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'bilateral', params: { spaceSigma: 6, rangeSigma: 28 } }] } },
    { id: 'grayscale', group: '调色', label: '去色', icon: ICONS.gray, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'grayscale', params: { mode: 'luma709' } }] } },
    { id: 'invert', group: '调色', label: '反色', icon: ICONS.invert, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'invert' }] } },
    { id: 'warm', group: '调色', label: '增色温', icon: '🌡', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'adjust', params: { temperature: 22, vibrance: 12 } }] } },
    { id: 'cool', group: '调色', label: '降色温', icon: '❄️', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'adjust', params: { temperature: -22, vibrance: 8 } }] } },
    { id: 'wb', group: '调色', label: '白平衡', icon: '⚖️', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'whiteBalance', params: { method: 'percentile', strength: 100 } }] } },
    { id: 'equalize', group: '调色', label: '直方图均衡', icon: '📊', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'equalize', params: { channel: 'luma' } }] } },
    { id: 'clahe', group: '调色', label: 'CLAHE', icon: ICONS.layers, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'clahe', params: { clipLimit: 3, tiles: 8 } }] } },
    { id: 'posterize', group: '调色', label: '色阶分离', icon: '🪄', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'posterize', params: { levelsCount: 6 } }] } },
    { id: 'pixelate', group: '滤镜', label: '像素化', icon: '🧊', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'pixelate', params: { size: 12, mode: 'avg' } }] } },
    { id: 'oil', group: '滤镜', label: '油画', icon: '🖼', media: ['image'], action: { type: 'step', chain: [{ op: 'oilPaint', params: { radius: 3, intensity: 32 } }] } },
    { id: 'vignette', group: '滤镜', label: '暗角', icon: '⭕', media: ['image'], action: { type: 'step', chain: [{ op: 'vignette', params: { amount: 60, radius: 68, soften: 45 } }] } },
    { id: 'chromakey', group: '滤镜', label: '抠色', icon: ICONS.scissors, media: ['image'], action: { type: 'step', chain: [{ op: 'chromaKey', params: { color: '#00ff00', tolerance: 45, feather: 12, model: 'hsv' } }] } },
    { id: 'round', group: '滤镜', label: '圆角', icon: '🔲', media: ['image'], action: { type: 'step', chain: [{ op: 'border', params: { radius: 24, feather: 0, corners: 'all', background: 'transparent' } }] } },
    { id: 'edges', group: '分析', label: 'Canny 边缘', icon: ICONS.edges, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'canny', params: { low: 40, high: 120, sigma: 1.4 } }] } },
    { id: 'sobel', group: '分析', label: 'Sobel', icon: '🧲', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'sobel', params: { mode: 'magnitude' } }] } },
    { id: 'binarize', group: '分析', label: 'Otsu 二值化', icon: '⬛', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'threshold', params: { mode: 'otsu' } }] } },
    { id: 'sauvola', group: '分析', label: '文档增强', icon: '📄', media: ['image'], action: { type: 'step', chain: [{ op: 'grayscale', params: {} }, { op: 'threshold', params: { mode: 'sauvola', blockSize: 41, k: 0.18 } }] } },
    { id: 'rotate-cw', group: '几何', label: '右转 90°', icon: ICONS.rotate, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'rotate', params: { angle: -90 } }] } },
    { id: 'rotate-ccw', group: '几何', label: '左转 90°', icon: '↺', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'rotate', params: { angle: 90 } }] } },
    { id: 'flip-h', group: '几何', label: '水平镜像', icon: ICONS.flip, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'flip', params: { dir: 'h' } }] } },
    { id: 'crop-square', group: '几何', label: '裁成正方', icon: ICONS.crop, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'crop', params: { mode: 'ratio', ratio: '1:1' } }] } },
    { id: 'crop-169', group: '几何', label: '裁成 16:9', icon: ICONS.crop, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'crop', params: { mode: 'ratio', ratio: '16:9' } }] } },
    { id: 'autotrim', group: '几何', label: '裁黑边', icon: '✂️', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'trim', params: { mode: 'auto', tolerance: 14 } }] } },
    { id: 'pad-white', group: '几何', label: '补白边', icon: '⬜', media: ['image'], action: { type: 'step', chain: [{ op: 'pad', params: { size: 32, color: '#ffffff' } }] } },
    { id: 'measure', group: '分析', label: '内容测量', icon: '📏', media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'detectSize', params: { mode: 'auto' } }] }, showImage: false },
    { id: 'palette', group: '分析', label: '取主色', icon: ICONS.palette, media: ['image'], action: { type: 'step', chain: [{ op: 'palette', params: { count: 8 } }] }, showImage: false },
    { id: 'stats', group: '分析', label: '像素统计', icon: ICONS.grid, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'stats' }] }, showImage: false },
    { id: 'hash', group: '分析', label: '感知哈希', icon: ICONS.hash, media: ['image', 'video'], action: { type: 'step', chain: [{ op: 'hashes' }] }, showImage: false },
    { id: 'corners', group: '分析', label: '角点', icon: '✳️', media: ['image'], action: { type: 'step', chain: [{ op: 'corners', params: { blockSize: 3, k: 0.04, thresholdRatio: 2, maxCorners: 120 } }] } },
    { id: 'lines', group: '分析', label: '直线检测', icon: '📐', media: ['image'], action: { type: 'step', chain: [{ op: 'lines', params: { pre: 'canny', threshold: 140, thetaSteps: 360, maxLines: 12 } }] } },
    { id: 'regions', group: '分析', label: '连通域', icon: '🧩', media: ['image'], action: { type: 'step', chain: [{ op: 'regions', params: { threshold: 128, minArea: 120 } }] } },

    // —— AI ——
    { id: 'ai-describe', group: 'AI', label: '看图说话', icon: ICONS.ask, media: ['image', 'video'], ai: 'describe', action: { type: 'ai', task: 'describe' }, needsHost: true, hint: '多模态模型生成画面描述' },
    { id: 'ai-ask', group: 'AI', label: 'AI 提问', icon: '❓', media: ['image', 'video'], ai: 'ask', action: { type: 'ai', task: 'ask' }, needsHost: true, hint: '弹出输入框，把问题连同图片发给多模态模型' },
    { id: 'ai-tags', group: 'AI', label: '标签识别', icon: ICONS.tag, media: ['image'], ai: 'tags', action: { type: 'ai', task: 'tags' }, needsHost: true },
    { id: 'ai-ocr', group: 'AI', label: 'OCR 读字', icon: '🔤', media: ['image', 'video'], ai: 'ocr', action: { type: 'ai', task: 'ocr' }, needsHost: true },
    { id: 'ai-sam', group: 'AI', label: '点选抠图', icon: ICONS.sam, media: ['image'], ai: 'sam', action: { type: 'ai', task: 'samPick' }, needsHost: true, hint: '进入取点模式，在图上点击目标生成遮罩' },
    { id: 'ai-sam-auto', group: 'AI', label: '自动分割', icon: '🪄', media: ['image'], ai: 'samauto', action: { type: 'ai', task: 'samAuto' }, needsHost: true },
    { id: 'ai-face', group: 'AI', label: '人脸识别', icon: ICONS.face, media: ['image', 'video'], ai: 'face', action: { type: 'ai', task: 'face' }, needsHost: true },
    { id: 'ai-face-blur', group: 'AI', label: '人脸打码', icon: '🕶', media: ['image', 'video'], ai: 'faceblur', action: { type: 'ai', task: 'faceBlur' }, needsHost: true },
    { id: 'ai-sr', group: 'AI', label: 'AI 超分', icon: '🔍', media: ['image', 'video'], ai: 'sr', action: { type: 'ai', task: 'superResolve' }, needsHost: true, hint: 'swin2SR / ESRGAN ONNX 模型放大' },
    { id: 'ai-depth', group: 'AI', label: '深度图', icon: '🌊', media: ['image'], ai: 'depth', action: { type: 'ai', task: 'depth' }, needsHost: true },
    { id: 'ai-clear', group: 'AI', label: '清除标注', icon: ICONS.x, media: ['image', 'video'], action: { type: 'builtin', fn: 'clearOverlay' } },

    // —— 视频专属 ——
    { id: 'v-frame', group: '视频', label: '当前帧', icon: ICONS.film, media: ['video'], action: { type: 'builtin', fn: 'extractFrame' }, hint: '抓取当前帧为干净原图（无播放器 UI）并预览' },
    { id: 'v-frame-save', group: '视频', label: '存当前帧', icon: ICONS.download, media: ['video'], action: { type: 'builtin', fn: 'saveFrame' } },
    { id: 'v-frames-sheet', group: '视频', label: '抽帧拼图', icon: '🎛', media: ['video'], action: { type: 'builtin', fn: 'frameSheet' }, params: [{ key: 'count', label: '帧数', type: 'number', def: 8 }] },
    { id: 'v-frames-export', group: '视频', label: '批量导出帧', icon: '🗂', media: ['video'], action: { type: 'builtin', fn: 'exportFrames' }, params: [{ key: 'count', label: '张数', type: 'number', def: 12 }, { key: 'range', label: '覆盖时长(s)', type: 'number', def: 0 }] },
    { id: 'v-copy-time', group: '视频', label: '复制时间码', icon: '⏱', media: ['video'], action: { type: 'builtin', fn: 'copyTime' } },
    { id: 'v-seek-in', group: '视频', label: '帧后退', icon: ICONS.stepB, media: ['video'], action: { type: 'builtin', fn: 'seekStep' }, params: [{ key: 'dir', label: '方向', type: 'number', def: -1 }] },
    { id: 'v-seek-out', group: '视频', label: '帧前进', icon: ICONS.stepF, media: ['video'], action: { type: 'builtin', fn: 'seekStep' }, params: [{ key: 'dir', label: '方向', type: 'number', def: 1 }] },
    { id: 'v-speed', group: '视频', label: '倍速循环', icon: ICONS.speed, media: ['video'], action: { type: 'builtin', fn: 'cycleSpeed' } },
    { id: 'v-play', group: '视频', label: '播放/暂停', icon: ICONS.play, media: ['video'], action: { type: 'builtin', fn: 'togglePlay' } },
    { id: 'v-mute', group: '视频', label: '静音', icon: ICONS.mute, media: ['video'], action: { type: 'builtin', fn: 'toggleMute' } },
    { id: 'v-loop', group: '视频', label: '循环', icon: ICONS.loop, media: ['video'], action: { type: 'builtin', fn: 'toggleLoop' } },
    { id: 'v-piP', group: '视频', label: '小窗播放', icon: '🗔', media: ['video'], action: { type: 'builtin', fn: 'pictureInPicture' } },
];

export const TOOL_GROUPS = ['基础', '高清', '调色', '滤镜', '几何', '分析', 'AI', '视频', '自定义'];

export const DEFAULT_TOOLS = [
    'copy-link', 'copy-image', 'download', 'open-src', 'info',
    'v-frame', 'v-frame-save', 'v-play', 'v-speed', 'v-loop',
    'v-seek-in', 'v-seek-out', 'v-copy-time', 'v-frames-sheet', 'v-mute', 'v-piP',
    'ai-describe', 'ai-sam', 'ai-face', 'upscale-lanczos', 'autotrim', 'gear',
];
// 视频态本来按钮就多，长尾的默认收进 ▾ 菜单，免得把工具栏撑到屏幕外
export const DEFAULT_COLLAPSED = ['v-seek-in', 'v-seek-out', 'v-copy-time', 'v-frames-sheet', 'v-mute', 'v-piP'];

// 默认工具栏：图片/视频各自显示哪些（顺序即显示顺序）
export function defaultToolbarState() {
    const state = {};
    for (const t of TOOLS) {
        state[t.id] = { enabled: DEFAULT_TOOLS.includes(t.id), order: null, label: null, icon: null, params: null, collapsed: DEFAULT_COLLAPSED.includes(t.id) };
    }
    return state;
}

export const DEFAULT_SETTINGS = {
    version: 2,
    toolbar: {
        layout: 'horizontal',        // horizontal | vertical | grid
        anchor: 'top-right',         // top-left top-right bottom-left bottom-right center top-edge bottom-edge
        offsetX: 0,
        offsetY: 0,
        gap: 4,
        scale: 1,
        opacity: 0.92,
        radius: 8,
        iconMode: 'both',            // icon | both | text
        theme: 'dark',               // dark | light | glass | neon
        showOn: 'hover',             // hover | always | hover-key (按住 Alt)
        showKey: 'Alt',
        hideDelay: 120,
        minImgSize: 200,
        maxTools: 0,                 // 0=不限制，超出折叠到 +
        animation: true,
        zIndex: 2147483647,
        dragMoved: false,
    },
    video: {
        trimLetterbox: true,
        frameFormat: 'png',
        frameMaxSide: 0,
        fpsFallback: 30,
        sheetColumns: 4,
        sheetCellWidth: 320,
    },
    output: {
        format: 'png',
        quality: 0.92,
        filenamePattern: '{base}_{op}_{w}x{h}.{ext}',
        autoDownloadAfterOp: false,
        copyAfterOp: false,
        showResultOverlay: true,
        keepOriginalName: true,
    },
    sites: {
        disabled: [],
        disabledHosts: [],
        includeFrame: true,
    },
    ai: {
        enabled: true,
        device: 'auto',              // auto | webgpu | wasm
        dtype: 'q4',                 // q4 | q4f16 | int8 | fp16
        hub: 'hf-mirror',            // hf-mirror | huggingface | jsdelivr | custom
        hubCustom: '',
        maxDim: 1024,
        keepAwake: true,
        downloadBudgetMB: 4096,
        autoUnloadAfter: 0,
        models: {
            vlm: 'onnx-community/Qwen3-VL-2B-Instruct-ONNX',
            sam: 'Xenova/slimsam-77-uniform',
            face: 'yunet-2023mar',
            sr: 'Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr',
            tags: 'Xenova/vit-gpt2-image-captioning',
            depth: 'Xenova/depth-anything-small-hf',
            ocr: 'sentence-transformers/all-MiniLM-L6-v2',
        },
        vlmPrompt: '请用中文详细描述这张图片的主体、场景、风格、构图与可见文字。',
        askPrompt: '{question}',
        samPointsPerTarget: 1,
        faceConfidence: 0.6,
        srTile: 256,
    },
    comfy: {
        server: 'http://127.0.0.1:8188',
        mode: 'frontend',            // frontend | api
        targetNodeType: '',
        targetNodeId: '',
        workflowJson: '',
        autoQueue: false,
        uploadFolders: 'both',       // input | output | both
        profiles: {},
        activeProfileId: 'default',
    },
    tools: defaultToolbarState(),
    customScripts: [],               // {id,name,label,icon,media,code,enabled,params}
    linkTools: [],                   // {id,name,label,icon,media,template,method,openTab,headers,enabled}
};

export const BUILTIN_VARS = [
    { key: '{src}', desc: '图片/视频直链（视频为 currentSrc）' },
    { key: '{page}', desc: '当前页面 URL' },
    { key: '{title}', desc: '页面标题' },
    { key: '{w} / {h}', desc: '源图自然尺寸' },
    { key: '{dw} / {dh}', desc: '页面显示尺寸' },
    { key: '{mime}', desc: '内容类型' },
    { key: '{bytes}', desc: '抓取到的字节数' },
    { key: '{t}', desc: '视频当前时间（秒）' },
    { key: '{dataUrl}', desc: '图像 dataURL（POST 时可用，可能很大）' },
];

export function findTool(id) {
    return TOOLS.find((t) => t.id === id) || null;
}

export function toolsForMedia(mediaType, isBg) {
    return TOOLS.filter((t) => {
        if (isBg && !t.media.includes('bg')) return false;
        if (!isBg && !t.media.includes(mediaType)) return false;
        return true;
    });
}

export function migrateSettings(raw) {
    const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    if (!raw || raw.version !== 2) {
        if (raw && raw.comfyConfig) {
            const c = raw.comfyConfig;
            s.comfy.server = (c.serverAddress || s.comfy.server).replace(/\/$/, '');
            s.comfy.mode = c.profiles && c.profiles[c.activeProfileId] ? (c.profiles[c.activeProfileId].mode || s.comfy.mode) : s.comfy.mode;
            s.comfy.targetNodeType = (c.profiles && c.profiles[c.activeProfileId] && c.profiles[c.activeProfileId].targetNodeType) || '';
            s.comfy.targetNodeId = (c.profiles && c.profiles[c.activeProfileId] && c.profiles[c.activeProfileId].targetNodeId) || '';
            s.comfy.workflowJson = (c.profiles && c.profiles[c.activeProfileId] && c.profiles[c.activeProfileId].workflowJson) || '';
            s.comfy.autoQueue = false;
            s.toolbar.anchor = c.buttonPosition || s.toolbar.anchor;
            s.toolbar.offsetX = c.offsetX || 0;
            s.toolbar.offsetY = c.offsetY || 0;
            s.toolbar.dragMoved = !!c.offsetX || !!c.offsetY;
            s.toolbar.anchorOffset = c.buttonPosition && !c.offsetX && !c.offsetY ? null : 'custom';
            s.sites.disabled = c.disabledHosts || [];
            s.toolbar.showOn = c.alwaysShow ? 'always' : 'hover';
            s.ai.enabled = true;
        }
        return s;
    }
    return mergeDeep(s, raw);
}

export function mergeDeep(base, patch) {
    if (patch === undefined) return base;
    if (Array.isArray(base) || Array.isArray(patch)) return patch === undefined ? base : JSON.parse(JSON.stringify(patch));
    if (base && typeof base === 'object' && patch && typeof patch === 'object') {
        const out = {};
        for (const k of Object.keys(base)) out[k] = mergeDeep(base[k], patch[k]);
        for (const k of Object.keys(patch)) if (!(k in base)) out[k] = JSON.parse(JSON.stringify(patch[k]));
        return out;
    }
    return patch;
}

// 工具栏实际渲染清单：内置(启用) + 自定义脚本(启用) + 链接工具(启用)
export function buildToolbar(settings, mediaType, isBg) {
    const items = [];
    const state = settings.tools || {};
    for (const t of TOOLS) {
        const st = state[t.id] || { enabled: false };
        if (!st.enabled) continue;
        if (!t.media.includes(mediaType)) continue;
        if (isBg && !t.media.includes('bg')) continue;
        items.push({
            id: t.id,
            label: st.label || t.label,
            icon: st.icon || t.icon,
            group: t.group,
            action: t.action,
            params: st.params || null,
            kind: 'builtin',
            showImage: t.showImage !== false,
            collapsed: !!st.collapsed,
        });
    }
    for (const c of settings.customScripts || []) {
        if (!c.enabled) continue;
        if (!(c.media || ['image', 'video']).includes(mediaType)) continue;
        items.push({ id: c.id, label: c.label || c.name, icon: c.icon || ICONS.code, group: '自定义', action: { type: 'script', script: c.code, scriptId: c.id, entry: c.entry }, params: c.params || null, kind: 'script', showImage: false, collapsed: !!c.collapsed });
    }
    for (const l of settings.linkTools || []) {
        if (!l.enabled) continue;
        if (!(l.media || ['image', 'video']).includes(mediaType)) continue;
        items.push({ id: l.id, label: l.label || l.name, icon: l.icon || ICONS.link, group: '自定义', action: { type: 'link', linkId: l.id }, params: l.params || null, kind: 'link', showImage: false, collapsed: !!l.collapsed });
    }
    items.sort((a, b) => {
        const oa = (state[a.id] && state[a.id].order), ob = (state[b.id] && state[b.id].order);
        if (oa != null && ob != null) return oa - ob;
        if (oa != null) return -1;
        if (ob != null) return 1;
        return 0;
    });
    return items;
}
