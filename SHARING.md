## 三个分支的共享契约

三个分支是同一套东西的三种打包方式，不是三个项目。它们之间共享什么、谁是唯一真本、
改一处要跟着动什么，都在这份文件里。

这份文件在三个分支的根目录下逐字节相同，在哪个分支读到的都是这一份。
下面所有 sha256 都是 2026-09-26 实测的，不是记忆里的数字。

### 1. 三个分支：
* `master`（默认分支）：`yrp.exe`（Node SEA 封装）+ 本地 HTTP 服务 + 浏览器页面
* `electron`：Electron 独立窗口 + IPC + `electron-builder` 打的单个 `yrp-tools.exe`
* `android`：Capacitor 8 外壳 + `@capawesome/capacitor-nodejs` 嵌进 APK 的 Node 运行时

新功能先进 `electron`（桌面），再同步给 `android`。`master` 是默认分支和回滚点，
保留的是改 Electron 之前那一代实现。

三者共用的只有一件东西：`chat-extractor.html` 里的 `@parser` 哨兵块
（解析和导出格式的唯一实现，见第 7 节）。之外的格局是：

* `electron` 和 `android` 的后端与界面全部共享（`proxy/api.js` + `proxy/gui.html`，逐字节相同）
* `master` 是另一套后端（`proxy/gui.js`，HTTP + SSE，没有 IPC），界面靠人手工同步

### 2. 界面只有一份真本：

界面层的唯一真本是 `electron` 分支的 `proxy/gui.html`。
`android` 的 `www/nodejs/proxy/gui.html` 和 `www/index.html` 是 `scripts/build-web.mjs`
拷出来、生成出来的产物；`master` 的 `proxy/gui.html` 是手工同步的近似副本。

改界面 = 改 `electron` 那份，然后同步，然后重新出包。
直接在副本上改，下一次同步就没了；忘了同步，另外两个分支就停在旧行为上，
而且不会有任何报错。

### 3. 哪些文件共享（2026-09-26 实测 sha256，前 16 位）：

| 文件 | electron | android（`www/` 里那份） | master |
|---|---|---|---|
| `chat-extractor.html` | `7647a5aa4176fdca` | `7647a5aa4176fdca` | `7647a5aa4176fdca` |
| `_parser.js` | `30bc83d4b28f4b7f` | `30bc83d4b28f4b7f` | `30bc83d4b28f4b7f` |
| `proxy/gui.html` | `1c0f976accdcba3a` | `1c0f976accdcba3a` | `ec84bf90b5026453`（手工同步的近似副本） |
| `proxy/api.js` | `42c631a98e7121dc` | `42c631a98e7121dc` | 没有这个文件（它的后端是 `proxy/gui.js`） |
| `proxy/observer.js` | `d8a6fcad78411a0b` | `d8a6fcad78411a0b` | `e5ff7de9f7b58694`（另一套写法） |
| `proxy/proxy.js` | `b9fab395bd3c015b` | `b9fab395bd3c015b` | `761b330046b0d7e1`（另一套写法） |
| `www/index.html` | 没有 | `e8ab42c5f6d503c5`（= `gui.html` + 一行垫片） | 没有 |

自己量一遍，不要相信这张表：

```bash
# android 的 www/ 是同步产物，先同步再量，否则量的是上一次的结果
cd yrp-tools-android && npm run sync
sha256sum ../yrp-tools-electron/proxy/api.js www/nodejs/proxy/api.js
sha256sum ../yrp-tools-electron/_parser.js    www/nodejs/_parser.js
```

前两列必须两两相同。`master` 那一列不同是设计如此（它是上一代实现），
不要为了「统一」去改成一样 —— 那要重写它的后端。

### 4. 同步：

```bash
cd yrp-tools-android && npm run sync     # = node scripts/build-web.mjs
```

这是 `www/` 唯一的产出者。它做四件事，每一步都带断言，不通过就退出码 1，
不会有「一半同步成功」：

* 白名单拷贝（`COPIES`，8 个文件）：`chat-extractor.html`、`_parser.js`、
  `proxy/{api,observer,proxy}.js`、`proxy/gui.html`，各自放到 `www/` 里对应的位置
* 生成 `www/index.html`：源版 `gui.html` 插一行 `<script src="yrp-shim.js"></script>`
  （在 `</head>` 之前、在内联脚本之前），除这一行外与源版逐字节相同
* 哨兵块：从 `_parser.js` 读哨兵文字（不硬编码），确认 `chat-extractor.html` 里那一对还在
* 反面断言：`NEVER_COPY = ["config.json", "observer.json", "settings.json", "replays", "gui-token.txt"]`
  一个都不许进 `www/`；再拿你真实配置里的值（房间名、昵称）扫一遍产物

为什么是白名单而不是整目录复制：安卓版没有 `electron-builder`，桌面版靠 `package.json`
的 `files` 白名单挡住用户数据，安卓版只能靠这份清单。改成递归复制 = 把用户的录像和
服务器地址一起打进 APK，而且包照常能跑，看不出来。

`www/` 里只有三个文件是手写的，不经同步、必须留在仓库里：`www/yrp-shim.js`（界面垫片）、
`www/nodejs/index.js`（Node 侧入口）、`www/nodejs/package.json`。其余都是同步产物，
不要提交进仓库，否则就有了第二份真相。

`master` 为什么手工同步：它的后端是 `proxy/gui.js`（本地 HTTP + SSE），接口形状和
`api.js` 的 IPC 完全不同（`post("recordings:import")` ←→ `post("/api/import")`），
没有共同来源可拷。代价是 `_test_paging.mjs` / `_test_import.mjs` 里有一批
「三份逐字相同」的断言，靠它们把手工同步的漂移当场报红。

### 5. 路径契约：

`android` 的这三个文件里都写着同一行：

```js
const SRC = path.resolve(HERE, "..", "yrp-tools-electron");
```

* `scripts/build-web.mjs`：同步的来源
* `tests/_test_shared_sync.mjs`：交叉验证同步没漂移、没过期
* `tests/_test_apk_noleak.mjs`：拿真实配置值扫 APK

也就是说，`android` 分支旁边必须有一个叫 `yrp-tools-electron` 的目录，
而且它是 `electron` 分支的检出。目录名不能变，改名就等于没有。

推荐用 worktree，一个 clone 拿全三个分支：

```bash
git clone <本仓库地址> yrp-tools          # 默认分支是 master
cd yrp-tools
git worktree add ../yrp-tools-electron electron
git worktree add ../yrp-tools-android  android
```

```
你放代码的地方/
├── yrp-tools/            ← master
├── yrp-tools-electron/   ← electron（桌面主力）
└── yrp-tools-android/    ← android
```

只要看录像、导出对话，根本不需要这一套：拿 `chat-extractor.html` 一个文件，
或者装打包好的桌面版 / 安卓版就行。这一节是给要改代码的人看的。

这三个目录名不是随便取的：

| 名字 | 谁要求它 | 为什么 |
|---|---|---|
| `yrp-tools-electron` | 安卓侧的 `build-web.mjs` 和两个测试 | 路径写死成 `HERE/../yrp-tools-electron` |
| `yrp-tools` | electron 侧的 `_test_paging.mjs` / `_test_import.mjs` | 找的是 `../yrp-tools/proxy/gui.html`（master 那份，用来做三端对比） |
| `yrp-tools-android` | electron 侧的 `_test_paging.mjs` | 找的是 `../yrp-tools-android/www/index.html` |

名字不对就是「找不到文件」这种看不出所以然的红。

刚 clone 下来要先跑一次同步再跑测试。安卓的 `www/` 是同步产物、不入库，
而 electron 侧的 `_test_paging.mjs` 会去比安卓那份 `www/index.html`。
没同步过的话，`cd yrp-tools-electron && npm test` 会红在
「安卓：找得到 yrp-tools-android\www\index.html」这一条上：

```bash
cd yrp-tools-android && npm run sync     # 首次必须跑；以后改了 electron 的界面也要重跑
```

### 6. 安卓那个「假 ChildProcess」：

安卓上没有 `child_process`（Node 是嵌进 APK 的，没有独立进程可起），
所以 `www/nodejs/index.js` 里有一个照 `api.js` 的调用形状写出来的假 ChildProcess：

| 契约 | 谁依赖它 |
|---|---|
| 靠 `args[0]` 的文件名判断跑哪个模式（`proxy.js` / `observer.js`） | 假 spawn |
| `--dump` 存在时才开抓包 | 假 spawn |
| `YRP_REPLAYS_DIR` 决定录像写哪儿 | 假 spawn |
| `YRP_DATA_DIR` 决定数据目录 | `index.js` 自己 |
| `opts.spawn` 是注入点（不注入就 `require("child_process")`） | `api.js` |
| 不能出现 `const { spawn } = require("child_process")` 这种解构写法 | 在安卓上加载期就抛，整个 `api.js` 报废 |

这几条任何一条改了，安卓侧会静默失配（起不来，或者录到别的目录去，
而用户只看到「怎么一个录像都没有」）。所以 `build-web.mjs` 把它们写成断言钉住了。

### 7. `@parser` 哨兵块：

`chat-extractor.html` 里那对哨兵注释之间的代码不只是解析函数，还是导出格式
（合并 TXT / 分文件 TXT / JSON / CSV）的唯一实现。它被三处复用：便携页自己、
`proxy/gui.html` 的导出按钮、以及 `_parser.js`（Node 侧用 `new Function` 抠出来跑，
浏览器侧当 IIFE 跑）。

四条硬约束，碰这块之前先读 `_test_parser.mjs`：

* 两行哨兵注释的字样不能改（`_parser.js` 读的就是它）
* 块内不能引用块外的东西（两边都是抠出来单独执行的）
* 块内不能有顶层 `await`
* 块内不能出现字面的 script 结束标签（会把内联脚本从中间截断）

往块里加函数，必须同步加进 `_parser.js` 的 `BROWSER_NAMES`，
然后重跑回归测试（三个分支各有一份 `_test_parser.mjs`，导出格式用黄金字符串逐字节钉死）。

### 8. 别做这些：

| 别做 | 为什么 |
|---|---|
| 手工改 `www/` 里的同步产物 | 下次同步就没了；`_test_shared_sync.mjs` 会红 |
| 把 `www/` 的同步产物提交进仓库 | 那就是第二份真相，改一边忘一边 = 用户拿到两个行为的版本 |
| 在 `master` 上加功能 | 新功能一律进 `electron`，再同步给 `android` |
| 以为「改了磁盘上的 `chat-extractor.html` / `gui.html` 就生效」 | 这两个文件是烘进产物的：桌面版要 `npm run dist` 重打包，`master` 要 `node build-release.mjs`，安卓版要 `npm run apk`。替换已发出包里的磁盘文件没有任何用 |
| 把 `api.js` 里的 `recordings:import` 和 `master` 的 `/api/import` 混起来 | 后者在安卓上不存在（没有本地 HTTP 服务），漏进 `www/` 的表现是「点了导入没反应」，`build-web.mjs` 有反面断言盯着 |

### 9. 改了一处之后要跑什么：

| 改了什么 | 同步 | 跑什么 | 重新出什么包 |
|---|---|---|---|
| `@parser` 哨兵块 / `_parser.js` | 三处都要（`_parser.js` 是各自仓库里的一份，哨兵块共享） | 三个分支的 `_test_parser.mjs` | 三个都要重出 |
| electron 的 `proxy/gui.html`（界面） | `npm run sync`（安卓）+ 手工同步 `master` | electron `npm test`、安卓 `npm test`、`master` 的 `_test_gui.mjs` | 三个都要重出 |
| electron 的 `proxy/api.js`（后端） | `npm run sync` | electron `npm test`、安卓 `npm test` | 桌面 + 安卓 |
| 默认服务器地址（`proxy.js` / `observer.js` / `api.js` 的 `DEFAULTS`） | 不用 | electron `npm test`、安卓 `npm test` | 三个都要重出 —— 地址是**预填进界面和产物**的，不改磁盘上那份就等于没改 |
| 安卓独有（`www/yrp-shim.js`、`index.js`、原生侧） | 不用 | 安卓 `npm test` | 安卓 |
| `master` 独有的 `proxy/gui.js` | 不用 | `master` 的 `_test_gui.mjs` | `master` |

各分支自己的完整文档：`USAGE.md`（`master` / `electron` 分支）、`DEVELOPING.md`（`android` 分支）。
