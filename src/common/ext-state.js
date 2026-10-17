// 扩展上下文是否还活着，以及把 Chrome 的内部报错翻译成人话。
//
// 为什么需要：在 edge://extensions 里点「重新加载」之后，已经打开的网页里那份内容脚本会变成僵尸 ——
// 它的 chrome.runtime 端口已随旧扩展一起销毁，之后任何 sendMessage 都会抛/返回
// "Extension context invalidated."。旧脚本没法自愈（删不掉也重连不上），唯一出路是刷新页面，
// 所以这里把这句天书换成明确指令，别让它以「分割失败: Extension context invalidated」的形式吓人。

export const DEAD_TEXT = '扩展已更新，本页面里的旧脚本已失效：请按 F5 刷新页面后再用';

const DEAD_RE = /Extension context invalidated|extension context has been invalidated|Could not establish connection\. Receiving end does not exist|message port closed|Cannot access a chrome-extension: URL of a different extension/i;

export function extAlive() {
    try { return !!(globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.id); } catch (e) { return false; }
}

/** @returns {{dead:boolean, text:string}} */
export function friendlyError(e) {
    const msg = String((e && e.message) || e || '未知错误');
    return DEAD_RE.test(msg) ? { dead: true, text: DEAD_TEXT } : { dead: false, text: msg };
}

/** 给「已经拿到手的错误字符串」用（bgSend 返回的是 {ok:false,error}，不是异常） */
export function friendlyText(msg) {
    const f = friendlyError({ message: String(msg || '') });
    return f.dead ? DEAD_TEXT : String(msg || '未知错误');
}
