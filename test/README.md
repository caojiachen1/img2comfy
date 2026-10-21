# 测试台

新版（v2，模块化 + 打包内容脚本）的验证分四层，逐层都比上一层真：

| 命令 | 覆盖 | 说明 |
| --- | --- | --- |
| `node scripts/check-imports.mjs` | 62 个文件 | 语法 + 相对路径 + 具名导入是否存在 |
| `node test/unit_pure.mjs` | 220 条 | 纯算法单测（重采样/色彩/滤波/边缘/CV/算子链/设置迁移/人脸数学/微博图 URL 升级与 `mw690`/`mw2000`/`large` 尺寸档位） |
| `node test/run_browser.mjs` | 18 条 | 内容脚本包在真实浏览器里：工具栏、折叠菜单、拖拽与滚动跟随图片、图层命中、算子链、视频取帧 |
| `node test/run_browser.mjs --only=options` | 52 条 | 设置页（`harness_options.html` 搬 DOM + 桩后台 + 逐个点按钮） |
| `node test/run_browser.mjs --ai --only=sr\|sam\|face\|vlm\|script\|warm\|faceid\|ms` | 按需 | 真实推理与模型源检查，`AI_WAIT`/`OPT_WAIT` 调轮询预算 |
| `node test/extension_smoke.mjs --headed` | 29 条 | **装了真扩展**：认领自己的 SW、注入、真鼠标点按钮（下载落盘 / 剪贴板有位图）、逐按钮扫描、人脸链路、日志窗、滚动时工具栏贴着图片走、**`chrome.runtime.reload()` 之后点齿轮只说「刷新页面」，不许冒 `Extension context invalidated` 未捕获异常**（这条必须在所有真功能步骤之后跑，重载会把扩展换掉） |
| `node test/gallery_probe.mjs --headed --weibo-host` | 61 条 | 本页图片面板：九宫格抑制、查看器大图、**按真微博桌面版 DOM 复刻的夹具**（`article.card9.weibo-main` + 表头「空文字头像链接 `/u/<uid>`」+「`_link_ _bolder_` 账户名但 href 指回 `/mygroups?gid=`」+ `_time_` 时间链接 + 正文 `@提及` + 每格角标图与每格永久链接 + 一条被搬到 `top:-9753` 的回收帖）：一条微博一组、组名必须是表头账户名（不被时间/正文 @提及顶替、不许「未识别账号」）、回收帖不混进列表、`orj360 → large` 且 `card=mw690 / full=mw2000`、**卡片只拉 mw690、查看器只拉 mw2000、浏览阶段一张都不拉 large（4.2MB）**、发送时才 36 次 large、每行固定三张（800/560/480 都验三列）、卡片图 `object-fit:contain` 留黑边不裁切、各视口无横向滚动、懒加载、**采集不滚不缩放用户页面**、注入懒加载小图后重复刷新也不把一条拆两组、「只看屏幕附近」能过滤、**打开面板自动滚到当前正在看的那条微博并高亮**、**面板重开靠后台按标签页缓存不丢、**关掉面板再打开勾选状态还在**（先在新面板勾 3 张、把面板标签页全关掉、再开一个全新文档，必须仍是这三张勾选且计数写「已选 3」）**、**用户自己滚过再刷新时数量只增不减**、**易误杀形状夹具 `?shapes=1`**（比例 12 的长图、`content-visibility` 容器里还没解码的懒图按属性尺寸收，1×1 的 data: 占位图不收，转发复用同一 pid 的两条微博各算一条且组内仍去重）、**内层滚动容器夹具 `?scroller=1`**（容器 scrollTop 要加回文档坐标，滚过顶部的帖子不算回收节点，同容器里 `top:-9000` 的照旧挡）、摘要必须写明「无用图片 N 张」并给出原因分布（无用图片是最后一个默认折叠的分组，展开前不建卡片、**展开后再点「收起」必须真的不显示任何卡片**）、**卡片角标只有尺寸+类型两个且不含档位文字**（`g-tag` 数量恰为 2，出现 `mw690/orj/large/缩略图/档位` 即失败）、**同域无扩展名的坏地址（夹具里的 `/u/false` → `https://weibo.com/u/false`）既不进内容组也不进无用组**、**打开面板不跳**（故意用 560×600 视口，比 CSS 兜底的 800 窄，所以钉尺寸前卡片必然偏大：`#bootMask` 必须在钉尺寸前可见，揭开后每张卡片宽度一次都不许变，`--cols` 仍是 3）、`?fold=1` 页（`_picNum_ +6`）靠 `/ajax/statuses/show` 补齐 9→15 张且补来的图带 mw690/mw2000 档、卡片不再先铺缩略图、`?wide=1` 大窗、后台代理缩略图、全选、批量发送到假 ComfyUI、**每个分组头自己的「反选」只翻转这一条微博**（两条微博各全选 9/9=18 → 点第一组的反选 → 0/9/9 → 再点一次翻回 9/18；然后演真实场景：一条九宫格只发 3 张，发完点这组的反选 → 选中的恰好是这条里没发的 6 张、已发的 3 张取消、别组一张不碰）、脚本漏传 filename 时上传名仍唯一、**微博信息流筛选**（`?filter=1` 夹具照真页面复刻虚拟列表：6 条帖子各自装在 `transform: translateY(...)` 的绝对定位槽里。断言是「被挡的帖子整条 `display:none` 且自身零高、其余照常」，**不承诺**相邻槽紧连：真页面是绝对定位虚拟列表，槽位由 scroller 摆，只藏 article 会保留一段空白（试过连槽上移，会被 scroller 覆盖回来并让整页闪/全黑，已回退）。面板顶部必须有两个 tab，切到「筛选微博」后表单可见、类型默认全勾；取消「纯文字」→ 立刻只藏那一条且槽位让位；把起始日期设成 2026-10-21 → 3 条；加「不含 抽奖」→ 4 条；再取消「原创」→ 5 条、只剩转发那条（夹具里每篇都带一个 `woo-font--retweet` 转发图标做诱饵，用 `[class*="retweet"]` 判转发会在这里全灭）；清除筛选 → 6 条全回来、槽位恢复、提示条消失；并存下 `site = 当前站点`（「针对当前微博网站」）。**实验模式**（`?filter=1` 夹具里塞了一个假 Vue 根 `#app._vnode.component.data.list`）：打开实验开关后，页面里那份数组从 6 条变 4 条（9001 纯文字/9004 抽奖被真正移除）、DOM 里只剩 4 条且没有被加过 `display:none`；关掉开关数组恢复 6 条、退回页面隐藏；再模拟一次 SPA 换页（换成一个新数组 + 改 hash + 把旧组件以「更长」的旧列表留在 Vue 树里 + 目录换成新页面的帖子）→ 必须只按新页面的列表筛、旧帖一条不许混进来；换页后关掉实验模式新页面要原样回来；换页后第一次调用就是「关掉」也不许把新页面清空；**右下角提示条可以点开**——页面隐藏模式下展开 1 条、正文含「随便聊聊」且带 `weibo.com` 原文链接；实验模式下展开 2 条（随便聊聊 / 抽奖送周边）、每条都有作者名和原文链接）。**不带 `--weibo-host` 时少 5 条**（筛选不挂非微博站点：条件开到最严也不插提示条、不改任何帖子），共 48 条。**不带 `--weibo-host` 跑同一份夹具**但走普通站点分支：只认 `rel="author"`／class 含 `name·nick·user`／`/u/ /profile/` 这类通用链接，认不出 `_link_`+`/mygroups` 的账户名，期望 3 组（认不出作者就并到同组），脚本按 `WEIBO_HOST` 切期望。两个 harness 坑：`--host-resolver-rules` 多条规则**必须逗号分隔**（空格拼会整条失效 → 夹具页变成 Chrome 报错页，症状是 `ready.root=false`、`imgs` 只剩报错页的 2 张）；本机上 `<img>` 请求根本没带 `sec-fetch-dest`，所以「代理请求」只能靠档位名区分（页面自己只会用 `orj360`） |

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
