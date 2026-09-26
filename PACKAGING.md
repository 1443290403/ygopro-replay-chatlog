# 打包说明（给开发者的）

把 `proxy/` 那套（界面 + 代理 + 观战）打成一个 **exe**，发给没装 Node 的人用。

> **日常改代码不用看这份文档。** 界面、代理、观战照旧用 `node xxx.js` 跑，
> 六个测试套件也照旧。这份只在**要出成品**的时候看。

---

## 一条命令

```bash
cd yrp-tools
node build-release.mjs
```

出来的是 `release/yrp-tools-<日期>/`：

```
yrp-tools-20260925/
├── yrp.exe              ← 全部代码 + 两个页面，都在这里面
├── START.vbs            ← 双击这个（没有黑窗口）
├── proxy.bat / observer.bat / gui-console.bat
├── chat-extractor.html  ← 便携版，能单独拷给别人（不参与运行）
└── README.txt           ← 源文件是 RELEASE-README.txt，拷进来时改名
```

跑一遍冒烟测试确认：

```bash
node _test_sea.mjs      # 真打一个 exe 出来起它点它（慢，十几秒）
```

> ⚠️ **要发出去之前，重新跑一次这条命令。** 发布目录同时是运行时的数据目录，
> 你只要在里面双击过一次，它就留下了你的服务器地址和录像（见坑 12）。

---

## 前置条件

| 需要什么 | 说明 |
|---|---|
| **Node.js** | 构建机的版本**就是使用者的运行时版本**（exe 是本机 `node.exe` 的副本）。现在是 v23.11.1 |
| **postject** | 只在**构建机**上需要。`npm i -D postject`，或者让脚本用 `npx` 临时拉一个（要联网） |
| 磁盘 | exe 约 87 MB，压成 7z/zip 大约 30 MB |

使用者那边**什么都不需要**：不用 Node、不用装任何东西、不用联网。

---

## 原理

```
yrp-tools/
├── _bundle.mjs     把 5 个模块内联成一个 CJS 脚本 → build/sea-main.js
├── _shipped.js     读「随程序走的文件」：平时读磁盘，打包后读烘进 exe 的资源
├── _parser.js      ├─ 读 chat-extractor.html
└── proxy/
    ├── gui.js      ├─ 读 gui.html；起子进程时用 --role= 再跑一遍自己
    ├── proxy.js    └─ 角色之一
    └── observer.js
```

`build/sea-main.js` 是**生成物，不要手改**（下次打包就没了）。它做两件事：

1. **一个自制的 `require`**：把 5 个模块包成
   `function(module, exports, require, __dirname, __filename){...}`，用一张表互相解析。
   SEA 里**不能** `require` 磁盘上的相对文件，所以必须内联。
2. **角色派发**：`--role=gui|proxy|observer` 决定跑哪个入口。
   不带这个参数就是界面 —— 双击 exe 的那个行为。

界面的「起子进程」在打包后变成**再执行一遍自己**（`process.execPath` 就是 exe）。
三个入口文件里的 `if (require.main === module)` 守卫一行都没改，
靠的是自制 `require` 把 `require.main` 指向入口模块对象。

---

## 手工步骤（脚本坏了照着做）

```bash
# 0. 装 postject（只需一次）
npm i -D postject

# 1. 生成脚本（这一步已经带了 #! 剥离和语法检查）
node _bundle.mjs
node --check build/sea-main.js

# 2. 写 build/sea-config.json
#    绝对路径最省事，相对路径按哪个目录解析各版本说法不一
#    { "main": ".../build/sea-main.js",
#      "output": ".../build/sea-prep.blob",
#      "disableExperimentalSEAWarning": true,
#      "assets": { "gui.html": ".../proxy/gui.html",
#                  "chat-extractor.html": ".../chat-extractor.html" } }

# 3. 生成 blob
node --experimental-sea-config build/sea-config.json

# 4. exe = node.exe 的副本
cp "$(which node)" build/yrp.exe

# 5. 注入。哨兵名是 Node 的固定常量，不是我们选的
npx postject build/yrp.exe NODE_SEA_BLOB build/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# 6. 把 yrp.exe 和 proxy/ 里那四个启动器、chat-extractor.html、
#    RELEASE-README.txt 拷到一个新目录里 —— **一项项拷，别拷目录**
```

> 本机的 Node **没有 `--build-sea`**（那是更新的版本才有的），所以第 5 步的
> postject 是必须的。哪天升级 Node 之后可以试试 `node --build-sea sea-config.json`，
> 能成功的话第 4、5 步就合并成一条命令了。

---

## 改了东西之后要不要重新打包

| 改了什么 | 要重新打包吗 |
|---|---|
| `proxy/gui.html`、`chat-extractor.html` | **要**。它们是**烘进 exe** 的，改了磁盘上的文件对已经发出去的 exe 没有任何影响 |
| `proxy/*.js`、`_parser.js`、`_shipped.js` | **要** |
| `proxy/START.vbs`、三个 `.bat`、`RELEASE-README.txt` | 不用。这些是 exe **旁边**的文件，直接替换就行 |
| 升级了 Node.js | **要**（exe 是本机 `node.exe` 的副本） |

---

## 坑（都是真踩过的）

### 1. 三个入口文件首行是 `#!`

`proxy.js` / `observer.js` / `gui.js` 第一行都是 `#!/usr/bin/env node`。
`#!` 只在**文件最开头**才被当成注释，内联进函数体就是 `SyntaxError`。
`_bundle.mjs` 的 `cleanSource()` 会剥掉（注意仓库是 CRLF，正则要容忍 `\r`）。

### 2. 绝不能用正则去扫源码

`_parser.js` 的头部注释里有一行长得像 `require("../_parser.js")` 的**说明文字**；
`chat-extractor.html` 里有字面量 `"/* @parser:begin"`。
任何「扫一遍源码找 require / 剥注释」的做法都会把它们当真代码。

所以 `_bundle.mjs` 只做两件事：剥 `#!`、按 `function(){ ... }` 拼接。
正确性靠运行时（解析不到就抛）和测试（三个角色真跑一遍），不靠静态扫描。

### 3. 每个模块要拿到**不同**的 `__dirname`

这是不能直接用 esbuild / webpack 的原因 —— 它们会把所有 `__dirname`
统一成产物所在目录，而这里两个根模块（`_parser.js`、`_shipped.js`）
需要**上一级**，`proxy/*` 需要**它自己**。

```
产物在 build/ 里跑：锚点 = yrp-tools/build/   → _parser.js 拿 yrp-tools/ ✓
打成 exe 之后：      锚点 = exe 所在目录      → proxy/* 拿 exe 目录 ✓
```

`proxy/*` 拿到的那个就是**运行时数据的落点**（`replays/`、`config.json`、
`gui-token.txt`…），发布包靠它把数据放在 exe 旁边。
表在 `_bundle.mjs` 的 `DIRS`，**加模块时别忘了补一行**。

### 4. `require.main` 弄错的两种死法

自制 `require` 把 `require.main` 指向入口模块对象，三个入口才认得出自己。

- 指向了别人 → **两个 `main()` 一起跑**（`observer.js` 顶层 `require("./proxy.js")`，
  很容易触发）
- 一个都没指对 → **一个 `main()` 都不跑**。这个更坏：界面是纯事件驱动的，
  不跑 `main()` 就没有任何待处理句柄，进程**立刻静默退出、退出码 0、一行输出都没有**。
  双击的人只看到「什么都没发生」。

`boot()` 里因此有三条断言（`__MAIN` 在模块体执行前设好、和 `__cache` 里是同一个对象、
结束时没被改过）。`_test_bundle.mjs` 第 4 节两个方向都测。

### 5. `--role=` 不能有兜底

角色拼错时**必须 `exit(2)`**，不能降级成界面。降级的话子进程会起第二个界面，
第二个探到第一个还活着就 `reopen()` 然后 `exit 0` —— 父进程以为起好了，
用户看到的是「界面已经在跑了」，完全不知道观战没起来。

剥 `--role=` 必须在 `boot()` **之前**：`proxy.js` 的 argv 是模块级算的。

### 6. 资源名有两张表要对上

`_shipped.js` 的 `SOURCE_PATHS`（资源名 → 源码树里的位置）和
`_bundle.mjs` 的 `ASSETS` 是同一个东西的两半。加随程序走的文件要**同时**改，
`_test_bundle.mjs` 会断言两张表的键完全一致。

### 7. exe 是控制台子系统的程序

它就是 `node.exe` 的副本，所以**双击 exe 会弹一个黑窗口**。
发布包里的 `START.vbs` 就是为这个存在的（`wscript.exe` 是 GUI 子系统的，
由它去 Run，程序就分不到窗口）。打包之后**照样需要这个 vbs**。

### 8. `NODE_OPTIONS` 要从子进程环境里删掉

exe 本身就是 node。使用者机器上要是全局设过 `NODE_OPTIONS`（比如某个
`--require`），会跟进来把 exe 搞崩，而且是「我这儿不复现」的那种。
`gui.js` 起子进程时会 `delete env.NODE_OPTIONS`。

### 9. Windows 会拦一下

exe 没买数字签名，所以：

- **SmartScreen**：「Windows 已保护你的电脑」→ 点「更多信息」→「仍要运行」
- **杀毒软件**可能误报（一个自己注入过的可执行文件）→ 加信任

`README.txt` 里跟使用者解释过这两条。

### 10. 发布包必须一项项拷

**绝不能整个目录拷 `proxy/`** —— 那底下有使用者的 `config.json` /
`observer.json`（写着他的第三方服务器地址）和他自己的 `replays/`。
`build-release.mjs` 的 `assemble()` 用白名单拷，并且反过来断言没混进去本机数据。

### 11. 别放进 `Program Files`

程序要往自己旁边写 `replays/`、`gui-token.txt`、`gui-url.txt`。
系统目录没写权限，`gui-url.txt` 写不进去会让「双击第二次 = 重开页面」
和「防止开两个界面」**静默失效**。`README.txt` 里提醒了。

### 12. ⚠️ **发布目录同时就是运行时的数据目录**（最严重的一条）

exe 把 `replays/`、`config.json`、`observer.json` 写在**它自己旁边**（这是有意的，
为了便携）。而发布目录里就放着 exe —— 所以**你在发布目录里双击跑一次，
它立刻就在那儿生成你的配置和录像**，其中包括**你的第三方服务器地址**。

后果：跑过一次之后直接把那个文件夹 zip 发出去 = 把服务器地址和录像一起发了。

**规则：发之前一定要重新跑一次 `node build-release.mjs`。** 组装步骤会把整个目录删掉重建，
所以重跑之后的目录是干净的。别直接发一个「跑过」的目录。

`assemble()` 末尾有一条白名单断言（`config.json` / `observer.json` /
`gui-token.txt` / `gui-url.txt` / `gui-error.log` / `replays` / `build`），
混进去就会**报错停下**。但那是最后一道防线 —— 你手动 zip 的时候它管不着。

> 同理，**跑过之后要重新打包，得先把界面/代理全关掉**：有进程占着文件就删不干净，
> `nukeDir()` 会直接报错停下（这是故意的，删不干净时静默继续才是灾难）。
> `taskkill //PID <pid> //F`，或者用任务管理器。

### 13. `fs.rmSync` 在中文路径下会**静默不删** —— 所以 `nukeDir()` 是自己写的

这条是坑 12 的帮凶，单独记一笔，因为踩的时候完全没有报错。

**现象**：`fs.rmSync(dir, { recursive: true, force: true })` 在本机 Windows 上，
只要**路径里任何一段是非 ASCII**（目录名是中文，或者它自己在一个中文名的父目录下），
就**一个文件都不删，也不抛异常**，直接返回。`force: true` 把错误吞了。

清零复现（`A:` 是普通固定 NTFS 卷，不是权限或盘符问题）：

| 目标 | 结果 |
|---|---|
| ASCII 目录 / ASCII 文件 | 删掉了 ✓ |
| ASCII 目录 / 中文文件 | 删掉了 ✓ |
| 中文目录 / ASCII 文件 | **删不掉，也不抛错** ✗ |
| 中文目录 / 中文文件 | **删不掉，也不抛错** ✗ |
| ASCII 名字、但在中文父目录下 | **删不掉，也不抛错** ✗ |

单独调 `unlinkSync` / `rmdirSync` 都正常。所以 `build-release.mjs` 里那个
`rmrf()` 是自己拿 `lstatSync` + `readdirSync` + `unlinkSync` + `rmdirSync` 走的
递归删除，`nukeDir()` 调它，删完还验一次目录是否真没了。

**什么情况下会撞上**：仓库放在 `D:\我的工具\yrp-tools\` 这种路径下，
或者 `%TEMP%` 里有中文 —— 那 `nukeDir()` 和测试的临时目录回收都会失效。
后果正是坑 12：发布目录没删干净，旧的本机数据被当成新打的包发出去。

> 你自己写构建脚本时，**别用 `fs.rmSync` 递归删**。要么照抄 `rmrf()`，
> 要么删完 `existsSync` 验一遍 —— 至少别让它静默过去。

---

## 以后想自己封装 / 换工具

这套东西的形态是被 SEA 的**约束**逼出来的，换别的方案前先看清楚约束：

| 约束 | 后果 |
|---|---|
| SEA 只吃**单个 CommonJS 脚本** | 必须自己内联模块 |
| SEA 里不能 `require` 磁盘上的相对文件 | 内联的模块要用自制 `require` |
| `process.argv` 是 `[exe, exe, ...参数]` | `slice(2)` 行为和普通 Node 一致，产品代码不用改 |
| `__dirname` = exe 所在目录 | 运行时数据自动落在 exe 旁边，这是好事 |
| exe 是 `node.exe` 的副本 | 87 MB、有黑窗口、构建机 Node 版本定死运行时版本 |
| 资源靠 `getAsset` | 改了 HTML 必须重新打包 |

**替代方案**（都不推荐，记下来免得重新调研）：

- **把资源解包到临时目录**：多一条「解包失败」的静默路径，两个 50KB 的 HTML 不值得
- **把 HTML 转义成字符串塞进脚本**：`_parser.js` 靠 `indexOf` 切原文，
  转义链上任何一处做手脚都会静默改变切片结果
- **引 esbuild / webpack**：`__dirname` 的问题照样存在（见坑 3），还多一个依赖
- **Electron / pkg**：几十上百 MB 起，为了三个本地脚本不值当

---

## 相关文件

| 文件 | 作用 |
|---|---|
| `build-release.mjs` | 构建脚本（这份文档讲的就是它） |
| `_bundle.mjs` | 内联 + 角色派发。**产物是生成物，别手改** |
| `_shipped.js` | 磁盘 / 资源两条路的分叉点，全项目只有这一处 |
| `_test_bundle.mjs` | 快测：派发 / argv / 资源（不用 postject） |
| `_test_sea.mjs` | 慢测：真打 exe 起它点它 —— 封装成功的唯一证明 |
| `RELEASE-README.txt` | 给使用者的，打包时拷进发布目录 |
