# yrp-tools 安卓版

把 `yrp-tools` 做到手机上：**装一个 APK 挂机录观战，录完在同一个 App 里看/导出对局对话。**

这是同一条需求线上的第三个产物，和另外两个是**兄弟关系，不是取代关系**：

| 目录 | 形态 | 状态 |
|---|---|---|
| `yrp-tools/` | 浏览器页 + Node SEA 打包的 `yrp.exe` | 主分支（默认分支），只当回滚点 |
| `yrp-tools-electron/` | Electron 独立窗口 + 安装包 | **桌面主力**，继续维护 |
| `yrp-tools-android/`（本目录） | Capacitor + 内嵌 Node 运行时 → APK | **本目录**，代码共享自 Electron 版 |

---

## 0. 一句话说清它怎么跑起来的

APK 里**真的塞了一个 Node 运行时**（nodejs-mobile 18.20.4，`libnode.so` 打进三个 ABI），
观战那个 `observer.js` 就跑在里面，**协议代码一个字都没重写**。

```
安卓 WebView (index.html = gui.html)
      │  window.yrp.invoke / .on     ← 和桌面版同一个契约
      ▼
www/yrp-shim.js                      ← 安卓版**唯一**的宿主实现（对应桌面的 preload.js）
      │  Capacitor 消息通道
      ▼
www/nodejs/index.js                  ← 桥的 Node 侧：数据目录、日志改道、假子进程
      │  require
      ▼
proxy/{api,observer,proxy}.js        ← 从 Electron 版**原样拷来**，observer.js 零改动
```

关键点：**安卓和桌面的差异全部收在 `www/yrp-shim.js` 一个文件里**，
所以共享的 `gui.html` 一个字都不用改（否则连桌面版一起改了）。

---

## 1. 手机上能用什么、不能用什么

**能用**：观战录制（填服务器 + 房间名，挂机）、录像列表（分页，10 条一页）、点开看对话、
导出 TXT、分享出去、复制对话、退出时自动停干净。

**不能用，界面上按钮已经被藏掉了**（是隐藏不是删除，`gui.html` 的 JS 照常读写它们）：

| 藏掉的 | 为什么 |
|---|---|
| 打开录像文件夹 | 「用资源管理器打开」是 Win32 专有，安卓没有对应物 |
| 改录像目录 / 恢复默认 | 安卓的 scoped storage 不允许指向任意路径 |
| 「录像存到：…」那一格 | 它显示的是输出目录，安卓上是 `/data/user/0/local.yrp.tools/files/replays`，看不懂也改不了；而且那个目录永远可写，行尾的「⚠️ 写不进去」是死代码 |
| 选导出目录 / 选文件夹 | 安卓 WebView 没有 `showDirectoryPicker`，`webkitdirectory` 也不工作 |
| 「自己打牌（代理）」整个页签 | 安卓上要「手机自己跑客户端并指向 127.0.0.1」才闭环，没做 |
| 「退出界面」按钮 | **两个平台都删了**（见下） |

### 界面上和桌面版不一样的两处（都是垫片改的，`gui.html` 一个字没动）

1. **拖放改成纯点击。** 安卓 WebView 没有拖放，而原来是「把 .yrp3d 文件**拖到这里**
   —— 也可以 [选择文件…]」，用户看着那片虚线框只会去点它。现在整块都能点，点了弹
   系统文件选择器（`accept` 也被去掉了 —— 安卓不认 `.yrp3d` 这个 MIME，留着它
   选择器里**一个文件都不显示**）。
   > 实现上这一步是**搬家**：把 `#pick-files` 那个已有节点搬进 `#drop`，不是新建按钮。
   > 新建的话 `gui.html` 绑在它上面的处理器留在旧节点上，表现是「按钮在、点了没反应」。
   > `_test_shim.mjs` 第 10 节钉的就是这个区别。
2. **「退出界面」按钮没了。** 点了之后 App 确实退，但**再进来必崩**（原因没查到根上，
   直接去掉是用户要的解法）。

> ✅ **上划会连同内嵌的 Node 进程一起关掉 —— 这是要的行为，别去"修"它。**
> 用户 2026-09-26 明确说过：要的就是「关掉 App 就一起关」，怕进程残留。
>
> 2026-09-26 真机实测（机型 vivo V2254A / Android 15），录制中（前台服务在跑）：
>
> | 手势 | 进程 | 前台服务 | 常驻通知 | 结果 |
> |---|---|---|---|---|
> | **上划** | `pid` 没了 | 没了 | 没了 | **Node 一起关** ✓ 用户要的 |
> | **按返回** | 还在 | 还在 | 还在 | **录像继续在后台跑** |
> | **按 Home** | 还在 | 还在 | 还在 | 同上 |
>
> ⚠️ **别把这两个手势说成等价。** 返回只是 finish 掉 Activity，前台服务撑着进程，
> 所以返回 = 收起界面但**继续录**；上划才是全关。录制中「收起界面继续录」用返回或
> Home，想彻底关掉用上划。
>
> 上划那条的 logcat 里**连一条 AOSP 的 kill 记录都没有**，进程就是静默消失。原因是
> Android 15 上前台服务被上划掉会立即终止（已知回归），vivo 的省电策略再叠一层 ——
> 注意这跟「AOSP 名义上前台服务应该活下来」是相反的：`android:stopWithTask` 没设、
> 插件里也没有 `onTaskRemoved`，**光看源码会推出错误结论，这里只认实测**。
>
> ⚠️ **别拿下面这些去"修"它**（它们会让上划之后进程也活下来，正好和用户要的相反）：
> `android:excludeFromRecents="true"`、`launchMode="singleTask"`、把 Node 挪进
> `android:process=":node"`。**现在这个「上划就一起死」就是终点状态。**
>
> 副作用是录制中上划会**中断**当前那局（不是干净地停），所以通知上那句
> 「关掉这个 App 会中断录像」是准确的，**别改成「不会中断」**。
>
> 验证方法（改完 FGS 相关的东西可以复跑）：起前台服务 → 上划 → `pidof local.yrp.tools`
> 应该是空的；按返回则应该还在。

导出**不做「用默认程序打开」，改成交给系统分享面板** —— 这是把文件带出 App 沙箱的唯一正路
（分享到微信、或选「保存到文件」）。所以导出按钮点完会弹系统面板，不是直接打开文件。

---

## 2. 构建

> 这份文档写于原作者的开发机：里面的绝对路径（`D:\development_install\...`）和
> `android-env.sh` 都换成你自己机器上的即可，**版本号要照抄**（JDK 21 / SDK 36 /
> NDK 27.1.12297006 / AGP 8.13），那些是实测能过的组合。

### 一次性：工具链

已经装好的（都在这台机器的 `D:\development_install\` 下，**没装 Android Studio、没装模拟器**）：

| 需要什么 | 实际在哪 | 为什么是它 |
|---|---|---|
| JDK 21 | `D:\development_install\Java\jdk-21.0.2` | Capacitor 8 的 android 包里写死 `JavaVersion.VERSION_21`；AGP 8.13 也要 17+。**原来的 jdk1.8.0_221 不够**，没动它 |
| Android SDK | `D:\development_install\android-sdk` | cmdline-tools + `platforms;android-36` + `build-tools;36.0.0` + `platform-tools` |
| NDK | `android-sdk/ndk/27.1.12297006` | **隐藏的硬依赖** —— Node 插件用 `externalNativeBuild { cmake }` 编 `native-lib.cpp` 去链 `libnode.so`，而且它的 `build.gradle` 里**没写 `ndkVersion`**，得在 `android/build.gradle` 里统一指定 |

每个新开的 shell 先：

```bash
source D:/development_install/android-sdk/android-env.sh
```

> 那个脚本里 PATH 用 POSIX 形式（`/d/...`）、`JAVA_HOME` 用 Windows 形式（`D:/...`），
> 这不是写错了 —— Git Bash 认前者，Gradle / `sdkmanager.bat` / `java.exe` 这些原生程序认后者。
> 写反了会报「找不到 java」或者路径解析成一堆斜杠。

### 每次出包

```bash
cd yrp-tools-android
source /path/to/android-env.sh
npm run apk
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`，**约 152 MB**
（三个 ABI 各一份 `libnode.so`，每份 ~50 MB。这是把真 Node 塞进 APK 的代价，无解）。

`npm run apk` 三步：`build-web.mjs`（从 Electron 版拷共享文件）→ `cap sync android` → `gradlew assembleDebug`。

### ⚠️ 网络：一个会指错方向的坑

这台机器上 `maven.google.com` **25 秒超时**，而 Gradle 会**每个依赖卡 25 秒然后失败**，
表现是「构建一动不动，也没有报错」。所以：

- `android/build.gradle` 里 `buildscript` 和 `allprojects` 的仓库**都**换成了阿里云镜像，放在最前
- `gradle/wrapper/gradle-wrapper.properties` 的 `distributionUrl` 换成了腾讯云镜像

> 阿里云的 `maven.aliyun.com/repository/google` 实测 0.08 秒响应。这几个镜像**必须留在最前面**，
> 挪到 `google()` 后面就等于没有。

---

## 3. 后台存活（**这一节是安卓版最容易白干的地方**）

### 已经做了的

观战是长时间挂机的长连接，而安卓在息屏/切后台时会**冻结甚至杀掉**后台进程。
插件把 Node 跑在后台**线程**上 —— 那只是线程，**不是前台服务**，照样被杀。

> 这一节管的是**息屏 / 按 Home 键切后台**（进程要活下来）。**上划关掉是另一码事，
> 而且是要让它一起死的** —— 见 §1 里那张实测表，别把两件事搞混。

所以开始观战时 App 会起一个**带常驻通知的前台服务**：

- 通知类型是 `specialUse`（`1073741824`），不是 `dataSync`
  —— Android 15 起 `dataSync` 被限制成 24 小时内最多累计 6 小时，到点系统直接停服务，观战必然撞上
- 起停**完全由 `proc` 事件驱动**（`api.js` 发出来的那个），不另外记一套状态。
  理由是两边迟早会飘：比如 Node 侧看门狗自己退出了，通知和界面按钮就会各说各话
- 通知权限（Android 13+）**被拒也不阻断录制** —— 服务照起，只是状态栏看不到那条通知。
  录像本身比那条通知重要得多
- **频道是 High 重要性（`4`），不是 Low** —— 这一条是用户真机实测后改的。
  原来写 Low 的理由是「常驻通知只是告诉你还在录，不该打扰人」，但那个理由在
  实际机型上破产了：Low + 插件那个 `silent` 会被系统归进**「静默通知」**，
  状态栏根本不显示，**而且全程没有任何报错**。拿到悬浮横幅只有 High 才行
  （Low/Default 都不行）。`silent` 这个选项名字也骗人 —— 它映射的是
  `setOnlyAlertOnce`（`AndroidForegroundService.java:53`），不是真的静音
- ⚠️ **改 importance 必须同时换频道 id。** Android 规定频道的 importance
  **建完就改不了**（`createNotificationChannel` 只更新名字和描述，插件源码自己
  也标了：`ForegroundService.java:142`）。所以从 Low 提到 High 时 id 从
  `yrp_observer` 换成了 **`yrp_observer_v2`** —— 复用老 id 的话，**已经装过
  App 的机器上什么都不会变，且看不出异常**。代价是设置里留一个废弃的旧频道，
  比让人卸载重装（录像会丢，见 §4）好得多

### 需要你手动做一次：电池优化白名单

前台服务能挡住「正常的内存回收」，但**挡不住国产 ROM 的省电策略**。
想挂一整晚不断，得把 App 加进电池白名单。各家菜单不一样，找的是这个意思：

1. 系统设置 → 应用 → 找到 **yrp-tools** → **电池 / 耗电管理**
2. 把省电策略改成 **无限制 / 允许后台运行**（不要用「智能省电」「自动管理」）
3. 如果有 **自启动 / 后台自启动** 开关，打开它
4. 华为/荣耀还要额外看：**电池 → 更多电池设置 → 休眠时始终保持网络连接**，打开

> 关键词是「省电策略」「后台运行」「自启动」。各版本菜单文字会变，但一定在
> 「设置 → 应用 → 本应用 → 电池」这一带。
>
> 验证方法：开始观战后按 Home 键，等一分钟回来看日志还在不在滚、录像文件大小还在不在涨。

---

## 4. 手机上的数据在哪

`app.datadir()` = **`/data/data/local.yrp.tools/files/`**（App 私有目录，非 root 看不到）：

```
files/
├── replays/    录下来的 .yrp3d
└── export/     导出的对话 TXT
```

> 插件文档明确警告：**Node 项目目录会在 App 更新时被覆盖**，所以持久数据必须放 `datadir()`。
> `www/nodejs/index.js` 里 `process.env.YRP_DATA_DIR = app.datadir()` 是**在任何 `require` 之前**
> 做的 —— 那几个模块的路径是**模块加载时**算出来的，顺序反了不报错，只会静默用错目录。

### ⚠️ 卸载 App 会连录像一起删掉

录像在 App 私有目录里，**卸载即全丢**，而且 debug 签名的 APK 换台机器重新构建后会因为签名不同
而必须卸载重装。所以：**想留的对话，导出成 TXT 分享出去再说。**

---

## 5. 装上手机

APK 是 **debug 签名**的（个人自用、侧载，不需要 keystore 也不需要上架）。

```bash
# 手机开 USB 调试后
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

或者把 APK 拷进手机，用文件管理器点开装（首次要允许「安装未知来源的应用」）。
App 名叫 **yrp-tools**，包名 `local.yrp.tools`。

> ⚠️ **装完先确认装的是不是新的那份。** App 里没有任何版本号 / 构建时间，
> 装反了不会有任何提示 —— 2026-09-26 就因为这个白查了一轮（功能写好了、测试全绿，
> 手机上装的却是改动之前打的包，表现成「新功能完全没生效」）。量一下：
>
> ```bash
> # 插件会把 assets 解到这儿，等于 APK 里那份的副本；把串换成你要确认的东西
> adb shell run-as local.yrp.tools grep -c recordings:import \
>   files/capawesome_nodejs/nodejs-project/proxy/api.js
> # 或者直接比时间：装包时间必须晚于你改完代码的时间
> adb shell dumpsys package local.yrp.tools | grep lastUpdateTime
> ```

---

## 6. 测试

```bash
npm test
```

四套，**全部纯离线**，不需要手机也不需要安卓构建：

| 文件 | 验什么 |
|---|---|
| `tests/_test_shared_sync.mjs` | 共享文件确实是从 Electron 版拷来的（逐字节），`index.html` == `gui.html` 只多一行垫片，且同步不是过期的 |
| `tests/_test_shim.mjs` | 垫片和 `gui.html` 的契约（`on()` 同步返回取消函数、invoke 回复乱序不串、隐藏的 id 真的存在）、前台服务起停、以及和原生侧的**字符串契约**（图标名 `ic_stat_yrp`、manifest 里的 specialUse） |
| `tests/_test_android_backend.mjs` | Node 侧入口：数据目录顺序、代理模式被拒、**在进程内对着假 srvpro 跑完一整场观战**、解析、导出、桥配对、隐私 |
| `tests/_test_apk_noleak.mjs` | 对着**最终那个 APK**：没夹带用户数据（路径层 + 拿真实配置值扫内容层）、包里的 web 和仓库 `www/` 逐字节一致、合并后的清单里前台服务齐全且插件都注册了 |

> `_test_apk_noleak.mjs` 在没有 APK 时会**跳过**（先跑 `npm run apk` 再跑就有用）。
> 它自己带了一个极简 ZIP 读取器，**不依赖 `unzip` 命令** —— 这条断言是隐私的唯一防线，
> 不能因为缺个外部程序就静默不跑。

改完 `www/` 里的东西，`npm test` 里「逐字节一致」那条会红，提醒你**重新出包**
（APK 里的 web 是打包时烘进去的，改磁盘文件对已装上的 App 无效）。

---

## 7. 已知限制 / 没做的

- **已经上真机了**（2026-09-26 用户实测装上了，录观战那一步能跑通）。真机上报回来的
  问题见 §1，其中「表单没填默认值」查下来**不是默认值缺失**，是冷启动时 Node 起得比
  20 秒的等待上限还慢，而失败被永久缓存了 —— 第一次 `config:get` 就撞上，于是整个
  `init()` 从那一行往后全部不执行。现在超时放宽到 60 秒、失败不缓存（下次调用重试）、
  而且 `loadConfig()` 失败不再中断初始化，改成顶部 banner 报出来。
  ⚠️ **如果以后再看到「界面能用但配置是空的」，先看 banner 怎么写的** —— 那就是这条
  还没修干净的信号。另：息屏挂一整晚（§3 的电池白名单）仍未验证
- **不做代理模式**，界面上那页签是灰的（见 §1）
- **不做 `shell:reveal`**，`explorer.exe` + PowerShell + `user32.dll` 全是 Win32 专有
- **不做 iOS**，插件的 iOS 侧要在 macOS 上构建
- **电池白名单要手动加**（见 §3）—— 没写成 App 内的一键按钮，因为那需要自己写一个原生插件，
  是个离线测不了的构建面；FGS + WAKE_LOCK 已经覆盖了主要的被杀路径
- **debug 签名**，换机器重新构建会因为签名不同而必须卸载重装（录像会丢，见 §4）

### 踩过的坑（改这块之前先看）

1. **垫片里 `invoke` 和 `invokeNode` 必须分开。** `app:quit` 的本地实现要「先让 Node 侧收摊，
   再退 App」，写成 `invoke("app:quit")` 会**自己调自己无限递归** ——
   表现是点「退出」整个 WebView 卡死然后 OOM 崩掉，而不是退出去
2. **`file_paths.xml` 里必须有 `<files-path>`。** `@capacitor/share` 只认 `file://`，
   而导出的文件在 `getFilesDir()` 下，FileProvider 没配这条路径会抛
   `Failed to find configured root` —— 只在真机上、点到「分享」那一步才炸
3. **`YRP_DATA_DIR` 必须在 `require` 之前设**（见 §4）
4. **`console.log` 被改道了。** `www/nodejs/index.js` 把 console 重定向进假子进程的流，
   这样 `observer.js` 里几十条日志一行不改就上了界面。副作用是**测试里的 `console.log` 也会被吞**
   —— `_test_android_backend.mjs` 为此在 import 时先存了一份 `realLog`
5. **小图标不能用 `@mipmap/ic_launcher`。** 系统取状态栏小图标时只取 **alpha 通道**，
   自适应图标取完会糊成一个白块或整块空白。所以另做了 `res/drawable/ic_stat_yrp.xml`
6. **`serviceType` 可以绕过插件的 TS 枚举。** 插件的 `ServiceType` 只枚举了 `Location`(8) 和
   `Microphone`(128)，**没有 `specialUse`**；但它在 Java 侧就是一路裸 int 传到 `startForeground` 的，
   所以直接传 `1073741824` 是可行的
7. **⚠️ `input.value = ""` 会清空你手里那个 `FileList`。** 这是「点选文件后完全没反应」的根因
   （2026-09-26 用户真机报的，三端都改了）。原来的写法是

   ```js
   const fs = e.target.files;   // 拿到 FileList
   e.target.value = "";         // ← 同一个对象被清空，fs.length 变成 0
   addLocalFiles(fs);           // 收到空列表
   ```

   桌面版一直用拖放（走 `dataTransfer` 那条分支），所以这行代码在桌面上**从没被走到过**；
   手机上只能点击选文件，必然撞上。而且它**不报错、不弹横幅** —— `addLocalFiles` 里那句
   「这些文件里没有 .yrp3d 录像」带着 `if (files.length)` 守卫，此时也是 0，于是静默返回。
   正确写法是**先拷成数组再清**：`const fs = [...e.target.files];`

   > 查这个问题绕了很久（`onActivityResult`、Capacitor 的 `showFilePicker`、cordova 的
   > `MockCordovaInterfaceImpl` 全查了一遍才排除）。**最后是靠 `adb forward` 把 Chrome
   > DevTools 接到手机上正在跑的那个 WebView 里，直接量出来的** —— 静态读代码看不出
   > 「浏览器的这个 setter 会连带清掉那个对象」。以后再遇到「真机上某一步点了没反应、
   > 日志里连异常都没有」，**先接 DevTools 上去量，别读代码猜**。
   > `_test_paging.mjs` 第 10 节把这个语义写进了假 DOM（清 value 会清空那个数组），
   > 所以这条以后会被测试挡住。
