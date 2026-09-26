# 打包说明（给开发者的）

把 `proxy/` 那套（窗口 + 代理 + 观战）打成一个 **exe**，发给没装 Node 的人用。

> **日常改代码不用看这份文档。** 平时 `npx electron .` 就能开窗口，
> 五套测试照旧 `node xxx.mjs`。这份只在**要出成品**的时候看。

> 这份文档之所以存在，是用户明确要求过「不靠 agent 也能自己封装」。
> 所以下面每一步都写成了照着敲就能成的形式。

---

## 一条命令

```bash
cd yrp-tools-electron
npm run dist
```

出来的是 `release/electron/yrp-tools-Setup.exe` —— **一个安装包，约 110 MB**。

对方拿到后双击它，选个安装目录，完事。**不用装 Node，也不用管旁边有什么文件。**

```
发给别人的：  yrp-tools-Setup.exe   ← 就这一个（安装向导里有开始菜单/桌面快捷方式）
可选单独发：  chat-extractor.html  ← 便携版网页，能单独拷给只想「看录像」的人
```

`RELEASE-README.txt` 现在**只给维护者自己看**（它是随仓库走的说明文档）。
要一起发给别人也行，但安装包本身已经够用了。

跑一遍冒烟测试确认：

```bash
node _test_electron.mjs             # 开发态：起真窗口，走完整条链路再关掉
node _test_electron.mjs --packaged  # 打包 → 静默装到临时目录 → 跑真正的安装版
```

`--packaged` 那条做三件事，慢（打包 + 装两次 + 卸一次，几分钟），出成品前跑：

1. 断言发布包里**没有夹带你的数据**（见「坑 1」）；
2. 对**装出来的那个 exe**（不是 `release/electron/win-unpacked/` 里那份没装过的）
   跑完整链路；
3. 断言 **`%APPDATA%` 里的用户数据在覆盖安装和卸载之后都还在**（见「坑 9」）。

### 网络不好时

`electron` 和 electron-builder 的 NSIS 工具链都从 GitHub 下，国内常超时。
两个镜像变量已经在别的项目里验证过：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm run dist
```

**两个都得给。** 只给一个会在下载另一种东西时卡到 600 秒超时，
而且报出来的是 `Timeout awaiting 'request'`，看不出在等什么。

---

## 前置条件

| 需要什么 | 说明 |
|---|---|
| **Node.js** | v23.11.1 上验过 |
| `npm install` | 装 `electron` + `electron-builder`，`node_modules` 约 400-600 MB |
| 磁盘 | 打包过程要额外几个 GB 的临时空间（解压 electron + 7z 压缩） |

使用者那边**什么都不需要**：不用 Node、不用装任何东西、不用联网。

---

## 原理

```
yrp-tools-electron/
├── package.json        electron-builder 的配置就在这里（build 字段）
├── _shipped.js         读「随程序走的文件」：gui.html / chat-extractor.html
├── _parser.js          ├─ 读 chat-extractor.html
└── proxy/
    ├── main.js         Electron 主进程：窗口、单实例锁、数据落在哪、关窗清理
    ├── preload.js      contextBridge 只放行 invoke / on
    ├── api.js          全部逻辑（一行 electron 都没有）
    ├── gui.html        窗口里那张页面
    ├── proxy.js        代理子进程
    └── observer.js     观战子进程
```

```
双击 exe
  └─ Electron 起 main.js
       ├─ BrowserWindow 加载 gui.html（本地文件，不走网络）
       ├─ 页面 → window.yrp.invoke(通道) → ipcMain → api.js 的 handlers
       └─ spawn(process.execPath, [proxy.js], { ELECTRON_RUN_AS_NODE: "1" })
```

### 几个关键决定

**`asar: false`（不打包成 asar 归档）。**
`_shipped.js` 的 `fs.readFileSync`、起子进程时拼的 `proxy.js` 路径、
`explorer` 打开录像文件夹 —— 全都要求真实文件路径。打成 asar 就得做
`asarUnpack` 调优 + 一堆 `process.noAsar` 判断，凭空多出一整类
「开发态好好的、打包后才炸」的坑。代价是用户能看见源码 —— 个人自用工具，
不做代码保护，**真正的边界是下面的 `files` 白名单**。

**子进程要带 `ELECTRON_RUN_AS_NODE=1`。**
打包态和开发态 `process.execPath` 都是 `electron.exe`，不带这个变量
会把 `proxy.js` 当成一个 Electron 应用起，弹出一个没有任何内容的 GUI 窗口。
带上它 Electron 就退化成纯 node，**开发态和打包态走同一条代码路径**。

**`electronFuses.runAsNode: true`（必须显式写）。**
写死之后 Electron 才认 `ELECTRON_RUN_AS_NODE`。关掉的话子进程起不来，
报 `The ELECTRON_RUN_AS_NODE environment variable is not supported`。

**`win.signAndEditExecutable: false`。**
个人工具，不要图标不要版本资源 —— 省掉 winCodeSign 那 ~100 MB 的下载。

**数据目录 = `app.getPath("userData")`（即 `%APPDATA%\yrp-tools\`）。**
打包态的数据**不放在安装目录里** —— 原因见「坑 9」，那是踩出来的。
开发态仍然是 `proxy/`，所以那 20 个录像和配置零迁移。

录像还分一层：默认在 `%APPDATA%\yrp-tools\replays\`，但**界面工具栏上能改到任意
目录**（存在同目录的 `settings.json` 里，由 `api.js` 自己读写，通过
`YRP_REPLAYS_DIR` 传给子进程）。改哪儿都行，反正不跟着安装目录走。

---

## ⚠️ 坑（按「会不会静默出错」排序）

### 1. `files` 白名单漏项 → 把用户的隐私打进发布包【静默·最高】

electron-builder 的默认值是 `["**/*"]`，而 app root **就是这个仓库的根目录**。
不显式收窄的话，`proxy/config.json`（用户的第三方服务器地址）、
`proxy/observer.json`、`proxy/replays/` 里的录像、`release/`（里面还有别的 exe）
**全都会被打进发布包**，而且发布包照常能跑，你完全看不出来。

`package.json` 的 `files` 是唯一的防线，`_test_electron.mjs` 里有一组
**打包后的反向断言**盯着它。改白名单之后必须跑 `--packaged`。

### 2. `process.env.YRP_DATA_DIR` 必须写在 `require("./api.js")` 之前【静默·高】

`api.js` / `proxy.js` / `observer.js` 的路径都是**模块加载时**算出来的。
`main.js` 里那三行顺序反了不报错，只会静默用错目录 ——
打包态把只读的 `resources/app/` 当数据目录，测试则会往真实的 `proxy/replays/` 里写。

### 3. `package.json` 里不能加 `"type": "module"`【静默·中】

`proxy.js` / `observer.js` / `api.js` / `_parser.js` / `_shipped.js` 全是 CJS。
加了之后立刻全废，报 `require is not defined`，而且是**启动时才炸**。
`.mjs` 仍是 ESM、`.js` 仍是 CJS，`node xxx.mjs` 的习惯完全不受影响。

### 4. 自检报告别只靠 stdout【静默·中】

**这条的原始版本是「portable 那个 exe 是个 NSIS 壳」** —— 壳把真正的 exe 解压到
`%TEMP%` 再起，那孩子的 stdout 接不回外层测试的管道，表现是「自检明明跑完了，
日志一条都读不到」。现在改成安装包之后，测试起的是装出来的真 exe，管道是通的。

但**双写保留着**，理由换了一个：程序要是在 flush 之前崩掉，stdout 里那点输出
就没了，看上去还是像「自检根本没跑」。所以 `main.js` 的 `report()` 同时写
stdout 和 数据目录里的 `selftest.log`，测试**两条都认**（`fromFile || out`）。

### 5. `build/` 这个名字被占用了【工序】

`electron-builder` 的 `directories.buildResources` 默认是 `build/`。
本项目里 `build/` 曾经是 SEA 的中转产物目录（已随 SEA 产线一起删掉），
但配置里仍显式写着 `electron-resources`，别改回去。

### 6. `shell.openPath` 不一定会把窗口提到前台【明显·中】

用户之前正是因为「点了没反应」报过这个问题 —— explorer 新建的窗口会开在
**调用它的那个窗口后面**（Windows 的前台锁）。

现在 `main.js` 先 `win.focus()`，再让 `api.js` 跑那段 PowerShell
（`AttachThreadInput` 提窗口）。**那段脚本不能删** —— 它是唯一能**判定**
到底提到前面没有的机制，`gui.html` 靠它的返回值决定要不要说「看一下任务栏」。

### 7. 产物体积【明显·低】

安装包约 **110 MB**（里面就是压缩后的 Electron 运行时 + 源码）。

早先那个「每次启动先把自己解压到 `%TEMP%`，慢 2-5 秒」的问题是**单文件
portable 形态**特有的，换成安装包之后没有了 —— 装完就是普通程序，启动很快。
代价换成了另一个：安装包要**装**一次（多一个步骤、多一个卸载项）。

想省掉安装步骤的话，`package.json` 的 `win.target` 加回 `"portable"` 就能同时出
一个免安装的单文件版。数据目录**不用改** —— `app.getPath("userData")` 对 portable
也是对的（这条正是「坑 9」的结论：数据一律不跟着 exe 走）。所以加了不会踩坑，
只是白白多花一次打包时间。

### 8. 没签名，别的机器上会被 SmartScreen 拦【明显·低】

个人自用无所谓，本机第一次可能也要点「仍要运行」。
它是个会自举起子进程的未签名 Electron 应用，杀软启发式误报的概率比原来的
SEA exe 略高一点。

### 9. 安装目录里的东西会被升级删掉【静默·最高·实测踩过】

NSIS 安装包**升级的时候会先跑旧版本的卸载器**，而卸载的动作就是
「把安装目录整个删掉，再装新的」。这不是猜测，是拿探针脚本实测出来的：

```
第 1 次装 → 往安装目录里塞 replays/_upgrade-marker.yrp3d 和 config.json
第 2 次装（覆盖）→ 录像没了 ❌  配置没了 ❌
卸载 → 整个安装目录被删
```

**所以任何用户数据都不许放在安装目录里。** 这是 `%APPDATA%\yrp-tools\`
这个选择的全部理由 —— 不是「Electron 的习惯做法」那种审美问题。

早先的便携版（`portable` target）正好相反：数据就在 exe 旁边，
`PORTABLE_EXECUTABLE_DIR` 指哪儿就写哪儿。换成安装包之后那条路必须堵死，
否则用户升一次级丢一次录像，而且**悄无声息**。

`_test_electron.mjs --packaged` 的 7a/7b/7c 三段就是钉这条的：
打包态的数据目录**真的**是 `%APPDATA%\yrp-tools`、覆盖安装后录像还在、卸载后录像还在。

### 10. `EPERM: rename '...win-unpacked.tmp' -> '...win-unpacked'`【工序·报错会指错方向】

electron-builder 把 electron 解压到 `release/electron/win-unpacked.tmp`，
再用 rename 换成 `win-unpacked`。**目标目录还在、或者正卡在 Windows 的
「待删除」状态里**时（它自己刚删过 `win-unpacked`，句柄还没放干净），rename 就报：

```
⨯ EPERM: operation not permitted, rename '...\win-unpacked.tmp' -> '...\win-unpacked'
    at extractArchive (app-builder-lib/.../electronGet.ts:249:5)
```

**报错位置在 `extractArchive` 里，看着像「electron 包下载坏了 / 缓存损坏」** ——
很容易往网络和缓存上查，其实跟下载一点关系都没有。这个坑通常是
**上一次构建被 Ctrl+C 或者被杀掉**留下的半截目录。

`_test_electron.mjs` 的 `build()` 在调 electron-builder **之前**会先删掉
`win-unpacked` 和 `win-unpacked.tmp`，就是为了绕开它。手工打包时如果撞上，
把 `release/electron/win-unpacked*` 删掉再跑一遍即可。

**但有时候那个目录根本删不掉。** 报 `EPERM` 或者 `Device or resource busy`，
重试几分钟也没用 —— 占用者多半是**杀软的实时防护**或者 Windows 索引器，它们
正在扫那个刚写出来的文件。实测撞过一次：`win-unpacked.tmp/resources/default_app.asar`
被腾讯电脑管家攥了 5 分钟以上，`rmSync` 重试 20 次都没松手。

这时候 `build()` **不再硬撞，而是换一个干净的输出目录**继续跑：

```
       ⚠️ win-unpacked.tmp 被别的进程占着，删不掉，这次改用 release\electron-nRvz5D
```

所以看到这行不要慌，构建是对的，只是产物**不在 `release/electron/` 里**：

```
⚠️ 这一轮的产物在 release\electron-nRvz5D（不是 release\electron）：
     <项目目录>\yrp-tools-electron\release\electron-nRvz5D\yrp-tools-Setup.exe
   release\electron 里那个是旧包，别用。
```

**这两行是给你指路的，别当成错误。** 顺手要做的只有一件事：等杀软松手后，
把 `release/electron/win-unpacked*` 和那些 `release/electron-XXXXXX/` 删掉。
（`electron-XXXXXX` 那几个里面有完整产物，删之前先确认新包装出来了。）

> 顺带一提：**构建的慢是正常的。** 解压那个 158 MB 的 electron 包 + LZMA 压缩
> 出 110 MB 的安装包，加起来要好几分钟，中间**一行输出都没有**。
> 别看见不动就以为卡死了（我查了半天，结果只是耐心不够）——
> 想看它到底在不在干活，去看 `%TEMP%` 下的 `*.tmp` 有没有在长大。

---

## 改完代码之后

| 改了什么 | 要做什么 |
|---|---|
| `proxy/api.js`、`proxy/proxy.js`、`proxy/observer.js` | 跑 `npm test`（不用打包） |
| `chat-extractor.html` 的哨兵块 | 跑 `node _test_parser.mjs` |
| `proxy/gui.html`、`proxy/main.js`、`package.json` 的 build 段 | **必须重新打包**，跑 `node _test_electron.mjs --packaged` |
| `chat-extractor.html`（整个文件） | 重新打包（它是烘进去的），并且给别人的那份也要换新 |

> **没有「替换磁盘上的文件就生效」这回事。** `gui.html` 和
> `chat-extractor.html` 都是打进 exe 的，改完必须重打。

---

## 这块东西的来历

原来是 **Node SEA**（`postject` 往 `node.exe` 副本里塞 blob）+ 本地 HTTP 服务 +
浏览器标签页，用 `.vbs` 把控制台窗口藏起来。

换成 Electron 的原因（用户原话）：

> 你这个打包其实跟我想要的不一样，我是想要通过 electron 打包出 exe 文件，
> 点击打开不依赖浏览器，并且关闭程序的时候，会自动关闭后台运行的脚本，
> 而不是需要手动点击退出界面。

浏览器当界面时那条「关了标签页进程还活着，得回页面点退出」是**结构性的**：
浏览器没有原始 TCP 接口，所以必须绕一层本地 HTTP 服务，于是界面必然在另一个进程里。
换成 Electron 之后窗口就是程序，关窗即退出，`before-quit` / `will-quit` /
`process.on("exit")` 三条路都调 `api.killAll()`。

顺带整块消失的东西：token 生成与校验、`gui-token.txt` / `gui-url.txt` 探活、
端口探测与 `EADDRINUSE` 重试、SSE 的断线重连协议、`cmd /c start` 开浏览器、
四个启动器脚本。多出来的是 Electron 那 400-600 MB 的 `node_modules`
和打包时间 —— 这是这次迁移最重的一次性成本。
