#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * 对话记录 —— 界面后端（**不认识传输层**）
 *
 * 这里装的是「界面要干的事」本身：读配置、写配置、起停录制子进程、解析录像、
 * 提录像文件夹、退出时收摊。调用方拿到一张 `handlers` 表，通道名进、结果出。
 *
 * 为什么和 main.js 拆开：这里一行 Electron 都没有，所以**整套逻辑只要
 * `node xxx.mjs` 就能测，不需要装 Electron**（见 _test_api.mjs）。系统能力
 * 全部靠注入，测试传假实现就能把导出目录、剪贴板这些通道走一遍。
 * 反过来说，凡是需要 `require("electron")` 的东西都只能待在 main.js 里。
 *
 * 硬约束：本文件**不许出现 `require("electron")`**。凡是需要系统能力的
 * （弹目录、写剪贴板、用默认程序打开文件）一律由创建者**注入**。
 *
 * `createApi(opts)` 收这些：
 *   childEnv         额外的子进程环境变量（Electron 用它塞 ELECTRON_RUN_AS_NODE）
 *   pickDir          弹目录选择框，返回目录或 null（取消）
 *   defaultExportDir 没选过目录时的落点（Electron 给「下载」文件夹）
 *   openFile         用系统默认程序打开一个**绝对路径**（路径由本文件拼）
 *   clipboard        写系统剪贴板
 *   spawn            起子进程用的函数，签名同 child_process.spawn
 *                    （安卓上注入一个「假 ChildProcess」在进程内跑 Observer）
 * 全都不给也能用 —— 相关的通道会给出可读的报错，其他功能不受影响。
 *
 * 约定：handler 成功时返回成功形状，失败时 **throw**。
 * 抛出来的错误带两个可选字段：
 *   e.status  —— 给 HTTP 适配层用的状态码（400 / 500），IPC 侧忽略
 *   e.payload —— 要原样发回去的完整响应体（有些失败结果里带 trimmed/running
 *                这类界面要用的字段，不能简化成一句 error）
 * ------------------------------------------------------------------ */
"use strict";

const fs = require("fs");
const path = require("path");
const { loadExtractor, parserSource, browserSource, BROWSER_NAMES } = require("../_parser.js");

/* 起子进程的能力**默认**来自 child_process，但在安卓上必须由调用方注入：
 * nodejs-mobile 里没有「把 Node 当解释器再起一份」这套机制，
 * `require("child_process")` 在那儿可能直接抛（官方 FAQ：spawn 不可用）。
 *
 * 所以这里 try/catch 而不是直接解构 —— 直接解构的话这个文件在安卓上
 * **加载期**就炸了，连配置都读不了。捕获失败时 spawn 为 null，
 * 下面 createApi 里会退到注入的实现；没人注入才报错。
 *
 * 桌面端行为完全不变：require 照样成功，spawn 就是原来那个函数。 */
let nodeSpawn = null;
try {
  ({ spawn: nodeSpawn } = require("child_process"));
} catch (_) {
  /* 安卓：没有子进程，靠 opts.spawn */
}

const HERE = __dirname;
// 两个**不同**的概念，别混：
//   DATA  —— 程序自己的东西：config.json / observer.json / settings.json。
//            跟着「程序装在哪」走，固定不动（见 main.js 顶部）。
//   OUTDIR —— 用户的录像。默认在 DATA\replays 下，但**可以被界面改到任意位置**
//            （选完存进 settings.json），所以装到哪儿都不影响录像。
// 和 proxy.js / observer.js 用同一个环境变量，保证界面看到的录像目录
// 就是子进程真正在写的那个（测试时指向临时目录）。
// ⚠️ DATA 这一行是**加载期**求值的 —— 调用方必须在 require 本文件**之前**
// 把 YRP_DATA_DIR 设好，否则会静默用错目录（见 main.js 顶部那条注释）。
const DATA = process.env.YRP_DATA_DIR || HERE;
const DEFAULT_OUTDIR = path.join(DATA, "replays");
const SETTINGS = path.join(DATA, "settings.json");
const PROXY_CFG = path.join(DATA, "config.json");
const OBS_CFG = path.join(DATA, "observer.json");

// 子进程日志最多留这么多条，界面重载时补发
const RING = 2000;

/* ---------------- 导入本机录像的上限 ----------------
   界面导入的 .yrp3d 要往录像目录里存一份，字节得 base64 编好从渲染进程送过来
   （安卓那条桥只能过 JSON，主分支那条是 JSON 请求体，两边都走不了二进制）。
   这里是**宿主侧的真正闸门**，界面里那份同名常量只是为了提前给出友好提示。
   实测用户真实录像只有 101 ~ 2591 字节，这三个数留了三个数量级余量。 */
const IMPORT_MAX_BYTES = 8 * 1024 * 1024;
const IMPORT_MAX_FILES = 50;
const IMPORT_MAX_TOTAL = 16 * 1024 * 1024;

// 默认值必须和 proxy.js / observer.js 里的 DEFAULTS 一致，否则界面显示的
// 是一套、子进程实际跑的是另一套。**这三份没有共同的来源，只能靠人盯着** ——
// 改了 `proxy.js` 的 DEFAULT_HOST / DEFAULT_PORT 就要回来同步这两份
// （`_test_api.mjs` 有一条断言比对它们，漏改会红）。
const DEFAULTS = {
  proxy: { remoteHost: "mygo.superpre.pro", remotePort: 888, listenPort: 888, recordOwnChat: false },
  observer: {
    host: "mygo2.superpre.pro",
    port: 888,
    room: "",
    name: "观战记录",
    version: require("./proxy.js").WIRE.PRO_VERSION,
  },
};

// 失败。status 给 HTTP 适配层，payload 是要原样发回去的响应体。
function fail(status, payload) {
  const e = new Error((payload && payload.error) || "出错了");
  e.status = status;
  e.payload = payload;
  return e;
}

/* ------------------------------------------------------------------ *
 * 配置读写
 *
 * proxy.js 的 loadConfig/saveConfig 没有导出，所以这里自己读自己写，
 * 但规则要跟着它们走：允许缺字段（用默认值补），写的时候格式化。
 * ------------------------------------------------------------------ */
function readJson(file) {
  let raw = fs.readFileSync(file, "utf8");
  // 记事本默认存 UTF-8 BOM，JSON.parse 见到 ﻿ 直接抛
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw);
}

function loadSide(mode) {
  const d = DEFAULTS[mode];
  try {
    return { ...d, ...readJson(mode === "proxy" ? PROXY_CFG : OBS_CFG) };
  } catch (e) {
    // 文件**不存在** = 第一次跑，用默认值预填 —— 服务器地址本来就是填好的，
    // 界面上一片空白只会让人以为还得自己查。返回 null 的话页面就不填了，
    // 预填值等于白设。
    if (e && e.code === "ENOENT") return { ...d };
    // 文件**坏了**是另一回事：这时候悄悄塞默认值，用户会以为配置没丢。
    // 返回 null 让界面留空、重填一遍。
    return null;
  }
}

// 原子写：先写临时文件再改名。fs.writeFileSync 不是原子的，中途挂掉会留下
// 半个 JSON —— 而半个 JSON 会让子进程走 configure()，也就是僵尸那条路。
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

// 写完必须回读验证一遍。宁可在这里报错，也不要放一个读不出来的配置
// 进去让子进程静默卡死。
function saveAndVerify(mode, cfg) {
  const file = mode === "proxy" ? PROXY_CFG : OBS_CFG;
  writeJsonAtomic(file, cfg);
  const back = readJson(file);
  if (!back || typeof back !== "object") throw new Error("写进去的配置读不回来");
  return back;
}

/* ------------------------------------------------------------------ *
 * 录像目录（可改）
 *
 * 为什么录像不跟 DATA 走：打包成安装包之后 DATA 就是**安装目录**，而 NSIS
 * 升级时会先跑旧版的卸载器，那个动作是「把安装目录整个删掉」—— 实测过，
 * 放在里面的录像和配置升级一次没一次。所以录像默认落在用户目录下，
 * 并且允许改到别处（D 盘、移动硬盘、NAS）。
 * ------------------------------------------------------------------ */
function readSettings() {
  try {
    const s = readJson(SETTINGS);
    return s && typeof s === "object" ? s : {};
  } catch (_) {
    // 没有 / 坏了都当「没设过」。这里坏掉**不报错**是有意的：它只是一个
    // 路径，回落到默认目录照样能用。config.json 坏掉要报出来，是因为
    // 那里面是用户填的服务器地址，悄悄塞默认值会让他以为配置没丢。
    return {};
  }
}

// 真写一个字节再算数。只 mkdir 发现不了只读介质 —— 写保护的 U 盘、
// 已经断开的网络共享、被组策略锁住的目录，mkdir 都可能成功而写文件失败。
// 「录了一晚上才发现什么都没录上」比当场报错糟得多。
function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".yrp-write-probe");
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 录像解析
 * ------------------------------------------------------------------ */
let PARSER = null;
let parserError = null;
// 同一个哨兵块的浏览器版本，发给界面用来自解析拖进去的本地文件。
// 在模块加载时算一次：那是个三十多 KB 的读文件 + 字符串拼接，每个请求现算没必要，
// 而且失败能在启动时就暴露成 parserError，而不是等用户拖文件才发现。
let PARSER_BUNDLE = null;
try {
  PARSER = loadExtractor();
  PARSER_BUNDLE = browserSource(parserSource(), BROWSER_NAMES);
} catch (e) {
  // 解析块读不出来不该让界面起不来 —— 起不来的话用户连日志都看不到。
  // 记下来，界面上挂条横幅说明哪些功能没了。
  parserError = e.message;
}

// .yrp3d = uint8 类型 + uint32 长度 + 数据。录制中读、或者被硬杀之后，
// 尾部可能是半个包 —— 而解析器见到半截包会把**整份**判为「已损坏」，
// 对话列表直接空掉。所以先自己走一遍，停在最后一个完整包再交给它。
function trimToLastPacket(buf) {
  let o = 0;
  while (o + 5 <= buf.length) {
    const len = buf.readUInt32LE(o + 1);
    if (len > buf.length || o + 5 + len > buf.length) break;
    o += 5 + len;
  }
  return { buf: buf.subarray(0, o), trimmed: o < buf.length };
}

async function parseRecording(name, running, outdir) {
  const safe = safeName(name);
  if (!safe) return { ok: false, error: "文件名不合法。" };

  const file = path.join(outdir, safe);
  let raw;
  try {
    raw = await fs.promises.readFile(file);
  } catch (e) {
    return { ok: false, error: `读不到这个文件：${e.message}` };
  }

  const { buf, trimmed } = trimToLastPacket(raw);
  if (!PARSER) {
    return { ok: false, error: `对话解析器没加载成功：${parserError}`, trimmed, running };
  }

  let r;
  try {
    r = PARSER.extract(safe, buf);
  } catch (e) {
    return { ok: false, error: `解析出错：${e.message}`, trimmed, running };
  }
  if (!r.ok) return { ok: false, error: r.error || "解析失败", trimmed, running };

  return {
    ok: true,
    name: safe,
    // size 是磁盘上那个文件的字节数（列表里显示的也是它），parsedSize 是裁掉
    // 尾部残包之后实际解析的字节数。导出的 JSON 用 size，和 chat-extractor.html
    // 的 size 同义；parsedSize 只给界面自己提示用。
    size: raw.length,
    parsedSize: buf.length,
    packets: r.packets,
    trimmed,
    running: !!running,
    seats: r.seats || {},
    chats: r.chats || [],
  };
}

// 文件名直接用在下发的路径上，必须挡住 ..\..\config.json 这种
function safeName(name) {
  if (typeof name !== "string" || !name) return null;
  if (name.includes(":") || name.includes("/") || name.includes("\\")) return null;
  if (path.basename(name) !== name) return null;
  if (!name.endsWith(".yrp3d")) return null;
  return name;
}

/* base64 -> Buffer。**不能直接用 Buffer.from(s,"base64")** —— 它对垃圾字符是
   静默丢弃的（"QUJD!!!" 会解出 "ABC"），那样「传坏了」会变成「静默写进去一个
   半截录像」，比报错难查得多。所以先卡形状，再回算长度，对不上就当非法。

   注意 "" 必须解出 0 字节的 Buffer 并放行：proxy.js 开录像用的是
   openSync(file,"w")，磁盘上真的会有 0 字节的 .yrp3d。 */
function decodeB64(s) {
  if (typeof s !== "string" || s.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s, "base64");
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return buf.length === (s.length / 4) * 3 - pad ? buf : null;
}

/* 往录像目录写一份，**只新建、绝不覆盖**。

   "wx" 是整个功能安全性的全部：路径已经存在（用户自己录的、正在录的那一个、
   上一次导入的同一个文件）就直接 EEXIST，交给下面换个名字 —— 而不是把它截断。
   不能写成「先 existsSync 再 writeFileSync」：那两步之间有一个窗口，正好撞上录像
   子进程新建文件（proxy.js 的 uniquePath + openSync "w"）就会毁掉人家一条录像。

   后缀 _2 / _3 是照抄 proxy.js:163 的 uniquePath —— 录像目录里已经有这个约定了，
   别在这儿自创一套（` (2)` 那种）。

   mtime 保留源文件的时间：列表是按 mtime 排的，而文件名本身就写着录像时间
   （09-25「16：23：49」），按「现在」写会跟它自己的名字矛盾。安卓上从 content://
   来的 lastModified 可能是 0 或者干脆没有，所以非法值必须挡住。 */
function writeCopy(dir, name, buf, mtime) {
  const base = name.slice(0, -".yrp3d".length).replace(/_\d+$/, "");
  for (let n = 1; n <= 999; n++) {
    const fname = n === 1 ? name : `${base}_${n}.yrp3d`;
    const full = path.join(dir, fname);
    try {
      fs.writeFileSync(full, buf, { flag: "wx" });
    } catch (e) {
      if (e.code !== "EEXIST") throw e; // 盘满 / 只读 / 拔了的移动硬盘交给调用方
      continue; // 同名，换下一个编号
    }
    if (Number.isFinite(mtime) && mtime > 0 && mtime < Date.now() + 86400000) {
      try { fs.utimesSync(full, mtime / 1000, mtime / 1000); } catch (_) {}
    }
    return { name: fname, size: buf.length };
  }
  throw new Error("这个名字在录像目录里已经有一千份了，换个名字再导入。");
}

// 导出的文件名。规矩和 safeName 一样，只是允许的扩展名不同 ——
// 导出的东西只有这三种，别的一律当非法。
const EXPORT_EXT = [".txt", ".json", ".csv"];
function exportName(name) {
  if (typeof name !== "string" || !name) return null;
  if (name.includes(":") || name.includes("/") || name.includes("\\")) return null;
  if (path.basename(name) !== name) return null;
  if (!EXPORT_EXT.some((e) => name.toLowerCase().endsWith(e))) return null;
  return name;
}

async function listRecordings(outdir) {
  let names;
  try {
    names = await fs.promises.readdir(outdir);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".yrp3d")) continue;
    try {
      const st = await fs.promises.stat(path.join(outdir, n));
      out.push({ name: n, size: st.size, mtime: st.mtimeMs });
    } catch (_) {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/* ------------------------------------------------------------------ *
 * 事件广播
 *
 * 带 id 的环形缓冲：SSE 那条路要「断线重连接着上次发」，IPC 那条路不需要
 * （同进程不可能断），但共用一份实现最省事 —— 订阅时不给 lastId 就是
 * 「只要新的」，给 `{t:"reset"}` 那段逻辑自然跳过。
 * ------------------------------------------------------------------ */
class Events {
  constructor() {
    this.subs = new Set();
    this.next = 1;
    this.ring = []; // [{i, ev}] 最近 RING 条
    this.dropped = 0; // 被挤出缓冲的条数，backlog 靠它说明「前面缺了」
  }

  // fn(ev, id)。给了 lastId 就先把缓冲里比它新的补发一遍。
  subscribe(fn, lastId = null) {
    this.subs.add(fn);

    // 断线重连要接着上次的地方发，不能从头重放（会重复），也不能当没事发生
    // （中间那段就没了）。id 已经被挤出环形缓冲就明说 reset。
    if (lastId != null) {
      const oldest = this.ring.length ? this.ring[0].i : this.next;
      if (lastId < oldest - 1) {
        fn({ t: "reset", why: "界面重启过，之前的日志已经没了" }, null);
      } else {
        for (const e of this.ring) if (e.i > lastId) fn(e.ev, e.i);
      }
    }

    return () => this.subs.delete(fn);
  }

  push(ev) {
    const i = this.next++;
    this.ring.push({ i, ev });
    if (this.ring.length > RING) {
      this.dropped += this.ring.length - RING;
      this.ring.splice(0, this.ring.length - RING);
    }
    for (const fn of this.subs) {
      try {
        fn(ev, i);
      } catch (_) {}
    }
  }

  // 界面重载（Ctrl+R）之后把日志面板灌回原样。窗口不会「重连」，
  // 但没有这个的话面板会一直停在「等待输出…」。
  backlog() {
    return { events: this.ring.map((e) => e.ev), truncated: this.dropped > 0 };
  }
}

/* ------------------------------------------------------------------ *
 * 在资源管理器里打开 replays/，并把窗口提到前台
 *
 * 为什么要「提」这一步：这个请求是浏览器点出来的，点完浏览器就是前台窗口、
 * 而且**刚收到过用户的输入**，Windows 的前台锁（foreground lock）会拒绝后台
 * 进程抢焦点 —— explorer 新建的窗口于是开在浏览器**后面**，用户看到的就是
 * 「点了没反应」。实测光叫 SetForegroundWindow 没用，得先 AttachThreadInput
 * 挂到当前前台线程上才拿得到这个权限。
 *
 * explorer 建窗口要几百毫秒，所以脚本自己带重试轮询：找到那个文件夹的窗口就提。
 * 脚本用 -EncodedCommand 传（UTF-16LE + base64）—— 免掉引号转义，
 * 也顺带支持路径里的中文和空格。
 * ------------------------------------------------------------------ */
const RAISE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class YrpFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  public static void Raise(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    uint t = GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint me = GetCurrentThreadId();
    AttachThreadInput(me, t, true);
    ShowWindow(h, 9);
    SetForegroundWindow(h);
    BringWindowToTop(h);
    AttachThreadInput(me, t, false);
  }
}
"@
$want = '__DIR__'
$wantN = $want.Replace('\\', '/').ToLower()
for ($i = 0; $i -lt 12; $i++) {
  $sh = New-Object -ComObject Shell.Application
  foreach ($w in $sh.Windows()) {
    try {
      $u = [Uri]::UnescapeDataString($w.LocationURL)
      if ($u) {
        $u = $u.ToLower() -replace '^file:///', ''
        if ($u -eq $wantN -or $u -eq ($wantN + '/')) { [YrpFg]::Raise($w.HWND); Write-Output 'RAISED'; exit 0 }
      }
    } catch {}
  }
  Start-Sleep -Milliseconds 150
}
Write-Output 'NORESULT'
`;

// 返回是否真的把窗口提起来了。提不起来不是错误（窗口已经开在那儿了，
// 只是可能还在浏览器后面），所以调用方只拿它决定要不要提示一句。
//
// spawnFn 由调用方注入，默认就是 child_process.spawn。安卓上 nodeSpawn 是 null
// 而且这整段（explorer.exe + PowerShell + user32.dll）在那边没有对应物 ——
// 直接返回 false 表示「没能提起来」，调用方不需要区分「平台不支持」和
// 「尝试了但失败了」。安卓的界面层压根不会发这个通道（见 yrp-shim.js）。
function revealInExplorer(dir, spawnFn = nodeSpawn) {
  if (!spawnFn) return Promise.resolve(false);

  // 用 explorer.exe 直接开，不走 cmd —— 文件名里可能有 # 号，
  // 让 cmd 去解析会出问题
  spawnFn("explorer.exe", [dir], { stdio: "ignore", windowsHide: true }).unref();

  const script = RAISE_SCRIPT.replace("__DIR__", dir.replace(/'/g, "''"));
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  // -ExecutionPolicy Bypass 是必须的：不少机器（包括本工作区这台）把执行策略
  // 锁成 Restricted，那种设置下连 -EncodedCommand 之外的脚本一律拒绝。
  // 注意这段代码**不能**改成外挂一个 .ps1 文件 —— 策略拦的正是脚本文件，
  // 本机实测 -File 直接报「禁止运行脚本」，-EncodedCommand 才过得去。
  const p = spawnFn(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      b64,
    ],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
  );

  return new Promise((resolve) => {
    let out = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c) => (out += c));
    // 提不起来（没装 PowerShell、超时、权限被策略挡了）一律当 false，不抛
    p.on("error", () => resolve(false));
    p.on("exit", () => resolve(out.includes("RAISED")));
  });
}

/* ------------------------------------------------------------------ *
 * 子进程
 *
 * **仍然是独立进程**，不 require 进来跑：proxy.js 在端口被占用时直接
 * process.exit(1)，in-process 会连界面一起带走；配置读不出来时它们会走
 * readline 提问，stdin 关了就是永远卡住的僵尸进程。spawn 之后这些全是
 * 子进程自己的事，界面完全不受影响。
 * ------------------------------------------------------------------ */
// 子进程一行一行地吐，按行切开再分类。日志本身是给人看的自由文本，
// 界面上只用来做诊断着色 —— 对话内容一律以 .yrp3d 为准，不去猜 stdout。
function classify(line, mode) {
  const s = line.trim();
  if (!s) return null;

  // 代理告诉用户端口的那一行，界面要把它放大显示
  const port = s.match(/监听：127\.0\.0\.1:(\d+)/);
  if (port) return { t: "log", kind: "port", port: Number(port[1]), text: s, mode };

  if (/^(!!|⚠|\[!\])/.test(s)) return { t: "log", kind: "warn", text: s, mode };
  if (/^\d{2}:\d{2}:\d{2}/.test(s)) return { t: "log", kind: "info", text: s, mode };
  return { t: "log", kind: "raw", text: s, mode };
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */
function intIn(v, lo, hi) {
  const n = typeof v === "number" ? v : parseInt(v, 10);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

function validate(mode, raw) {
  const d = DEFAULTS[mode];
  const warn = [];
  const cfg = { ...d, ...(raw || {}) };

  if (mode === "proxy") {
    cfg.remoteHost = String(cfg.remoteHost || "").trim();
    if (!cfg.remoteHost) return { error: "要把服务器的地址填上。" };
    const rp = intIn(cfg.remotePort, 1, 65535);
    const lp = intIn(cfg.listenPort, 1, 65535);
    if (rp == null) return { error: "服务器端口要是 1-65535 之间的整数。" };
    if (lp == null) return { error: "本机监听端口要是 1-65535 之间的整数。" };
    cfg.remotePort = rp;
    cfg.listenPort = lp;
    cfg.recordOwnChat = !!cfg.recordOwnChat;
    return { cfg, warn };
  }

  cfg.host = String(cfg.host || "").trim();
  cfg.room = String(cfg.room || "").trim();
  cfg.name = String(cfg.name || "").trim() || d.name;
  const p = intIn(cfg.port, 1, 65535);
  const v = intIn(cfg.version, 0, 65535);
  if (!cfg.host) return { error: "要把服务器的地址填上。" };
  if (!cfg.room) return { error: "要把房间名填上。" };
  if (p == null) return { error: "端口要是 1-65535 之间的整数。" };
  if (v == null) return { error: "版本号要是 0-65535 之间的整数。" };
  cfg.port = p;
  cfg.version = v;

  // observer.js 里这条警告写在 configure() 内，spawn 这条路径永远走不到，
  // 所以必须在这儿补 —— 否则房间名会被静默截断，录到的是个空房间
  if ([...cfg.room].length > 19) {
    warn.push(`房间名超过 19 个字，协议里放不下，实际会用「${[...cfg.room].slice(0, 19).join("")}」。`);
  }
  return { cfg, warn };
}

/* ------------------------------------------------------------------ *
 * 后端实例
 *
 * **一个实例一份子进程表**（不是模块级）：今天 `_test_api.mjs` 会建第二个
 * 实例来测「退出」，共用模块级 procs 的话第二个实例会把第一个的进程当成
 * 自己的（表现在外就是「没在跑却报已经在跑」）。
 * ------------------------------------------------------------------ */
function createApi(opts = {}) {
  const events = new Events();
  const procs = {}; // mode -> { child, mode, sawOutput, watchdog }
  const childEnv = opts.childEnv || {};
  // 起子进程的实现。桌面上没人注入，就是 child_process.spawn（行为不变）；
  // 安卓上 nodejs-mobile 没有子进程，由 index.js 注入一个在**进程内**跑
  // Observer 的替身。下面 procs 那整套逻辑不用知道自己在跟谁说话。
  const spawnFn = opts.spawn || nodeSpawn;

  const running = () => ({ proxy: !!procs.proxy, observer: !!procs.observer });
  const anyRunning = () => !!procs.proxy || !!procs.observer;

  /* ---------------- 录像目录 ---------------- *
   * **实例级**，不是模块级：`_test_api.mjs` 会建第二个实例来测退出，
   * 共用模块级变量的话第二个实例会把第一个的录像目录改掉。
   * opts.replaysDir 是测试用的显式落点；settings.json 是用户自己选的。 */
  let outDir = opts.replaysDir || readSettings().replaysDir || DEFAULT_OUTDIR;

  /* ---------------- 导出目录 ---------------- *
   * 渲染进程只能往**这边发出去过**的目录写文件。它不该有能力往任意路径写东西，
   * 哪怕跑的是我们自己的代码 —— 界面里那些文件名和对话内容都是别人能左右的东西。 */
  const exportDirs = new Set();
  let exportDir = null;

  const defaultExportDir = () => {
    try {
      return (opts.defaultExportDir && opts.defaultExportDir()) || outDir;
    } catch (_) {
      return outDir;
    }
  };
  // 没选过目录时的落点也是「发出去过的」
  exportDirs.add(defaultExportDir());
  // 录像目录同理 —— 它也是界面「发下来过」的一个目录
  exportDirs.add(outDir);

  const currentExportDir = () => exportDir || defaultExportDir();
  function allowedExportDir() {
    const dir = currentExportDir();
    if (!exportDirs.has(dir)) throw fail(400, { ok: false, error: "这个目录不是选出来的，不能往这里写。" });
    return dir;
  }

  // 换录像目录的三步：先**验**能不能写，再落盘，最后才改内存里的值。
  // 顺序不能反 —— 先落盘的话，用户选了个写不进去的目录（拔了的移动硬盘、
  // 只读的网络共享），下次启动会带着一个坏设置起来，而且录了才知道。
  // 录制中不给改：子进程已经把旧目录写死了，这时候换掉，界面看的是新目录、
  // 子进程写的是旧目录 —— 表现是「一直在录，但列表里一个文件都不出来」。
  // 单独抽出来是因为 pickDir 也得在**弹目录对话框之前**问一遍：否则用户挑完
  // 一个文件夹才被告知「先停下来」，白挑一趟。
  function assertNotRunning() {
    if (anyRunning()) {
      throw fail(400, { ok: false, error: "正在录，先停下来再改录像目录。" });
    }
  }

  function applyOutDir(dir) {
    assertNotRunning();
    const target = dir || DEFAULT_OUTDIR;
    if (!canWrite(target)) {
      throw fail(400, {
        ok: false,
        // 一句话，不换行：这条会进 banner，而 banner 那边是 textContent，
        // 换行符会被 HTML 折叠掉，白写。
        error: `这个目录写不进去：${target} —— 换一个，或者看看盘还在不在。`,
      });
    }
    const s = readSettings();
    if (dir) s.replaysDir = target;
    else delete s.replaysDir;
    writeJsonAtomic(SETTINGS, s);
    outDir = target;
    exportDirs.add(target);
    return { ok: true, dir: target, custom: !!dir };
  }

  function startProc(mode, extraArgs) {
    if (procs[mode]) return { ok: false, error: "已经在跑了。" };

    // 子进程是**盘上那个真文件**（前身 SEA 版要把这两个脚本烘进 exe 再靠
    // --role= 派发，Electron 版 asar 关掉、文件平铺，那条路没有了）。
    const script = mode === "proxy" ? "proxy.js" : "observer.js";
    const args = [path.join(HERE, script), ...extraArgs];

    // NODE_NO_WARNINGS：exe 启动会往 stderr 打一行 ExperimentalWarning，而下面把
    //   子进程的 stderr 当红色日志转发到界面上 —— 不压掉就是每次起停都刷一条没用的红字。
    //   顺带也把「10 秒还没输出就报警」那个 watchdog 还回来：那行 warning 会让它误以为
    //   子进程已经活过来了。
    // NODE_OPTIONS：exe 本身就是 node，使用者机器上全局设过的 flag 会跟进来，
    //   而不兼容的 flag 会让 exe 一启动就崩 —— 这种「我这儿不复现」最难查。
    //
    // YRP_DATA_DIR / YRP_REPLAYS_DIR 都得显式传下去：本文件自己知道录像目录被
    //   用户改到哪了，子进程只能靠这两个变量告诉它。**不传的话子进程会按
    //   `|| __dirname` 自己算**，于是界面列表看的是 D:\录像、子进程往程序目录里写。
    // childEnv 是调用方（Electron）塞的 ELECTRON_RUN_AS_NODE：那边的 process.execPath
    //   是 electron.exe，不带这个变量会把子进程起成一个 GUI。
    const env = {
      ...process.env,
      ...childEnv,
      NODE_NO_WARNINGS: "1",
      YRP_DATA_DIR: DATA,
      YRP_REPLAYS_DIR: outDir,
    };
    delete env.NODE_OPTIONS;

    if (!spawnFn) {
      // 只有「安卓上忘了注入」会走到这儿。报出来而不是静默什么都不做。
      events.push({ t: "proc", mode, running: false, code: null, signal: null });
      return { ok: false, error: "这个平台没有子进程机制，而且没有注入替身。" };
    }

    // stdio[0] 用 'ignore'：配置已经写好并回读验证过，子进程不会去走 configure()。
    // windowsHide 免得弹黑框；**不用 detached** —— 子进程和控制台共享终端，
    // 用户按 Ctrl+C 才能正常传到它。
    const child = spawnFn(process.execPath, args, {
      cwd: HERE,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env,
    });

    const rec = { child, mode, sawOutput: false };
    procs[mode] = rec;

    // setEncoding 是必须的：管道里一个中文字可能横跨两个 chunk，
    // 逐块 toString() 会把字符永久撕碎
    if (child.stdout) child.stdout.setEncoding("utf8");
    if (child.stderr) child.stderr.setEncoding("utf8");

    const pipe = (stream) => {
      let tail = "";
      stream.on("data", (chunk) => {
        rec.sawOutput = true;
        tail += chunk;
        const lines = tail.split("\n");
        tail = lines.pop();
        for (const l of lines) {
          const ev = classify(l, mode);
          if (ev) events.push(ev);
        }
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);

    // 万一配置还是读不出来，子进程会静默卡在 readline 上。给个提示，
    // 免得界面一直显示「运行中」而什么都没有。
    rec.watchdog = setTimeout(() => {
      if (!rec.sawOutput) {
        events.push({
          t: "log",
          kind: "warn",
          mode,
          text: "10 秒了还没有任何输出。可能是配置读不出来卡住了 —— 点「停止」重来一次。",
        });
      }
    }, 10000);
    rec.watchdog.unref?.();

    child.on("error", (e) => {
      events.push({ t: "log", kind: "warn", mode, text: `起不来：${e.message}` });
    });

    child.on("exit", (code, signal) => {
      // 「停了」一律以这个事件为准 —— 硬杀时子进程根本来不及打印收尾那行
      clearTimeout(rec.watchdog);
      delete procs[mode];
      events.push({ t: "proc", mode, running: false, code, signal: signal || null });
    });

    events.push({ t: "proc", mode, running: true });
    return { ok: true };
  }

  function stopProc(mode) {
    const rec = procs[mode];
    if (!rec) return { ok: false, error: "没在跑。" };
    // Windows 上这就是 TerminateProcess，SIGINT/SIGTERM 处理器不会执行。
    // 录像不会因此丢 —— Recorder.write 用的是 fs.writeSync，每个包当场落盘。
    rec.child.kill();
    return { ok: true };
  }

  // 界面退出、关窗口、收到信号 —— **三条路都得走这里**，
  // 否则会留下孤儿进程占着端口，下一次启动莫名其妙地失败。
  function killAll() {
    for (const mode of Object.keys(procs)) {
      try {
        procs[mode].child.kill();
      } catch (_) {}
    }
  }

  const handlers = {
    "state:get": () => ({ ok: true, running: running(), parserError }),

    "config:get": () => ({ ok: true, proxy: loadSide("proxy"), observer: loadSide("observer") }),

    "config:save": ({ mode, cfg } = {}) => {
      const m = mode === "proxy" ? "proxy" : "observer";
      const v = validate(m, cfg);
      if (v.error) throw fail(400, { ok: false, error: v.error });
      saveAndVerify(m, v.cfg);
      return { ok: true, cfg: v.cfg, warn: v.warn };
    },

    "proc:start": ({ mode, cfg, dump } = {}) => {
      const m = mode === "proxy" ? "proxy" : "observer";
      if (procs[m]) throw fail(400, { ok: false, error: "已经在跑了。" });

      const v = validate(m, cfg);
      if (v.error) throw fail(400, { ok: false, error: v.error });

      // 先落盘再 spawn，子进程才不会去走交互式提问
      saveAndVerify(m, v.cfg);

      const r = startProc(m, dump ? ["--dump"] : []);
      if (!r.ok) throw fail(400, r);
      return { ok: true, warn: v.warn };
    },

    "proc:stop": ({ mode } = {}) => {
      const m = mode === "proxy" ? "proxy" : "observer";
      const r = stopProc(m);
      if (!r.ok) throw fail(400, r);
      return { ok: true };
    },

    // 录像目录现在长什么样。writable=false 时界面要提醒一句 ——
    // 用户选了块拔掉的移动硬盘，录一晚上一个文件都不会有。
    "replays:getDir": () => ({
      ok: true,
      dir: outDir,
      defaultDir: DEFAULT_OUTDIR,
      custom: path.resolve(outDir) !== path.resolve(DEFAULT_OUTDIR),
      writable: canWrite(outDir),
    }),

    // 改录像目录。用户点取消**不是错误**（界面上等价于「什么都没发生」），
    // 和 export:pickDir 一样走 canceled 而不是 throw。
    "replays:pickDir": async () => {
      assertNotRunning(); // 见它上面的注释：先挡，再弹对话框
      if (!opts.pickDir) throw fail(500, { ok: false, error: "这个界面不支持选目录。" });
      const dir = await opts.pickDir();
      if (!dir) return { canceled: true };
      return applyOutDir(dir);
    },

    // 恢复默认。**必须把 settings.json 里那条真的删掉** —— 只改内存的话，
    // 下次启动读回来又是自定义那个目录，用户会以为按钮坏了。
    "replays:resetDir": () => applyOutDir(null),

    "recordings:list": async () => {
      const list = await listRecordings(outDir);
      // list 按 mtime 倒序，正在录的那个就是 list[0] —— 界面拿 anyRunning
      // 决定要不要把它标成「录制中」
      return { ok: true, list, anyRunning: anyRunning() };
    },

    "recording:parse": async ({ name } = {}) => {
      const r = await parseRecording(name || "", anyRunning(), outDir);
      // 失败结果里有 trimmed/running 这类界面要用的字段，整份发回去
      if (!r.ok) throw fail(400, r);
      return r;
    },

    /* 把界面导入的 .yrp3d 在录像目录里存一份。

       存了它就是个真文件：recordings:list 每次都是现场 readdir，下次轮询就会
       带上它，重启之后也还在 —— 整个功能**不需要任何额外的持久化状态**。

       落点用 outDir（就是界面上那个「录像存到：…」），副本和录下来的录像平铺在
       同一个目录里。不能另开子目录：listRecordings 只 readdir 顶层，放子目录里
       列表根本不会显示。

       这里**故意不 assertNotRunning()**：改录像目录要停下来是因为子进程已经把旧
       目录写死了，而往目录里多放一个文件不影响任何在跑的进程 —— 名字撞了有
       writeCopy 的 "wx" 兜着。

       返回的 saved[].i / failed[].i 是**请求数组下标**：同批里有同名文件时靠名字
       对不回去，靠下标才行。 */
    "recordings:import": async ({ files } = {}) => {
      const list = Array.isArray(files) ? files : [];
      if (list.length > IMPORT_MAX_FILES) {
        throw fail(400, { ok: false, error: `一次最多导入 ${IMPORT_MAX_FILES} 个录像。` });
      }

      // 先全验一遍再动手写（照 export:write 的规矩）。整批级的问题直接拒；
      // 单个文件写不进去才进 failed —— 一个文件失败不该连累同批其它文件。
      const plan = [];
      let total = 0;
      for (let i = 0; i < list.length; i++) {
        const it = list[i] || {};
        const name = safeName(String(it.name || ""));
        if (!name) {
          throw fail(400, { ok: false, error: `文件名不合法：${String(it.name || "")}` });
        }
        const buf = decodeB64(it.data);
        if (!buf) throw fail(400, { ok: false, error: `录像数据不是合法的 base64：${name}` });
        if (buf.length > IMPORT_MAX_BYTES) {
          throw fail(400, {
            ok: false,
            error: `这个录像太大了（最多 ${IMPORT_MAX_BYTES / 1024 / 1024} MB）：${name}`,
          });
        }
        total += buf.length;
        if (total > IMPORT_MAX_TOTAL) {
          throw fail(400, { ok: false, error: "这一批加起来太大了，分几次导入。" });
        }
        plan.push({ i, name, buf, mtime: Number(it.mtime) });
      }

      const saved = [];
      const failed = [];
      if (plan.length) {
        // 用户选的录像目录可能是块已经拔掉的移动硬盘（canWrite 只在选目录那一刻
        // 验过），所以这一步也得自己兜住。
        try {
          fs.mkdirSync(outDir, { recursive: true });
        } catch (e) {
          throw fail(400, { ok: false, error: `写不进录像目录：${e.message}` });
        }
        for (const p of plan) {
          try {
            const r = writeCopy(outDir, p.name, p.buf, p.mtime);
            saved.push({ i: p.i, src: p.name, name: r.name, size: r.size });
          } catch (e) {
            failed.push({ i: p.i, src: p.name, error: e.message });
          }
        }
      }
      return { ok: true, dir: outDir, saved, failed };
    },

    // 哨兵块的浏览器版。界面拖入本地 .yrp3d 时用它解析 —— 和录像列表走的
    // 是同一份代码，而字节一个都不用穿过传输层（真实录像内嵌整局回放，
    // 随便就超过 HTTP 那条 1MB 的请求体上限）。
    "parser:get": () => {
      if (!PARSER_BUNDLE) throw fail(500, { ok: false, error: `解析块读不出来：${parserError}` });
      return { ok: true, source: PARSER_BUNDLE };
    },

    "log:backlog": () => ({ ok: true, ...events.backlog() }),

    "shell:reveal": async () => {
      fs.mkdirSync(outDir, { recursive: true });
      // raised=false 不是失败：文件夹已经打开了，只是没能提到前台
      const raised = await revealInExplorer(outDir, spawnFn);
      return { ok: true, raised, dir: outDir };
    },

    // 选导出目录。用户点了取消**不是错误**（界面上等价于「什么都没发生」），
    // 所以取消走 canceled 而不是 throw。
    "export:pickDir": async () => {
      if (!opts.pickDir) throw fail(500, { ok: false, error: "这个界面不支持指定导出目录。" });
      const dir = await opts.pickDir();
      if (!dir) return { canceled: true };
      exportDirs.add(dir);
      exportDir = dir;
      return { ok: true, dir };
    },

    "export:write": ({ files } = {}) => {
      const list = Array.isArray(files) ? files : [];
      const dir = allowedExportDir();
      if (!list.length) return { ok: true, dir, written: [] };

      // 先把**所有**名字验一遍，再动手写。边写边验会留下写了一半的目录 ——
      // 用户看到的是「报了错，但文件夹里多了几个文件」，而且不知道哪些是这次的。
      const names = list.map((f) => {
        const name = exportName(f && f.name);
        if (!name) throw fail(400, { ok: false, error: `文件名不合法：${(f && f.name) || ""}` });
        return name;
      });

      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < names.length; i++) {
        fs.writeFileSync(path.join(dir, names[i]), String((list[i] && list[i].text) || ""), "utf8");
      }
      exportDir = dir;
      return { ok: true, dir, written: names };
    },

    "clipboard:write": async ({ text } = {}) => {
      if (!opts.clipboard) throw fail(500, { ok: false, error: "系统剪贴板用不了。" });
      await opts.clipboard(String(text == null ? "" : text));
      return { ok: true };
    },

    // 用系统默认程序打开刚导出的文件。**只收文件名**，路径由这里拼 —— 渲染
    // 进程不该有能力让主进程去打开任意一个路径。
    "shell:openFile": async ({ name } = {}) => {
      const safe = exportName(name);
      if (!safe) throw fail(400, { ok: false, error: "文件名不合法。" });
      const full = path.join(allowedExportDir(), safe);
      if (!fs.existsSync(full)) throw fail(404, { ok: false, error: "这个文件不在了，重新导出一次。" });
      if (opts.openFile) await opts.openFile(full);
      return { ok: true, path: full };
    },

    // 只收摊，**不负责退出** —— 退出是调用方的事：HTTP 版要先把响应发完
    // 再 process.exit，Electron 版要 app.quit()。
    "app:quit": () => {
      const stopped = Object.keys(procs);
      killAll();
      return { ok: true, stopped };
    },
  };

  return {
    handlers,
    events,
    subscribe: (fn) => events.subscribe(fn),
    backlog: () => events.backlog(),
    running,
    anyRunning,
    killAll,
    parserError,
    DEFAULTS,
    // 给调用方（尤其测试）用的路径，省得各自再拼一遍拼错。
    // outDir 是**函数**不是值 —— 它会被「更改…」改掉，发一个快照出去就过期了。
    DATA,
    outDir: () => outDir,
    DEFAULT_OUTDIR,
    exportDir: () => currentExportDir(),
  };
}

module.exports = {
  createApi,
  DEFAULTS,
  validate,
  trimToLastPacket,
  safeName,
  exportName,
  decodeB64,
  writeCopy,
  loadSide,
  saveAndVerify,
  readSettings,
  canWrite,
  classify,
  revealInExplorer,
};
