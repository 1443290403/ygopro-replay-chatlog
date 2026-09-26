/* ------------------------------------------------------------------ *
 * window.yrp 的安卓实现 —— 界面和 Node 运行时之间那道桥。
 *
 * 桌面上这个对象是 preload.js 用 contextBridge 开出来的，底下接着 ipcMain；
 * 安卓上没有 Electron，接的是 @capawesome/capacitor-nodejs 的消息通道。
 * **两个实现的对外契约完全一样**：
 *     invoke(ch, args) -> Promise        问一次，拿回结果
 *     on(ch, fn)       -> () => void     订阅事件，同步返回取消函数
 * 所以 gui.html 一个字都不用改（它只用这两个方法，见 gui.html:394 和 455）。
 *
 * 这个文件**只在安卓版存在**。所有安卓特有的差异都收在这里，绝不写进共享的
 * gui.html —— 那样连桌面版一起改了。差异有三类：
 *   1. 按钮的可见性（安卓干不了的事，把按钮藏掉而不是让用户点了没反应）
 *   2. 需要安卓原生 API 的通道（剪贴板、分享），在本地就地实现，不下发到 Node
 *   3. WebView 的文件选择器怪癖（accept 里的未知扩展名会让它什么都选不了）
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  const Cap = window.Capacitor;
  const Plugins = (Cap && Cap.Plugins) || {};
  const Nodejs = Plugins.Nodejs;

  /* ------------------------------------------------------------------ *
   * 1. 桥本身
   * ------------------------------------------------------------------ */

  let nextId = 0;
  const pending = new Map(); // id -> { resolve, 超时句柄 }
  const listeners = new Map(); // 通道名 -> Set<回调>

  // 「Node 侧多久不回就当它死了」。给得宽是因为 recording:parse 解析大录像
  // 可能要几秒；但也不能不给 —— 没有它的话 Node 一崩，界面就永远转圈。
  const REPLY_TIMEOUT_MS = 60000;

  function emit(ch, payload) {
    const set = listeners.get(ch);
    if (!set) return;
    // 复制一份再遍历：回调里取消订阅是合法操作，直接遍历原集合会漏掉后面的
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (e) {
        console.error("[yrp-shim] 订阅者抛异常了：", e);
      }
    }
  }

  function onMessage(ev) {
    const name = ev && ev.eventName;
    const a = (ev && ev.args) || [];
    if (name === "reply") {
      const r = a[0] || {};
      const slot = pending.get(r.id);
      if (!slot) return; // 超时后被丢弃的迟到回复，正常
      pending.delete(r.id);
      clearTimeout(slot.timer);
      return slot.resolve(r.result);
    }
    if (name === "event") {
      // Node 侧推上来的日志/进程状态。形状和桌面版**完全一致**，
      // gui.html 的 pushLog / setRunning 零改动。
      const ev = a[0];
      // 前台服务跟着同一个事件走（定义在第 2.5 节，函数声明会提升）
      syncKeepAlive(ev);
      return emit("yrp:event", ev);
    }
    console.warn("[yrp-shim] 不认识的通道：", name);
  }

  /* 两件事必须在**任何 invoke 之前**做完：
   *   1. 挂上消息监听 —— 否则第一条回复会在没人听的时候到达然后永久丢失。
   *   2. 等 Node 运行时真的 ready —— 插件文档写明 send 在 ready 之前不可用。
   *      少了这道门，界面启动那几秒点的按钮会一路失败到 60 秒超时才报错。
   *
   * ⚠️ 监听器**只在模块加载时挂一次**，不放进下面那个可重试的 ensureReady 里。
   * 原来两者是绑在一起的，于是「重试」这个动作会把 onMessage 挂成两份 ——
   * 表现是每条日志在界面上出现两次、每个事件被分发两次。
   * 现在 ready 可以重试，而重试不会碰监听器。 */
  const listening = Nodejs
    ? Promise.resolve(Nodejs.addListener("message", onMessage)).catch((e) => {
        console.error("[yrp-shim] 挂消息监听失败：", (e && e.message) || e);
      })
    : Promise.resolve();

  /* 60 秒。原来给的是 20 秒，太紧 —— 安卓冷启动要加载 54 MB 的 libnode.so，
   * 慢设备上真能超过 20 秒。而这个数只影响「多久之后报错」，不影响成功的速度。 */
  const READY_TIMEOUT_MS = 60000;

  /* **轮询** isReady()，不是监听 "ready" 事件。监听有个躲不掉的时序问题：
   * Node 完全可能在我们挂上监听**之前**就已经 ready 了，那个事件永远等不到，
   * 于是白等满 60 秒然后失败。轮询没这个问题，重试时也不会越堆越多监听器。
   * 「ready」的定义很宽松：Node 侧一旦 require('bridge') 就算 ready（见插件 README）。 */
  async function probeReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const r = await Nodejs.isReady();
        if (r && r.ready) return true;
      } catch (_) {
        /* 插件自己还没起来时 isReady() 本身就可能失败，算「还没好」继续等 */
      }
      if (Date.now() >= deadline) return false;
      // unref 在浏览器里不存在（用 ?. 挡掉），但测试是在 node 里跑这个文件的，
      // 少了它这些定时器会把测试进程硬吊住
      await new Promise((r) => setTimeout(r, 300).unref?.());
    }
  }

  let ready = null;
  function ensureReady() {
    if (ready) return ready;
    if (!Nodejs) return Promise.reject(new Error("Node 运行时插件不可用"));
    ready = listening.then(() => probeReady(READY_TIMEOUT_MS)).then((up) => {
      if (up) return;
      /* ⚠️ **失败不留缓存。** 留了的话一次超时就把整个会话判了死刑：
       * 此后每一次 invoke 都直接失败，哪怕 Node 下一秒就起来了。
       * 界面上「配置读不出来、三个输入框全是空的」就是这么来的 ——
       * 第一次 invoke 恰好就是 config:get，于是整个界面看着是好的、其实全瘫。
       * 置空之后下一次调用会重新探一遍，Node 晚到几分钟也还救得回来。 */
      ready = null;
      throw new Error(`Node 运行时 ${READY_TIMEOUT_MS / 1000} 秒都没起来`);
    });
    return ready;
  }
  ensureReady().catch((e) => {
    console.error("[yrp-shim] 桥初始化失败：", e && e.message);
  });

  const localHandlers = {}; // 下面第 2 节填

  /* 两个入口，必须分开：
   *
   *   invokeNode —— **无条件**发给 Node 侧。
   *   invoke     —— 先看本地有没有实现，没有才发给 Node。
   *
   * 本地处理器内部必须用 invokeNode。踩过的坑：app:quit 的本地实现要
   * 「先让 Node 侧收摊，再退 App」，写成 `invoke("app:quit")` 的话——因为
   * localHandlers 里正好也有 app:quit ——就变成自己调自己，无限递归。
   * 表现是点「退出」整个 WebView 卡死然后 OOM 崩掉，而不是退出去。 */
  function invokeNode(ch, args) {
    if (!Nodejs) {
      return Promise.resolve({ ok: false, error: "Node 运行时还没起来（Capacitor 插件没装或没启动）" });
    }
    // 第二个参数是「桥没起来」的兜底：ensureReady() 会 reject，
    // 不接住的话 gui.html 那边看到的是 unhandled rejection，界面上什么都不显示。
    return ensureReady().then(
      () =>
        new Promise((resolve) => {
          const id = ++nextId;
          const timer = setTimeout(() => {
            if (pending.delete(id)) {
              resolve({ ok: false, error: `Node 侧 ${REPLY_TIMEOUT_MS / 1000} 秒没有响应` });
            }
          }, REPLY_TIMEOUT_MS);
          pending.set(id, { resolve, timer });
          Nodejs.send({ eventName: "invoke", args: [{ id, ch, args: args || {} }] }).catch((e) => {
            if (pending.delete(id)) {
              clearTimeout(timer);
              resolve({ ok: false, error: "发给 Node 侧失败：" + ((e && e.message) || e) });
            }
          });
        })
    );
  }

  // 本地优先。本地处理器抛异常 -> 变成一条能看懂的失败，别让界面挂住。
  function invoke(ch, args) {
    if (localHandlers[ch]) {
      return Promise.resolve()
        .then(() => localHandlers[ch](args || {}))
        .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    }
    return invokeNode(ch, args);
  }

  function on(ch, fn) {
    if (!listeners.has(ch)) listeners.set(ch, new Set());
    listeners.get(ch).add(fn);
    // **必须同步返回**：gui.html:455 是 `offEvents = window.yrp.on(...)`，
    // 然后在 connect() 里 `if (offEvents) offEvents()`。返回 Promise 会在
    // reload 时抛 "offEvents is not a function"。
    return () => {
      const set = listeners.get(ch);
      if (set) set.delete(fn);
    };
  }

  window.yrp = { invoke, on };

  /* ------------------------------------------------------------------ *
   * 2. 就地实现的通道（不进 Node）
   *
   * 这些要在安卓原生侧完成，Node 运行时碰不到系统剪贴板和分享面板。
   * 形状必须和 api.js 里对应 handler 的返回一致（成功 {ok:true,...}，
   * 失败 {ok:false,error:...}）—— gui.html 是 `if (!r.ok) return banner(r.error)`。
   * ------------------------------------------------------------------ */

  localHandlers["clipboard:write"] = async ({ text }) => {
    const C = Plugins.Clipboard;
    if (C) {
      await C.write({ string: String(text == null ? "" : text) });
      return { ok: true };
    }
    // 退路：WebView 里的 navigator.clipboard 只在安全上下文可用，
    // Capacitor 默认是 https://localhost 所以通常能成，但不保证。
    await navigator.clipboard.writeText(String(text == null ? "" : text));
    return { ok: true };
  };

  /* 桌面上 shell:openFile 是「用默认程序打开刚写的那个文件」。
   * 安卓上没法「用默认程序打开」自己沙箱里的文件，正解是**交给系统分享面板**
   * —— 用户在面板里选「保存到文件」或发给别人。这是把文件带出沙箱的唯一正路。 */
  localHandlers["shell:openFile"] = async ({ name }) => {
    const FS = Plugins.Filesystem;
    const Share = Plugins.Share;
    if (!FS || !Share) return { ok: false, error: "这个设备不支持分享" };
    const safe = String(name || "").replace(/[\\/]/g, "");
    if (!safe) return { ok: false, error: "文件名是空的" };
    const { uri } = await FS.getUri({ path: `export/${safe}`, directory: "DATA" });
    await Share.share({ title: safe, files: [uri] });
    return { ok: true };
  };

  /* explorer.exe + PowerShell + user32.dll 那套抢前台的逻辑是 Win32 专有的，
   * 安卓没有对应物，也不该假装有。按钮在第 3 节里被藏掉了，这里只是兜底。 */
  localHandlers["shell:reveal"] = async () => ({
    ok: false,
    error: "安卓版没有「打开文件夹」这个功能，用导出后的分享按钮把文件发出去吧",
  });

  /* app:quit：先让 Node 侧把观战停干净，再退整个 App。
   * 不能反过来 —— 先退 App 的话观察者的 TCP 连接会由系统硬断，
   * 录像最后那个包可能没落盘。
   *
   * 必须用 invokeNode 而不是 invoke：本处理器自己就注册在 app:quit 上，
   * 用 invoke 会递归调用自己（见 invokeNode 上面的注释）。 */
  localHandlers["app:quit"] = async () => {
    let stopped = [];
    try {
      const r = await invokeNode("app:quit");
      stopped = (r && r.stopped) || [];
    } catch (_) {
      /* Node 侧已经死了也得让用户退得掉，不能卡在这儿 */
    }
    /* 显式收掉前台服务。观战在跑的话上面那条 app:quit 会带回一个
     * running:false 的 proc 事件、syncKeepAlive 已经收过一次了；但**没在录**
     * 的时候不会有那个事件，服务还挂着 —— 不退掉的话用户会看到一个
     * 「正在录制观战」的通知而 App 已经关了。stopService 重复调是安全的。 */
    await stopKeepAlive();
    const App = Plugins.App;
    if (App && App.exitApp) setTimeout(() => App.exitApp(), 150);
    return { ok: true, stopped };
  };

  /* ------------------------------------------------------------------ *
   * 2.5 前台服务 —— 观战期间的常驻通知
   *
   * 插件把 Node 跑在**后台线程**上，那只是线程，不是前台服务：息屏或切后台
   * 之后系统照样会冻结甚至杀掉它。而观战是长时间挂机的长连接，被杀的表现是
   * 「录到一半录像断了，而且没有任何提示」—— 最难查的那种坏法。
   *
   * 起停**完全由 proc 事件驱动**（见下面 onMessage 里的 syncKeepAlive），
   * 不在这里另外记一套「我觉得在不在录」。理由是那样两边迟早会飘：
   * 比如 Node 侧自己因为看门狗退出了，界面上的按钮状态和通知就会各说各话。
   * 现在唯一的真相是 api.js 发出来的 proc 事件，通知和界面都跟着它走。
   * ------------------------------------------------------------------ */

  const FGS = Plugins.ForegroundService;

  /* FOREGROUND_SERVICE_TYPE_SPECIAL_USE。
   * 插件的 TS 枚举里**没有**这个值（只有 Location=8 和 Microphone=128），
   * 但 serviceType 在 Java 侧就是一路裸 int 传到 startForeground 的
   * （ForegroundService.java:87 塞进 Bundle → AndroidForegroundService.java:73
   * 取出来直接用），所以绕过枚举直接给数字是可行的，不是歪门邪道。
   *
   * 为什么不用 dataSync(=1)：Android 15 起 dataSync 被限制成 24 小时内最多累计
   * 6 小时，到点系统直接停服务。观战就是长时间挂机，撞这个上限是必然的。 */
  const FGS_TYPE_SPECIAL_USE = 1073741824;

  const FGS_ID = 1;
  /* ⚠️ 频道 id **不能**继续用 "yrp_observer" —— Android 规定通知频道的
   * importance 一旦建好就改不了：createNotificationChannel 只会更新名字和
   * 描述，重要性原样保留（插件源码自己也标了：ForegroundService.java:142）。
   * 所以从 Low 提到 High 必须换一个新 id，不然**已经装过 App 的机器上什么
   * 都不会变**，而且看不出任何异常。
   *
   * 代价是系统设置里会留一个废弃的旧频道，可以接受 —— 比让人卸载重装好得多
   * （卸载会连录像一起删掉，见 README §4）。 */
  const FGS_CHANNEL = "yrp_observer_v2";

  let fgsWanted = false; // 逻辑上「现在该不该有这个服务」
  let fgsUp = false; // 实际上起起来了没有

  async function ensureFgsChannel() {
    try {
      await FGS.createNotificationChannel({
        id: FGS_CHANNEL,
        name: "观战录制",
        description: "录制观战期间显示的常驻通知",
        /* Importance.High（4），**不是 Low** —— 用户真机实测后改的。
         * 原来写 Low 的理由是「常驻通知只是告诉你还在录，不该打扰人」，
         * 但那个理由在实际机型上破产了：Low + 下面那个 silent 会被系统归进
         * 「静默通知」，状态栏根本不显示，而且**全程没有任何报错**。
         * 录制中看不到「正在录」比多响一声糟糕得多，所以宁可要悬浮横幅。
         * Low/Default 都出不来悬浮，拿到它**必须**是 High。 */
        importance: 4,
      });
    } catch (e) {
      // 频道已存在会走这里。不影响后面 startForegroundService。
      console.warn("[yrp-shim] 建通知频道没成功（通常是在重复建）：", (e && e.message) || e);
    }
  }

  async function startKeepAlive() {
    if (!FGS) return; // 桌面 / 测试环境没这个插件，静默跳过
    fgsWanted = true;
    if (fgsUp) return; // 已经在录了（比如换了一局），不用重起
    try {
      /* Android 13+ 通知要运行时授权。**被拒也不阻断** —— 服务照样能起，
       * 只是状态栏看不到那条通知。录像本身比那条通知重要得多，不能因为
       * 用户点了个「不允许」就录不了。 */
      const perm = await FGS.checkPermissions().catch(() => null);
      if (perm && perm.display === "prompt") {
        await FGS.requestPermissions().catch(() => {});
      }
      await ensureFgsChannel();
      await FGS.startForegroundService({
        id: FGS_ID,
        title: "正在录制观战",
        body: "保持连接中，关掉这个 App 会中断录像",
        smallIcon: "ic_stat_yrp",
        /* 显式 false（也是插件的默认值）。这个选项名字骗人：它映射的是
         * `setOnlyAlertOnce`（AndroidForegroundService.java:53），true 会让
         * 这条通知**只在第一次出现时提醒**。单独看没什么，和 Low 叠在一起
         * 就是用户报的「静默通知、状态栏里没有」。 */
        silent: false,
        notificationChannelId: FGS_CHANNEL,
        serviceType: FGS_TYPE_SPECIAL_USE,
      });
      fgsUp = true;
    } catch (e) {
      // 前台服务起不来**不是**致命错误（观战还在跑，只是可能被系统冻住），
      // 所以只记一笔，不往上抛 —— 抛出去会变成界面上一句莫名其妙的报错。
      console.warn("[yrp-shim] 前台服务没起来：", (e && e.message) || e);
    }
    // 起的过程中用户可能已经点了停止，补一刀
    if (!fgsWanted && fgsUp) stopKeepAlive();
  }

  async function stopKeepAlive() {
    fgsWanted = false;
    if (!FGS || !fgsUp) return;
    fgsUp = false;
    try {
      await FGS.stopForegroundService();
    } catch (e) {
      console.warn("[yrp-shim] 前台服务没收干净：", (e && e.message) || e);
    }
  }

  /* proc 事件 -> 通知。**不 await**：emit 是同步的，gui.html 的界面更新
   * 不该等一次插件往返（安卓上那是几十毫秒级的）。 */
  function syncKeepAlive(ev) {
    if (!ev || ev.t !== "proc" || ev.mode !== "observer") return;
    if (ev.running) startKeepAlive();
    else stopKeepAlive();
  }

  /* ------------------------------------------------------------------ *
   * 3. WebView 里的界面适配
   *
   * 全部是「藏起来」而不是「删掉」：元素还在，gui.html 的 JS 照常给它们挂事件、
   * 读它们的值，不会因为 $() 返回 null 而抛异常（那会导致整个界面零日志）。
   * ------------------------------------------------------------------ */

  const HIDE_IDS = [
    "reveal", // 打开录像文件夹 —— Win32 专有
    "rec-dir", // 改录像目录 —— 安卓不允许任意路径
    "rec-reset", // 恢复默认录像目录
    "rec-target", // 「录像存到：/data/user/0/...」（见下面 adjustDom 里的说明）
    "exp-dir", // 选导出目录 —— 安卓 WebView 没有 showDirectoryPicker
    "pick-dir", // 选文件夹 —— <input webkitdirectory> 在安卓 WebView 里不工作
  ];

  function adjustDom() {
    for (const id of HIDE_IDS) {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
      // 元素不见了只说明 gui.html 改了 id（藏不掉而已，不是功能坏了），
      // 不值得报错打断用户，但要让 _test_shim.mjs 能发现 —— 那份测试盯着这些 id。
      //
      // rec-target 为什么也藏：它显示的是录像**输出目录**，安卓上是
      // /data/user/0/local.yrp.tools/files/replays —— 用户既看不懂，也没有任何
      // 办法改（「更改…」和「恢复默认」就在上面被藏了）。而且那个目录是 App
      // 自己的 files 目录，**永远可写**，所以行尾那个「⚠️ 写不进去」在安卓上
      // 是死代码，不会出现。注意**不能**改它的文案：gui.html 的
      // updateRecTarget() 在每次 refreshRecDir() 之后都会把它覆盖回去。
    }

    /* accept=".yrp3d,.yrp" 在安卓上会**把文件选择器变成什么都不显示**：
     * 系统不知道 .yrp3d 是什么 MIME，于是按扩展名过滤时一个文件都匹配不上。
     * 去掉 accept 让它退化成「所有文件」，用户自己挑。 */
    const fi = document.getElementById("file-input");
    if (fi) fi.removeAttribute("accept");

    const tgt = document.getElementById("exp-target");
    if (tgt) tgt.textContent = "导出到：应用内部，导出后点「分享」发出去";

    /* 安卓 WebView 没有拖放。原文案是「把 .yrp3d 文件或整个文件夹**拖到这里**
       —— 也可以 [选择文件…]」，用户看着那片虚线框就会去点它，而它自己不响应点击。
       实测反馈就是这么来的：「手机端没有拖动文件上传功能，只需要点击上传即可」。

       做法是把原有的按钮节点**搬过来**（replaceChildren 移动的是同一个节点对象，
       不是克隆）—— gui.html 已经绑在 #pick-files / #pick-clear-local 上的处理器
       原样保留。#pick-clear-local 必须留着：它在选了文件之后才显示，是清空
       本机文件的唯一入口。#pick-dir 不带上，它本来就被上面藏了。 */
    const drop = document.getElementById("drop");
    if (drop) {
      /* ⚠️ 重画 #drop 的内容时，**凡是带 id 的元素一个都不能漏**。
       *
       * 原来写的是
       *     drop.replaceChildren(hint, pick-files, pick-clear-local)
       * 漏了 #pick-dir，于是它被 replaceChildren 摘出了文档。
       *
       * 注意这和上面 HIDE_IDS 是两种不同的机制：那边只设
       * style.display="none"，元素还在文档里，gui.html 照样 $() 得到它；
       * 这边是**从 DOM 里删掉**，$() 返回 null，下一行的 `.onclick =`
       * 就是 TypeError。
       *
       * 目前没炸纯属侥幸：gui.html 的内联脚本在**解析时**就跑完了，
       * 而 adjustDom 挂在 DOMContentLoaded 上、跑得更晚，所以
       * `$("pick-dir").onclick = ...` 读到的是真元素。但这是时序巧合 ——
       * 以后谁在 DOMContentLoaded 之后读一次 $("pick-dir") 就会炸，
       * 而它和 init() 在同一个 <script> 里，一抛后面全不执行。
       *
       * 所以规则写成「先捞出所有带 id 的子元素，一个不落地放回去」，
       * 而不是手写清单 —— 手写清单就会像刚才那样漏。顺带这也删掉了
       * 原来的提示文字和里面的 <b>.yrp3d</b>（它们没有 id，是纯装饰）。 */
      const keep = Array.from(drop.children).filter((el) => el.id);
      const hint = document.createElement("div");
      hint.textContent = "点这里选择 .yrp3d 录像（可多选）";
      drop.replaceChildren(hint, ...keep);
      // 整块都能点，不只是那个小按钮。
      // 点在内部按钮上时让按钮自己处理 —— 不拦的话会弹两次选择器
      // （#pick-files 的 handler 干的就是 file-input.click()）。
      drop.addEventListener("click", (e) => {
        if (e.target && e.target.closest && e.target.closest("button")) return;
        const f = document.getElementById("file-input");
        if (f) f.click();
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", adjustDom);
  } else {
    adjustDom();
  }

  console.log("[yrp-shim] 已就绪（安卓桥）");
})();
