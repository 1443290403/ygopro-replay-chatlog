#!/usr/bin/env node
"use strict";
/*
 * 对话记录代理 —— 在 ygopro 客户端和第三方服务器之间做一次本地中转。
 *
 * 客户端用裸 TCP 明文通信，帧格式是 [uint16 LE 长度][uint8 类型][数据]，
 * 长度字段 = 1 + 数据长度。所以只要把流切成一帧一帧，就能顺手抄下 STOC_CHAT。
 *
 * 抄下来的东西写成 .yrp3d 包流，搜索、筛选、批量导出那一整套都能用：
 * 界面（gui.js）里直接看和导出，命令行用户喂给 ../chat-extractor.html，两边同一份代码。
 *
 * 代理只读不改：除了自己解析，转发过去的字节和客户端发来的一模一样。
 *
 * 用法：
 *   node proxy.js            正常跑
 *   node proxy.js --config   重新问一遍服务器地址
 *   node proxy.js --dump     额外把每个包的类型和十六进制倒进 replays/_dump_*.log
 *
 * 打包成单个 exe 之后（见 PACKAGING.md）没有 proxy.js 这个文件了，改成：
 *   yrp.exe --role=proxy [--config|--dump]
 */

const net = require("net");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

// 配置和录像默认就放在脚本旁边。测试时用 YRP_DATA_DIR 指到临时目录 ——
// 界面（main.js）是把本文件当子进程 spawn 的，环境变量能一级级传下去，
// 所以这一个变量就能让整条链路都写到别处，不碰真实的 config.json 和录像。
//
// 录像目录多一层：界面里能把它改到任意位置（存 settings.json），改完由 api.js
// 通过 YRP_REPLAYS_DIR 传下来。命令行长跑时没有这个变量，那就是脚本旁边的 replays/。
const DATA = process.env.YRP_DATA_DIR || __dirname;
const CFG_PATH = path.join(DATA, "config.json");
const OUTDIR = process.env.YRP_REPLAYS_DIR || path.join(DATA, "replays");
// 运行时的输出目录，end-to-end 测试会把它换掉
let OUT = OUTDIR;

// ---- 线上协议（ygopro/gframe/network.h + duelclient.cpp） ----
// 注意 0x21 在两个方向上含义不同：服务器发的是 HS_PLAYER_CHANGE，
// 客户端发的才是 HS_TOOBSERVER（切成观战）。
const STOC_ERROR_MSG = 0x02; // uint8 msg + 3 填充 + uint32 code
const STOC_TYPE_CHANGE = 0x13; // uint8 type = (主机?0x10:0) | 座位
const STOC_CHAT = 0x19; // uint16 player_type + UTF-16LE NUL 结尾文本
const STOC_HS_PLAYER_ENTER = 0x20; // uint16 name[20] + uint8 pos（41 字节紧凑）
const STOC_HS_PLAYER_CHANGE = 0x21; // uint8 status = (pos<<4) | state
const CTOS_PLAYER_INFO = 0x10; // uint16 name[20]（40 字节）
const CTOS_JOIN_GAME = 0x12; // 48 字节，见 encodeJoinGame()
const CTOS_CHAT = 0x16; // UTF-16LE NUL 结尾文本（客户端不带 player_type）
const CTOS_HS_TOOBSERVER = 0x21; // 无载荷

// 客户端源码里的 PRO_VERSION（gframe/config.h:29）。服务器不一定用同一个值，
// 发错了服务器会在 STOC_ERROR_MSG 里把正确版本告诉我们。
const PRO_VERSION = 0x1362;

// 服务器期望的版本和客户端不一致时的错误码（ygopro-server.coffee:2255）
const ERROR_VERSION_MISMATCH = 4;

const PLAYERCHANGE_LEAVE = 11;
const SEATS = 4;

// ---- .yrp3d 包类型（MDPro3） ----
const SIBYL_CHAT = 230;
const SIBYL_NAME = 235;

// ---- 全局选项 ----
const args = process.argv.slice(2);
const DUMP = args.includes("--dump");
const RECONFIG = args.includes("--config");

let dumpFd = null;
let dumpCounts = null;

/* ------------------------------------------------------------------ *
 * 编解码
 * ------------------------------------------------------------------ */

// UTF-16LE，遇到 NUL 停。代理和录像两边都是这个规矩。
function decodeU16z(buf, off) {
  let s = "";
  for (let i = off || 0; i + 1 < buf.length; i += 2) {
    const c = buf.readUInt16LE(i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// 编成 UTF-16LE 并补 NUL；给了 cap 就补/截到固定字节数（名字槽要 100 字节）
function encodeU16z(s, cap) {
  const b = Buffer.alloc(cap || (s.length + 1) * 2);
  const n = Math.min(s.length, (b.length >> 1) - 1);
  for (let i = 0; i < n; i++) b.writeUInt16LE(s.charCodeAt(i), i * 2);
  return b;
}

// makeSplitter 的逆运算。代理只转发不用它，观战端要自己发握手包。
function frame(type, payload) {
  const b = Buffer.alloc(3 + payload.length);
  b.writeUInt16LE(1 + payload.length, 0);
  b[2] = type;
  payload.copy(b, 3);
  return b;
}

/* ------------------------------------------------------------------ *
 * 切帧
 *
 * TCP 不保证一次 data 事件正好是一个包，所以必须自己攒。feed() 每次吃一块，
 * 内部保留没喂完的尾巴，下次接着拼。
 * ------------------------------------------------------------------ */
function makeSplitter(onPacket, label = "数据流") {
  let buf = Buffer.alloc(0);
  let broken = false;
  return function feed(chunk) {
    if (broken) return;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let o = 0;
    while (buf.length - o >= 3) {
      const len = buf.readUInt16LE(o); // = 1 + 载荷长度
      if (len < 1) {
        // 长度字段不合理，说明已经错位了，再切下去只会越错越远
        console.log(`  !! ${label}无法解析（长度字段 = ${len}），停止记录但继续转发`);
        broken = true;
        return;
      }
      if (buf.length - o < len + 2) break; // 还没收全，等下一块
      const type = buf[o + 2];
      const payload = buf.subarray(o + 3, o + 2 + len);
      o += len + 2;
      try {
        onPacket(type, payload);
      } catch (e) {
        console.log(`  !! 解析包 0x${type.toString(16)} 出错：${e.message}`);
      }
    }
    buf = buf.subarray(o);
  };
}

/* ------------------------------------------------------------------ *
 * .yrp3d 落盘
 *
 * 建立连接就开文件，边收边追加 —— 中途崩了也不会全丢。
 * ------------------------------------------------------------------ */
function yrpPacket(type, payload) {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32LE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

function stampName() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w || 2, "0");
  return (
    `${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `「${p(d.getHours())}：${p(d.getMinutes())}：${p(d.getSeconds())}」`
  );
}

function uniquePath(dir, base) {
  let p = path.join(dir, base + ".yrp3d");
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base}_${i}.yrp3d`);
  return p;
}

class Recorder {
  // dir 只有测试会传；正常跑用模块的 OUT。
  // prefix 用来把观战录像和代理录像区分开（观战端传房间名）。
  constructor(dir, prefix) {
    const out = dir || OUT;
    fs.mkdirSync(out, { recursive: true });
    // 房间名是用户随手起的，可能带 Windows 文件名非法字符，落盘前先洗一遍
    const tag = prefix ? String(prefix).replace(/[\\/:*?"<>|]/g, "_").trim() : "";
    this.file = uniquePath(out, tag ? `${tag}-${stampName()}` : stampName());
    this.fd = fs.openSync(this.file, "w");
    this.seats = new Array(SEATS).fill(null); // 座位 -> 名字
    this.mySeat = null;
    this.written = 0; // 已写进文件的对话条数
    this.nameDirty = true; // 名字表要不要重写
    this.recent = []; // recordOwnChat 的回声去重窗口
    this.closed = false;
  }

  get name() {
    return path.basename(this.file);
  }

  write(buf) {
    if (this.closed) return;
    try {
      fs.writeSync(this.fd, buf);
    } catch (e) {
      console.log(`  !! 写录像失败：${e.message}`);
    }
  }

  // 座位表变了就重写一个 235 包。提取器取最后一个，所以重复写是安全的。
  flushNames() {
    if (!this.nameDirty) return;
    if (!this.seats.some(Boolean)) return; // 一个名字都还不知道，先别写
    this.nameDirty = false;
    // 实测布局：[P0, '---', P0, P1, '---', P1]，下标 0 和 3 才是有效名字
    const s = [
      this.seats[0] || "", "---", this.seats[0] || "",
      this.seats[1] || "", "---", this.seats[1] || "",
    ];
    const pl = Buffer.alloc(6 * 100 + 4);
    s.forEach((n, i) => encodeU16z(n, 100).copy(pl, i * 100));
    pl.writeUInt32LE(6, 600);
    this.write(yrpPacket(SIBYL_NAME, pl));
  }

  chat(playerType, msg) {
    this.flushNames();
    const m = encodeU16z(msg);
    const pl = Buffer.alloc(4 + m.length);
    pl.writeUInt32LE(playerType >>> 0, 0); // 线上是 uint16，录像里是 uint32，值不变
    m.copy(pl, 4);
    this.write(yrpPacket(SIBYL_CHAT, pl));
    this.written++;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      fs.closeSync(this.fd);
    } catch (_) {}
  }
}

/* ------------------------------------------------------------------ *
 * 会话：一条客户端连接 = 一个录像文件
 * ------------------------------------------------------------------ */
class Session {
  constructor(dir, prefix) {
    this.rec = new Recorder(dir, prefix);
    // 从模块级 cfg 拷一份，别在方法里直接读它 —— observer.js 复用这个类时
    // 根本没走过 start()，那时 cfg 还是 null。
    this.recordOwnChat = !!(cfg && cfg.recordOwnChat);
    this.remote = null;
    this.seats = {}; // pos -> 名字
    this.hist = {}; // 包类型 -> 次数，断开时打印，方便诊断非标准服务器
    console.log(`\n[${clock()}] 新连接 -> ${this.rec.name}`);
  }

  count(type) {
    this.hist[type] = (this.hist[type] || 0) + 1;
  }

  nameOf(pos) {
    return this.seats[pos] || `座位${pos}`;
  }

  /** 客户端 -> 服务器 */
  fromClient(type, payload) {
    this.count(type);
    if (type === CTOS_PLAYER_INFO) {
      // uint16 name[20]，我自己的昵称
      const me = decodeU16z(payload);
      if (me) console.log(`  [${clock()}] 我的昵称：${me}`);
    } else if (type === CTOS_CHAT) {
      const msg = decodeU16z(payload);
      if (!msg) return;
      if (this.recordOwnChat) {
        // 服务器通常会把发言广播回来，自己再记一份就重复了 —— 记个指纹，
        // 5 秒内收到同样的广播就跳过一次。
        this.rec.recent.push({ msg, at: Date.now() });
        this.rec.chat(this.rec.mySeat == null ? 0 : this.rec.mySeat, msg);
        console.log(`  [${clock()}] 我：${msg}`);
      }
    }
  }

  /** 服务器 -> 客户端 */
  fromServer(type, payload) {
    this.count(type);
    switch (type) {
      case STOC_HS_PLAYER_ENTER: {
        if (payload.length < 41) return this.warnShort(type, payload.length, 41);
        const name = decodeU16z(payload.subarray(0, 40));
        const pos = payload[40];
        if (pos > 3) return; // 观战者位置，录像里没有对应槽位
        if (this.seats[pos] === name) return;
        this.seats[pos] = name;
        this.rec.seats[pos] = name;
        this.rec.nameDirty = true;
        return;
      }
      case STOC_HS_PLAYER_CHANGE: {
        if (payload.length < 1) return this.warnShort(type, payload.length, 1);
        const status = payload[0];
        const pos = (status >> 4) & 0xf;
        const state = status & 0xf;
        if (state === PLAYERCHANGE_LEAVE && pos <= 3) {
          delete this.seats[pos];
          this.rec.seats[pos] = null;
          this.rec.nameDirty = true;
        }
        return;
      }
      case STOC_TYPE_CHANGE: {
        if (payload.length < 1) return this.warnShort(type, payload.length, 1);
        const seat = payload[0] & 0xf;
        this.rec.mySeat = seat < SEATS ? seat : null; // 7 = 观战
        return;
      }
      case STOC_CHAT: {
        if (payload.length < 4) return this.warnShort(type, payload.length, 4);
        const playerType = payload.readUInt16LE(0);
        const msg = decodeU16z(payload, 2);
        if (!msg) return;
        // recordOwnChat 开着的时候跳过自己那条回声（指纹 5 秒内有效）
        const now = Date.now();
        this.rec.recent = this.rec.recent.filter((r) => now - r.at < 5000);
        if (this.recordOwnChat && playerType === this.rec.mySeat) {
          const i = this.rec.recent.findIndex((r) => r.msg === msg);
          if (i >= 0) {
            this.rec.recent.splice(i, 1);
            return;
          }
        }
        this.rec.chat(playerType, msg);
        console.log(`  [${clock()}] ${whoLabel(playerType, this.seats)}: ${msg}`);
        return;
      }
      default:
        return;
    }
  }

  warnShort(type, got, want) {
    console.log(`  !! 包 0x${type.toString(16)} 只有 ${got} 字节（至少要 ${want}），已跳过`);
  }

  finish() {
    this.rec.close();
    const kb = fs.existsSync(this.rec.file) ? fs.statSync(this.rec.file).size : 0;
    const kinds = Object.keys(this.hist)
      .map(Number)
      .sort((a, b) => a - b)
      .map((t) => `0x${t.toString(16).padStart(2, "0")}×${this.hist[t]}`)
      .join(" ");
    console.log(
      `[${clock()}] 断开：${this.rec.name} —— ${this.rec.written} 条对话，${kb} 字节`
    );
    if (kinds) console.log(`  见到的包类型：${kinds}`);
  }
}

function whoLabel(playerType, seats) {
  if (playerType < 4) return seats[playerType] || `座位${playerType}`;
  if (playerType === 7) return "观战者";
  if (playerType === 8 || playerType === 9) return "系统";
  return "服务器";
}

/* ------------------------------------------------------------------ *
 * 输出小工具
 * ------------------------------------------------------------------ */
function clock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function openDump() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const f = path.join(OUTDIR, `_dump_${stampName().replace(/[「」：]/g, "-")}.log`);
  dumpFd = fs.openSync(f, "w");
  dumpCounts = {};
  console.log(`诊断模式：每个包都会写进 ${path.basename(f)}\n`);
}

function dump(dir, type, payload) {
  if (!dumpFd) return;
  const k = `${dir}0x${type.toString(16).padStart(2, "0")}`;
  dumpCounts[k] = (dumpCounts[k] || 0) + 1;
  const hex = payload.length > 64 ? payload.subarray(0, 64).toString("hex") + "…" : payload.toString("hex");
  try {
    fs.writeSync(dumpFd, `${clock()} ${dir} type=0x${type.toString(16).padStart(2, "0")} len=${payload.length} ${hex}\n`);
  } catch (_) {}
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */
let cfg = null;

// 这份默认值同时是**首次运行的预填值**（下面的 ask() 都拿它当 fallback）和
// 配置缺字段时的兜底。改这里必须同步改 observer.js 和 gui.js 里那两份 ——
// gui.js 那边的注释写了原因。
const DEFAULT_HOST = "example.com";
const DEFAULT_PORT = 888;
const DEFAULTS = {
  remoteHost: DEFAULT_HOST,
  remotePort: DEFAULT_PORT,
  listenPort: DEFAULT_PORT,
  recordOwnChat: false,
};

function ask(question, fallback) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) =>
    rl.question(fallback ? `${question}（回车 = ${fallback}）: ` : `${question}: `, (a) => {
      rl.close();
      res(a.trim() || fallback || "");
    })
  );
}

function loadConfig() {
  if (!RECONFIG && fs.existsSync(CFG_PATH)) {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CFG_PATH, "utf8")));
    } catch (e) {
      console.log(`config.json 读不出来（${e.message}），重新配置一遍。\n`);
    }
  }
  return null;
}

function saveConfig(c) {
  fs.writeFileSync(CFG_PATH, JSON.stringify(c, null, 2) + "\n", "utf8");
}

async function configure() {
  console.log("== 首次使用，先填一下第三方服务器的地址 ==\n");
  console.log("（就是你在 ygopro 客户端里平时填的那个服务器地址和端口）\n");
  // 问的时候带上默认值：直接回车就是它。全部清空则会退回默认值而不是报错，
  // 因为 DEFAULTS 里本来就有值（想换服务器就把它覆盖掉重打）。
  const host = await ask("第三方服务器地址（域名或 IP）", DEFAULT_HOST);
  const remotePort = parseInt(await ask("第三方服务器端口", String(DEFAULT_PORT)), 10);
  const listenPort = parseInt(
    await ask("本机监听端口（客户端等一会儿要连这个）", String(remotePort || DEFAULT_PORT)),
    10
  );
  const c = {
    remoteHost: host || DEFAULT_HOST,
    remotePort: remotePort || DEFAULT_PORT,
    listenPort: listenPort || DEFAULT_PORT,
    recordOwnChat: false,
  };
  saveConfig(c);
  console.log(`\n已写入 config.json。\n`);
  return c;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
// config / outDir 只有测试会传；正常跑用上面的 cfg 和 OUTDIR。
function start(config, outDir) {
  if (config) cfg = config;
  if (outDir) OUT = outDir;
  const server = net.createServer((client) => {
    const sess = new Session(OUT);

    const remote = net.connect(cfg.remotePort, cfg.remoteHost);
    sess.remote = remote;
    remote.setNoDelay(true);
    client.setNoDelay(true);

    const feedC = makeSplitter((t, p) => {
      dump("→", t, p);
      sess.fromClient(t, p);
    }, "客户端方向");
    const feedS = makeSplitter((t, p) => {
      dump("←", t, p);
      sess.fromServer(t, p);
    }, "服务器方向");

    client.on("data", (chunk) => {
      feedC(chunk);
      if (!remote.write(chunk)) client.pause();
    });
    remote.on("drain", () => client.resume());

    remote.on("data", (chunk) => {
      feedS(chunk);
      if (!client.write(chunk)) remote.pause();
    });
    client.on("drain", () => remote.resume());

    remote.on("connect", () => {
      console.log(`[${clock()}] 已连上 ${cfg.remoteHost}:${cfg.remotePort}`);
    });

    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      if (why) console.log(`  (${why})`);
      sess.finish();
    };
    client.on("close", () => {
      remote.destroy();
      finish("客户端断开");
    });
    remote.on("close", () => {
      client.destroy();
      finish("服务器断开");
    });
    client.on("error", (e) => {
      console.log(`  !! 客户端连接出错：${e.message}`);
      remote.destroy();
      finish("客户端出错");
    });
    remote.on("error", (e) => {
      console.log(`  !! 连不上 ${cfg.remoteHost}:${cfg.remotePort} —— ${e.message}`);
      console.log(`     检查 config.json 里的地址和端口，以及本机网络。`);
      client.destroy();
      finish("服务器出错");
    });
  });

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.log(`\n!! 端口 ${cfg.listenPort} 已被占用。`);
      console.log(`   可能是代理已经开着一个了，或者别的程序占了。`);
      console.log(`   改 config.json 里的 listenPort 换个端口重试。\n`);
    } else {
      console.log(`\n!! 代理启动失败：${e.message}\n`);
    }
    process.exit(1);
  });

  server.listen(cfg.listenPort, "127.0.0.1", () => {
    // 报告真正绑上的端口，不是配置里写的那个（listenPort 为 0 时由系统分配）
    const port = server.address().port;
    console.log("─".repeat(60));
    console.log("  对话记录代理已启动\n");
    console.log(`  监听：127.0.0.1:${port}   （客户端填这个）`);
    console.log(`  转发到：${cfg.remoteHost}:${cfg.remotePort}`);
    console.log(`  录像存到：${OUT}`);
    console.log("\n  现在打开 ygopro，把服务器地址改成 127.0.0.1，");
    console.log(`  端口改成 ${port}，然后正常打牌 / 观战就行。`);
    console.log("\n  打完回界面里就能看和导出（命令行用户拖进 ../chat-extractor.html 也一样）。");
    console.log("  按 Ctrl+C 退出。");
    console.log("─".repeat(60) + "\n");
  });
  return server;
}

async function main() {
  if (DUMP) openDump();
  let c = loadConfig();
  if (!c) {
    c = await configure();
  }
  if (!c.remoteHost) {
    console.log(
      "config.json 里没写 remoteHost。正常用法是在界面里填上「对方服务器」再启动；\n" +
        "  命令行的话跑一次 `node proxy.js --config` 补上。"
    );
    process.exit(1);
  }
  start(c);
}

// 只有直接跑才启动服务；被测试 require 进来时只拿函数。
if (require.main === module) {
  process.on("SIGINT", () => {
    console.log("\n代理已退出。");
    process.exit(0);
  });
  main();
}

// observer.js 复用这里的切帧/落盘/会话，所以协议常量也要一并导出。
const WIRE = {
  STOC_ERROR_MSG,
  STOC_TYPE_CHANGE,
  STOC_CHAT,
  STOC_HS_PLAYER_ENTER,
  STOC_HS_PLAYER_CHANGE,
  CTOS_PLAYER_INFO,
  CTOS_JOIN_GAME,
  CTOS_CHAT,
  CTOS_HS_TOOBSERVER,
  PRO_VERSION,
  ERROR_VERSION_MISMATCH,
  SEATS,
};

module.exports = {
  makeSplitter,
  decodeU16z,
  encodeU16z,
  yrpPacket,
  frame,
  openDump,
  dump,
  Recorder,
  Session,
  start,
  DEFAULTS,
  WIRE,
};
