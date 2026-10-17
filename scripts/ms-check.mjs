// 查 ModelScope 上是否已有这些仓库（含同名/常见镜像前缀），避免白搬几十小时带宽。
// 用法：node scripts/ms-check.mjs
const REPOS = [
    'onnx-community/Qwen3-VL-2B-Instruct-ONNX',
    'onnx-community/Qwen2-VL-2B-Instruct',
    'HuggingFaceTB/SmolVLM2-500M-Video-Instruct',
    'HuggingFaceTB/SmolVLM2-2.2B-Instruct',
    'Xenova/slimsam-77-uniform',
    'onnx-community/mobilesam-1.0.0-hf',
    'Xenova/sam-vit-base',
    'onnx-community/sam2-hiera-small',
    'Xenova/swin2SR-classical-sr-x2-64',
    'Xenova/swin2SR-lightweight-x2-64',
    'Xenova/swin2SR-classical-sr-x4-64',
    'Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr',
    'onnx-community/mobilenetv4_conv_small.e2400_r224_in1k',
    'Xenova/vit-base-patch16-224',
    'Xenova/clip-vit-base-patch32',
    'Xenova/depth-anything-small-hf',
    'Xenova/depth-anything-base-hf',
    'WePrompt/buffalo_sc',
];
const PREFIXES = ['sd-webui', 'AI-ModelScope', 'Google', 'LLM-Research', 'Xenova', 'onnx-community', 'HuggingFaceTB', 'deepseek-ai', 'damo', 'iic'];

async function exists(id) {
    const r = await fetch(`https://www.modelscope.cn/api/v1/models/${id}`, { cache: 'no-store' });
    if (!r.ok) return false;
    const t = await r.text();
    return !/"Code":\s*4|not found|Not Found/i.test(t.slice(0, 400)) && /"Name"|"Model"/i.test(t);
}

async function files(id) {
    const r = await fetch(`https://www.modelscope.cn/api/v1/models/${id}/repo/files?Revision=master&Recursive=true`, { cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json();
    return (d?.Data?.Files || []).map((f) => ({ path: f.Path, size: f.Size }));
}

for (const repo of REPOS) {
    const [org, name] = repo.split('/');
    const cands = [repo, `${org}--${name}`, ...PREFIXES.map((p) => `${p}/${name}`), ...PREFIXES.map((p) => `${p}/${repo.replace('/', '--')}`)];
    let hit = null;
    for (const c of cands) {
        if (await exists(c)) { hit = c; break; }
    }
    if (!hit) { console.log(`缺  ${repo}`); continue; }
    const fs_ = await files(hit);
    const total = (fs_ || []).reduce((a, f) => a + (f.size || 0), 0);
    console.log(`有  ${repo}  →  ${hit}  (${(fs_ || []).length} 文件 / ${(total / 1048576).toFixed(1)} MB)`);
}
