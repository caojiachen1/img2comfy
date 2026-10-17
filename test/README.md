# 测试台

新版（v2，模块化 + 打包内容脚本）的验证分四层，逐层都比上一层真：

| 命令 | 覆盖 | 说明 |
| --- | --- | --- |
| `node scripts/check-imports.mjs` | 62 个文件 | 语法 + 相对路径 + 具名导入是否存在 |
| `node test/unit_pure.mjs` | 209 条 | 纯算法单测（重采样/色彩/滤波/边缘/CV/算子链/设置迁移/人脸数学） |
| `node test/run_browser.mjs` | 18 条 | 内容脚本包在真实浏览器里：工具栏、折叠菜单、拖拽与锁位、图层命中、算子链、视频取帧 |
| `node test/run_browser.mjs --only=options` | 52 条 | 设置页（`harness_options.html` 搬 DOM + 桩后台 + 逐个点按钮） |
| `node test/run_browser.mjs --ai --only=sr\|sam\|face\|vlm\|script\|warm\|faceid\|ms` | 按需 | 真实推理与模型源检查，`AI_WAIT`/`OPT_WAIT` 调轮询预算 |
| `node test/extension_smoke.mjs --headed` | 26 条 | **装了真扩展**：认领自己的 SW、注入、真鼠标点按钮（下载落盘 / 剪贴板有位图）、逐按钮扫描、人脸链路、日志窗、滚动后锁位 |

前置：自动测试必须用 Chrome for Testing（品牌版 Chrome/Edge 137+ 忽略 `--load-extension`）：

```bash
npx @puppeteer/browsers install chrome@stable --path test/.browsers
```

## 排障工具（要手动起服务器）

```bash
python test/cors_server.py 8765          # 带 CORS 回声 + Range/206 的静态服务器
PAGE=face_probe.html node test/face_probe.mjs     # 人脸框与五点画回原图，肉眼核对解码
node test/face_fit.mjs                            # 量长宽比 / 眼距÷框宽 / 五点是否落在框内
```

`test/wasm_probe.html`（Cache API → blob → ORT 建会话）、`test/runtime_probe.html`（假装 vendor 里没有
→ 真 CDN 下载 → 进度事件 → 装好后的状态）、`test/vlm_call_probe.html`（多模态在 4.3.1 这份构建上的真实
函数签名）同理，都是 `PAGE=… node test/face_probe.mjs` 或直接开页面跑。

## 踩过的坑（改测试前先读）

- **判定一律读产物**：脚本自己写的 `test/out_smoke.json` 里 `summary.failed` 才算数。后台命令末尾挂
  `; echo exit=$?` 会让通知里的 0 属于 `echo`；日志只有半截、没有 `=== 汇总 ===` 是**中途断了**，不是通过。
- **面板先出、覆盖层后画**是常见顺序，轮询断言要再看几轮取"最终/最多"那一帧，first-match 就 return 会误判成失败。
- harness 里换图必须 `document.dispatchEvent(new MouseEvent('mouseover'|'mousemove',{bubbles:true,composed:true}))`：
  `Input.dispatchMouseEvent{type:'mouseMoved'}` 在真扩展里**不会**让工具栏收起（指针落在工具栏自己身上时不许收，
  这是产品行为），于是后面读到的还是上一张图。
- 往 fixture 里加元素会让后面的步骤掉到视口外，`elementFromPoint` 拿不到东西 → 表现成"功能坏了"的假故障。
  任何新素材都要先 `scrollIntoView({block:'center'})` 再量。
- CSS 选择器穿不过 shadow root：要 `document.getElementById('mtb-root').shadowRoot.querySelectorAll(...)`。
- 剪贴板与下载要真手势（`Input.dispatchMouseEvent` + `Page.bringToFront`），合成点击骗不过激活检查；
  验证结果用 OS 侧读回（`Get-Clipboard -Format Image` / 回收 `chrome.downloads` 的 `state`）。
- 桩必须照抄真后台的转发语义与响应形状：宿主路由是 `sendResponse({ok:true, ...结果})`（平铺），
  桩直接回最终结果会让"进度事件到不到得了 UI"这条链永远没被覆盖。

`test/media/` 是人脸链路素材（`face_lena.jpg`、`det_500m.onnx`、`w600k_mbf.onnx`，缺文件时该步自动按"跳过"处理），
`sample.mp4` 是 MDN 的 CC0 flower.mp4。测试页里那些 `/test/make/edge.png`、`/test/make/sample.mp4`
**不是磁盘上的文件**：`run_browser.mjs` 内置的静态服务器现场生成（左白右黑的边图）或从 `test/media` 读出来回，
所以别去目录里找它们。`sample.mp4` 只有一个关键帧，任何 `currentTime` 赋值都被浏览器吸回 0，
"逐帧真的前进一帧"在自动化里测不出来，只能断链路 + 反馈文案。
