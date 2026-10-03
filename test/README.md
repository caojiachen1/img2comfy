# 视频取帧测试

不依赖已安装的扩展：`harness.js` 在页面里桩掉 `chrome.storage/runtime` 后，把
`../content.js` 直接当页面脚本运行。

## 两种跑法

**1. 无头 Edge 自动化（推荐，全自动出报告）**

```sh
python test/cors_server.py 8765   # 两个都要起（CORS 回声服务器，模拟扩展 DNR 注入的响应头）
python test/cors_server.py 8766
node test/run_headless.js
```

**2. 有头浏览器手动观察**：打开 `http://<本机IP>:8765/test/index.html` 直接玩，
或用 bsk 会话驱动。结果读 `window.__comfyTestLog`（顶层 `await window.__collectComfyLogs()`
汇总各 iframe）。

## 关键约束（踩过的坑）

- 测试源必须**非 localhost**：content.js 把 127.0.0.1/localhost 一律当 ComfyUI 页面直接退出。
- 两个端口 (A:8765 / B:8766) 即互为跨源；必须用同一本机 IP。
- **缓存毒化**：媒体元素以 no-cors 方式缓存过的响应不带 ACAO 头，默认缓存模式的
  CORS fetch 会复用它然后 ERR_FAILED——扩展代码里 fetch 必须 `cache:'no-store'`，
  测试服务器则带 CORS 回声（模拟 DNR 注入）。
- 内部取帧上限 500MB，流式读取超限即断；下载进度刷在按钮上。截图接口有每秒配额
  （MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND），连点会限流，报错已带提示。
- Edge 会缓存测试页，改页面后带 `?v=N`。
- 无头 Edge 的全屏布局有怪癖（绝对定位子元素 rect 报到文档坐标），全屏用例请在
  真实浏览器验证。

## 用例矩阵（index.html）

1. 普通视频 + 透明覆盖层（canvas 直取）
2. 跨域直链视频（画布污染 → CORS 克隆取帧：DNR 放行后 `<video crossorigin>` 直指原 URL，
   浏览器按需拉取；服务器带 Range/206 支持模拟 CDN，可用日志验证零整包 200）——微博同型
3. open Shadow DOM 内的视频
4. `pointer-events:none` 视频（抖音分页回归）
5. iframe：同源 child（干净+污染）、跨源 cross2（污染，跨 frame 救援）
6. 自带左右黑边的视频（captureStream 把黑边烘进画面，验证 trimLetterbox 裁成 640x360）
7. 容器全屏（真实浏览器里验证：wrap 迁入全屏元素 + 视口坐标）

`test/media/sample.mp4` 是 MDN 的 CC0 flower.mp4，可删。
`debug_*.js` 是排障脚本（fetch 毒化定位、全屏布局探查），留作复用。
