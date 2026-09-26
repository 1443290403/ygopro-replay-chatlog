#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * 对话记录 —— 本地网页界面
 *
 * 浏览器开不了 TCP 连接（网页里没有这个 API），所以界面不能自己干活。
 * 这个文件起一个**只监听 127.0.0.1** 的本地服务：浏览器当界面，
 * 真正连服务器的事交给 spawn 出来的 proxy.js / observer.js 子进程。
 *
 * 为什么是子进程而不是 require 进来跑：
 *   - proxy.js 在端口被占用时直接 process.exit(1)，in-process 会连界面一起带走
 *   - 配置读不出来时它们会走 readline 提问，stdin 关了就是一个永远卡住、
 *     一行输出都没有的僵尸进程
 *   - 它们没有 stop 句柄，活动连接拿不到，停不掉
 * spawn 之后这些全是子进程自己的事，界面完全不受影响。
 *
 * 用法：
 *   node gui.js              正常跑，自动开浏览器
 *   node gui.js --no-open    不开浏览器（自己访问打印出来的地址）
 * ------------------------------------------------------------------ */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { loadExtractor, parserSource, browserSource, BROWSER_NAMES } = require("../_parser.js");
const { readShipped, isBundled } = require("../_shipped.js");

const HERE = __dirname;
// 和 proxy.js / observer.js 用同一个环境变量，保证界面看到的录像目录
// 就是子进程真正在写的那个（测试时指向临时目录）
const DATA = process.env.YRP_DATA_DIR || HERE;
const OUTDIR = path.join(DATA, "replays");
const PROXY_CFG = path.join(DATA, "config.json");
const OBS_CFG = path.join(DATA, "observer.json");
const TOKEN_FILE = path.join(DATA, "gui-token.txt");
// 上次跑的时候把自己的地址写在这儿。为的是「双击第二次 = 重新打开页面」
// 而不是开第二个界面（两个界面会抢同一批录像文件）。
const URL_FILE = path.join(DATA, "gui-url.txt");
// 页面**不在这里拼路径**：打成 exe 之后它是烘进二进制的资源，而且本文件运行时的
// __dirname 是「运行时数据该落在哪」（exe 旁边），不是「源文件在哪」。
// 路径由 _shipped.js 的 SOURCE_PATHS 一处说了算。
const PAGE_ASSET = "gui.html";

const DEFAULT_PORT = 7912;

// 子进程日志超过这个长度就丢掉最老的，只保最近一段
const RING = 2000;

/* ---------------- 导入本机录像的上限 ----------------
   界面导入的 .yrp3d 要往录像目录里存一份，字节得 base64 编好放在 JSON 请求体里
   送过来。这里是**宿主侧的真正闸门**，界面里那份同名常量只是为了提前给出友好
   提示。实测用户真实录像只有 101 ~ 2591 字节，这三个数留了两三个数量级余量。

   这三份数值和 electron 版 api.js 里的必须一样（_test_import.mjs 盯着）。 */
const IMPORT_MAX_BYTES = 8 * 1024 * 1024;
const IMPORT_MAX_FILES = 50;
const IMPORT_MAX_TOTAL = 16 * 1024 * 1024;
// base64 膨胀 4/3，再给整个 JSON 的壳留一点。只给 /api/import 用，别顺手改成
// readBody 的默认值。
const IMPORT_BODY_MAX = Math.ceil((IMPORT_MAX_TOTAL * 4) / 3) + 256 * 1024;

// 默认值必须和 proxy.js / observer.js 里的 DEFAULTS 一致，否则界面显示的
// 是一套、子进程实际跑的是另一套。**这三份没有共同的来源，只能靠人盯着** ——
// 改了 `proxy.js` 的 DEFAULT_HOST / DEFAULT_PORT 就要回来同步这两份
// （`_test_gui.mjs` 有一条断言比对它们，漏改会红）。
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
 * 录像解析
 * ------------------------------------------------------------------ */
let PARSER = null;
let parserError = null;
// 同一个哨兵块的浏览器版本，发给 gui.html 用来自解析拖进去的本地文件。
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

async function parseRecording(name, running) {
  const safe = safeName(name);
  if (!safe) return { ok: false, error: "文件名不合法。" };

  const file = path.join(OUTDIR, safe);
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

async function listRecordings() {
  let names;
  try {
    names = await fs.promises.readdir(OUTDIR);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".yrp3d")) continue;
    try {
      const st = await fs.promises.stat(path.join(OUTDIR, n));
      out.push({ name: n, size: st.size, mtime: st.mtimeMs });
    } catch (_) {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/* ------------------------------------------------------------------ *
 * 日志广播（SSE）
 * ------------------------------------------------------------------ */
class Hub {
  constructor() {
    this.clients = new Set();
    this.next = 1;
    this.ring = []; // 最近 RING 条，重连时补发
  }

  add(res, lastId) {
    const c = { res };
    this.clients.add(c);

    // 断线重连要接着上次的地方发，不能从头重放（会重复），也不能当没事发生
    // （中间那段就没了）。id 已经被挤出环形缓冲就明说 reset。
    if (lastId != null) {
      const oldest = this.ring.length ? this.ring[0].i : this.next;
      if (lastId < oldest - 1) {
        this.send(c, { t: "reset", why: "界面重启过，之前的日志已经没了" });
      } else {
        for (const e of this.ring) if (e.i > lastId) this.send(c, e.ev, e.i);
      }
    }

    res.on("close", () => {
      // 不摘掉的话，每次重连都多一个写入者，客户端会收到 N 份重复
      this.clients.delete(c);
      clearInterval(c.ping);
    });
    c.ping = setInterval(() => {
      // 注释行，不占 id 也不触发 onmessage，纯粹防中间设备掐连接
      try {
        res.write(": ping\n\n");
      } catch (_) {}
    }, 20000);
    c.ping.unref?.();
    return c;
  }

  send(c, obj, id) {
    const payload = JSON.stringify(obj); // 单行，聊天里的换行不会破坏 SSE 分帧
    try {
      c.res.write(id != null ? `id: ${id}\ndata: ${payload}\n\n` : `data: ${payload}\n\n`);
    } catch (_) {}
  }

  push(obj) {
    const i = this.next++;
    this.ring.push({ i, ev: obj });
    if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);
    for (const c of this.clients) this.send(c, obj, i);
  }
}

/* ------------------------------------------------------------------ *
 * 子进程
 * ------------------------------------------------------------------ */
const procs = {}; // mode -> { child, mode, out, buf }

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

function startProc(hub, mode, extraArgs) {
  if (procs[mode]) return { ok: false, error: "已经在跑了。" };

  // 打包产物里 "起个子进程" 就是**再跑一遍自己**，用 --role= 挑活干
  // （磁盘上没有 proxy.js 这个文件，拼路径那套不成立）。
  // 用 isBundled() 而不是 isSea()：用普通 node 跑 build/sea-main.js 时也不是 SEA，
  // 但 build/ 里同样没有 proxy.js，一样得走 --role=。
  // argv 的形态在两种情况下一致：SEA 的 argv 也是 [程序, 程序, ...参数]。
  const bundled = isBundled();
  const script = mode === "proxy" ? "proxy.js" : "observer.js";
  const args = bundled ? [`--role=${mode}`, ...extraArgs] : [path.join(HERE, script), ...extraArgs];

  // NODE_NO_WARNINGS：exe 启动会往 stderr 打一行 ExperimentalWarning，而下面把
  //   子进程的 stderr 当红色日志转发到界面上 —— 不压掉就是每次起停都刷一条没用的红字。
  //   顺带也把「10 秒还没输出就报警」那个 watchdog 还回来：那行 warning 会让它误以为
  //   子进程已经活过来了。
  // NODE_OPTIONS：exe 本身就是 node，使用者机器上全局设过的 flag 会跟进来，
  //   而不兼容的 flag 会让 exe 一启动就崩 —— 这种「我这儿不复现」最难查。
  const env = { ...process.env, NODE_NO_WARNINGS: "1" };
  delete env.NODE_OPTIONS;

  // stdio[0] 用 'ignore'：配置已经写好并回读验证过，子进程不会去走 configure()。
  // windowsHide 免得弹黑框；**不用 detached** —— 子进程和控制台共享终端，
  // 用户按 Ctrl+C 才能正常传到它。
  const child = spawn(process.execPath, args, {
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
        if (ev) hub.push(ev);
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  // 万一配置还是读不出来，子进程会静默卡在 readline 上。给个提示，
  // 免得界面一直显示「运行中」而什么都没有。
  rec.watchdog = setTimeout(() => {
    if (!rec.sawOutput) {
      hub.push({
        t: "log",
        kind: "warn",
        mode,
        text: "10 秒了还没有任何输出。可能是配置读不出来卡住了 —— 点「停止」重来一次。",
      });
    }
  }, 10000);
  rec.watchdog.unref?.();

  child.on("error", (e) => {
    hub.push({ t: "log", kind: "warn", mode, text: `起不来：${e.message}` });
  });

  child.on("exit", (code, signal) => {
    // 「停了」一律以这个事件为准 —— 硬杀时子进程根本来不及打印收尾那行
    clearTimeout(rec.watchdog);
    delete procs[mode];
    hub.push({ t: "proc", mode, running: false, code, signal: signal || null });
  });

  hub.push({ t: "proc", mode, running: true });
  return { ok: true };
}

function stopProc(hub, mode) {
  const rec = procs[mode];
  if (!rec) return { ok: false, error: "没在跑。" };
  // Windows 上这就是 TerminateProcess，SIGINT/SIGTERM 处理器不会执行。
  // 录像不会因此丢 —— Recorder.write 用的是 fs.writeSync，每个包当场落盘。
  rec.child.kill();
  return { ok: true };
}

function killAll() {
  for (const mode of Object.keys(procs)) {
    try {
      procs[mode].child.kill();
    } catch (_) {}
  }
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
 * HTTP
 * ------------------------------------------------------------------ */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

/* max 只有 /api/import 会传大值（base64 比原字节膨胀 4/3，还要加上整个 JSON 的
   壳）。**不要**把默认值整体抬高：那会把 /api/config、/api/start 的上限一起放宽，
   而它们本来只需要几百字节。 */
function readBody(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    let s = "";
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > max) return reject(new Error("请求体太大"));
      s += c;
    });
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
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
function revealInExplorer(dir) {
  // 用 explorer.exe 直接开，不走 cmd —— 文件名里可能有 # 号，
  // 让 cmd 去解析会出问题
  spawn("explorer.exe", [dir], { stdio: "ignore", windowsHide: true }).unref();

  const script = RAISE_SCRIPT.replace("__DIR__", dir.replace(/'/g, "''"));
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  // -ExecutionPolicy Bypass 是必须的：不少机器（包括本工作区这台）把执行策略
  // 锁成 Restricted，那种设置下连 -EncodedCommand 之外的脚本一律拒绝。
  // 注意这段代码**不能**改成外挂一个 .ps1 文件 —— 策略拦的正是脚本文件，
  // 本机实测 -File 直接报「禁止运行脚本」，-EncodedCommand 才过得去。
  const p = spawn(
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

function createServer(token) {
  const hub = new Hub();

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch (_) {
      return json(res, 400, { ok: false, error: "地址不合法" });
    }
    const p = url.pathname;

    // 每个路由都要带 token，**包括 / 本身** —— 只校验 /api/ 的话，
    // DNS rebinding 可以先取回带 token 的页面再打接口。
    const given = url.searchParams.get("t") || req.headers["x-token"];
    if (given !== token) {
      return json(res, 401, { ok: false, error: "token 不对，请重新双击「START.vbs」打开。" });
    }

    try {
      if (p === "/" && req.method === "GET") {
        let html = readShipped(PAGE_ASSET);
        html = html.replace("__TOKEN__", token);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        return res.end(html);
      }

      // 哨兵块的浏览器版。界面拖入本地 .yrp3d 时用它解析 —— 和录像列表走的
      // 是同一份代码，而字节一个都不用上传（真实录像内嵌整局回放，随便就超过
      // readBody 那 1MB 的上限）。
      if (p === "/parser.js" && req.method === "GET") {
        if (!PARSER_BUNDLE) {
          return json(res, 500, { ok: false, error: `解析块读不出来：${parserError}` });
        }
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          // token 存在 gui-token.txt 里，跨重启不变，所以地址是稳定的 ——
          // 不禁止缓存的话，改了 chat-extractor.html 再重启会拿到旧解析器
          "cache-control": "no-store",
        });
        return res.end(PARSER_BUNDLE);
      }

      if (p === "/api/events" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.write("retry: 2000\n\n");
        const last = req.headers["last-event-id"];
        hub.add(res, last != null && last !== "" ? Number(last) : null);
        return;
      }

      if (p === "/api/state" && req.method === "GET") {
        return json(res, 200, {
          ok: true,
          running: { proxy: !!procs.proxy, observer: !!procs.observer },
          parserError, // 非 null 就是对话查看器用不了
        });
      }

      if (p === "/api/config" && req.method === "GET") {
        return json(res, 200, { ok: true, proxy: loadSide("proxy"), observer: loadSide("observer") });
      }

      if (p === "/api/config" && req.method === "POST") {
        const body = await readBody(req);
        const mode = body.mode === "proxy" ? "proxy" : "observer";
        const v = validate(mode, body.cfg);
        if (v.error) return json(res, 400, { ok: false, error: v.error });
        saveAndVerify(mode, v.cfg);
        return json(res, 200, { ok: true, cfg: v.cfg, warn: v.warn });
      }

      if (p === "/api/start" && req.method === "POST") {
        const body = await readBody(req);
        const mode = body.mode === "proxy" ? "proxy" : "observer";
        if (procs[mode]) return json(res, 400, { ok: false, error: "已经在跑了。" });

        const v = validate(mode, body.cfg);
        if (v.error) return json(res, 400, { ok: false, error: v.error });

        // 先落盘再 spawn，子进程才不会去走交互式提问
        saveAndVerify(mode, v.cfg);

        const extra = body.dump ? ["--dump"] : [];
        const r = startProc(hub, mode, extra);
        if (!r.ok) return json(res, 400, r);
        return json(res, 200, { ok: true, warn: v.warn });
      }

      if (p === "/api/stop" && req.method === "POST") {
        const body = await readBody(req);
        const mode = body.mode === "proxy" ? "proxy" : "observer";
        const r = stopProc(hub, mode);
        return json(res, r.ok ? 200 : 400, r);
      }

      if (p === "/api/recordings" && req.method === "GET") {
        const list = await listRecordings();
        // list 按 mtime 倒序，正在录的那个就是 list[0] —— 界面拿 anyRunning
        // 决定要不要把它标成「录制中」
        return json(res, 200, { ok: true, list, anyRunning: !!procs.proxy || !!procs.observer });
      }

      if (p === "/api/recording" && req.method === "GET") {
        const name = url.searchParams.get("name") || "";
        const r = await parseRecording(name, !!procs.proxy || !!procs.observer);
        return json(res, r.ok ? 200 : 400, r);
      }

      /* 把界面导入的 .yrp3d 在录像目录里存一份。

         存了它就是个真文件：/api/recordings 每次都是现场 readdir，下次轮询就会
         带上它，重启之后也还在 —— 整个功能**不需要任何额外的持久化状态**。

         副本和录下来的录像平铺在同一个目录里（就是界面上那个「录像存到：…」）。
         不能另开子目录：listRecordings 只 readdir 顶层，放子目录里列表根本不显示。

         这里**不需要停下来**：改录像目录要停是因为子进程已经把旧目录写死了，而往
         目录里多放一个文件不影响任何在跑的进程 —— 名字撞了有 writeCopy 的 "wx" 兜着。

         返回的 saved[].i / failed[].i 是**请求数组下标**：同批里有同名文件时靠名字
         对不回去，靠下标才行。 */
      if (p === "/api/import" && req.method === "POST") {
        const body = await readBody(req, IMPORT_BODY_MAX);
        const list = Array.isArray(body && body.files) ? body.files : [];
        if (list.length > IMPORT_MAX_FILES) {
          return json(res, 400, { ok: false, error: `一次最多导入 ${IMPORT_MAX_FILES} 个录像。` });
        }

        // 先全验一遍再动手写。整批级的问题直接拒；单个文件写不进去才进 failed ——
        // 一个文件失败不该连累同批其它文件。
        const plan = [];
        let total = 0;
        for (let i = 0; i < list.length; i++) {
          const it = list[i] || {};
          const name = safeName(String(it.name || ""));
          if (!name) {
            return json(res, 400, { ok: false, error: `文件名不合法：${String(it.name || "")}` });
          }
          const buf = decodeB64(it.data);
          if (!buf) {
            return json(res, 400, { ok: false, error: `录像数据不是合法的 base64：${name}` });
          }
          if (buf.length > IMPORT_MAX_BYTES) {
            return json(res, 400, {
              ok: false,
              error: `这个录像太大了（最多 ${IMPORT_MAX_BYTES / 1024 / 1024} MB）：${name}`,
            });
          }
          total += buf.length;
          if (total > IMPORT_MAX_TOTAL) {
            return json(res, 400, { ok: false, error: "这一批加起来太大了，分几次导入。" });
          }
          plan.push({ i, name, buf, mtime: Number(it.mtime) });
        }

        const saved = [];
        const failed = [];
        if (plan.length) {
          // 录像目录可能是块已经拔掉的移动硬盘（之前只在选目录那一刻验过），
          // 所以这一步也得自己兜住。
          try {
            fs.mkdirSync(OUTDIR, { recursive: true });
          } catch (e) {
            return json(res, 400, { ok: false, error: `写不进录像目录：${e.message}` });
          }
          for (const q of plan) {
            try {
              const r = writeCopy(OUTDIR, q.name, q.buf, q.mtime);
              saved.push({ i: q.i, src: q.name, name: r.name, size: r.size });
            } catch (e) {
              failed.push({ i: q.i, src: q.name, error: e.message });
            }
          }
        }
        return json(res, 200, { ok: true, dir: OUTDIR, saved, failed });
      }

      if (p === "/api/quit" && req.method === "POST") {
        // 隐藏启动之后没有窗口可关，退出只能从页面点。先记录在跑的子进程，
        // 再把响应发完，最后才真的退 —— 顺序反了浏览器那边只会看到连接被掐断。
        const running = Object.keys(procs);
        killAll();
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        return res.end(JSON.stringify({ ok: true, stopped: running }), () => {
          try {
            fs.unlinkSync(URL_FILE);
          } catch (_) {}
          process.exit(0);
        });
      }

      if (p === "/api/reveal" && req.method === "POST") {
        fs.mkdirSync(OUTDIR, { recursive: true });
        // raised=false 不是失败：文件夹已经打开了，只是没能提到浏览器前面
        const raised = await revealInExplorer(OUTDIR);
        return json(res, 200, { ok: true, raised });
      }

      return json(res, 404, { ok: false, error: "没有这个接口" });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  });

  return { server, hub };
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    const ok = () => {
      server.removeListener("error", bad);
      resolve(server.address().port);
    };
    const bad = (e) => {
      server.removeListener("listening", ok);
      reject(e);
    };
    server.once("listening", ok);
    server.once("error", bad);
    server.listen(port, "127.0.0.1");
  });
}

function loadToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    // token 只用在 URL 查询串上，限制成十六进制就不会有转义问题
    if (/^[a-f0-9]{32,}$/.test(t)) return t;
  } catch (_) {}
  const t = crypto.randomBytes(16).toString("hex");
  try {
    fs.writeFileSync(TOKEN_FILE, t + "\n", "utf8");
  } catch (_) {}
  return t;
}

function openBrowser(url) {
  // token 是十六进制、端口是数字，所以这个 URL 里没有需要转义的字符，
  // 可以安全地交给 cmd /c start
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", windowsHide: true }).unref();
  } catch (_) {}
}

// 这个地址背后是不是还活着一个「我们自己的」界面？
// 拿同一个 token 去打 /api/state —— 只认 200，所以端口上蹲着别的程序也不会误判。
function probeExisting(url) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return resolve(false);
    }
    // 地址文件是明文的，被人改成别的机器就变成浏览器带着 token 去打外网了
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return resolve(false);

    const req = http.get(
      { host: u.hostname, port: u.port, path: "/api/state" + u.search, timeout: 1500 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

// 地址文件里那个界面还活着的话，把地址返回；否则 null
async function readLiveUrl() {
  let prev = null;
  try {
    prev = fs.readFileSync(URL_FILE, "utf8").trim();
  } catch (_) {
    return null;
  }
  return prev && (await probeExisting(prev)) ? prev : null;
}

function reopen(url) {
  console.log("界面已经在跑了，直接把浏览器打开：");
  console.log(`  ${url}`);
  console.log("");
  console.log("  不用开第二个 —— 两个界面会抢同一批录像文件。");
  console.log("  要退出：在页面右上角点「退出界面」。");
  if (!process.argv.includes("--no-open")) openBrowser(url);
}

async function main() {
  const token = loadToken();

  // 已经开着一个了？多半是用户关了浏览器页面又想回来（隐藏启动没有窗口，
  // 找不到原来那个标签页）。那就只把页面重新打开，别再起一个。
  const live = await readLiveUrl();
  if (live) return reopen(live);

  const { server } = createServer(token);

  let port;
  try {
    port = await listenOn(server, DEFAULT_PORT);
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
    console.log(`端口 ${DEFAULT_PORT} 被占了（可能是别的程序），换一个。`);
    port = await listenOn(server, 0);
  }

  // 固定用 127.0.0.1，不写 localhost —— 万一浏览器把 localhost 解析成 ::1，
  // 只监听 IPv4 的我们会拒绝连接
  const url = `http://127.0.0.1:${port}/?t=${token}`;

  // 刚才那几百毫秒里可能已经有一个跑起来了（连点两下启动文件）。抢在写地址
  // 之前再探一次 —— 探到就让位，不然会留下一个没人管的后台界面。
  const raced = await readLiveUrl();
  if (raced && raced !== url) {
    await new Promise((r) => server.close(r));
    return reopen(raced);
  }

  try {
    fs.writeFileSync(URL_FILE, url + "\n", "utf8");
  } catch (_) {}

  console.log("─".repeat(60));
  console.log("  对话记录界面已启动");
  console.log(`  地址：${url}`);
  console.log("");
  console.log("  浏览器会自动打开。没打开的话，把上面那行整条复制到浏览器里。");
  console.log("  录下来的文件在 replays 文件夹里。");
  console.log("");
  console.log("  要退出：在页面右上角点「退出界面」。");
  console.log("  这个窗口别关 —— 关了界面就没法干活了。");
  console.log(`  （页面不小心关了：再双击一次启动文件就行，会直接把页面打开。）`);
  console.log("─".repeat(60) + "\n");

  if (!process.argv.includes("--no-open")) openBrowser(url);

  // 界面崩了不能留下孤儿子进程占着端口，下一次启动会莫名其妙地失败
  const bye = () => {
    killAll();
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
    try {
      process.on(sig, bye);
    } catch (_) {}
  }
  process.on("exit", killAll);
}

if (require.main === module) main().catch((e) => {
  console.error(`启动失败：${e.message}`);
  process.exit(1);
});

module.exports = {
  createServer,
  loadToken,
  listenOn,
  probeExisting,
  DEFAULTS,
  trimToLastPacket,
  safeName,
  validate,
};
