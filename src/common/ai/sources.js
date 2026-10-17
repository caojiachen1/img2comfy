// 模型源解析：默认从自己的 ModelScope 仓库取（国内实测 5~14 MB/s，扩展页跨源有 CORS 头），
// 用户在设置里把源切回 hf-mirror / huggingface.co 时，用预设里保留的原始 HF id。
// 每个预设因此带两个字段：model = HF 上的原仓库，ms = 自己命名空间下的镜像仓库。

export const MS_NS = 'cjc1887415157';
export const MS_BASE = 'https://www.modelscope.cn';

export function modelIdFor(ai = {}, preset) {
    if (!preset) return '';
    if (ai.hub === 'modelscope' && preset.ms) return preset.ms;
    return preset.model;
}

// 裸 ONNX 文件（人脸检测/识别这类不走 transformers.js 的）拼绝对地址用
export function msFile(name) {
    return `${MS_BASE}/models/${MS_NS}/${name}`;
}
