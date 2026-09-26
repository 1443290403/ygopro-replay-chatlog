// 安卓侧 Node 后端的离线测试：**不碰安卓**，普通 node 就能跑。
//
//   node tests/_test_android_backend.mjs
//
// 为什么值得写：这条路线最大的风险是「代码编过了，但真机上什么都不工作」，
// 而真机调试的反馈环很慢。而这个方案里安卓与桌面的**唯一**架构差异就是
// 「没有子进程」—— 把那个差异用一个假 ChildProcess 补上之后，整套逻辑
// 在本地就能完整跑：起观战、连一个假的 srvpro、录出 .yrp3d、解析、导出。
//
// 覆盖的正是三个最容易静默出错的地方：
//   1. YRP_DATA_DIR 的设置顺序（反了不报错，只会用错目录）
//   2. 假 ChildProcess 和 api.js 的契约（脚本名 / --dump / YRP_REPLAYS_DIR）
//   3. 桥的请求-回复配对（每条 invoke 必须兑现对应的那一条，不能串）
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import Module from "node:module";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// 本文件是 ESM（tests/ 下和 build-web.mjs 保持一致），但被测的 index.js /
// api.js / observer.js 都是 CJS —— 所以要一个 require 才能把它们拉进来
const require = createRequire(import.meta.url);

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODEJS = path.join(HERE, "www", "nodejs");

/* ⚠️ 必须在这里（**import 期**）抓住真正的 console.log。
 * index.js 一被 require 就会把 console.log/error 改道到界面的日志通道上去
 * （那是它的正经功能，observer.js 几十条日志靠它上界面）。测试要是直接用
 * console.log 打印，所有 ok/FAIL 都会被吞进那个假子进程的管子 ——
 * 表现就是「测试一个错误都不报，但也一个 ok 都不打」，最难查的那种。 */
const realLog = console.log.bind(console);
const realErr = console.error.bind(console);

let fail = 0;
const ok = (cond, what, extra = "") => {
  if (cond) realLog(`  ok   ${what}`);
  else {
    fail++;
    realLog(`  FAIL ${what}${extra ? `\n       ${extra}` : ""}`);
  }
};
const eq = (got, want, what) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  ok(a === b, what, a === b ? "" : `得到 ${a}，期望 ${b}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await wait(step);
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 假桥：把 @capawesome/capacitor-nodejs 提供的 `bridge` 顶掉。
 *
 * 用 Module._load 拦截而不是往 node_modules 里放一个真文件 ——
 * 那样会在 www/ 里多出一个**会被打进 APK** 的东西，而它只是测试用的。
 * ------------------------------------------------------------------ */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "yrp-android-"));
const posts = []; // channel.post 出去的每一条
const appHandlers = {}; // app.on 注册的
const nodeHandlers = {}; // channel.on 注册的

const fakeBridge = {
  app: {
    // 真插件返回的是 context.getFilesDir()（见 Nodejs.java:97）
    datadir: () => TMP,
    on: (ev, fn) => {
      appHandlers[ev] = fn;
    },
  },
  channel: {
    on: (ev, fn) => {
      nodeHandlers[ev] = fn;
    },
    post: (ev, payload) => {
      posts.push({ ev, payload });
    },
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "bridge") return fakeBridge;
  return origLoad.apply(this, arguments);
};

const say = realLog;

say(`临时数据目录：${TMP}\n`);

/* ------------------------------------------------------------------ *
 * 加载 index.js —— 注意 require 之前**不能**设 YRP_DATA_DIR，
 * 因为 index.js 自己会从 app.datadir() 设，那正是要验证的行为。
 * ------------------------------------------------------------------ */
delete process.env.YRP_DATA_DIR;
delete process.env.YRP_REPLAYS_DIR;

/* index.js 会注册 uncaughtException / unhandledRejection 把异常转成界面事件 ——
 * 那是正经功能，但副作用是测试里的异常不再让进程退出、也不再打印。
 * 自己再挂一对监听器把它捞回来，否则「测试静悄悄地少跑了一半」是最坏的情况。 */
process.on("uncaughtException", (e) => {
  realErr("\n!! 未捕获异常：", (e && e.stack) || e);
  fail++;
});
process.on("unhandledRejection", (e) => {
  realErr("\n!! 未处理的失败：", (e && e.stack) || (e && e.message) || e);
  fail++;
});

const mod = require(path.join(NODEJS, "index.js"));
const { api } = mod;

/* ------------------------------------------------------------------ *
 * 1. YRP_DATA_DIR 的顺序
 * ------------------------------------------------------------------ */
say("1. 数据目录（顺序错了会静默用错地方）");
eq(process.env.YRP_DATA_DIR, TMP, "index.js 把 YRP_DATA_DIR 设成了 app.datadir()");
eq(api.DATA, TMP, "api.js 加载期算出来的 DATA 就是它（说明设在 require 之前）");
eq(path.join(mod.EXPORT_DIR), path.join(TMP, "export"), "导出目录落在数据目录下");

/* observer.js 的路径同样是加载期算的。用「有没有读到刚写的配置」间接验：
 * 写进 TMP 的 observer.json，如果 observer.js 指向别处就读不到。 */
fs.writeFileSync(
  path.join(TMP, "observer.json"),
  JSON.stringify({ host: "127.0.0.1", port: 1, room: "哨兵房间", name: "谁", version: 0 })
);
const obs = require(path.join(NODEJS, "proxy", "observer.js"));
eq(obs.loadConfig().room, "哨兵房间", "observer.js 读的也是 TMP 里的 observer.json");

/* ------------------------------------------------------------------ *
 * 2. 通道表：几个不需要网络的
 * ------------------------------------------------------------------ */
say("\n2. 通道（纯本地的几个）");
eq(api.handlers["state:get"](), { ok: true, running: { proxy: false, observer: false }, parserError: null },
   "state:get：什么都没在跑，解析器加载成功");
ok(typeof api.handlers["parser:get"]().source === "string", "parser:get 能发出哨兵块的浏览器版");

{
  const r = api.handlers["config:get"]();
  eq(r.ok, true, "config:get 成功");
  eq(r.proxy.remoteHost, "example.com", "代理侧预填了默认服务器（和 demo 一致）");
}

/* ------------------------------------------------------------------ *
 * 3. 代理模式必须**明确拒绝**
 *
 * 安卓上跑不了代理（要手机自己跑客户端指向 127.0.0.1），而且 proxy.js
 * 端口被占用时会 process.exit(1) —— 进程内跑会把整个 App 的 Node 带走。
 * 拒绝本身好写，难的是「拒绝得像真的起不来一样」：api.js 是靠
 * child 的 error/exit 事件维护 procs 表的，少了 exit 界面会永远显示「运行中」。
 * ------------------------------------------------------------------ */
say("\n3. 代理模式被拒绝，而且 procs 表自己清干净");
{
  const before = posts.length;
  const r = api.handlers["proc:start"]({
    mode: "proxy",
    cfg: { remoteHost: "127.0.0.1", remotePort: 1, listenPort: 23456 },
  });
  eq(r.ok, true, "proc:start 返回成功（api.js 的语义是「进程已拉起」）");

  const cleared = await waitFor(() => !api.running().proxy);
  const evs = posts.slice(before).map((p) => p.payload);
  ok(evs.some((e) => e.t === "proc" && e.mode === "proxy" && e.running === true), "先推了 proc/running=true");
  ok(evs.some((e) => e.t === "log" && /只支持观战记录/.test(e.text || "")), "给了能看懂的拒绝理由");
  ok(cleared, "最后还是回到了「没在跑」（说明 error 之后确实补了 exit）");
  eq(api.handlers["state:get"]().running.proxy, false, "state:get 也认为它没在跑");
}

/* ------------------------------------------------------------------ *
 * 4. 真跑一场观战：假 srvpro 收人、发聊天，看 .yrp3d 落不落盘
 *
 * 这是整个测试的重点 —— 它一次性验完了假 ChildProcess、api.js 的
 * 进程账本、日志改道、observer.js 的协议，以及录像目录。
 * ------------------------------------------------------------------ */
say("\n4. 进程内跑一场真观战");

const WIRE = require(path.join(NODEJS, "proxy", "proxy.js")).WIRE;
const STOC_TYPE_CHANGE = 0x13, STOC_CHAT = 0x19, STOC_HS_PLAYER_ENTER = 0x20;

const u16 = (s) => {
  const b = Buffer.alloc((s.length + 1) * 2);
  for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), i * 2);
  return b;
};
const frame = (type, payload) => {
  const b = Buffer.alloc(3 + payload.length);
  b.writeUInt16LE(1 + payload.length, 0);
  b[2] = type;
  payload.copy(b, 3);
  return b;
};
const chat = (seat, msg) => {
  const m = u16(msg);
  const b = Buffer.alloc(2 + m.length);
  b.writeUInt16LE(seat, 0);
  m.copy(b, 2);
  return frame(STOC_CHAT, b);
};
const enter = (name, pos) => {
  const b = Buffer.alloc(41);
  u16(name).copy(b, 0, 0, 40);
  b[40] = pos;
  return frame(STOC_HS_PLAYER_ENTER, b);
};

// 等它把 JOIN_GAME 发过来再开场：这样「服务器先说话」这件事是确定的，
// 不用赌连接建立和 data 监听谁先谁后
let sawJoin = false;
const server = net.createServer((sock) => {
  sock.on("data", (c) => {
    for (let o = 0; o + 3 <= c.length; ) {
      const len = c.readUInt16LE(o);
      if (len < 1 || o + len + 2 > c.length) break;
      if (!sawJoin && c[o + 2] === WIRE.CTOS_JOIN_GAME) {
        sawJoin = true;
        // 席位 0 == 被当玩家坐下了 -> 观察者应当让位并转成观战
        sock.write(frame(STOC_TYPE_CHANGE, Buffer.from([0x00])));
        sock.write(enter("RLX", 0));
        sock.write(enter("新人", 1));
        sock.write(chat(1, "你好"));
        sock.write(chat(7, "围观一下"));
      }
      o += len + 2;
    }
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const outDir = path.join(TMP, "replays");
const before = posts.length;

try {
  const saved = api.handlers["config:save"]({
    mode: "observer",
    cfg: { host: "127.0.0.1", port, room: "测试房间", name: "观战记录", version: WIRE.PRO_VERSION },
  });
  eq(saved.ok, true, "config:save 存下了配置");
  eq(saved.cfg.room, "测试房间", "配置回读正确");
  ok(fs.existsSync(path.join(TMP, "observer.json")), "observer.json 写进了数据目录");

  // 形状照抄 gui.html:535 —— 界面传的是 {mode, cfg, dump}，cfg 是表单里的活值。
  // 少了 cfg 的话 api.js 会拿默认值校验，房间名是空的，直接报「要把房间名填上」。
  const started = api.handlers["proc:start"]({
    mode: "observer",
    cfg: { host: "127.0.0.1", port, room: "测试房间", name: "观战记录", version: WIRE.PRO_VERSION },
    dump: false,
  });
  eq(started.ok, true, "proc:start 成功");
  eq(api.running().observer, true, "api.js 认为观战在跑");

  const gotJoin = await waitFor(() => sawJoin, 5000);
  ok(gotJoin, "观察者连上了假服务器并发出了 JOIN_GAME");

  const appeared = await waitFor(() => {
    try {
      return fs.readdirSync(outDir).some((f) => f.endsWith(".yrp3d"));
    } catch (_) {
      return false;
    }
  }, 5000);
  ok(appeared, "录像文件在数据目录的 replays/ 下出现了");

  /* 日志改道：observer.js 那些 console.log 必须变成界面事件。
   * 「连 … —— 房间「测试房间」，昵称「观战记录」」是它 connect() 里的第一句。 */
  const logs = posts.slice(before).filter((p) => p.payload && p.payload.t === "log");
  ok(logs.length > 0, `日志改道到界面了（${logs.length} 条）`);
  ok(
    logs.some((p) => /测试房间/.test(p.payload.text || "")),
    "改道的日志里有房间名（说明 stdout 那根管子接对了）"
  );
  ok(logs.some((p) => p.payload.mode === "observer"), "日志被归类成 observer 模式（api.js 的 classify 在起作用）");

  // 停：走的是 child.kill() -> ob.sock.destroy()
  eq(api.handlers["proc:stop"]({ mode: "observer" }).ok, true, "proc:stop 成功");
  const stopped = await waitFor(() => !api.running().observer, 5000);
  ok(stopped, "停止后 procs 表清空了（exit 事件到了）");
  /* api.js 的约定是「失败就 throw」，不是返回 ok:false —— 所以这里必须包住。
   * 桥那边（index.js）会把它转成 {ok:false, error} 发给界面，这条在下面第 7 节验。 */
  {
    let msg = null;
    try {
      api.handlers["proc:stop"]({ mode: "observer" });
    } catch (e) {
      msg = e.message;
    }
    eq(msg, "没在跑。", "再停一次抛的是「没在跑。」而不是崩");
  }

  await wait(200);

  /* 5. 解析录出来的那个文件 */
  say("\n5. 解析刚录的录像");
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".yrp3d"));
  eq(files.length, 1, "恰好一个录像文件");
  if (files.length === 1) {
    const parsed = await api.handlers["recording:parse"]({ name: files[0] });
    eq(parsed.ok, true, "recording:parse 成功");
    eq(parsed.seats, { 0: "RLX", 1: "新人" }, "座位名解出来了");
    eq(parsed.chats.map((c) => `${c.who}/${c.kind}`), ["新人/player", "观战者/observer"],
       "说话者和身份都对");
    eq(parsed.chats.map((c) => c.msg), ["你好", "围观一下"], "对话内容按顺序");
  }

  /* 6. 导出：走 api.js 的 export:write，落点在数据目录的 export/ 下。
   * 这一条连着安卓那边的分享 —— 垫片是按 `export/<文件名>` 去 Filesystem
   * 里找文件的，路径形状必须一致。 */
  say("\n6. 导出");
  {
    const r = api.handlers["export:write"]({
      files: [{ name: "对话.txt", text: "hello" }, { name: "data.json", text: "{}" }],
    });
    eq(r.ok, true, "export:write 成功");
    eq(r.dir, path.join(TMP, "export"), "落点是数据目录下的 export/");
    eq(fs.readFileSync(path.join(TMP, "export", "对话.txt"), "utf8"), "hello", "文件内容写对了");

    // 垫片按这个形状去找文件，路径对不上真机上就是「点了分享没反应」
    ok(fs.existsSync(path.join(TMP, "export", "data.json")), "export/<文件名> 这个形状成立");

    // 文件名安全：不许穿越
    let threw = false;
    try {
      api.handlers["export:write"]({ files: [{ name: "../evil.txt", text: "x" }] });
    } catch (_) {
      threw = true;
    }
    ok(threw, ".. 穿越的文件名被拒了");
  }
} finally {
  server.close();
}

/* ------------------------------------------------------------------ *
 * 6b. 导入的录像真的过桥落盘了
 *
 * 桌面上「导入的录像存一份到录像目录」走的是 IPC；安卓上走的是这条
 * **纯 JSON** 的桥（@capawesome/capacitor-nodejs 的 MessageCodec 就是
 * JSON.stringify），所以二进制必须先 base64 编好 —— 全项目没有别的先例。
 *
 * 这里刻意**手写一遍 JSON 往返**（收、发两侧都过）：假桥平时是直接把对象
 * 塞进数组的，那样测的只是「同一个进程里的对象引用」，base64 编错、
 * 含非法字符、或者哪天有人想直接塞 Buffer（JSON.stringify 会把它变成
 * {"type":"Buffer","data":[...]}，然后 decodeB64 拿到一个对象就拒）都发现不了。
 * ------------------------------------------------------------------ */
say("\n6b. 导入录像过 JSON 桥落盘");
{
  const invoke = nodeHandlers["invoke"];
  ok(typeof invoke === "function", "channel.on('invoke') 挂上了");

  // 内容挑得刁一点：0x00 / 0xFF / 高位字节 / 换行，都是 base64 编解码最容易错的地方
  const bytes = Buffer.from([0, 1, 2, 127, 128, 200, 253, 254, 255, 10, 13, 0]);
  const reps = path.join(TMP, "replays");
  const gone = path.join(reps, "安卓导入.yrp3d");
  try { fs.unlinkSync(gone); } catch (_) {}

  // 界面侧：字节 -> base64 -> 参数对象 -> JSON 字符串（就是过桥那一瞬）
  const payload = JSON.parse(JSON.stringify({
    files: [{ name: "安卓导入.yrp3d", data: bytes.toString("base64"), mtime: 1700000000000 }],
  }));
  const wire = JSON.stringify(payload); // 真桥就是把这个字符串递过去的
  ok(!/Buffer/.test(wire), "参数里没有 Buffer（JSON.stringify 会把它变成别的东西）", wire.slice(0, 80));

  const n0 = posts.length;
  invoke({ id: 606, ch: "recordings:import", args: JSON.parse(wire) });
  await wait(300);

  const r = posts.slice(n0).find((p) => p.ev === "reply" && p.payload.id === 606);
  ok(r && r.payload.result && r.payload.result.ok === true, "过桥的回复是成功", JSON.stringify(r && r.payload.result));
  ok(fs.existsSync(gone), "★ 文件真的落进了 App 的录像目录");
  if (fs.existsSync(gone)) {
    ok(fs.readFileSync(gone).equals(bytes), "★★ 过完桥字节逐字节相同（base64 编解码没吃掉任何一位）");
  }
  // 回复本身也必须能过 JSON（Node -> 界面那一半）
  ok(JSON.parse(JSON.stringify(r.payload.result)).saved.length === 1, "回复也能 JSON 往返");

  // 落盘之后列表里就有它了 —— 这才是「重启还在」的前半截
  const L = await api.handlers["recordings:list"]();
  ok(L.list.some((f) => f.name === "安卓导入.yrp3d"), "recordings:list 里带出来了");

  // 坏 base64 必须整批拒（Buffer.from 会静默吞掉垃圾字符，写进去就是半截录像）
  const n1 = posts.length;
  invoke({ id: 707, ch: "recordings:import", args: { files: [{ name: "坏的.yrp3d", data: "QUJD!!!" }] } });
  await wait(200);
  const r2 = posts.slice(n1).find((p) => p.ev === "reply" && p.payload.id === 707);
  ok(r2 && r2.payload.result && r2.payload.result.ok === false, "坏 base64 走失败回复", JSON.stringify(r2 && r2.payload.result));
  ok(!fs.existsSync(path.join(reps, "坏的.yrp3d")), "★ 而且没在磁盘上留下半截录像");
}

/* ------------------------------------------------------------------ *
 * 7. 桥的请求-回复配对
 *
 * 界面那边每条 invoke 都带一个自增 id，Node 侧必须原样回。这一条错了
 * 的表现是「点 A 按钮，B 按钮的位置显示 A 的结果」—— 录像列表和录像详情
 * 都在 2 秒轮询，串了几乎看不出来。
 * ------------------------------------------------------------------ */
say("\n7. 桥：请求-回复配对与 app:quit");
{
  const invoke = nodeHandlers["invoke"];
  ok(typeof invoke === "function", "channel.on('invoke') 挂上了");

  const n0 = posts.length;
  // 故意发两条并发、且**乱序返回**（第二条先回），看会不会串
  invoke({ id: 101, ch: "state:get", args: {} });
  invoke({ id: 202, ch: "config:get", args: {} });
  await wait(150);

  const replies = posts.slice(n0).filter((p) => p.ev === "reply").map((p) => p.payload);
  eq(replies.length, 2, "两条请求各回了一条");
  eq(replies.map((r) => r.id).sort((a, b) => a - b), [101, 202], "id 原样回传，没有串");
  ok(replies.every((r) => r.result && r.result.ok === true), "两条都是成功结果");
  ok(
    replies.find((r) => r.id === 101).result.running !== undefined &&
      replies.find((r) => r.id === 202).result.proxy !== undefined,
    "各自拿到的是自己那一条的结果（不是同一个）"
  );

  // 不存在的通道：必须回一条能看懂的失败，而不是让界面的 Promise 永远挂着
  const n1 = posts.length;
  invoke({ id: 303, ch: "没这个通道", args: {} });
  await wait(100);
  const r = posts.slice(n1).find((p) => p.ev === "reply" && p.payload.id === 303);
  ok(r && r.payload.result && r.payload.result.ok === false, "未知通道回了 ok:false");
  ok(r && /没有这个通道/.test(r.payload.result.error || ""), "并且说了是哪个通道");

  /* 处理器抛错 -> 桥必须回一条能看懂的失败。
   * 这里挑「房间名没填」是因为它走的是 err.**payload** 那条路（api.js 明确
   * 把原始响应体挂在错误上），而不是从 message 现编一句 —— 界面拿到的
   * 必须是 api.js 本来要发的那份。 */
  const n2 = posts.length;
  invoke({ id: 404, ch: "proc:start", args: { mode: "observer", cfg: { host: "127.0.0.1", port, room: "" } } });
  await wait(200);
  const r2 = posts.slice(n2).find((p) => p.ev === "reply" && p.payload.id === 404);
  eq(r2 && r2.payload.result, { ok: false, error: "要把房间名填上。" },
     "抛出的失败原样走 payload 回给界面");

  // 读不到的文件：另一条失败路径，只有一句 error
  const n3 = posts.length;
  invoke({ id: 505, ch: "recording:parse", args: { name: "根本不存在.yrp3d" } });
  await wait(200);
  const r3 = posts.slice(n3).find((p) => p.ev === "reply" && p.payload.id === 505);
  ok(r3 && r3.payload.result.ok === false && /读不到/.test(r3.payload.result.error || ""),
     "读不到的文件 -> 明确说读不到");

  /* 反过来的一个反直觉事实，值得钉住：**坏文件不会失败**。
   * parseRecording 先拿 trimToLastPacket 裁到最后一个完整包，而裁完剩下的
   * 一定是个合法包流（parseYrp3d 的失败条件恰好被裁掉了）—— 所以 api.js 里
   * 「解析出错」那条分支实际到不了。真要有人改了 trimToLastPacket，
   * 这条会红，提醒他上面的推理已经不成立。 */
  fs.writeFileSync(path.join(TMP, "replays", "坏文件.yrp3d"), Buffer.from([1, 2, 3, 4, 5, 6, 7]));
  const n4 = posts.length;
  invoke({ id: 606, ch: "recording:parse", args: { name: "坏文件.yrp3d" } });
  await wait(200);
  const r4 = posts.slice(n4).find((p) => p.ev === "reply" && p.payload.id === 606);
  ok(r4 && r4.payload.result.ok === true && r4.payload.result.chats.length === 0,
     "全垃圾的字节被裁成空包流 -> 成功但没有对话（不是报错）");
  ok(r4 && r4.payload.result.trimmed === true, "而且 trimmed=true，界面能据此提示文件是残的");

  const quit = api.handlers["app:quit"]();
  eq(quit.ok, true, "app:quit 成功");
  eq(Array.isArray(quit.stopped), true, "返回了 stopped 列表（是数组）");
}

/* ------------------------------------------------------------------ *
 * 8. 反向：用户数据一个字节都不在 www/ 里
 *    （build-web.mjs 也查，这里再查一次是因为这条是隐私的唯一防线）
 * ------------------------------------------------------------------ */
say("\n8. 隐私");
{
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
  const all = walk(path.join(HERE, "www"));
  for (const bad of ["config.json", "observer.json", "settings.json"]) {
    ok(!all.some((p) => path.basename(p) === bad), `www/ 里没有 ${bad}`);
  }
  ok(!all.some((p) => p.includes(`${path.sep}replays${path.sep}`)), "www/ 里没有 replays/");
}

Module._load = origLoad;
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch (_) {}

say(fail ? `\nFAILED (${fail})` : "\n全部通过");
process.exit(fail ? 1 : 0);
