## YGOPro 录像对话记录工具 —— 桌面版

支持 `.yrp3d` 录像文件对话导出以及实时录制进行中对局对话，主要用于跑团 RP 记录。

### 分支：
* [`master`](../../tree/master)：`yrp.exe`（Node SEA 封装）+ 本地 HTTP 服务 + 浏览器页面
* `electron`：本分支，Electron 独立窗口
* [`android`](../../tree/android)：Capacitor 外壳 + 嵌进 APK 的 Node 运行时

三个分支是同一套东西的三种打包方式。本分支的 `proxy/gui.html` 是界面层的唯一真本，
`android` 的 `www/` 由 `scripts/build-web.mjs` 从这里生成。

### 文件：
* 装好之后双击 `yrp-tools.exe`
* `chat-extractor.html`：便携单文件，双击即用，不装任何东西
* `proxy/proxy.bat`：命令行，代理模式
* `proxy/observer.bat`：命令行，观战模式

### 运行：
* `npm install`，然后 `npx electron .` 起开发模式的窗口
* `node proxy/proxy.js`：只跑后端。代理模式，把客户端的服务器地址改成 `127.0.0.1`
* `node proxy/observer.js`：只跑后端。观战模式，填服务器和房间名就挂机录

### 打包：
* `npm run dist`：打成 `release/electron/yrp-tools-Setup.exe`（NSIS 安装包，约 106 MB）
* 用户数据不在安装目录里，在 `%APPDATA%\yrp-tools\`（开发时在 `proxy/replays/`）

### 目录：
* `proxy/replays`：录出来的 `.yrp3d`
* `proxy/config.json`：代理模式填的服务器地址和房间名
* `proxy/observer.json`：观战模式填的服务器地址和房间名

### 测试：
* `npm test`：七套回归，纯离线，不碰 `proxy/replays/`（用临时目录）
* `node _test_electron.mjs`：慢的，真起 Electron 走完整条链路

### 文档：
* [USAGE.md](USAGE.md)：完整使用说明，`.yrp3d` 格式说明也在里面
* [PACKAGING.md](PACKAGING.md)：打包细节
* [SHARING.md](SHARING.md)：三个分支之间的共享契约
* [proxy/README.md](proxy/README.md)：现场录制那一套的细节

### 注意：
* 只记录你在客户端里本来就能看到的东西（房间里的聊天），不修改游戏数据，不注入客户端
* 仓库里不含任何人的录像、房间名或昵称；默认服务器地址是公开的
  （代理 `mygo.superpre.pro:888`、观战 `mygo2.superpre.pro:888`），要连别的服务器直接覆盖
* 没有联网上传这一步，录像只写在你自己的磁盘上

### 许可：
未声明许可证（保留所有权利）。
