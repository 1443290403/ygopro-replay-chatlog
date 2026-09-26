# 录像对话导出器

从 YGOPro 改版客户端（MDPro3 / YGOPro-Unity）的 `.yrp3d` 录像里，批量导出对局中的聊天记录。

只认 `.yrp3d`。别的文件拖进来一律标成「解析失败」，不影响同时载入的其他文件。

> **用标准 ygopro 打牌或观战？** 它存的 `.yrp` 录像**不含对话**，这个工具读不了。
> 用 [`proxy/`](proxy/) —— 那里能把对话现场录成 `.yrp3d`，下面所有功能照常可用：
>
> - **`START.vbs`**（推荐）：浏览器界面，点按钮开始录。**查看、导出、拖入本机录像都已经在里面**，
>   不用再开这个页面；而且底下的代码就是同一份（见「共享的解析块」），导出的结果逐字节一致。
>   ⚠️ 开发时这条路**需要装 Node.js**（`proxy/` 整个跑在 Node 上，零 npm 依赖）。
>   要拷给别人就**打包成 exe**（`node build-release.mjs`，见 [`PACKAGING.md`](PACKAGING.md)），
>   对方不需要装任何东西；
>   而这个页面**不需要**——只要「看录像 + 导出」的话，给这**一个文件**就行
> - `proxy.bat` **代理**：命令行版，自己下场打牌时用（把客户端服务器地址改成 `127.0.0.1`）
> - `observer.bat` **观战**：命令行版，盯别人的局时用（电脑上不用开客户端，填服务器 + 房间名就挂机录）
>
> 这三条的**服务器地址已经填好了**（代理 `mygo.superpre.pro:888`、观战 `mygo2.superpre.pro:888`）：界面里是预填值，
> 命令行版第一次问的时候括号里就是它，直接回车即可。要连别的服务器就把它覆盖掉 ——
> 三份默认值（`proxy.js` / `observer.js` / `gui.js`）必须同步改，`_test_gui.mjs` 有断言盯着。
>
> 命令行版录完之后没有界面可点，仍然是把 `proxy/replays/` 里的文件拖进这个页面。

---

## 使用

双击 `chat-extractor.html`，浏览器打开即用。不需要安装任何东西，文件不会上传——全部在你的电脑本地解析。

1. **载入** — 把录像拖进页面，或点击选择。支持一次选多个、也支持直接拖入整个文件夹。
2. **查看** — 每个录像显示成一张卡片，标明对话条数和双方名字。说话者只显示玩家名（**不带座位号**），
   座位上悬停鼠标才会看到。可以用搜索框过滤内容，也可以切换只看玩家发言 / 只看观战发言 / 排除系统消息。
3. **导出** — 合并 TXT / 分文件 TXT / JSON / CSV，或者直接复制到剪贴板。
   工具栏两个勾选框可以在导出时**排除系统消息**、**排除观战发言**，两者互不影响，
   也可以同时勾上只留双方玩家说的话。**这两个勾选框对四种格式和「复制全部」一律生效**，
   没有哪个格式是例外。

### 导出文件名带时间戳

**每次导出的文件名都会带导出时间，永远不会覆盖上一次的结果**——写进指定文件夹时同名文件是直接覆盖的，没有时间戳就会把前一次悄悄冲掉。

```
录像对话汇总_20260925-143012.txt
09-25「13：09：46」_chat_20260925-143012.txt
09-25「13：38：35」_chat_20260925-143012.txt
```

一次「分文件 TXT」导出里的所有文件**共用同一个时间戳**，方便辨认它们是同一批。

导出完成后右下角会弹出提示，写明导出了几个文件、存到了哪里、以及具体文件名。
**文件名是可以点的**，点一下会在新标签页里打开刚导出的内容。

> 网页没有权限打开磁盘上已有的文件（浏览器不给这个能力），所以点开的是**同一份内容的浏览器副本**，
> 不是你去下载目录里双击那个文件。想改内容请打开真正的文件。

### 导出到哪里

默认走**浏览器自己的下载功能**，文件进你的下载目录。页面顶部一直有一行提示写着当前目标，不会搞不清。

想固定输出位置，点工具栏的 **「📁 导出目录…」** 选一个文件夹，之后所有导出都进那里。

> 这个按钮依赖浏览器的 File System Access API，**目前只有 Chrome / Edge 能用**。
> 别的浏览器上会弹窗说明并自动退回下载目录，不会静默丢文件。

### 命令行版（备用）

网页版是主推用法。如果要用脚本批量处理，`dev/` 下有等价的 Python 实现：

```bash
python dev/yrp3d_chat.py *.yrp3d          # 每个文件生成 out/<名字>_chat.txt
python dev/yrp3d_chat.py -c *.yrp3d       # 额外生成 out/_all_chat.txt
python dev/yrp3d_chat.py --json *.yrp3d   # 结构化输出到 stdout
python dev/yrp3d_chat.py -o D:\logs *.yrp3d   # 写到别处
python dev/yrp3d_chat.py --here *.yrp3d   # 写回每个输入文件旁边
```

逐条日志默认写进 `dev/out/`，所以拿根目录的录像跑它不会在根目录散落 `_chat.txt`。
`-o` 支持跨盘符（会退化成绝对路径而不是报错）。标准 `.yrp` 会被识别并提示「不含对话」，不会抛解析异常。

---

## 注意

- **观战发言会被记录**，标成 `观战者`。如果某局录像里观战者确实说过话却找不到，先看筛选器是不是停在「只看玩家发言」——那一档会把它过滤掉。
- **观战者默认没有名字**，区分不出是哪个观战者在说——除非服务器开了 `display_watchers`（见「格式说明」）。
- **两个座位可能叫同一个名字**（实测遇到过双方都叫 `RLX`）。界面和导出都只写名字，这时**光看文本分不出是谁在说**——
  卡片顶部的「座位 0= / 1=」和消息上的悬停提示是仅有能区分的地方。要做严格归属就得靠它们。
- **玩家名在不同对局里可能不一致**（同一个人在不同录像里可能叫 `RLX`、`RLX$7781991`），做跨局统计时要按这个前提处理。
- **消息没有时间戳**，只有包在文件里的先后顺序，导出时按这个顺序排列。
- **解析失败的信息是统一的**，不区分具体是哪种格式不对——`无法解析：不是有效的 .yrp3d 录像文件，或者文件已损坏。`

---

## 格式说明（供维护者参考）

### `.yrp3d`（MDPro3 / YGOPro-Unity）

无魔数、无版本号、无校验和。整个文件就是一个包流，顺序读到 EOF：

```
uint8  包类型
uint32 数据长度（小端）
uint8[长度] 数据
```

**格式正确的判据**：按上述规则走完，偏移必须**恰好等于文件大小**。对不上就是损坏或不完整。

用到的包类型：

| 类型 | 名称 | 数据布局 |
|---|---|---|
| `230` | `sibyl_chat` | `uint32 说话者` + UTF-16LE 字符串（**含 NUL 结尾**） |
| `231` | `sibyl_replay` | 一段完整的标准 `.yrp`/`.yrp2` 字节流 |
| `235` | `sibyl_name` | 6 个 100 字节名字槽 + 末尾 `uint32` 槽位数 |
| `236` | `sibyl_quit` | — |
| 其余 | — | ocgcore 原始 GameMessage |

对话包长度恒等于 `4 + 2 × (字符数 + 1)`。**包内没有时间戳**，消息先后只能靠包在文件里的位置。

名字槽实测布局为 `[P0, '---', P0, P1, '---', P1]`，即下标 0 是玩家 0、下标 3 是玩家 1。
两个空槽（`---`）是占位。样本量只有 3 个文件，遇到异常布局需人工复核。

### 说话者（`player_type`）语义

对照 srvpro 的 `data/constants.json` 中 `COLORS`：

| 值 | 含义 | 显示 |
|---|---|---|
| `0` / `1` | 对战双方座位 | 映射到名字槽，只显示 `名字` |
| `7` | `TYPE_OBSERVER`，**观战者发言** | 显示为 `观战者`（无名） |
| `9` | 观战发言的**具名转发**，见下 | 显示为 `观战者「名字」` |
| `8` | `LIGHTBLUE`，系统广播的 Tip | 文字自带 `Tip: ` 前缀，但**不加** `[Server]: ` |
| `11`–`19` | 各颜色（RED/BABYBLUE/…） | — |
| `≥10` | 服务器消息 | `[Server]: ` 是**已经写进字符串里**的 |

对应 srvpro `data/constants.json` 的 `NETPLAYER`（`0`–`5` 是各座位号、`7` 是观战者）
和 `COLORS`。观战者在录像里**有记录**，和玩家发言一样是 `sibyl_chat` 包。

### 观战者为什么没有名字（以及怎么让它有）

**默认情况下拿不到。** `sibyl_chat` 包只有 `player_type` + 文本两个字段，观战者的名字
根本没进包；`sibyl_name` 包虽然有 6 个槽，实测只填了双方座位（`[P0, '---', P0, P1, '---', P1]`），
观战者不在里面。所以只能笼统标「观战者」，多个观战者同时说话也分不清是谁。

**但服务器端是有名字的。** srvpro 的 `ygopro-server.coffee:3479` 有个开关：

```coffee
if !cancel and settings.modules.display_watchers and (client.is_post_watcher or client.pos > 3)
  ygopro.stoc_send_chat_to_room(room, "#{client.name}: #{msg}", 9)
```

`client.name` 就是观战者的账号名。这个开关在 `data/default_config.json:32` 里
**默认为 `false`**，所以观战发言按原样（`player_type = 7`）转发，名字被丢掉。

把 `display_watchers` 改成 `true` 后，观战发言会改走 `player_type = 9` 的房间广播，
文本变成 `"名字: 内容"` —— **名字就进录像了**，本工具会把它解析出来显示成 `观战者「名字」`。

> 只对开启开关**之后**录的像有效，存量的 `.yrp3d` 补不回来——名字当初就没写进去。
> 另外这时观战发言会走 `stoc_send_chat_to_room` 广播给全场，行为上更接近「房间公告」。

`9` 本身不在 `NETPLAYER` 表里（那里只到 `7`），是 srvpro 转发时硬写的值。

### 背景：为什么标准 `.yrp` / `.yrp2` 读不了

（产品界面不区分格式，一律显示「解析失败」。这段只是把当初的结论记下来，免得以后重复调查。）

两条独立证据：

1. **代码层**：`ygopro_serve/ygopro/gframe/single_duel.cpp` 里所有 `last_replay.` 写入只涉及
   头部、两个 40 字节玩家名、四个 int32 参数、双方卡组卡片编号，以及 `WriteResponse`
   （只在 `GetResponse` 中调用）。`Chat()` 仅通过 TCP 发给 `replay_recorder`。
   客户端播放时靠 `set_responseb(pduel, resp)` **重新模拟**——录像是操作日志，不是视频流。
2. **实测**：解出真实文件 `2026-09-25 13-10-37.yrp`，数据恰好 532 字节
   = 80（名字）+ 16（参数）+ 436（卡组）+ **剩余 0**；`0x19`（STOC_CHAT）出现 **0 次**。

文件结构：80 字节头 + 原始 LZMA1 压缩的 `replay_data`。

> **解压坑**：头部 `props` 里存的是 `lzma_properties_encode` 输出的参数，压缩用的是
> `LZMA_FILTER_LZMA1EXT` 且 `ext_flags = 0`，即**没有结束标记**。
> Python 的 `FORMAT_RAW` 无法指定解压后大小，会报 "ended before the end-of-stream marker"。
> 可行做法：把原始 LZMA1 包进 legacy `.lzma`（"alone"）容器，在容器头里写上未压缩大小，
> liblzma 就会在那里停下。实现见 `dev/inspect_yrp.py`。

---

## 目录结构

```
yrp-tools/
├── chat-extractor.html     ← 产品本体，自包含单文件，直接双击使用（也是下面那个共享块的所在地）
├── README.md               索引：三个分支怎么选、这个分支怎么快速开始
├── USAGE.md                本文件：完整使用说明（格式说明也在里面）
├── SHARING.md              三个分支的共享契约（哪些文件共享、怎么同步、改一处要跑什么）
├── PACKAGING.md            开发用：怎么把 proxy/ 那套封成单个 exe 发出去
├── _parser.js              开发用：从上面那个 HTML 里抠共享块（测试、proxy、界面共用）
├── _shipped.js             开发用：读「随程序走的文件」（平时读磁盘，打包后读 exe 里的资源）
├── _test_parser.mjs        开发用：解析器回归测试
├── _bundle.mjs             开发用：把 5 个模块内联成一个脚本（打包用）
├── build-release.mjs       开发用：一条命令出成品（`node build-release.mjs`）
├── _test_bundle.mjs        开发用：打包器的快速测试（Role 派发 / argv / 资源）
├── _test_sea.mjs           开发用：真打 exe 起它点它——封装成功的唯一证明（慢）
├── proxy/                  标准 ygopro 用户的对话记录（界面 + 代理 + 观战，见它自己的 README）
├── build/                  开发用：打包中转产物，可随时删（生成物，别手改）
└── dev/                    开发用：逆向分析工具，普通使用者不需要
    ├── inspect_yrp.py      标准 .yrp 头部/LZMA 解码 + 结构转储
    ├── inspect_yrp3d.py    .yrp3d 包流遍历 + 转储
    ├── dump_region.py      指定区间的 hex/utf16/u32 转储
    ├── yrp3d_chat.py       Python 版导出器（参考实现，非产品）
    └── _replay_data.bin    inspect_yrp.py 的中间产物，可随时删
```

`chat-extractor.html` 仍然是可以单独拷给别人的便携版——复制这一个文件出去就能用。
但**在你自己这台机器上，日常入口是 `proxy/START.vbs`**：录制、查看、导出都在同一个页面里，
不用来回倒文件。

### 共享的解析块（改代码前必读）

`chat-extractor.html` 里的 `@parser` 哨兵块**不只是解析函数，还是导出格式的唯一实现**。
`proxy/gui.html` 的导出按钮调的就是它，所以两个页面导出的文件逐字节一致。

它靠两行哨兵注释定位：

```js
/* @parser:begin
 * ...解析 + 导出格式的纯函数...
 */
/* @parser:end */
```

四条硬约束，越界了会以很难查的方式坏掉：

1. **两行注释不要删、也不要改字样**——删了会四处一起报错（报错信息会点名是哪个文件缺哪个标记）。
2. **块内不能引用块外定义的东西**。Node 侧它被整段 `new Function()` 跑；浏览器侧被包成
   IIFE 发给界面（`GET /parser.js`）。DOM、`alert()`、`RESULTS` 一概够不着。
3. **块内不能有顶层 `await`**——`new Function` 的函数体和经典脚本都不支持。
4. **块内不能出现字面的 script 结束标签**（`<` + `/script`）。HTML 的解析器在 `<script>`
   里碰到这个序列就无条件收尾，会把整个内联脚本从中间截断，连 `@parser:end` 一起吃掉——
   而 `chat-extractor.html` 会看起来完全正常，只是后面的按钮全都不响应。

浏览器侧**必须包成 IIFE**、显式挂到 `window.YRP_PARSER`，不能裸发：顶层 `function` 会变成
`window` 的属性但顶层 `const` 不会，裸发时 `window.extract` 是 `undefined` 而裸标识符 `extract`
又能用；而且同名 `const` 重复声明是 SyntaxError，会让整个脚本静默不执行。

往块里加了函数，记得同时加进 `_parser.js` 的 `BROWSER_NAMES`——`_test_parser.mjs` 会逐个
断言它们真的挂到了 `window.YRP_PARSER` 上，漏了会红。

### 改了代码记得跑回归测试

```bash
node _test_parser.mjs [样例目录]     # 默认用工作区根目录的录像
```

它把 `chat-extractor.html` 里的共享块抠出来直接跑，验证的是**网页里那份代码本身**，
不是重打一遍的副本。导出的 TXT/JSON/CSV 用黄金字符串逐字节钉死，所以两个页面不会各自漂移。

改过 `chat-extractor.html` 的解析部分，`proxy/` 也要一起跑——它的测试会把代理真实产出的
`.yrp3d` 喂进同一份解析器：

```bash
node proxy/_test_proxy.mjs     # 切帧、解码、录像进解析器
node proxy/_test_e2e.mjs       # 真开 socket 跑一遍：假服务器 + 代理 + 假客户端
node proxy/_test_observer.mjs  # 观战端：假 srvpro，握手 / 让座 / 版本学习 / 落盘
node proxy/_test_gui.mjs       # 界面：token / SSE / 起停子进程 / 残包 / 路径穿越
```

### 要给别人用就打包成 exe

`proxy/` 那几个启动器是跑在 Node 上的，别人拿到文件夹双击只会看到「请先安装 Node.js」。
封成单个 exe 只需要一条命令：

```bash
node build-release.mjs   # 产物在 release/yrp-tools-<日期>/，双击里面的 START.vbs
node _test_bundle.mjs    # 打包器的快速测试（不用 postject）
node _test_sea.mjs       # 真打 exe 并冒烟，慢，出成品前跑
```

**原理、手工步骤、以及所有踩过的坑都在 [`PACKAGING.md`](PACKAGING.md)** —— 那份文档的
存在意义就是「不靠 agent 也能自己封装一遍」。

> ⚠️ 两个 HTML（`chat-extractor.html` / `proxy/gui.html`）是**烘进 exe** 的。
> 改完它们必须重新打包才会生效，光替换磁盘上的文件对已经发出去的 exe 没有任何影响。
