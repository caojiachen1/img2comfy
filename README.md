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
点扩展图标打开「本页图片」下拉面板；面板右上角「设置」按钮进设置页，工具栏的 ⚙ 也能进。工具栏的外观、按钮、位置、AI、自定义功能全在那里配。
每个按钮（内置与自定义都一样）可设三态：**常驻 / 折叠进 ▾ 菜单 / 不显示**。行内的勾选框只管显示与隐藏，
「显示位置（常驻 / 折叠）」放在该按钮右侧 ⚙ 的设置面板里，和它的参数一起改；折叠项收在工具栏末尾的
「⋯ 更多 ▾」里，点一下就执行并自动收起（点别处或按 Esc 也收）。

扩展图标打开的「本页图片」下拉面板会扫描当前标签页（含 iframe）的全部图片，微博**按每条微博分组**
（同一账户连发多条会分成一组组，分组头显示账户头像、名字和这条微博的正文摘要）。
"一条微博"认的是**微博容器本身**（`article` / `.card9` / `.weibo-main` / `.vue-recycle-scroller__item-view` 这类，
往上找最近的匹配祖先）。不能认"最近的带作者链接的祖先"，也不能认"装着几张图的容器"：
真微博的九宫格每个格子里既有内容图、又有 GIF/长图角标图，还各自带一条 `weibo.com/<uid>/<图片id>` 的永久链接，
两种认法都会把一条微博切成九条。容器里所有图进同一组，头像（`tva*` / `crop.*`）与 18×14 那类徽标按尺寸/URL 规则挡掉。
另外虚拟列表会把布局压成 0×0，所以 `rect` 塌掉的图改用 `naturalWidth/Height` 判，
否则信息流里大半的图会被"显示太小"这条误杀（真实的小角标照旧挡）。
真页面还有一类**搬去画布外的回收节点**：看过的整条微博会被挪到 `top:-9753` 这类位置留着复用，
图仍在 DOM 里、尺寸也正常 —— 按文档坐标 `rect.top + scrollY < -800` 直接丢掉，不然面板里
全是"我现在根本看不到的图"。分组顺序按这条微博在页面里的位置排，面板顺序 = 信息流顺序。
分组头的用户名另有两坑。其一是微博把「18小时前」这个**时间也包成指向本条微博的链接**
（`weibo.com/<uid>/<pid>`），它在打分器里和昵称同为 0 分，"同分取短名"就会被时间抢走 ——
先排除时间样文字（`^\d+ (秒|分钟|小时|天…)前$` 等）和永久链接形状的 href。其二是桌面版表头长这样：
`<a class="_default_x" href="/u/<uid>">`（头像，链接文字是空的）、`<a class="_link_x _bolder_x" href="/mygroups?gid=…">账户名</a>`
（**账户名那条链接指回分组页，形状上完全不像用户主页**）、`<a class="_superText_x" href="/p/…">超话</a>`、
`<a class="_time_x" href="/<uid>/<pid>">时间</a>`，而正文里的 @提及是 `<a href="/n/<昵称>">@某某</a>`。
真页面实测：结果采集器把"李一桐工作室"这条微博标成了正文里被 @ 的"@李一桐Happy"，认不出表头的
几条则并成一整组「未识别账号」。现在微博分支先认**表头 class 词根**（`name`/`link`/`bolder`/`nick`/`title`/`fwv`）
拿账户名，uid 从 `/u/<uid>` 或 `/<uid>/<pid>` 取（同 uid 的多条微博靠分组键区分），
文字以 `@` 开头的一律不当发帖人；老打分路径只作兜底。
其它站点有作者信息就按作者分组、没有就放在同组；但**微博即使认不出账户名也要一条微博一组**（用这条的
uid + 永久链接当分组键，不能整条并回「页面组」）；支持全选 / 反选 / 单组全选，**每条微博的分组头还有一个自己的「反选」**
——发过几张之后点它，选中的就是这条里剩下没发的那几张（发送成功的卡片勾不掉，所以组内翻转恰好等于「取消已发送、选中未发送」，
而且只动这一条微博，别组一条不碰），勾选后**逐张串行**
发送到 ComfyUI 或发送并排队执行，面板右上角可直接进设置页。
**采集只读不写：绝不滚动、绝不改用户正在看的页面**（真微博的信息流是"滚到才挂载"，
实测第一屏 DOM 里只有 6 条微博 / 67 张图，往下滚一段才变 13 条 / 117 张 —— 所以没采全时是**你先滚、再点刷新**，
面板自己滚页面会被立刻骂回来）。分组键必须跨多次扫描稳定：用这条微博自己的 `mid/bid` 属性或
正文里那条永久链接，**不能用图片地址**（图是懒加载的，第一张图会变，一条微博会在第二轮扫描里裂成两组），
也不能用本次扫描的序号。`src/gallery/collect.mjs` 里的采集函数会被 `chrome.scripting.executeScript` 直接注入页面，
所以不依赖内容脚本是否已加载。面板是 action popup，**点一下网页就销毁**，重开是新文档，所以采集结果
按标签页缓存在后台（`galleryCacheGet/Put`，标签页关闭或换页即清），滚过的内容不会因为关掉面板而清零。
**勾选状态同样按标签页存在后台**（`gallerySelGet/Put`，存的是条目键列表，标签页关闭/换页一起清）：
关掉菜单再打开，之前勾的那几张还是勾着的。写入是每次点勾就同步发一次（跟上次的内容一样就不发），
**不能用防抖定时器** —— 用户点完可能立刻去点网页把 popup 收掉，定时器连同这一次一起没了。
恢复时按 `pageUrl` 再校验一道，换过页面不许把上一页的勾选搬过来。
顶部还有个「只看屏幕附近」开关：只保留扫描那一刻视口上下各一屏内的图（文档坐标判），关掉则列出
这个页面已加载的全部图。
**三档清晰度，各用各的**（真页面实测同一 pid：`large` 7008×4672 / 4.2MB，`mw2000` 2000×1333 / 283KB，
`mw690` 690×460 / 41KB，`orj360` 405×270 / 14KB）：sinaimg 的 URL 形状是 `/<尺寸变体>/<pid>.jpg`，
`wap180`/`tw420`/`orj360`/`mw690`/`square`/`bmiddle`/`thumb980`/`auto-webkit` 这类变体段可以互换
（`crop.*` 是裁过的头像不动，`/m/wallpaper/` 这类不像尺寸段的不动）。卡片只升 `mw690`（~41KB，卡片才 ~250px 宽），
点开的大图查看器升 `mw2000`（~283KB）；**发给 ComfyUI 的档位可以在面板底部选**（卡片 `mw690` / 高清 `mw2000` / 原图 `large`，默认 `mw690`，选择会记住）——以前固定发 `large`，用户反馈九宫格发过去接近 2000×2000、一张几 MB。
以前卡片也去拉 `large`：二十几条就是一百多 MB，队列堵在半路，面板长时间停在糊缩略图上 ——
这正是"面板里显示的还是小缩略图"的成因。**取不到更清晰的档时给卡片描一圈橙边**（角标上不写档位），
不会糊弄用户说这是高清。
（同一份缓存键还犯过更隐蔽的一次：`thumbKey()` 用的是"去掉尺寸段的去重键"，`orj360` 与 `mw690` 撞成同一个 key，
升档请求根本没发出去 —— 数据缓存键必须用完整地址，去重键才用去掉尺寸段的。）
**去重按组、不按全站**：条目键是 `<组键>|<图片去重键>`。转发微博会原样复用同一批 pid，
全局去重就把第二条微博的图吃掉（真页面实测 7 张 dupe，那条九宫格从 9 张变 8 张）。
**尺寸信号取三层**：布局矩形 → 已解码 `naturalWidth/Height` → 标签上的 `width/height` 属性。
只认前两层的代价：还没解码的懒图、`content-visibility` 跳过渲染的容器里的图被整批误杀 ——
面板是自己带 Referer 取字节的，浏览器先不先解码跟能不能给用户看不相干。
比例过滤不看纯比例（微博长图比例能到 12），只在"又扁、短边又不足 120"时当分隔条丢掉；
`data:image/…` 的 1×1 占位图在没解码成功时一律不收。
地址还得**真的像一张图**（`looksLikeImage`）：`data:` 开头、结尾有图片扩展名，或域名跟页面不同才算；
微博表头那种解析成 `https://weibo.com/u/false` 的同域无扩展名地址直接不算 —— 收进面板就是一张永远
「加载失败」的卡片。
采集函数常开统计 `dropHist`（每张被丢的图归一个原因），面板摘要因此会写「无用图片 N 张（默认收起）」，
鼠标悬停给出分布（画布外的回收帖 / 头像图标 / 同条重复 / 隐藏 / 无地址 / 分隔条 / 超上限）——
少图不能是黑箱；再传 `opt.debug` 会额外带回 `skipped:[{why,u,w,h,nw,nh}]` 逐张样本，
这一轮就是靠它在真页面把"少图"逐项定位掉的。
**打开面板自动定位到你正在看的那条微博**：采集结果里带了扫描那一刻的视口位置（`view:{y,h}`），每组又带着它在页面里的文档 Y，
首次渲染后把面板滚到「起始位置不超过视口上沿」的最后一条，并给该组加一条左侧高亮。
**筛选没了，改成「无用图片」折叠组**：头像、角标、图标这类不再直接丢掉，而是收进每组末尾那个
默认折叠的分组（展开前连卡片都不建，几百张头像不会拖慢面板），展开后和普通卡片一样能勾选发送，
也能再点「收起」真的收回去 —— `.g-grid{display:grid}` 会盖掉 `[hidden]` 的 UA 样式，所以必须显式写
`.g-grid[hidden]{display:none}`，否则「收起」只改了按钮文字、卡片还挂在页面上；
只有真正没有地址的（`data:` 占位、空 src）才仍然丢弃并记在"已忽略"里。
**九宫格被折叠的图会补齐**：微博一条多图微博只往 DOM 里挂 9 张，角标 `+6` 表示一共 15 张
（真页面实测：接口 15 张、DOM 9 张；用户读作"少了一大堆"）。采集器对带 `_picNum_` 角标的微博
调页面自己那条 `/ajax/statuses/show?id=<bid>`（同源带 cookie），按返回的 `pic_ids`/`pic_infos`
把缺的图补进同一组，补来的图照样有 `mw690`/`mw2000` 档。最多补 6 条微博、每条 1.8s 超时，失败不影响主扫描。
**面板不再先铺缩略图**：卡片按 `mw690` → `mw2000` → `large` 依次尝试，每一档**先直连**（扩展页的 `<img>` 请求不带 Referer，实测 `mw690` 直连能加载 690×1039，而带 `crossOrigin` 反而失败 —— 所以不要给面板图加 CORS），
直连失败再走后台带 Referer 的代理，三档全挂才回落到页面自己那张并描一圈橙边。**卡片角标只留尺寸和类型**
（用户要求），档位只记在 `card.dataset.tier` 和悬停提示里，悬停还能看到原始地址 —— 核对"到底给的是不是大图"
不用靠角标占地方。
**图片一律 `object-fit: contain` + 黑底**：不裁切、等比缩进方形框，多出来的部分留黑边（悬停也不放大，放大等于二次裁切）。
缩略图不是让浏览器直连原站，而是经**后台代理带 Referer 抓取后以 data URL 显示**，
防盗链、无 Referer、混合内容导致的「整页图片全挂」都能绕开。面板宽度**跟着 popup 的真实视口走**：
`settlePanelSize()` 等视口稳定后把 `--panel-w/--panel-h` 钉成 `min(800×600 上限, innerWidth×innerHeight)`，
窗口尺寸再变会重钉。写死 800 在可视区不足 800 的浏览器里会顶出横向滚动条，写 `100vw` 又会被 popup 的初值
锁成几百 px——两头都踩过，所以只能"先按 800 撑开、量准了再钉"。
**撑尺寸这段过程用户不该看见**：`askPanelSize()` 第一帧就把尺寸设成 `min(800, screen.availWidth)`，
`.g-boot` 遮罩从首帧盖到尺寸钉死、列数按最终宽度算完才揭开（`setPanelSize()` 里 `fitLayout()` 之后才
`revealBoot()`，另有 2.6s 兜底防止遮罩锁死面板），所以打开看到的就是成品三列网格，不会有"先大后小跳一下"。分组一律**上下排列**，每组内部是
`repeat(--cols, 1fr)` 的**大卡片网格**：**每行固定三张**（实测 800/560/480 宽都是 3 列，低于约 330px 才退两列；面板还没钉尺寸前按目标宽 800 算列数，所以打开就是三列，不会先两列再跳三列），卡片 = 顶部勾选/预览 + 类型·尺寸角标，
中间方形大图，底部一行原图 URL；1fr 铺满整行、右边不留残缺、**永远不出横向滚动条**。
卡片这么大就不可能一屏放下，所以主区纵向滚动 + 懒加载（`IntersectionObserver` 进视口才去后台取图）。
想要更大的浏览面就点右上角「⤢ 大窗」：同一个面板以 `?wide=1` 开成接近全屏的独立窗口（约屏幕 90%），
那边没有 800px 上限，还是每行三张、卡片更大。**批量队列跑在后台**：
下拉面板失焦关闭后，已开始的发送会继续，重新点扩展图标可在面板底部看到进度或上一次的结果。

**微博信息流筛选**（在图片面板顶部的「筛选微博」tab 里，照微博原生那套）：类型（原创 / 转发 / 纯文字 / 含图片 / 含视频 / 含音乐）、
关键字（包含 / 不含）、时间范围（起止日期），外加「应用到所有微博网站」开关——不勾时只作用于当前这个微博站点。
改哪一项**立刻生效**，不用刷新页面（面板把条件发给当前标签页的内容脚本，同时写进设置给其它标签页同步）。
判定语义：类型里「原创/转发」二选一，媒体类型按命中的任意一个通过（纯文字 = 没有任何媒体），三组条件之间是「并且」；
时间读不出来的帖子不参与时间判断（宁可多留，不误杀）。
被筛掉的微博整条 `display:none`。**但原位置会留一段空白**（页面底色，看起来像一块黑）：真页面的帖子是绝对定位的
虚拟列表（`article.woo-panel-main` → `div.vue-recycle-scroller__item-view`，靠 `transform: translateY(...)` 摆位），
槽位坐标由 scroller 自己按累计高度算，只藏 `article` 动不了那段空间。做过「连槽隐藏 + 把后面的槽上移」的版本：
scroller 会用原始坐标不停覆盖回来，滚动时整页闪、甚至所有槽堆到顶部变成全黑，已**回退**——稳定优先，保留空白。
**实验开关：让被筛掉的微博真正消失**（默认关，面板里有醒目风险提示）：空白来自微博的虚拟列表——槽位由它自己记账，
光藏 DOM 动不了。实验模式改成**从数据源头解决**：后台用 `chrome.scripting.executeScript({ world: 'MAIN' })` 在页面主世界里
找到微博自己的信息流数组（实测挂在 `#app._vnode.component` 下的 `Home.data.list`），把不满足条件的条目直接拿掉 ——
列表组件会自己重排，前后帖子紧连、不留空位；关掉开关时把原条目按原顺序放回去。
**换页要重来**：微博是单页应用，点「主页 / 分组」不会刷新页面，上一页的组件还挂在 Vue 树里、那份「原始条目」快照也还在——
所以换页时会按 `location.href` 清空快照，并且**用屏幕上真正渲染出来的帖子当指纹**去认「当前是哪一份列表」，
不会把上一页的帖子带过来（用户报过这个 bug）。换页后第一次调用如果恰好是「关掉筛选」，也不会拿空快照去清空新页面。
**风险**：用的是微博内部结构（`_vnode` / 组件 data / 字段名），微博改版后可能失效；极端情况下当前页面显示异常，
**按 F5 刷新即可恢复**（状态只存在当前页面的 window 上）。找不到数组或注入失败会自动退回「只隐藏元素」，
面板状态会写明当前是「实验模式（改内部列表）」还是「页面隐藏（会留空位）」。
页面右下角只在真有帖子被挡时出现「已隐藏 N 条」，**点这条会展开一个下拉列表，把被隐藏的微博按「原帖缩略卡」列出来**（头像 + 作者 + 日期 + 多行正文，
有图最多带 4 张缩略图、视频带封面、转发带原文摘要；点一条在新标签页打开原帖）。
实验模式下这些内容直接来自微博自己那份数据，普通模式下从被隐藏的 DOM 里现读；
点 ✕ 一键清除；被挡的帖子在「本页图片」里也当没发过
（采集器跳过 `[data-mtb-filtered="1"]`，原因记 `filtered-post`）。
**只挂 weibo.com / m.weibo.cn**，其它站点连筛选 tab 都不可点（回归里有站点门禁断言）。

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
工具栏**始终贴在当前媒体上**：页面滚动、布局变化、或指针换到另一张图，只要那张图的矩形变了就立刻重新锚定跟上；
矩形没变时（同一张图内移动指针、300ms 心跳重探）一动不动，不会原地抖。
**认矩形不认 DOM 节点**：大图查看器加载原图时常常把 `<img>` 换成新节点，按节点身份认锚点会永久冻在旧位置
（就是"点开大图后滚动页面工具栏不跟随，移出再移入才恢复"那个 bug 的根因）。
拖 ⠿ 手柄改的是**相对图片的偏移**（松手即写回 `offsetX/offsetY`），之后滚动仍然带着这个偏移贴着图走。
**缩略图例外**：能单击打开大图的小图（微博九宫格、lightbox 网格）默认不在小图上出工具栏，
点开后的大图/查看器里才出；判定只认「可点开」的缩略图，普通插图和没有查看器的站点保持原行为。
设置页「缩略图不弹（点开大图后显示）」可关闭这条规则。微博的 `orj360/mw690/thumb` 缩略图在
「本页图片」里会自动升级成 `large` 再发送。
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

## 一之三、界面风格（主题）

设置页「工具栏外观」页最上面那块「界面风格」的下拉框（`#uiTheme`）选的是 `settings.ui.theme`，共五档
（选项由 `src/common/theme.js` 的 `UI_THEMES` 动态生成，HTML 里不写死，顺序就是那份数组的顺序）：
**glass 暗色玻璃**（当前默认，也就是改造前用户正在用的那套外观，逐像素钉死不许动）、
**fluent 黑白·亮** 与 **fluent-dark 黑白·暗**（纯黑白灰实色，无半透明、无渐变、无毛玻璃、小圆角）、
**neon 霓虹**（深底青紫发光，允许通透）、**contrast 高对比**（纯黑纯白 + 2px 描边 + 黄色强调，无障碍取向）。
认不出的值一律回落 glass，存储里保留原值不改写，回落发生在渲染侧。

**它只管扩展自己的页面**：设置页（`options.html`）与「本页图片」面板（`gallery.html`），
外加右下角那条微博筛选提示条（提示条画在用户自己的页面上、Shadow DOM 吃不到扩展页的 `theme.css`，
所以 `weibo-filter.mjs` 里另带一套 `--cf-*`，靠宿主元素上的 `data-theme` 选档，`mountWeiboFilter()`
贴一次、设置变更推送进来时再刷一次）。**悬浮工具栏的皮肤不由它管**，仍由老字段
`settings.toolbar.theme` 单独控制，六档 `dark|light|glass|neon|fluent|contrast`
（`dark` 是 `.wrap` 的默认值所以 CSS 里没有 `data-theme="dark"` 那一块；本次新增的「黑白·实色」与
「高对比」就落在 `fluent`/`contrast` 上：整块关掉 `backdrop-filter`、顶部渐变亮线和内白纱，
底色/描边全换成实色，`contrast` 另外把描边提到 2px）。两个字段互不相干，迁移时也不会互相带跑。

维护约定，改样式前先看这条：**颜色只能进 `src/common/theme.css`**，那里是唯一的颜色真值，
按 `html[data-theme="X"]` 整块切换（glass 那块同时挂 `:root` 兜底，JS 还没贴上属性时不至于闪一块白板）；
五块的 token 键集必须两两完全相等，少一个键的那个主题会去兜 `:root`，切过去就缺一块底色。
`src/options/options.css` 与 `src/gallery/gallery.css` 里**只许读 `var(--…)`，不许再出现一个字面颜色**
——漏一处，切到别的主题时那一块就还是上一套皮肤的颜色，用户看到的就是一块花掉的补丁，
而这种错位只有在切过主题之后才会被发现，所以 `test/unit_pure.mjs` 直接拿文本断言拦在前面
（顺带拦住 `#faceGallery` 这类长得像十六进制的 ID 选择器：检测器只扫声明块，并有正对照自证不是永远 0 命中）。
新加一档时四处都要补齐：`UI_THEMES` 加一项、`theme.css` 加一块（键顺序保持一致）、
`weibo-filter.mjs` 加一个 `:host([data-theme=…])`，工具栏那一套在 `ui.mjs` 的 `CSS` 里加
`.wrap[data-theme=…]` 并在 `options.html` 的 `<select id="theme">` 里加一项 —— 少补哪一处，
`test/unit_pure.mjs` 的 theme 一节都会红，不会让你悄悄漏过去。
`fluent`/`fluent-dark`/`contrast` 三套的整块里一次都不许出现 `rgba(`、`linear-gradient`、`blur(`
（`--shadow: none`、`--blur: none` 这种写法是允许的，`test/gallery_probe.mjs` 还会在真浏览器里读回
分组底色的 alpha 与页脚的 `backdrop-filter` 复核，并钉住 glass 下提示条底色必须是
`rgba(18, 21, 28, 0.92)`），glass/neon 则反过来断言仍然含半透明与毛玻璃，免得默认外观被偷偷抹平。

## 二、验证

```bash
node scripts/check-imports.mjs        # 语法 + 相对路径 + 具名导入是否存在（50+ 文件）
node test/unit_pure.mjs              # 294 条纯算法 + 主题体检（重采样/色彩/滤波/边缘/CV/算子链/设置/人脸数学/微博图 URL 与尺寸档位/界面风格五档的 CSS 文本断言）
node test/run_browser.mjs            # 页面级：内容脚本包 + 工具栏 + 拖拽 + 算子链 + 视频取帧
node test/run_browser.mjs --ai       # 再加：vendor + slimSAM/swin2SR/YuNet 真实推理 + 设置页
node test/run_browser.mjs --ai --only=sr|sam|face|vlm|script|options   # 单跑某一阶段
node test/gallery_probe.mjs --headed --weibo-host   # 本页图片下拉面板 + 九宫格抑制 + 批量发 ComfyUI（假服务端）
```

`--only=script` 那一支是 QuickJS 引擎的端到端检查（7 条）：引擎加载、异步服务桥接、语法错误捕获、
运行时异常回传、`module.exports` 形式、死循环被中断、供设置页用的语法检查。

`--only=options` 那一支是**设置页**检查（`test/harness_options.html`，52 条）：扩展页在无头里打不开，
所以把 `options.html` 的 DOM 搬进普通网页、用 `harness_stub.js` 冒充后台，然后逐个点开标签页、
点每个按钮（检测运行时/模型占用/测试连接/自检/新建脚本/语法检查/试跑/新建链接）。
它专门用来逼出「只有点到那个按钮才炸」的 `ReferenceError`——已揪出过 `doRuntimeProbe` 里把函数参数
`S_` 当模块变量用的真 bug。断言的形状是：任何输出块里都不许出现 `is not defined` / `Cannot read properties of undefined`。

`test/gallery_probe.mjs` 用 `--host-resolver-rules` 把 `weibo.com` 指到本地夹具（`wx*.sinaimg.cn`/`tvax1`/`h5`
两种模式都映射到本地，这样尺寸档位的请求能落到假服务端并被记进 `counters.tiers`），验证九宫格缩略图不弹、
查看器大图弹、按每条微博分组（分组上下排列、每行三张）、表头账户名不被时间和正文 @提及抢走、
画布外回收帖不混进列表、卡片只拉 `mw690`、查看器拉 `mw2000`、**浏览阶段一张都不拉 `large`**、**发送默认按卡片档 `mw690`**（切换档位后确实请求对应档）、
后台代理加载缩略图、宽度自适应不出现横向滚动条、「只看屏幕附近」能过滤、面板重开靠后台缓存不丢、
**用户自己滚过之后再刷新数量只增不减**、全选后逐张发送；
另有两份专门守「少图」的夹具：`?shapes=1`（比例 12 的长图、`content-visibility` 容器里还没解码的懒图按属性尺寸也要收，
1×1 的 `data:` 占位图不收；转发复用同一 pid 的两条微博各算一条、组内仍去重）与
`?scroller=1`（内层容器自己滚：容器 `scrollTop` 要加回文档坐标，滚过顶部的帖子不算回收节点，
同容器里 `top:-9000` 的回收节点照旧挡）；面板摘要还必须写明「无用图片 N 张」并给出原因分布；另有一份 `?fold=1` 夹具（角标 `+6`）验证经 `/ajax/statuses/show` 把 9 张补成 15 张。
还有一份 `?filter=1` 夹具守信息流筛选：照真页面的**虚拟列表**复刻（6 条帖子各自装在
`transform: translateY(...)` 的绝对定位槽里），所以除了「该藏的藏了」，还断言隐藏后相邻可见槽间距为 0 ——
前后帖子紧连、不留空槽；面板里从 tab 切到筛选、取消「纯文字」、设起始日期、加「不含 抽奖」、再取消「原创」，
每一步都要求 1→3→4→5 条实时变化（夹具里那条「转发」还带了一个每篇都有的转发图标做诱饵），
清除后 6 条全部回来、槽位恢复原样。
假 ComfyUI 只统计 `/upload/image` 与 `/prompt` 次数，并核对批次实际跑在后台（`galleryBatchState`）、
以及**脚本不传 filename 时上传名也唯一**（后台注入一个不带 filename 的探针脚本点一次，断言拿到的是 `web_<时间戳>.png`
而不是固定名 —— 固定名配上 `overwrite:true` 会让后一张盖掉前一张，「发送并立即执行」批量就只剩最后一张）。
扩展页在无头里打不开，所以跑这个脚本要带 `--headed`
（不带 `--weibo-host` 时走普通站点分组分支：同一份夹具期望 **3 组**而不是 4 组 —— 普通分支只认
`rel="author"`／class 里含 `author|user|name|nick|owner`／`/u/ /profile/` 这类通用作者链接，
认不出微博表头那种 `class="_link_x _bolder_x"` 且 href 指回 `/mygroups?gid=…` 的账户名链接，
按「认不出作者就并到同组」处理；脚本按 `--weibo-host` 切换期望的组数与组名，别为此往
`GENERIC_USER_HREF` 里加微博专属形状 —— 那会让别的站点的 `/n/2024/…` 文章路径变成组名）。

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

`ctx.comfySend` 的 `filename` 可以不传：后台会兜一个 `web_<时间戳>.<ext>`，并且**同名不同内容会自动加 `_2/_3` 序号**
（`/upload/image` 带 `overwrite:true`，重名就等于互相覆盖）。自己写脚本时仍然建议传，名字里带上时间戳或序号。

用户脚本由 `src/common/script-vm.js` 在宿主页里交给 **QuickJS（编译成 wasm）** 解释执行：拿不到
`chrome.*`、`document` 与页面 DOM，只能用 `ctx.fetch / ctx.host / ctx.ai / ctx.comfySend / ctx.download /
ctx.storage / ctx.overlay …`，特权动作由后台按名字白名单提供。VM 与宿主之间是「请求队列 + 结果回填」的
单向轮询桥，所以不需要 host 函数注入，也就不需要 `eval`。每次同步执行都带中断时限（`setInterruptHandler`），
脚本写成 `while(true){}` 会在超时处被 `InternalError: interrupted` 掐断，不会把宿主页永久冻死。

## 四、结构

```
manifest.json                 MV3：content_scripts 指向打包产物；offscreen 宿主；host_permissions
background.js                 ES module SW：设置存储与迁移、DNR 伪装 Referer/补 CORS、抓取与下载代理、
                              离屏宿主生命周期、ComfyUI 上传+节点注入（前端注入 / API 两种模式）、
                              扩展图标 → 本页图片下拉面板（批量发送在后台执行）
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
gallery.html                  本页图片面板：账户分组、多选、批量发送到 ComfyUI（?wide=1 = 大窗模式）
src/gallery/*                 采集注入函数 collect.mjs + 批量窗口逻辑/样式
src/common/gallery.js         微博图 URL 升级/去重键/域名判定等纯函数
vendor/                       transformers.js + onnxruntime-web + QuickJS wasm（setup-vendor.mjs 生成，已 gitignore）
scripts/                      build-content / setup-vendor / check-imports
test/                         unit_pure（294 条）、run_browser + harness_page/harness_ai/harness_options/harness_stub、
                              gallery_probe（有头，本页图片/批量发送）、cdp.mjs、旧的 run_headless + harness + cors_server
```

架构要点：
- 像素与 AI 一律在 **offscreen 宿主文档**里跑（有 DOM/OffscreenCanvas/WebGPU，且能装 wasm）；
  不可用时自动退回隐藏标签页承载同一份 `host.mjs`。内容脚本只做命中探测、UI、视频取帧、结果叠加与下载。
- 图片经后台按 `Referer` 伪装 + `host_permissions` 取回，天然避开跨域污染；视频帧沿用 v1 的降级链。
- `ai.device` = `auto|webgpu|wasm`；WebGPU 不可用自动回落 CPU，并在设置页「检测运行时」里说明原因。

## 五、已知边界（如实记录）

- 端到端验证覆盖到：294 条算法与主题单测、内容脚本包在真实浏览器里的工具栏/拖拽/算子链/视频取帧/图层命中、
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
- 在 edge://extensions 里**重载扩展之后，已经打开的网页里那份内容脚本是僵尸**（它的 runtime 端口随旧扩展一起销毁），
  没法自愈，唯一出路是刷新页面。所以内容脚本的一次性动作（点齿轮开设置、拖位置、开标签）都走 `bgSend()`：
  先 `extAlive()` 探活、再兜住同步抛出的 `Extension context invalidated`，统一提示「扩展已更新…请按 F5 刷新页面后再用」，
  不让它冒成未捕获异常。
- 用户脚本不能直接操作页面 DOM（只能经 `ctx.overlay/panel`），这是刻意的安全边界。
