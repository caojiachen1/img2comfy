// 扩展上下文是否还活着，以及把 Chrome 的内部报错翻译成人话。
//
// 为什么需要：在 edge://extensions 里点「重新加载」之后，已经打开的网页里那份内容脚本会变成僵尸 ——
// 它的 chrome.runtime 端口已随旧扩展一起销毁，之后任何 sendMessage 都会抛/返回
// "Extension context invalidated."。旧脚本没法自愈（删不掉也重连不上），唯一出路是刷新页面，
// 所以这里把这句天书换成明确指令，别让它以「分割失败: Extension context invalidated」的形式吓人。

export const DEAD_TEXT = '扩展已更新，本页面里的旧脚本已失效：请按 F5 刷新页面后再用';

// wasm 是 32 位地址空间，浏览器里一份大权重 + 激活值就会越界，
// ORT 崩出来只有一句 "memory access out of bounds"，用户看不出跟模型大小有关。
export const MEMORY_TEXT = '浏览器内存放不下这个模型（wasm 只有 4GB 地址空间）：请在设置里换小一点的模型/档位（如 q4），或改用 WebGPU 设备';

const DEAD_RE = /Extension context invalidated|extension context has been invalidated|Could not establish connection\. Receiving end does not exist|message port closed|Cannot access a chrome-extension: URL of a different extension/i;
const MEMORY_RE = /memory access out of bounds|out of memory|Aborted\(|RuntimeError: memory|Cannot allocate memory|too many bytes/i;

export function extAlive() {
    try { return !!(globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.id); } catch (e) { return false; }
}

/** @returns {{dead:boolean, text:string}} */
export function friendlyError(e) {
    const msg = String((e && e.message) || e || '未知错误');
    if (DEAD_RE.test(msg)) return { dead: true, text: DEAD_TEXT };
    if (MEMORY_RE.test(msg)) return { dead: false, text: MEMORY_TEXT, memory: true };
    return { dead: false, text: msg };
}

/** 给「已经拿到手的错误字符串」用（bgSend 返回的是 {ok:false,error}，不是异常） */
export function friendlyText(msg) {
    return friendlyError({ message: String(msg || '') }).text;
}
