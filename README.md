## YGOPro 录像对话记录工具

支持 `.yrp3d` 录像文件对话导出以及实时录制进行中对局对话，主要用于跑团 RP 记录。

### 分支：
* `master`：本分支，`yrp.exe`（Node SEA 封装）+ 本地 HTTP 服务 + 浏览器页面
* [`electron`](../../tree/electron)：Electron 独立窗口，桌面版
* [`android`](../../tree/android)：Capacitor 外壳 + 嵌进 APK 的 Node 运行时

三个分支是同一套东西的三种打包方式。新功能先进 `electron`，再同步给 `android`。

### 文件：
* `chat-extractor.html`：便携单文件，双击即用，不装任何东西
* `proxy/START.vbs`：开录制界面（Windows，无黑窗口）
* `proxy/gui-console.bat`：同上，保留黑窗口看日志
* `proxy/proxy.bat`：命令行，代理模式
* `proxy/observer.bat`：命令行，观战模式
* `build-release.mjs`：打成 `release/yrp-tools-<日期>/`，对方不需要装 Node

### 命令行：
* `node proxy/proxy.js`：代理模式。把客户端的服务器地址改成 `127.0.0.1`
* `node proxy/observer.js`：观战模式。填服务器和房间名就挂机录，本地不用开客户端

### 目录：
* `proxy/replays`：录出来的 `.yrp3d`
* `proxy/config.json`：代理模式填的服务器地址和房间名
* `proxy/observer.json`：观战模式填的服务器地址和房间名

### 文档：
* [USAGE.md](USAGE.md)：完整使用说明，`.yrp3d` 格式说明也在里面
* [PACKAGING.md](PACKAGING.md)：怎么封装成单文件 exe 发给别人
* [SHARING.md](SHARING.md)：三个分支之间的共享契约
* [proxy/README.md](proxy/README.md)：现场录制那一套的细节

### 注意：
* 只记录你在客户端里本来就能看到的东西（房间里的聊天），不修改游戏数据，不注入客户端
* 仓库里不含任何人的录像、房间名或昵称；默认服务器地址是公开的
  （代理 `mygo.superpre.pro:888`、观战 `mygo.superpre.pro:888`），要连别的服务器直接覆盖
* 没有联网上传这一步，录像只写在你自己的磁盘上

### 许可：
未声明许可证（保留所有权利）。
