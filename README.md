## YGOPro 录像对话记录工具 —— 安卓版

支持 `.yrp3d` 录像文件对话导出以及实时录制进行中对局对话，主要用于跑团 RP 记录。

界面和后端就是桌面版的那一份（`proxy/gui.html` / `proxy/api.js` 逐字节相同）。
桌面版能做的那套（导出录像里的对话、导入本机录像）这里都有。

### 分支：
* [`master`](../../tree/master)：`yrp.exe`（Node SEA 封装）+ 本地 HTTP 服务 + 浏览器页面
* [`electron`](../../tree/electron)：Electron 独立窗口，桌面主力，界面层的唯一真本
* `android`：本分支，Capacitor 外壳 + 嵌进 APK 的 Node 运行时（nodejs-mobile）

三个分支是同一套东西的三种打包方式。要改界面本身，去 `electron` 分支改真本，
再同步回来（见 [SHARING.md](SHARING.md) 第 4 节），不要在这里手改 `www/`。

### 功能：
* 录制：填服务器 + 房间名，点开始。录的时候通知栏挂一个前台服务，息屏也继续录
* 查看 / 导出 / 分享：列表里点开一局看对话，导出走系统的「分享」（发给微信、存到文件…）
* 导入本机录像：点「选择文件…」，选中的 `.yrp3d` 会存一份进 App 的录像目录，
  重启 App 之后还在列表里（同名不覆盖，自动叫 `xxx_2.yrp3d`）

界面和桌面版是同一张页面，只有两处不一样，都由 `www/yrp-shim.js` 这个垫片改，
`gui.html` 一个字没动：
* 拖放改成整块点击（手机上没法拖文件进来，点一下开系统文件选择器）
* 藏掉「录像存到：/data/user/0/...」那行路径（手机上没得选，固定是 App 自己的目录）

### 手机上的两个坑：
* 系统会把息屏的 App 冻住 → 要手动把本 App 加进**电池优化白名单**，否则录到一半会断
* **卸载 App 会连录像一起删掉** → 卸载前先用「导出/分享」把要留的录像发出来

录像在 App 私有目录里：`/data/data/local.yrp.tools/files/replays/`，没有 root 看不进去，
所以导出走系统分享。

### 构建前：
本分支不能单独构建 —— `scripts/build-web.mjs` 会从并列的 `yrp-tools-electron` 目录
（electron 分支的检出）拷共享文件过来，没有它连 `npm run apk` 都跑不起来。

```bash
git clone <本仓库地址> yrp-tools
cd yrp-tools
git worktree add ../yrp-tools-electron electron   # 必须并列，且必须叫这个名字
git worktree add ../yrp-tools-android  android
```

### 工具链：
* JDK `21`（Capacitor 8 写死 `JavaVersion.VERSION_21`，AGP 8.13 也要 17+）
* Android SDK `platforms;android-36`、`build-tools;36.0.0`、`platform-tools`
* NDK `27.1.12297006`（隐藏的硬依赖：Node 插件要用 cmake 编 `native-lib.cpp` 去链 `libnode.so`）

版本以 `android/variables.gradle` + `android/build.gradle` 里的为准。要设 `JAVA_HOME`
和 `ANDROID_HOME`；[DEVELOPING.md](DEVELOPING.md) 里那套 `android-env.sh` 写的是原作者
那台机器的路径，照它列的版本号自己在你的机器上装一份即可。

### 打包：
* `npm run apk`：同步共享文件 → `cap sync` → `gradlew assembleDebug`
* 产物 `android/app/build/outputs/apk/debug/app-debug.apk`（约 152 MB，三个 ABI 各一份 `libnode.so`）
* `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`
* `gradlew` 在 Windows 的 cmd 里可能因为 `NoDefaultCurrentDirectoryInExePath` 找不到，
  那就自己跑 `cd android && ./gradlew assembleDebug`

### 测试：
* `npm test`：四套，全部纯离线，不需要手机，也不需要先构建 APK
* `tests/_test_shared_sync.mjs` 验「`www/` 里的东西确实是 electron 版拷来的、没过期」
* `tests/_test_apk_noleak.mjs` 拆开真 APK 验「一个字节的用户数据都没夹带」
* 这两套都要求旁边那个 `yrp-tools-electron` 目录在

### 文档：
* [DEVELOPING.md](DEVELOPING.md)：本分支的完整开发文档（构建、后台存活、数据在哪、装机、踩过的坑）
* [SHARING.md](SHARING.md)：三个分支之间的共享契约
* [`electron` 分支的 USAGE.md](../../blob/electron/USAGE.md)：桌面版的完整使用说明
  （`.yrp3d` 格式说明、说话者语义、导出的四种格式两边通用）

### 注意：
* 只记录你在客户端里本来就能看到的东西（房间里的聊天），不修改游戏数据，不注入客户端
* 仓库里不含任何人的录像、房间名或昵称；默认服务器地址是公开的（代理 `mygo.superpre.pro:888`、
  观战 `mygo2.superpre.pro:888`），要连别的服务器直接覆盖
* `build-web.mjs` 每次同步都会拿你真实配置里的房间名和昵称反面扫一遍产物，漏一个就构建失败
  （服务器地址是公开的，不在扫描范围内）
* 没有联网上传这一步，录像只存在你手机上的 App 私有目录里

### 许可：
未声明许可证（保留所有权利）。
