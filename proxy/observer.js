#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * 无头观战端
 *
 * 和 proxy.js 的区别：proxy.js 要改客户端、要挂在那儿转发；
 * 这个不用 —— 它自己就是一个 ygopro 客户端，直接连服务器、以观战身份
 * 坐进一个房间，只收不发（除了握手），把对话记成 .yrp3d。
 *
 * 客户端加入房间的流程（ygopro/gframe/duelclient.cpp:147-201）：
 *   CTOS_PLAYER_INFO（昵称） -> CTOS_JOIN_GAME（版本 + gameid=0 + 房间名）
 * 服务器一定会先把你当玩家坐下，收到 STOC_TYPE_CHANGE 发现自己有座位号时
 * 再补一个 CTOS_HS_TOOBSERVER 让出座位 —— 和真人点「观战」是一回事。
 *
 * 观战者不受心跳约束（ygopro-server.coffee:1166，client.pos > 3 直接跳过），
 * 所以可以一直挂着。
 * ------------------------------------------------------------------ */
"use strict";

const net = require("net");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const {
  makeSplitter,
  encodeU16z,
  frame,
  Session,
  openDump,
  dump,
  WIRE,
} = require("./proxy.js");

// 见 proxy.js 里同名常量：YRP_DATA_DIR 是给测试用的，默认还是脚本所在目录；
// YRP_REPLAYS_DIR 是界面把录像目录改到别处之后传下来的。
const DATA = process.env.YRP_DATA_DIR || __dirname;
const CONFIG = path.join(DATA, "observer.json");
const OUTDIR = process.env.YRP_REPLAYS_DIR || path.join(DATA, "replays");

// 服务器这两项要和 proxy.js 的 DEFAULTS、gui.js 的 DEFAULTS 保持一致 ——
// 三份不一致的话会出现「界面显示的是一套、子进程实际跑的是另一套」。
// 房间名没有合理的默认值（服务器会给你新建一个空房间，见下），留空必填。
const DEFAULTS = {
  host: "mygo.superpre.pro",
  port: 888,
  room: "",
  name: "观战记录",
  version: WIRE.PRO_VERSION,
};

/* ------------------------------------------------------------------ *
 * 握手包
 * ------------------------------------------------------------------ */

// CTOS_JoinGame，sizeof == 48：uint16 version + 2 字节填充 + uint32 gameid
// + uint16 pass[20]。gameid 恒为 0（真人客户端也一样，房间靠 pass 选）。
function encodeJoinGame(version, room) {
  const b = Buffer.alloc(48);
  b.writeUInt16LE(version & 0xffff, 0);
  b.writeUInt32LE(0, 4);
  encodeU16z(room, 40).copy(b, 8);
  return b;
}

function clock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ------------------------------------------------------------------ *
 * 观战端
 * ------------------------------------------------------------------ */
class Observer {
  constructor(cfg, opts) {
    this.cfg = cfg;
    this.opts = opts || {};
    this.sess = null;
    this.sock = null;
    this.retried = false; // 版本不符只自动重连一次，避免打转
    this.promoted = false; // 已经让出座位切成观战
    this.seenPlayers = false; // 见过真人玩家进场
    this.retryWith = null; // 待重连时用的版本号
    this.ended = false;
    this.idleTimer = null;
    this.done = null;
  }

  log(msg) {
    console.log(`[${clock()}] ${msg}`);
  }

  // 录像文件等真的进了房间才建。版本不对时服务器会立刻踢人，
  // 那种失败不该在 replays/ 里留一个空文件。
  ensureSession() {
    if (!this.sess) {
      this.sess = new Session(this.opts.outDir, this.cfg.room);
      this.idleTimer = setTimeout(() => this.hintIfEmpty(), 20000);
    }
    return this.sess;
  }

  // 房间名打错的话，服务器会当成新房间建一个空的（ROOM_find_or_create_by_name
  // 找不到就 new Room），于是我们安安静静地录一个没人的房间。必须提醒。
  hintIfEmpty() {
    if (this.ended || !this.sess || this.sess.rec.written || this.seenPlayers) return;
    console.log("");
    console.log("  ⚠ 20 秒了，房间里没见到别的玩家，也没录到任何对话。");
    console.log("    如果房间名和客户端里填的不完全一致，服务器会给你新建一个空房间。");
    console.log("    请核对 observer.json 里的 room（区分大小写，带密码的房间要写成 房间名$密码）。");
    console.log("");
  }

  run() {
    return new Promise((resolve) => {
      this.done = resolve;
      this.connect(this.cfg.version);
    });
  }

  connect(version) {
    console.log(
      `\n连 ${this.cfg.host}:${this.cfg.port} —— 房间「${this.cfg.room}」，昵称「${this.cfg.name}」`
    );

    const sock = net.connect(this.cfg.port, this.cfg.host);
    this.sock = sock;
    const feed = makeSplitter((t, p) => this.onPacket(t, p), "服务器");

    sock.setNoDelay(true);
    sock.on("connect", () => {
      this.log("已连上，正在加入房间…");
      sock.write(frame(WIRE.CTOS_PLAYER_INFO, encodeU16z(this.cfg.name, 40)));
      sock.write(frame(WIRE.CTOS_JOIN_GAME, encodeJoinGame(version, this.cfg.room)));
    });
    sock.on("data", feed);
    sock.on("error", (e) => {
      console.log(`  连不上 ${this.cfg.host}:${this.cfg.port} —— ${e.message}`);
    });
    sock.on("close", () => this.finish());
  }

  onPacket(type, payload) {
    if (this.opts.dump) dump("S→", type, payload);

    // 版本不符要单独处理：这时候我们还没进房间，不能连累录像
    if (type === WIRE.STOC_ERROR_MSG) return this.onError(payload);

    this.ensureSession().fromServer(type, payload);

    if (type === WIRE.STOC_HS_PLAYER_ENTER && payload.length >= 41) {
      if (payload[40] <= 3) this.seenPlayers = true;
    } else if (type === WIRE.STOC_TYPE_CHANGE && payload.length >= 1) {
      // 有座位号说明服务器把我们当玩家坐下了，让出去
      if ((payload[0] & 0xf) < WIRE.SEATS) this.becomeObserver();
    }
  }

  becomeObserver() {
    if (this.promoted) return;
    this.promoted = true;
    this.log("占了玩家位，切换到观战…");
    this.sock.write(frame(WIRE.CTOS_HS_TOOBSERVER, Buffer.alloc(0)));
  }

  onError(payload) {
    if (payload.length < 8) return this.log("服务器返回了一个格式不对的错误包，已忽略");
    const msg = payload[0];
    const code = payload.readUInt32LE(4);

    if (msg === WIRE.ERROR_VERSION_MISMATCH) {
      if (this.retried) {
        console.log(`  版本还是不对（服务器要 ${code}）。请把 observer.json 里的 version 改成 ${code}。`);
        return;
      }
      this.retried = true;
      this.retryWith = code;
      this.log(`版本不符：我发的是 ${this.cfg.version}，服务器要 ${code}。用 ${code} 重连…`);
      this.cfg.version = code;
      saveConfig(this.cfg, this.opts.configPath);
      return;
    }

    // 其余都是 stoc_die 之类，服务器紧接着就会断开
    this.log(`服务器拒绝了这个连接（错误码 ${msg}，附加 ${code}）`);
  }

  finish() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;

    if (this.sess) this.sess.finish();
    else console.log(`[${clock()}] 没进到房间里，所以没有生成录像。`);

    if (this.retryWith != null) {
      const v = this.retryWith;
      this.retryWith = null;
      this.ended = false;
      this.sess = null;
      this.promoted = false;
      this.seenPlayers = false;
      this.sock = null;
      setTimeout(() => this.connect(v), 300);
      return;
    }

    // 不自动重连：房主关掉房间后重连只会让服务器给我们新建一个空房间，
    // 越连越乱。要接着盯就手动再跑一次。
    if (this.done) this.done();
  }
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */
function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG, "utf8")) };
  } catch (_) {
    return null;
  }
}

// p 只有测试会传 —— 学到新版本号要回写配置，测试不能污染真配置。
function saveConfig(c, p) {
  try {
    fs.writeFileSync(p || CONFIG, JSON.stringify(c, null, 2) + "\n");
  } catch (e) {
    console.log(`  !! 写配置失败：${e.message}`);
  }
}

function ask(question, fallback) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) =>
    rl.question(fallback ? `${question}（回车 = ${fallback}）: ` : `${question}: `, (a) => {
      rl.close();
      res(a.trim() || fallback || "");
    })
  );
}

async function configure(base) {
  const b = base || DEFAULTS;
  console.log("先填几项，填完记在 observer.json 里，以后不再问。\n");

  let host = "";
  while (!host) host = await ask("第三方服务器地址（域名或 IP）", b.host);

  const port = parseInt(await ask("第三方服务器端口", String(b.port)), 10) || DEFAULTS.port;

  let room = "";
  while (!room) {
    room = await ask("房间名（要和客户端里填的完全一致）", b.room);
    if (!room) console.log("  房间名不能空。带密码的房间写成「房间名$密码」。");
  }
  if ([...room].length > 19) {
    console.log(`  [!] 房间名超过 19 个字，协议里放不下，会被截断成「${[...room].slice(0, 19).join("")}」。`);
  }

  const name = await ask("观战用的昵称（服务器要一个名字）", b.name);

  const c = { host, port, room, name, version: b.version };
  saveConfig(c);
  console.log(`\n已写入 ${path.basename(CONFIG)}，以后直接双击「observer.bat」就行。`);
  return c;
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */
async function main() {
  const argv = process.argv.slice(2);
  const opts = { dump: argv.includes("--dump"), outDir: OUTDIR };
  if (opts.dump) openDump();

  let cfg = loadConfig();
  if (!cfg || !cfg.host || !cfg.room || argv.includes("--config")) cfg = await configure(cfg);

  console.log("正在观战记录。想停就按 Ctrl+C，或者直接关掉这个窗口。");

  const ob = new Observer(cfg, opts);
  const stop = () => {
    console.log("\n停止观战…");
    if (ob.sock) ob.sock.destroy();
    else ob.finish();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await ob.run();
  console.log("观战结束。录像在 replays\\ 目录里。");
  // chat-extractor.html 在上一级（proxy/ 的兄弟）—— 打包后也是这个相对位置，
  // 因为 resources/app/ 就是源码树的平铺副本
  console.log("回界面里就能看和导出；命令行用户拖进 ..\\chat-extractor.html 也一样。");
}

if (require.main === module) main();

module.exports = { Observer, encodeJoinGame, loadConfig, saveConfig, DEFAULTS };
