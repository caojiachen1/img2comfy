# Media Hover Toolbar（网页图片/视频悬浮工具栏）

悬停任意网页的 `<img>` / `<video>` / `background-image` 容器，即出一个**完全可自定义**的悬浮工具栏：
图片基础操作、经典 CV 算子、AI 能力（多模态识别 / 分割 / 人脸 / 超分），以及你自己的自定义功能。
ComfyUI 发送与「发送并立即执行」是两条**内置的自定义脚本示例**，走的正是第三方功能那套 `ctx` API。

> 本项目由 `Send image to ComfyUI` v1.3 改造而来，v1 的取帧与防盗链能力全部保留（含四级降级取帧、
> 黑边三重防误裁、抖音轮播/遮挡剔除/shadow DOM 穿透等已验证行为）。

---

## 一、装上

```bash
# 1) 打包内容脚本（Chrome 的 content_scripts 不支持 ES 模块，必须合成经典脚本）
node scripts/build-content.mjs

# 2) 安装 AI 运行时（可选，但 AI 按钮必需；约 67MB 落到 vendor/）
node scripts/setup-vendor.mjs
```

然后 Edge 打开 `edge://extensions` → 开发模式 → 「加载解压缩的扩展」→ 选本目录。
点扩展图标进设置页；工具栏的外观、按钮、位置、AI、自定义功能全在那里配。
每个按钮（内置与自定义都一样）可设三态：**常驻 / 折叠进 ▾ 菜单 / 不显示**。行内的勾选框只管显示与隐藏，
「显示位置（常驻 / 折叠）」放在该按钮右侧 ⚙ 的设置面板里，和它的参数一起改；折叠项收在工具栏末尾的
「⋯ 更多 ▾」里，点一下就执行并自动收起（点别处或按 Esc 也收）。

悬停只认**最上层**那张媒体：`elementsFromPoint` 会漏掉 `pointer-events:none` 的元素，所以命中栈下标不能
单独当图层深浅，另按 CSS 绘制顺序（同父分叉处先看 z-index/是否定位，再看 DOM 顺序）比较，被压在下面的
图片永远不弹工具栏。但**隐形的不算遮挡物**（`display:none`/`visibility:hidden`/`opacity:0`）：x.com 的照片
正是「容器 `background-image` + 里面一张 `opacity:0` 的占位 `<img>`」，占位图若被当成不透明遮挡物，
它爹（真正那张图）就被剔除，整站再也弹不出工具栏；父容器与自己的后代互为遮挡物同样不成立。
候选全被剔除时也不再直接放弃，而是退回候选里最上层那个——「有图却什么都不弹」比弹错一张更糟。
`background-image` 容器与 `<img>` 走同一条直链取图路径，所以拿到的是**完整工具栏**（复制/下载/算子/AI/ComfyUI），
不再只有三枚链接按钮。尺寸闸门除「两边都 ≥ 最小尺寸」外还认两种：细长横幅（短边 ≥ 40%、面积够）与
「显示很小但源图很大」的缩略图（短边 ≥ 64px、源图两边都达标），24px 一类的图标仍然不打扰；
阈值是设置页的「最小尺寸」（`toolbar.minImgSize`，默认 200）。
工具栏**一旦显示就锁住屏幕位置**——移动指针、换图、重新探测、页面滚动都不会让它自己
跑掉，只有拖 ⠿ 手柄才会挪（松手即写回 `offsetX/offsetY`）；收起后再次悬停别的图片才按那张图重新锚定。
「推理中 / 取帧中 / 已开始下载」这类过程日志全部进**右侧悬浮日志窗**（同一任务原地刷一行，结束补耗时，
✕ 或超时收起，可拖动），工具栏按钮旁边不再有状态文字。

改动 `src/content/**`、`src/common/**` 后需要重跑 `build-content.mjs`（内容脚本是打包产物）。
`src/host`、`src/options`、`background.js` 是扩展页/SW，用原生 ES 模块，改完在扩展页
点「重新加载」即可，不需要打包。

## 一之二、AI 运行时怎么来

MV3 扩展页的 `script-src 'self'` 挡掉了跨源脚本与 `blob:` 模块，所以 **JS 与 `.mjs` glue 必须随扩展打包**；
但 `.wasm` 走 `wasm-unsafe-eval` + 普通 fetch，可以先下进 Cache API 再把 `blob:` 地址交给 ORT。
于是「自动安装运行时」只做一件事：**按需下载 `ort-wasm-simd-threaded.asyncify.wasm`（约 26MB）**。

- 设置页「AI 与模型 → AI 运行时文件」列出每个文件的状态（扩展包内 / 已下载 / 未安装 / 不完整）、总大小与
  存储余量；按钮是「安装运行时 / 安装全部三份 / 重新检测 / 清除已装」，下面是进度条与实时速率。
- 版本按 transformers.js 4.3.1 依赖的 `onnxruntime-web@1.31.0-dev.20260914-8d85527a0` 锁死，下完用
  **字节数复核**（26,861,777），对不上就换下一个源：自建 ModelScope 镜像 → jsDelivr → fastly → gcore → unpkg。
- 机制验证：`PAGE=wasm_probe.html node test/face_probe.mjs` 跑「wasm → Cache → blob → ORT 真推理」；
  `PAGE=runtime_probe.html node test/face_probe.mjs` 跑「假装包里没有 → 真 CDN 下载 → 进度事件 → 装好后的状态」。
- 想离线预置或 CDN 全不通，仍可跑 `node scripts/setup-vendor.mjs`；包里有文件时不会重复下载。
- **默认模型源是 ModelScope，且权重全部镜像到自建仓库**（`cjc1887415157/*`，
  `https://www.modelscope.cn/models/{id}/resolve/master/{file}`，实测下行 5~15 MB/s、上行 ~4.5 MB/s，
  且 resolve 直链带 `Access-Control-Allow-Origin:*`，扩展页可直接取）。
  搬运与校验脚本：`node scripts/ms-mirror.mjs --list` 看计划、`--all` 全搬（按字节数校验后才上传，
  半截文件不会进仓库）；`node scripts/ms-check.mjs` 查上游是否已有同步仓。

## 二、验证

```bash
node scripts/check-imports.mjs        # 语法 + 相对路径 + 具名导入是否存在（30+ 文件）
node test/unit_pure.mjs              # 209 条纯算法单测（重采样/色彩/滤波/边缘/CV/算子链/设置/人脸数学）
node test/run_browser.mjs            # 页面级：内容脚本包 + 工具栏 + 拖拽 + 算子链 + 视频取帧
node test/run_browser.mjs --ai       # 再加：vendor + slimSAM/swin2SR/YuNet 真实推理 + 设置页
node test/run_browser.mjs --ai --only=sr|sam|face|vlm|script|options   # 单跑某一阶段
```

`--only=script` 那一支是 QuickJS 引擎的端到端检查（7 条）：引擎加载、异步服务桥接、语法错误捕获、
运行时异常回传、`module.exports` 形式、死循环被中断、供设置页用的语法检查。

`--only=options` 那一支是**设置页**检查（`test/harness_options.html`，52 条）：扩展页在无头里打不开，
所以把 `options.html` 的 DOM 搬进普通网页、用 `harness_stub.js` 冒充后台，然后逐个点开标签页、
点每个按钮（检测运行时/模型占用/测试连接/自检/新建脚本/语法检查/试跑/新建链接）。
它专门用来逼出「只有点到那个按钮才炸」的 `ReferenceError`——已揪出过 `doRuntimeProbe` 里把函数参数
`S_` 当模块变量用的真 bug。断言的形状是：任何输出块里都不许出现 `is not defined` / `Cannot read properties of undefined`。

`test/run_browser.mjs` 需要 **Chrome for Testing**：品牌版 Chrome/Edge 从 137 起忽略
`--load-extension`，所以自动测试用 CfT（脚本会自动找 `test/.browsers`）：

```bash
npx @puppeteer/browsers install chrome@stable --path test/.browsers
```

`test/extension_smoke.mjs` 是**装了真扩展**的端到端检查：认领我们自己的 service worker（Chrome 自带的
内置扩展也有 `background.js` 的 SW target，得按「解包扩展 ID = 路径 UTF-16 SHA-256 前 32 位映射 a-p」认领）、
内容脚本注入、悬停出工具栏、算子链、视频取帧、离屏宿主（断言没有多余 host 标签页）、
**CDP 真鼠标点按钮**→ 下载真的落盘 / 剪贴板真的有位图与文本，再把每个启用的按钮挨个点一遍。

```bash
node test/extension_smoke.mjs --headed     # 有头：扩展页能打开，剪贴板/下载都按真手势走（推荐）
node test/extension_smoke.mjs              # 无头：扩展页必然 chrome-error，那几步自动按「跳过」处理
```

v1 的那套（`content.js` / `content.css` / `popup.*` / `test/index.html` + `run_headless.js` + `harness.js`
跨源取帧用例）已经删掉：新版工具栏与取帧链路由 `test/run_browser.mjs` 与 `test/extension_smoke.mjs` 覆盖，
旧文件既不在清单里也不再被引用。`test/cors_server.py` 留着，它是有 CORS 回声的静态服务器，
`node test/face_probe.mjs`、`node test/face_fit.mjs` 这两个量人脸几何的排障工具靠它起页面。

## 三、能力清单

**基础**：复制链接 / 复制干净链接（去签名与尺寸参数）/ 复制图片 / 下载 / 新标签打开原图 /
详细信息（源址、自然尺寸与显示尺寸、字节、MIME、时长、倍速、音量）/ 原图预览浮层。

**高清与几何**：Lanczos2/3/4、Bicubic(Catmull-Rom)、Mitchell、Cubic B-spline、Bilinear、Area/Box、
Nearest 重采样；Unsharp Mask、核锐化；旋转（任意角度双线性 + 90° 无损快路径）、翻转、按比例/矩形/中心裁剪、
补边、自动裁黑边（黑/白/纯色/自动 + 三重防误裁）、圆角羽化。

**调色/滤镜**：亮度/对比度/饱和度/vibrance/色相/色温/色调/Gamma/曝光/色阶/曲线/通道混合器/
色阶分离/去色（5 种权重）/反色/怀旧/双色调/纯色叠加/白平衡（灰世界·百分位·手动）/
直方图均衡/CLAHE/自动色阶/一键增强。

**CV 算子**：高斯/均值/中值/双边滤波、加噪（高斯·椒盐·乘性）、像素化、油画、暗角、抠色（RGB/HSV 双模型）；
Sobel/Scharr/Laplacian/Canny/LoG；OTSU·固定·自适应均值·Sauvola·局部 std 二值化（可 trirate）；
形态学（腐蚀/膨胀/开/闭/梯度/顶帽/黑帽，方/十字/圆结构元）。

**分析与测量**：像素统计、直方图与熵、主色板（中位切割）、连通域、轮廓（Moore 追踪 + RDP + 凸包 +
最小外接矩 + 圆度）、Harris 角点、霍夫直线、HSV 范围分割、模板匹配（NCC）、a/d/p-hash 与海明距离、
SSIM/PSNR/MSE、帧间差、内容区测量。

**AI**（`vendor/` + 浏览器内推理，可切 GPU/CPU）：
- 看图说话 / 提问 / OCR / 标签：**Qwen3-VL-2B**（默认，`cjc1887415157/Qwen3-VL-2B-Instruct-ONNX`）
  或 Qwen2-VL-2B / SmolVLM2-500M / SmolVLM2-256M（CPU 首选，q4 约 250MB），也可手填任意仓库 ID
- 点选抠图 / 自动分割：**slimSAM**（约 13MB，已实测跑通）、SAM ViT-B
- 人脸识别 / 人脸打码：**YuNet 2023mar**（232KB，已实测加载+推理+多输出解码）
- AI 超分：**swin2SR** 系列（5–10MB，已实测 256×128 → 512×256）、或自填任意 Real-ESRGAN 类 ONNX
- 深度图：Depth Anything Small/Base
- 权重下载默认走自建 **ModelScope** 镜像（`cjc1887415157/*`，国内实测 5~15 MB/s），设置里可切回
  hf-mirror / huggingface.co / jsDelivr / 自定义源；进度实时刷在按钮上；Cache API 持久缓存 + 占用统计/清理；
  下载预算闸门（超预算要先确认）

**视频专属**：提取当前帧（四级降级：画布直取 → CORS 克隆免整包下载 → 整包重建 → 标签页截图裁剪）、
存当前帧、抽帧拼图、批量导出帧、复制时间码、逐帧进退、倍速循环、播放/暂停、静音、循环、画中画。
倍速/循环/静音改的是 `<video>` 元素属性，而 B 站、抖音这类播放器会在 play / seek / 换源后把它改回去，
所以这些操作记着「用户意图」并在这些事件上重新按一次，同时把**最终值读回来**提示（不生效就说不生效，不谎报）。
默认配置里播放控制（播放/暂停、倍速、循环）常驻，逐帧、时间码、抽帧、静音、小窗折叠进 ▾ 菜单。

**自定义功能**：
1. **脚本型**（`ctx` API 的 JS）——内置示例①发送到 ComfyUI、示例②发送并立即执行、示例③AI 读字并复制、
   示例④算子链组合。API 见设置页「自定义功能 → ctx API 参考」，或 `src/common/builtin-scripts.js`。
2. **链接型**（不写代码）——URL 模板 + `{src} {page} {w} {h} {t} {title} {dataUrl}` 占位符，GET 开标签/复制，
   POST 走后台。内置示例：以图搜图。

用户脚本由 `src/common/script-vm.js` 在宿主页里交给 **QuickJS（编译成 wasm）** 解释执行：拿不到
`chrome.*`、`document` 与页面 DOM，只能用 `ctx.fetch / ctx.host / ctx.ai / ctx.comfySend / ctx.download /
ctx.storage / ctx.overlay …`，特权动作由后台按名字白名单提供。VM 与宿主之间是「请求队列 + 结果回填」的
单向轮询桥，所以不需要 host 函数注入，也就不需要 `eval`。每次同步执行都带中断时限（`setInterruptHandler`），
脚本写成 `while(true){}` 会在超时处被 `InternalError: interrupted` 掐断，不会把宿主页永久冻死。

## 四、结构

```
manifest.json                 MV3：content_scripts 指向打包产物；offscreen 宿主；host_permissions
background.js                 ES module SW：设置存储与迁移、DNR 伪装 Referer/补 CORS、抓取与下载代理、
                              离屏宿主生命周期、ComfyUI 上传+节点注入（前端注入 / API 两种模式）
src/content/                  内容脚本（打包成 content.bundle.js）
  main.mjs  probe.js  frame.js  ui.mjs  runner.mjs
src/common/
  registry.js      工具目录 + 默认设置 + 旧配置迁移（唯一真值：工具栏、设置页、host 都用它）
  steps.js         算子注册表（参数元信息驱动设置页编辑器）
  imgops/*.js      geometry / color / filter / edge —— 纯像素实现，不依赖 canvas
  cv.js            分析与测量
  ai/*.js          vlm / sam / face / sr / vision / ort-load / ai-env / ai-io / input
  builtin-scripts.js  内置自定义功能（ComfyUI 两条 + 示例）
  script-vm.js     QuickJS(wasm) 用户脚本引擎：ctx 外壳、服务轮询桥、中断时限与超时
src/host/host.html|host.mjs   offscreen 宿主：算子链执行、AI 任务、用户脚本桥接
src/options/*                 设置页（外观/按钮/输出/AI/自定义/站点/导入导出 + 实时预览与拖拽）
vendor/                       transformers.js + onnxruntime-web + QuickJS wasm（setup-vendor.mjs 生成，已 gitignore）
scripts/                      build-content / setup-vendor / check-imports
test/                         unit_pure（182 条）、run_browser + harness_page/harness_ai/harness_options/harness_stub、
                              cdp.mjs、旧的 run_headless + harness + cors_server
```

架构要点：
- 像素与 AI 一律在 **offscreen 宿主文档**里跑（有 DOM/OffscreenCanvas/WebGPU，且能装 wasm）；
  不可用时自动退回隐藏标签页承载同一份 `host.mjs`。内容脚本只做命中探测、UI、视频取帧、结果叠加与下载。
- 图片经后台按 `Referer` 伪装 + `host_permissions` 取回，天然避开跨域污染；视频帧沿用 v1 的降级链。
- `ai.device` = `auto|webgpu|wasm`；WebGPU 不可用自动回落 CPU，并在设置页「检测运行时」里说明原因。

## 五、已知边界（如实记录）

- 端到端验证覆盖到：209 条算法单测、内容脚本包在真实浏览器里的工具栏/拖拽/算子链/视频取帧/图层命中、
  slimSAM 与 swin2SR 的真实推理、SCRFD+ArcFace 的加载+推理+解码+人脸库比对（同一人 0.98/0.73、异人 0.04）、
  多模态也跑通了真推理（`qwen3vl-2b` q4f16 约 490s、`smolvlm2-256m` 约 146s 出答案）。
  GB 级权重在 CPU 模式下仍然很慢，建议 GPU + `q4`；断流写坏的半截缓存会在建会话时炸成
  protobuf/内存错误，现在会丢缓存自动重下一次。
- 扩展页（`options.html` / `host.html`）在 **headless** CfT 里打不开（返回 `chrome-error://`），这是无头模式的限制，
  不是清单/CSP 问题：`scripts/probe-manifest.mjs` 实测 8 种 manifest 变体都能正常注册 SW、扩展能被加载。
  **有头 CfT 可以打开扩展页**，所以设置页与宿主页已经进了 `extension_smoke.mjs --headed` 的断言；
  另外 `test/harness_options.html` 用「搬 DOM + 桩后台 + 逐个点按钮」在普通网页里覆盖了设置页逻辑。
  真人 Edge 里剩下的只是装载本身的体检（品牌浏览器忽略 `--load-extension`，没法自动化）。
- 视频位于跨域 iframe 且画布受保护时，只能退回标签页截图（会带播放器 UI）。
- **CSP**：MV3 的 `extension_pages` **不允许 `'unsafe-eval'`**（只允许 `'wasm-unsafe-eval'`，写 unsafe-eval 会被 Edge 直接拒绝加载扩展）。
  核对结论：`@huggingface/jinja`（聊天模板）与 transformers.js 浏览器构建里 `new Function(`、`eval(`
  命中数均为 **0**——jinja 是 AST 解释器，不生成 JS 代码，所以**没有 unsafe-eval 时 VLM 照常可用**。
  唯一需要 eval 的是用户自定义脚本，现在改为在 wasm 里跑 QuickJS 解释器（`src/common/script-vm.js`），
  因此 manifest 里既没有 `sandbox` 页也没有放松 CSP；设置页的「语法检查」同样经宿主转发给 QuickJS 编译。
- 用户脚本不能直接操作页面 DOM（只能经 `ctx.overlay/panel`），这是刻意的安全边界。
