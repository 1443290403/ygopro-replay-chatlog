// 观战端测试。起一个假 srvpro，按真实协议回包，看 observer.js 的应答对不对。
//
// observer.js 是 CommonJS，这里用 createRequire 拿进来。
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const { Observer, encodeJoinGame, loadConfig, saveConfig } = require("./observer.js");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "obs-test-"));

let failed = 0;
function ok(cond, what, extra) {
  if (cond) console.log(`  ok   ${what}`);
  else {
    failed++;
    console.log(`  FAIL ${what}${extra ? `\n       ${extra}` : ""}`);
  }
}

// ---- 线上帧，和服务端同一套 -----------------------------------------
const P = {
  ERROR_MSG: 0x02,
  JOIN_GAME: 0x12,
  TYPE_CHANGE: 0x13,
  CHAT: 0x19,
  PLAYER_ENTER: 0x20,
  PLAYER_INFO: 0x10,
  JOIN_GAME_CTOS: 0x12,
  TOOBSERVER: 0x21,
};

function frame(type, payload) {
  const b = Buffer.alloc(3 + payload.length);
  b.writeUInt16LE(1 + payload.length, 0);
  b[2] = type;
  payload.copy(b, 3);
  return b;
}
function u16z(s, cap) {
  const b = Buffer.alloc(cap || (s.length + 1) * 2);
  const n = Math.min(s.length, (b.length >> 1) - 1);
  for (let i = 0; i < n; i++) b.writeUInt16LE(s.charCodeAt(i), i * 2);
  return b;
}
function readU16z(buf, off = 0) {
  let s = "";
  for (let i = off; i + 1 < buf.length; i += 2) {
    const c = buf.readUInt16LE(i);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}
// 按 [uint16 len][uint8 type][payload] 切客户端发来的包
function splitter(onPacket) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let o = 0;
    while (buf.length - o >= 3) {
      const len = buf.readUInt16LE(o);
      if (len < 1 || buf.length - o < len + 2) break;
      onPacket(buf[o + 2], buf.subarray(o + 3, o + 2 + len));
      o += len + 2;
    }
    buf = buf.subarray(o);
  };
}

/* ------------------------------------------------------------------ *
 * 假 srvpro：记录客户端发来的每个包，由每个用例自己决定怎么回
 * ------------------------------------------------------------------ */
function fakeServer(onFrame) {
  const got = []; // { type, payload }
  const server = net.createServer((sock) => {
    const feed = splitter((type, payload) => {
      got.push({ type, payload });
      onFrame(type, payload, sock, got);
    });
    sock.on("data", feed);
    sock.on("error", () => {});
  });
  return new Promise((res) =>
    server.listen(0, "127.0.0.1", () =>
      res({ server, got, port: server.address().port, close: () => server.close() })
    )
  );
}

function waitClose(ob) {
  return ob.run();
}

/* ------------------------------------------------------------------ *
 * 1. 握手包长得对不对
 * ------------------------------------------------------------------ */
console.log("\n1. 握手包格式");
{
  const cfg = { host: "127.0.0.1", port: 0, room: "测试房$pw", name: "旁观", version: 4962 };
  // 直接用导出的构造函数验证，不走网络
  const jg = encodeJoinGame(4962, "测试房$pw");
  ok(jg.length === 48, "CTOS_JOIN_GAME 是 48 字节", `实际 ${jg.length}`);
  ok(jg.readUInt16LE(0) === 4962, "版本写在偏移 0");
  ok(jg.readUInt32LE(4) === 0, "gameid 恒为 0（房间靠 pass 选）");
  ok(readU16z(jg, 8) === "测试房$pw", "房间名写在偏移 8", `实际 ${readU16z(jg, 8)}`);

  const pi = u16z("旁观", 40);
  ok(pi.length === 40, "CTOS_PLAYER_INFO 是 40 字节");
  ok(readU16z(pi) === "旁观", "昵称能解出来");

  // 19 字上限：协议里 pass 只有 uint16[20]
  const long = "一二三四五六七八九十一二三四五六七八九十";
  ok(readU16z(encodeJoinGame(1, long), 8).length === 19, "超长房间名被截到 19 字");
  void cfg;
}

/* ------------------------------------------------------------------ *
 * 2. 版本不符 -> 学会新版本 -> 用新版本重连
 * ------------------------------------------------------------------ */
console.log("\n2. 版本自动学习");
{
  const versions = [];
  let conn = 0;
  const cfgPath = path.join(TMP, "cfg.json");
  const { server, port, close } = await fakeServer((type, payload, sock) => {
    if (type !== P.JOIN_GAME_CTOS) return;
    versions.push(payload.readUInt16LE(0));
    conn++;
    if (conn === 1) {
      // 真实服务器：stoc_die 之前先发 ERROR_MSG{msg:4, code:期望版本}
      const err = Buffer.alloc(8);
      err[0] = 4;
      err.writeUInt32LE(4945, 4);
      sock.write(frame(P.ERROR_MSG, err));
      sock.end();
    }
    // 第二次不踢，让它挂着
  });

  const cfg = { host: "127.0.0.1", port, room: "房", name: "旁观", version: 9999 };
  const ob = new Observer(cfg, { outDir: path.join(TMP, "out"), configPath: cfgPath });
  const run = waitClose(ob);
  setTimeout(() => ob.sock && ob.sock.destroy(), 1500);
  await run;
  await new Promise((r) => setTimeout(r, 200));

  ok(versions[0] === 9999, "第一次用配置里的版本", `实际 ${versions[0]}`);
  ok(versions[1] === 4945, "第二次用服务器告知的版本", `实际 ${versions[1]}`);
  ok(cfg.version === 4945, "配置对象被更新");
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (_) {}
  ok(saved && saved.version === 4945, "新版本回写进了配置文件");
  ok(conn === 2, "只重连了一次", `实际 ${conn} 次`);

  // 没进房间就不该留下空录像
  const files = fs.existsSync(path.join(TMP, "out")) ? fs.readdirSync(path.join(TMP, "out")) : [];
  ok(files.length === 0, "版本失败没有生成空的录像文件", `实际 ${files.join(",")}`);
  close();
}

/* ------------------------------------------------------------------ *
 * 3. 完整流程：坐下 -> 让座 -> 收对话 -> 落盘 -> 提取器能读
 * ------------------------------------------------------------------ */
console.log("\n3. 完整观战流程");
{
  const outDir = path.join(TMP, "full");
  const { server, got, port, close } = await fakeServer((type, payload, sock) => {
    if (type === P.JOIN_GAME_CTOS) {
      // 真实内核：先 JOIN_GAME 再 TYPE_CHANGE（single_duel.cpp:148-149）
      const scjg = Buffer.alloc(2);
      scjg.writeUInt16LE(0x1362, 0);
      sock.write(frame(P.JOIN_GAME, scjg));
      sock.write(frame(P.TYPE_CHANGE, Buffer.from([1]))); // 座位 1 = 玩家
    } else if (type === P.TOOBSERVER) {
      sock.write(frame(P.TYPE_CHANGE, Buffer.from([7]))); // 观战
      // 座位表 + 对话
      const pe = Buffer.alloc(41);
      u16z("房主", 40).copy(pe, 0);
      pe[40] = 0;
      sock.write(frame(P.PLAYER_ENTER, pe));
      const pe2 = Buffer.alloc(41);
      u16z("挑战者", 40).copy(pe2, 0);
      pe2[40] = 1;
      sock.write(frame(P.PLAYER_ENTER, pe2));

      const chat = (pt, msg) => {
        const m = u16z(msg);
        const pl = Buffer.alloc(2 + m.length);
        pl.writeUInt16LE(pt, 0);
        m.copy(pl, 2);
        sock.write(frame(P.CHAT, pl));
      };
      chat(0, "你好");
      chat(1, "好久不见");
      chat(7, "围观");
      setTimeout(() => sock.end(), 300);
    }
  });

  const cfg = { host: "127.0.0.1", port, room: "朋友的房", name: "旁观", version: 4962 };
  const ob = new Observer(cfg, { outDir });
  await ob.run();

  const pi = got.find((g) => g.type === P.PLAYER_INFO);
  ok(!!pi, "发了 CTOS_PLAYER_INFO");
  ok(pi && readU16z(pi.payload) === "旁观", "昵称是配置里的");

  const ts = got.filter((g) => g.type === P.TOOBSERVER);
  ok(ts.length === 1, "只让座一次（重复的 TYPE_CHANGE 不会重复发）", `实际 ${ts.length} 次`);
  ok(
    got.findIndex((g) => g.type === P.TOOBSERVER) > got.findIndex((g) => g.type === P.JOIN_GAME_CTOS),
    "让座发生在加入房间之后"
  );

  const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".yrp3d"));
  ok(files.length === 1, "生成了 1 个录像文件", `实际 ${files.length}`);
  ok(files[0].startsWith("朋友的房-"), "文件名带房间名前缀", files[0]);

  // 用产品自带的解析器验，这才是真正的验收标准（抠法和别的套件共用 _parser.js）
  const { extract } = require("../_parser.js").loadExtractor();
  const r = extract(files[0], new Uint8Array(fs.readFileSync(path.join(outDir, files[0]))));
  ok(r.ok, "提取器读得动", r.error);

  const texts = r.chats.map((c) => c.msg);
  ok(texts.includes("你好"), "提取到座位 0 的发言");
  ok(texts.includes("好久不见"), "提取到座位 1 的发言");
  ok(texts.includes("围观"), "提取到观战者的发言");

  const byMsg = {};
  for (const c of r.chats) byMsg[c.msg] = c.who;
  ok(byMsg["你好"] === "房主", "座位 0 认出了名字", `实际 ${byMsg["你好"]}`);
  ok(byMsg["好久不见"] === "挑战者", "座位 1 认出了名字", `实际 ${byMsg["好久不见"]}`);
  ok(byMsg["围观"] === "观战者", "观战发言标成观战者", `实际 ${byMsg["围观"]}`);

  close();
}

/* ------------------------------------------------------------------ *
 * 4. 服务器不发 TYPE_CHANGE 时不乱发让座包
 * ------------------------------------------------------------------ */
console.log("\n4. 异常情况");
{
  const { port, got, close } = await fakeServer(() => {});
  const cfg = { host: "127.0.0.1", port, room: "房", name: "旁观", version: 1 };
  const ob = new Observer(cfg, { outDir: path.join(TMP, "q") });
  const run = ob.run();
  await new Promise((r) => setTimeout(r, 400));
  ok(!got.some((g) => g.type === P.TOOBSERVER), "没收到 TYPE_CHANGE 就不发让座包");
  ob.sock.destroy();
  await run;
  close();
}

/* ------------------------------------------------------------------ *
 * 5. 连不上时不崩、报告清楚
 * ------------------------------------------------------------------ */
console.log("\n5. 连不上");
{
  const cfg = { host: "127.0.0.1", port: 1, room: "房", name: "旁观", version: 1 };
  const ob = new Observer(cfg, { outDir: path.join(TMP, "dead") });
  await ob.run();
  ok(ob.sess === null, "没生成会话");
  ok(fs.existsSync(path.join(TMP, "dead")) === false, "也没建输出目录");
}

/* ------------------------------------------------------------------ *
 * 6. 配置读写
 * ------------------------------------------------------------------ */
console.log("\n6. 配置");
{
  const p = path.join(TMP, "c2.json");
  saveConfig({ host: "h", port: 7911, room: "r", name: "n", version: 42 }, p);
  const back = JSON.parse(fs.readFileSync(p, "utf8"));
  ok(back.version === 42 && back.room === "r", "saveConfig 写对了");
  void loadConfig;
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(failed ? `\n${failed} 个失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
