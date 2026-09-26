/* ------------------------------------------------------------------ *
 * 安卓版的 Node 侧入口。跑在 @capawesome/capacitor-nodejs 内嵌的
 * nodejs-mobile 运行时里（Node 18），和界面之间隔着一条 JSON 消息通道。
 *
 * 这个文件干三件事：
 *   1. 把 Electron 版的「主进程」补出来 —— 创建一个 api 实例，接上桥。
 *      api.js 一行都不用改（它本来就不认识传输层）。
 *   2. **在进程内**跑观战记录。安卓上没有「把 Node 当解释器再起一份」
 *      这种机制（nodejs-mobile 的 FAQ 明确写了 child_process.spawn 不可用），
 *      所以给 api.js 注入一个假的 ChildProcess，让它以为自己起了个子进程。
 *   3. 把 console 改道到界面的日志面板 —— observer.js 里几十条日志
 *      一行不改就上了界面。
 *
 * 桌面版对应的是 electron 的 main.js；那边 12KB，这边能小很多是因为
 * 窗口、托盘、单实例、抢前台这些全都不需要。
 * ------------------------------------------------------------------ */
"use strict";

const path = require("path");
const util = require("util");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const { app, channel } = require("bridge");

/* ------------------------------------------------------------------ *
 * 0. 数据目录 —— **必须在 require api.js 之前设好**
 *
 * api.js / observer.js / proxy.js 的路径全是**模块加载期**算出来的
 * （observer.js:36-38 那种 `process.env.YRP_DATA_DIR || __dirname`）。
 * 顺序反了**不会报错**，只会静默用错目录 —— 表现是「配置填了、重启就没了」。
 * 这个坑在桌面的 PACKAGING.md 里踩过一次，这里不能再踩。
 *
 * app.datadir() = context.getFilesDir()，**和应用私有目录是同一个**
 * （已核对 src/main/java/.../Nodejs.java:97 与 Capacitor Filesystem 的
 * `"DATA" -> c.filesDir`），所以界面那边用 Filesystem 的 Directory.Data
 * 去读导出的文件读得到。
 *
 * 为什么不能用 __dirname：插件的 git 树里那份注释写得很清楚 ——
 * Node 项目目录在 **App 更新时会被整个删掉重拷**，持久数据必须放 datadir()。
 * ------------------------------------------------------------------ */
const DATA = app.datadir();
process.env.YRP_DATA_DIR = DATA;

// 导出的 txt/json/csv 落在这儿。api.js 的 export:write 会自己 mkdir。
const EXPORT_DIR = path.join(DATA, "export");

/* ------------------------------------------------------------------ *
 * 1. console 改道
 *
 * 装在任何 require 之前，reason：observer.js 是被懒加载的，但 api.js /
 * _parser.js 在加载期也可能吐日志，装晚了那几条就掉进黑洞了。
 *
 * 改道规则：
 *   - 有子进程在跑 -> 写进那个假 ChildProcess 的 stdout/stderr，
 *     由 api.js 现有的 pipe()+classify() 去分类。**不重复实现分类逻辑**，
 *     界面看到的和桌面版逐字一致。
 *   - 没在跑 -> 直接以原始日志的事件形状推给界面。
 * ------------------------------------------------------------------ */
const realConsole = { log: console.log.bind(console), error: console.error.bind(console) };

let active = null; // { stdout, stderr } —— 当前那个假子进程的两根管子

function post(ev) {
  try {
    channel.post("event", ev);
  } catch (e) {
    // 界面还没订阅 / 桥断了。这时候只能写回真正的 stdout，别让它静默消失。
    realConsole.error("[yrp] 推事件失败：", e && e.message);
  }
}

function redirect(which) {
  return (...args) => {
    // util.format 就是 console.log 本来的实现，用它才不会把 %s / 对象
    // 打成一团 [object Object]
    const line = util.format(...args);
    if (active && active[which]) active[which].write(line + "\n");
    else post({ t: "log", kind: which === "stderr" ? "warn" : "raw", text: line, mode: null });
  };
}
console.log = redirect("stdout");
console.info = redirect("stdout");
console.debug = redirect("stdout");
console.warn = redirect("stderr");
console.error = redirect("stderr");

/* ------------------------------------------------------------------ *
 * 2. 假 ChildProcess
 *
 * 形状必须**恰好**是 api.js 用到的那几样，不多不少：
 *   stdout / stderr   带 setEncoding() 的可读流，api.js 会挂 'data'
 *   on('error'|'exit')  失败与结束
 *   kill()            停止
 *
 * stdout/stderr 用 PassThrough 而不是 EventEmitter：api.js 是
 * 「先 spawn，返回之后再 pipe()」，中间那点时间差里吐出来的日志，
 * PassThrough 会**缓冲**到 'data' 挂上为止，EventEmitter 会丢。
 * observer.js 一上来就是「连 xxx —— 房间 yyy」，丢了这句用户就以为没反应。
 * ------------------------------------------------------------------ */
function spawnInProcess(command, args, options) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  // 读 api.js 的**调用契约**（不是猜）：args[0] 是要跑的脚本绝对路径，
  // '--dump' 在 args 里，录像目录在 env 里。
  const script = path.basename((args && args[0]) || "");
  const env = (options && options.env) || process.env;
  const outDir = env.YRP_REPLAYS_DIR || path.join(DATA, "replays");
  const dump = !!(args && args.includes("--dump"));

  let exited = false;
  const emitExit = (code) => {
    if (exited) return;
    exited = true;
    child.emit("exit", code, null);
  };
  const die = (msg) => {
    child.emit("error", new Error(msg));
    emitExit(1);
  };

  // 代理模式在安卓上不成立：它要求**手机自己跑着 ygopro 客户端并指向
  // 127.0.0.1**，这套在手机上闭环不了（界面上那一页签也是藏着的）。
  // 更要紧的是 proxy.js 端口被占用时会直接 process.exit(1) ——
  // 进程内跑会把**整个 App 的 Node 运行时**带走，界面跟着一起死。
  //
  // 按真进程失败的样子收场（先 error 再 exit），api.js 的 procs 表
  // 才能自己清干净；只发 error 不发 exit 的话界面会永远显示「运行中」。
  if (script !== "observer.js") {
    setImmediate(() => die(`安卓版只支持观战记录，不支持 ${script || "这个模式"}`));
    return child;
  }

  let Observer, loadConfig, openDump;
  try {
    // 必须在 DATA 设好之后 require —— observer.js:36-38 是加载期求值的
    ({ Observer, loadConfig } = require("./proxy/observer.js"));
    if (dump) ({ openDump } = require("./proxy/proxy.js"));
  } catch (e) {
    setImmediate(() => die(`加载观战模块失败：${e.message}`));
    return child;
  }

  const cfg = loadConfig();
  if (!cfg) {
    // api.js 在 spawn 之前已经把配置写盘并回读验证过了，所以走到这儿
    // 基本只剩「文件被别的东西改坏了」。报出来，别让用户等 20 秒的提示。
    setImmediate(() => die("配置读不出来（observer.json 坏了或者不在）"));
    return child;
  }

  const ob = new Observer(cfg, { dump, outDir });
  active = { stdout: child.stdout, stderr: child.stderr };
  if (dump && openDump) openDump();

  // kill() == observer.js:285-289 的 stop()，逐字一致：
  // 连着就往 socket 上捅一刀（'close' 会走到 finish()），
  // 没连上就直接 finish()。
  child.kill = () => {
    if (exited) return;
    try {
      if (ob.sock) ob.sock.destroy();
      else ob.finish();
    } catch (e) {
      post({ t: "log", kind: "warn", mode: "observer", text: `停止时出错：${e.message}` });
      emitExit(1);
    }
  };

  ob.run().then(
    () => {
      // 先清 active 再 emitExit：finish() 里最后那几条日志要进面板，
      // 而 emitExit 之后 api.js 就认为这个模式没在跑了。
      active = null;
      post({ t: "log", kind: "info", mode: "observer", text: "观战结束。" });
      emitExit(0);
    },
    (e) => {
      active = null;
      child.stderr.write(`观战异常退出：${(e && e.message) || e}\n`);
      // stderr 是异步的，等一个 tick 再发 exit，让最后那行日志先出去
      setImmediate(() => emitExit(1));
    }
  );

  return child;
}

/* ------------------------------------------------------------------ *
 * 3. 接上桥
 * ------------------------------------------------------------------ */
// require 顺序：YRP_DATA_DIR 已在上面设好 ✓
const { createApi } = require("./proxy/api.js");

const api = createApi({
  spawn: spawnInProcess,
  // 导出的落点固定在应用私有的 export/ 下。安卓的 scoped storage 不允许
  // 「选一个任意目录写」，桌面那套「录像目录可指向任意盘符」的模型在
  // 这边不成立（界面上对应的按钮也藏了）。
  defaultExportDir: () => EXPORT_DIR,
  // pickDir / openFile / clipboard 都不注入：
  //   前两个界面层压根不提供入口（见 yrp-shim.js 的 HIDE_IDS），
  //   clipboard 和 openFile 由垫片在**原生侧**就地实现 ——
  //   Node 运行时碰不到系统剪贴板和分享面板。
});

// 日志/进程状态：一发一收，形状和桌面版完全一致
api.subscribe((ev) => post(ev));

channel.on("invoke", (req) => {
  const { id, ch, args } = req || {};
  Promise.resolve()
    .then(() => {
      const h = api.handlers[ch];
      // api.js 的约定是「失败就 throw」，抛出来的错误可能带 payload
      // （有些失败结果里有 trimmed/running 这类界面要用的字段，不能简化掉）
      if (!h) {
        const e = new Error(`没有这个通道：${ch}`);
        e.payload = { ok: false, error: `没有这个通道：${ch}` };
        throw e;
      }
      return h(args || {});
    })
    .then(
      (result) => channel.post("reply", { id, result }),
      (err) => {
        const result =
          (err && err.payload) || { ok: false, error: (err && err.message) || String(err) };
        channel.post("reply", { id, result });
      }
    );
});

/* ------------------------------------------------------------------ *
 * 4. 切后台
 *
 * 观战是**长时间挂机长连**，最怕录到一半 App 一进后台就被冻结。
 *
 * 插件把 Node 跑在后台线程上（不阻塞 UI），但那一线程不是前台服务；
 * App 进后台时插件会发一个 pause 消息给 Node 侧（Nodejs.java:113），
 * Node 那边收到 pauseLock 就准备把事件循环停下来 —— **只要还有锁没释放
 * 就不会停**（nodejs-mobile 的 app 模块语义）。
 *
 * 所以：录制中**故意不释放**锁；没在录就正常释放，别白耗电。
 * 这只是第一层防护，而且**扛不住系统的 cached-app freezer** ——
 * 真正管用的是阶段 4 那个前台服务（常驻通知），两样一起上。
 * ------------------------------------------------------------------ */
app.on("pause", (pauseLock) => {
  const recording = api.running().observer;
  if (!recording) {
    try {
      pauseLock.release();
    } catch (_) {}
  }
  // 录制中：**故意不 release**，让事件循环继续跑
});
app.on("resume", () => {
  post({ t: "log", kind: "info", mode: null, text: "回到前台。" });
});

/* ------------------------------------------------------------------ *
 * 5. 收尾
 * ------------------------------------------------------------------ */
// 任何未捕获的异常都要让用户看见 —— 安卓上没有黑窗口，不推给界面就彻底消失了。
//
// **同时**还得往真 stdout 写一份：注册了监听器之后 Node 就不会因为未捕获异常
// 退出了，如果只 post 不打印，出错时 `adb logcat` 里一片安静，而界面面板
// 可能还没订阅上（比如异常发生在界面加载之前）—— 那就是彻底查不出来。
// 两条路都写，多花一行，换的是「真出事时看得见」。
const reportFatal = (label) => (e) => {
  const detail = (e && e.stack) || (e && e.message) || e;
  realConsole.error(`[yrp] ${label}：`, detail);
  post({ t: "log", kind: "warn", mode: null, text: `${label}：${detail}` });
};
process.on("uncaughtException", reportFatal("内部错误"));
process.on("unhandledRejection", reportFatal("未处理的失败"));

realConsole.log(`[yrp] Node 侧已就绪，数据目录：${DATA}（Node ${process.version}）`);

/* 导出来只为了测试（tests/_test_android_backend.mjs）：插件把本文件当主脚本
 * 跑，导出与否不影响它；但有了这个，整套安卓侧的逻辑——假子进程、桥的
 * 请求/回复配对、YRP_DATA_DIR 的顺序——都能在**普通的 node 里**跑一遍，
 * 不需要手机。这是这条路线唯一能在本地证明「不是只有编译过了」的办法。 */
module.exports = { api, spawnInProcess, DATA, EXPORT_DIR };
