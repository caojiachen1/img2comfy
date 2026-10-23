# 测试台

新版（v2，模块化 + 打包内容脚本）的验证分四层，逐层都比上一层真：

| 命令 | 覆盖 | 说明 |
| --- | --- | --- |
| `node scripts/check-imports.mjs` | 58 个文件 | 语法 + 相对路径 + 具名导入是否存在 |
| `node test/unit_pure.mjs` | 312 条 | 纯算法单测（重采样/色彩/滤波/边缘/CV/算子链/设置迁移/人脸数学/微博图 URL 升级与 `mw690`/`mw2000`/`large` 尺寸档位）+ **theme（界面风格）60 条**：`UI_THEMES` 五档清单与回落、`theme.css` 五块键集两两相等、实色三套零半透明、两个页面样式表零字面颜色、`var()` 引用全部有定义、提示条与工具栏的档位块齐全、`ui.theme` 与 `toolbar.theme` 互不干涉  + **mergeFeedPosts（信息流数据并进分组）12 条**：按帖子 id 认回采集器的组、id 认不出靠「这张图已在哪个组」找回（只许落到 DOM 组，落到 `feed:` 组会把下一轮才出现的转发帖子整条吞掉）、转发复用同一批图的两条各算一组、纯文字与脏输入只跳过不抛、条目键仍是 `<组键>|<去重键>`（popup 重开才认得回勾选）、新组按列表下标在两个真实位置之间插值 + **翻页映射与页数 6 条**（`weiboStatusToPost` 优先 `large`、只有 `mw2000` 就退化一档、`latest_url` 也认、转发原帖同 pid 只算一张、非 http 地址与脏输入不抛、index 不是数字归 0 不许把 NaN 喂进插值；`clampLoadPages` 卡死 1~10） |
| `node test/run_browser.mjs` | 18 条 | 内容脚本包在真实浏览器里：工具栏、折叠菜单、拖拽与滚动跟随图片、图层命中、算子链、视频取帧 |
| `node test/run_browser.mjs --only=options` | 52 条 | 设置页（`harness_options.html` 搬 DOM + 桩后台 + 逐个点按钮） |
| `node test/run_browser.mjs --ai --only=sr\|sam\|face\|vlm\|script\|warm\|faceid\|ms` | 按需 | 真实推理与模型源检查，`AI_WAIT`/`OPT_WAIT` 调轮询预算 |
| `node test/extension_smoke.mjs --headed` | 29 条 | **装了真扩展**：认领自己的 SW、注入、真鼠标点按钮（下载落盘 / 剪贴板有位图）、逐按钮扫描、人脸链路、日志窗、滚动时工具栏贴着图片走、**`chrome.runtime.reload()` 之后点齿轮只说「刷新页面」，不许冒 `Extension context invalidated` 未捕获异常**（这条必须在所有真功能步骤之后跑，重载会把扩展换掉） |
| `node test/gallery_probe.mjs --headed --weibo-host` | 108 条 | 本页图片面板：九宫格抑制、查看器大图、**按真微博桌面版 DOM 复刻的夹具**（`article.card9.weibo-main` + 表头「空文字头像链接 `/u/<uid>`」+「`_link_ _bolder_` 账户名但 href 指回 `/mygroups?gid=`」+ `_time_` 时间链接 + 正文 `@提及` + 每格角标图与每格永久链接 + 一条被搬到 `top:-9753` 的回收帖）：一条微博一组、组名必须是表头账户名（不被时间/正文 @提及顶替、不许「未识别账号」）、回收帖不混进列表、`orj360 → large` 且 `card=mw690 / full=mw2000`、**卡片只拉 mw690、查看器只拉 mw2000、浏览阶段一张都不拉 large（4.2MB）**、**发送默认按卡片档 mw690（36 张，一次 large 也不拉）**、切换到底部「原图 large」后服务端确实收到 large（设置也存下来了）、每行固定三张（800/560/480 都验三列）、卡片图 `object-fit:contain` 留黑边不裁切、各视口无横向滚动、懒加载、**采集不滚不缩放用户页面**、注入懒加载小图后重复刷新也不把一条拆两组、「只看屏幕附近」能过滤、**打开面板自动滚到当前正在看的那条微博并高亮**、**面板重开靠后台按标签页缓存不丢、**关掉面板再打开勾选状态还在**（先在新面板勾 3 张、把面板标签页全关掉、再开一个全新文档，必须仍是这三张勾选且计数写「已选 3」）**、**用户自己滚过再刷新时数量只增不减**、**易误杀形状夹具 `?shapes=1`**（比例 12 的长图、`content-visibility` 容器里还没解码的懒图按属性尺寸收，1×1 的 data: 占位图不收，转发复用同一 pid 的两条微博各算一条且组内仍去重）、**内层滚动容器夹具 `?scroller=1`**（容器 scrollTop 要加回文档坐标，滚过顶部的帖子不算回收节点，同容器里 `top:-9000` 的照旧挡）、摘要必须写明「无用图片 N 张」并给出原因分布（无用图片是最后一个默认折叠的分组，展开前不建卡片、**展开后再点「收起」必须真的不显示任何卡片**）、**卡片角标只有尺寸+类型两个且不含档位文字**（`g-tag` 数量恰为 2，出现 `mw690/orj/large/缩略图/档位` 即失败）、**同域无扩展名的坏地址（夹具里的 `/u/false` → `https://weibo.com/u/false`）既不进内容组也不进无用组**、**打开面板不跳**（故意用 560×600 视口，比 CSS 兜底的 800 窄，所以钉尺寸前卡片必然偏大：`#bootMask` 必须在钉尺寸前可见，揭开后每张卡片宽度一次都不许变，`--cols` 仍是 3）、`?fold=1` 页（`_picNum_ +6`）靠 `/ajax/statuses/show` 补齐 9→15 张且补来的图带 mw690/mw2000 档、卡片不再先铺缩略图、`?wide=1` 大窗、后台代理缩略图、全选、批量发送到假 ComfyUI、**每个分组头自己的「反选」只翻转这一条微博**（两条微博各全选 9/9=18 → 点第一组的反选 → 0/9/9 → 再点一次翻回 9/18；然后演真实场景：一条九宫格只发 3 张，发完点这组的反选 → 选中的恰好是这条里没发的 6 张、已发的 3 张取消、别组一张不碰）、脚本漏传 filename 时上传名仍唯一、**微博信息流筛选**（`?filter=1` 夹具照真页面复刻虚拟列表：6 条帖子各自装在 `transform: translateY(...)` 的绝对定位槽里。断言是「被挡的帖子整条 `display:none` 且自身零高、其余照常」，**不承诺**相邻槽紧连：真页面是绝对定位虚拟列表，槽位由 scroller 摆，只藏 article 会保留一段空白（试过连槽上移，会被 scroller 覆盖回来并让整页闪/全黑，已回退）。面板顶部必须有两个 tab，切到「筛选微博」后表单可见、类型默认全勾；取消「纯文字」→ 立刻只藏那一条且槽位让位；把起始日期设成 2026-10-21 → 3 条；加「不含 抽奖」→ 4 条；再取消「原创」→ 5 条、只剩转发那条（夹具里每篇都带一个 `woo-font--retweet` 转发图标做诱饵，用 `[class*="retweet"]` 判转发会在这里全灭）；清除筛选 → 6 条全回来、槽位恢复、提示条消失；并存下 `site = 当前站点`（「针对当前微博网站」）。**实验模式**（`?filter=1` 夹具里塞了一个假 Vue 根 `#app._vnode.component.data.list`）：打开实验开关后，页面里那份数组从 6 条变 4 条（9001 纯文字/9004 抽奖被真正移除）、DOM 里只剩 4 条且没有被加过 `display:none`；关掉开关数组恢复 6 条、退回页面隐藏；再模拟一次 SPA 换页（换成一个新数组 + 改 hash + 把旧组件以「更长」的旧列表留在 Vue 树里 + 目录换成新页面的帖子）→ 必须只按新页面的列表筛、旧帖一条不许混进来；换页后关掉实验模式新页面要原样回来；换页后第一次调用就是「关掉」也不许把新页面清空；**右下角提示条可以点开**——页面隐藏模式下展开 1 条、正文含「随便聊聊」且带 `weibo.com` 原文链接；实验模式下展开 2 条（随便聊聊 / 抽奖送周边）、每条都有作者名和原文链接）。**「全部微博」夹具 `?feed=1`（9 条）**：DOM 里只挂两条帖子（甲、乙，各九宫格 9 张），另外四条只活在假 Vue 根 `#app._vnode.component.data.list` 里 —— 这就是真虚拟列表滚过去之后的样子。先开信息流筛选把「庚」标成 `data-mtb-filtered`（**夹具里手写的那个属性会被内容脚本当陈旧标记清掉，所以必须让筛选现造，而且这个前置条件本身也写成一条断言**），再验：`weiboFeedPage` 从数据里捞到 5 条有图的（共 7 条；纯文字那条不建组、被筛掉的庚连数据都不许捞回、己的图挂在 `retweeted_status` 上必须并成它自己的一组）；面板一打开就是 27 张 / 5 组，摘要写「按微博数据补出 3 条 / 9 张」；**补来的三条按列表下标插在两条在屏微博中间**（`@甲,@丙,@乙,@丁,@己`，不是堆到列表尾巴上）；补来的卡片自己就把图取到了、`data-tier` 恰为 `card`，服务端 `large` 计数一次都不许涨；关掉「全部微博」只剩页面上真有的 18 张且摘要不再写「补出」，再打开又回 27 张（开关是唯一来源，`feed:` 补来的条目也不许混进后台缓存糊过去）。反向对照：让 `mergeFeedPosts` 直接 return → 面板那 5 条一起红；把 `isHidden` 短路 → 数据侧和面板侧 6 条一起红（卡片变 29、`@庚被筛掉` 冒出来）。
**「帮我翻页」夹具 `?more=1`…`?more=6`（13 条）**：页面列表里先放 12 条（DOM 只挂 2 条纯文字帖子），页面故意做到 4000+ px 高 ——
**这条高度本身就是断言之一**，因为「不滚页面」这个卖点只有在「一滚就一定会挪视口」的页面上测出来才有意义（前置条件写成断言，否则是永远绿的假绿）。
`?more=1` 给假 Home 组件挂一个真的 `ctx.loadMoreData()`（异步 320ms 追加 5 条并推 `max_id_str`），点一次按钮要看到
**列表 12→27、面板跟着 27 组 27 张、`loadMoreData` 恰好被调 3 次（页数）、`window.scrollY` 始终是 0、`article` 数量一点没变**；
`?more=2` 把那个方法摘掉、只留一条页面自己发过的 `/ajax/feed/groupstimeline` 请求（`performance` 里可克隆），
假接口按 `max_id` 一页 5 条、第三页起回空 —— 要看到面板 12→22、toast 写「直接向微博要了 2 页 · 10 条有图的微博」、
**页数选到 10 时服务端总共只被问 3 次（碰到空页自己收手）**、且这条路完全没碰页面（列表还是 12、`loadMoreData` 一次没调）；
再验证**直接要来的这 10 条进了按标签页缓存**：把面板关掉重开还是 22 张，而且不再多问微博一次。
反向对照：把按钮接到空函数上 → 依赖翻页的 5 条一起红；在产品里加一句 `window.scrollTo(0,900)` → 「不滚页面」那 2 条红；
把「碰到空页就 break」改成 `continue` → 「只被问 3 次」和「重开还在」一起红。
`?more=3`/`?more=4` 演的是**真页面报过一次的那个错**：分组页每个标签页都留一份 `Home` 组件，先找到的那份内部状态是空的，
一调它的 `loadMoreData` 就抛 `Cannot read properties of undefined (reading 'id')`（夹具里就用 `this.curTab.id` 造这个一模一样的错）。
mode 3 把**坏的那份故意给更长的列表**，让它在「可见 → 更长」的候选排序里排第一 —— 必须换下一份并翻成功
（坏的那份被试过 1 次、好的那份 `calls=1`、列表 12→17、坏的那份 20 条一条不许动、`scrollY` 仍是 0）；
mode 4 两份都坏 —— 必须自动退回接口路线并在结果里标 `fallback`，页面列表一点没动。
反向对照：把候选循环里「抛错就换下一份」的 `continue` 改成 `break` → mode 3 那条红。
`?more=5`/`?more=6` 演的是**用户报「没加载到更多：这一页是空的」那个真实现场**：点的是**个人主页**，
它的信息流不在 `Home.data.list` 而在 `ProfileFeed.data.data`、翻页接口是 `/ajax/statuses/mymblog?uid=…&page=N`（**按页码**）、
返回体是 `data.list`（不是 `data.statuses`），而且它的 `loadMoreData` 是**整个换掉数组引用**而不是原地 `push`。
mode 5 只给这一种形状且让 loader 换引用 → 必须走组件路线连翻 2 页（12→22，`window.__mtbFeed` 那份旧引用仍是 12，
证明长度是从 `data[key]` 重新读的而不是攥着旧数组）；mode 6 把 loader 换成会抛的那个、只留页面自己发过的 `mymblog?page=1` →
必须**从组件当前页码接着往后要**（第 2、3 页各 5 条、第 4 页空了就收手 = 10 条），且页面一点没动。
反向对照：把 `lenOf` 改回攥着 `c.list` 旧引用 → mode 5 红（其余不红）；把 `parseList` 里 `data.list` 那行删掉 → mode 6 红。**界面风格（主题）实测 22 条**，改设置一律走后台写 `mtbSettings.ui.theme` 这条既有通路（就是用户从设置页切风格时走的同一条，测试不碰任何产品代码），轮询等 `chrome.storage.onChanged` 把皮肤推到位再读：面板那 16 条两分支都跑——先钉「面板开局就是 glass」（`#bootMask` 揭开前必须贴好主题，闪一块别的皮肤用户看得见），再把 fluent / fluent-dark / neon / contrast 各切一遍，**实色三档下 `.g-group` 的 `backgroundColor` alpha 必须恰为 1、`backgroundImage` 里不许有 `gradient(`**，毛玻璃那两条量在**页脚 `.g-foot`** 上（`.g-group` 自己压根没写 `backdrop-filter`，量在分组上会永远绿、等于没测），glass/neon 反过来断言底色仍是半透明或渐变且页脚仍带 `blur(`；**五档各自读到的「底色/描边/正文色」三元组必须两两不同**，这里是收实测值判两两不等而**不写死任何一个颜色**——以后调色不会红一片，但两档撞成同一个样子（也就是根本没换过去）一定会红；最后回到 glass 再核一遍 `--cols` 仍是 3、`.g-card` 数量与换肤前一致、`scrollWidth <= innerWidth + 1`，即换肤不许把网格弄坏。提示条那 6 条只在 `--weibo-host` 跑（它画在用户页面上、Shadow DOM 吃不到扩展页的 `theme.css`，只能自己贴 `data-theme`）：`#mtb-filter-chip` 宿主上的 `dataset.theme` 必须跟着换，fluent 下底色 alpha=1 且 `backdrop-filter` 为 `none`，contrast 下 `.chip` 的 `borderTopWidth` 必须是 `2px`，**切回 glass 时底色必须逐字符回到 `rgba(18, 21, 28, 0.92)`**（这条是唯一写死颜色的地方，为的就是钉死「用户当前在用的外观一像素都不许动」）。这些断言都做过反向对照：把 `applyUiTheme` / `applyChipTheme` 的赋值行注释掉 → 面板 + 提示条共 21 条一起红（所有行都读成同一组 glass 值、`dataset.theme` 是空串），单独改坏 `--blur-foot` / contrast 的 `--panel-grad` / glass 的 `--panel-grad` / 提示条的 `--cf-blur` / `--cf-bw` / `--cf-chip-bg` → 各自只红对应那一条，把 `--cols` 在 glass 下钉成 2 → 「回到 glass 网格没被换坏」红。**不带 `--weibo-host` 时少 43 条**（信息流筛选整块不挂非微博站点：条件开到最严也不插提示条、不改任何帖子；提示条跟随主题的 6 条随之不跑；**「全部微博」整块 9 条也只在微博域名跑**（非微博站点没有那份信息流数据，开关根本不露）；**「帮我翻页」整块 13 条也只在微博域名跑**（非微博站点没有那份信息流数据，开关根本不露）**）），共 65 条。**不带 `--weibo-host` 跑同一份夹具**但走普通站点分支：只认 `rel="author"`／class 含 `name·nick·user`／`/u/ /profile/` 这类通用链接，认不出 `_link_`+`/mygroups` 的账户名，期望 3 组（认不出作者就并到同组），脚本按 `WEIBO_HOST` 切期望。两个 harness 坑：`--host-resolver-rules` 多条规则**必须逗号分隔**（空格拼会整条失效 → 夹具页变成 Chrome 报错页，症状是 `ready.root=false`、`imgs` 只剩报错页的 2 张）；本机上 `<img>` 请求根本没带 `sec-fetch-dest`，所以「代理请求」只能靠档位名区分（页面自己只会用 `orj360`） |

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

- **读夹具挂在页面世界的全局（`window.__mtbFeed` 这种）必须 `chrome.scripting.executeScript({world:'MAIN'})`**：
  默认注入的是隔离世界，那里 `window.__mtbFeed` 恒为 `undefined`，症状是「面板明明一切正常、测试脚本读到的一路是 null」，
  很容易误判成功能坏了（2026-10-22 「帮我翻页」夹具就这么红过一整批断言）。CDP 的 `Runtime.evaluate` 走的是页面世界，
  两边行为不一样，别拿 CDP 读到的值去推断注入结果。
- **判定一律读产物**：脚本自己写的 `test/out_smoke.json` 里 `summary.failed` 才算数。后台命令末尾挂
  `; echo exit=$?` 会让通知里的 0 属于 `echo`；日志只有半截、没有 `=== 汇总 ===` 是**中途断了**，不是通过。
- **`gallery_probe.mjs --weibo-host` 对 CPU 负载敏感，必须独占机器串行跑**：并行跑别的测试（哪怕只是另一个
  有头浏览器）会出现**成片的「慢一拍」假失败**——图片解码/懒加载/存储推送这些都要等，轮询预算被抢走的 CPU
  挤掉就红一片，而且红的每次不是同一批，很容易被误读成产品坏了。跑它之前 `taskkill //IM chrome.exe //F`
  清残留实例，别同时跑 `run_browser` / `extension_smoke`，也别拿 `--weibo-host` 与不带它的两条命令去并行。
- **换肤类断言里 `getComputedStyle().borderTopWidth` 拿到的是「实际用的值」不是「写的值」**：本机把 CSS 的
  `1px` 读成 `0.666667px`（`2px` 才恰好读成 `2px`）。所以只许拿它钉 `2px` 这种粗描边，**别拿它钉 1px**，
  否则 glass 档「一切正常」也会红；要钉默认外观就钉颜色字符串（提示条那条钉的就是 `rgba(18, 21, 28, 0.92)`）。
- **反向对照改 `src/content/*.mjs` 之后必须重跑 `node scripts/build-content.mjs`**：manifest 里只挂
  `content.bundle.js`，直接改模块源文件浏览器根本看不见，症状是「断言怎么弄坏都不红」，其实是包没重建。
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
