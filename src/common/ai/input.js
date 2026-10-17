// 把内部像素对象转成 transformers.js 接受的图像输入。
// v4.3.1 的 RawImage.read 只认 RawImage / string|URL / Blob / (Offscreen)Canvas，
// 传 ImageData 会直接 "Unsupported input type: object"，所以统一走 RawImage(data,w,h,4)。

let cached = new WeakMap();

export function canvasInput(px, tf) {
    if (tf && tf.RawImage) {
        const key = tf;
        let entry = cached.get(key);
        if (!entry) { entry = new Map(); cached.set(key, entry); }
        const sig = px.width + 'x' + px.height + ':' + px.data.length;
        let ri = entry.get(sig);
        if (!ri || ri.data !== px.data) {
            ri = new tf.RawImage(px.data, px.width, px.height, 4);
            entry.set(sig, ri);
        }
        return ri;
    }
    return pxToCanvas(px);
}

function pxToCanvas(px) {
    const Ctor = typeof OffscreenCanvas !== 'undefined' ? OffscreenCanvas : HTMLCanvasElement;
    const canvas = new Ctor(px.width, px.height);
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(px.data, px.width, px.height), 0, 0);
    return canvas;
}

export { pxToCanvas };
