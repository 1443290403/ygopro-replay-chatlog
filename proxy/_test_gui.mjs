// 界面（gui.js）的测试。起真的 HTTP 服务 + 假 srvpro，整条链路走一遍：
// 开始观战 → SSE 收到日志 → 假服务器发对话 → 停止 → 录像列表里出现文件
// → 解析出的座位名/说话者分类都对。
//
// YRP_DATA_DIR 指向临时目录，所以这个测试**不会碰**真实的 config.json /
// observer.json / 录像目录 —— 界面是把子进程 spawn 出去的，环境变量能传下去。
//
//   node _test_gui.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "yrp-gui-"));

// 必须在 require gui.js 之前设置：那些路径是模块加载时算出来的
process.env.YRP_DATA_DIR = TMP;

const require = createRequire(import.meta.url);
const gui = require("./gui.js");
const proxy = require("./proxy.js");
const observer = require("./observer.js");
// 界面里的导出按钮用的是同一份函数，所以端到端那几段直接抠出来调
const { loadExtractor } = require("../_parser.js");

let failed = 0;
function ok(cond, what, extra) {
  if (cond) console.log(`  ok   ${what}`);
  else {
    failed++;
    console.log(`  FAIL ${what}${extra ? `\n       ${extra}` : ""}`);
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 等条件成立，最多等 ms 毫秒。子进程要几百毫秒才起得来，写死 sleep 会不稳。
async function until(fn, ms = 8000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await wait(step);
  }
}

/* ---------------- 线上帧 ---------------- */
const P = { ERROR_MSG: 0x02, TYPE_CHANGE: 0x13, CHAT: 0x19, PLAYER_ENTER: 0x20,
            PLAYER_INFO: 0x10, JOIN_GAME: 0x12, TOOBSERVER: 0x21 };

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

const TS = "10:00:00";
const log = (t) => console.log(`\n${t}`);

/* ================================================================== *
 * 1. 校验（CLI 覆盖不到，只有界面这条路径会走）
 * ================================================================== */
log("1. 表单校验");
{
  let v = gui.validate("observer", { host: "h", port: 7911, room: "房", name: "n", version: 4962 });
  ok(v.cfg && v.cfg.port === 7911, "正常参数通过");

  v = gui.validate("observer", { host: "h", port: "abc", room: "房", version: 1 });
  ok(!!v.error && !v.cfg, "端口不是数字 -> 报错", JSON.stringify(v));

  v = gui.validate("observer", { host: "h", port: 99999, room: "房", version: 1 });
  ok(!!v.error, "端口超范围 -> 报错");

  v = gui.validate("observer", { host: "h", port: 7911, room: "", version: 1 });
  ok(!!v.error, "房间名空 -> 报错");

  // 19 字上限是协议决定的，spawn 这条路径走不到 observer.js 里那条警告，
  // 所以界面必须自己补。漏了的话房间名会被静默截断、录到别人的空房间。
  const long = "一二三四五六七八九十一二三四五六七八九十";
  v = gui.validate("observer", { host: "h", port: 7911, room: long, name: "n", version: 1 });
  ok(v.warn && v.warn.length === 1, "超长房间名给警告", JSON.stringify(v.warn));
  const short = "一二三四五六七八九十一二三四五六七八九";
  v = gui.validate("observer", { host: "h", port: 7911, room: short, name: "n", version: 1 });
  ok(v.warn && v.warn.length === 0, "正好 19 字不警告");

  v = gui.validate("proxy", { remoteHost: "", remotePort: 7911, listenPort: 7911 });
  ok(!!v.error, "代理缺服务器地址 -> 报错");
  v = gui.validate("proxy", { remoteHost: "h", remotePort: 7911, listenPort: 7911 });
  ok(v.cfg && v.cfg.remoteHost === "h", "代理正常参数通过");
}

/* ================================================================== *
 * 1b. 三份 DEFAULTS 必须一致
 *
 * proxy.js / observer.js / gui.js 各有一份默认值，**没有共同来源**，全靠人同步。
 * 不一致的后果是静默的：界面用预填值把 config.json 写下去，子进程读到的却是
 * 另一套 —— 表现为「界面上明明填的 A，却连去了 B」，很难往默认值上想。
 * 所以这里直接把它钉死；改了服务器地址只改一处就会红。
 * ================================================================== */
log("1b. DEFAULTS 一致性");
{
  ok(
    gui.DEFAULTS.proxy.remoteHost === proxy.DEFAULTS.remoteHost &&
      gui.DEFAULTS.proxy.remotePort === proxy.DEFAULTS.remotePort &&
      gui.DEFAULTS.proxy.listenPort === proxy.DEFAULTS.listenPort,
    "界面和 proxy.js 的代理默认值一致",
    `界面 ${JSON.stringify(gui.DEFAULTS.proxy)} / proxy.js ${JSON.stringify(proxy.DEFAULTS)}`
  );
  ok(
    gui.DEFAULTS.observer.host === observer.DEFAULTS.host &&
      gui.DEFAULTS.observer.port === observer.DEFAULTS.port &&
      gui.DEFAULTS.observer.name === observer.DEFAULTS.name,
    "界面和 observer.js 的观战默认值一致",
    `界面 ${JSON.stringify(gui.DEFAULTS.observer)} / observer.js ${JSON.stringify(observer.DEFAULTS)}`
  );
}

/* ================================================================== *
 * 2. 尾部残包容忍
 *
 * 录制中读、或者被硬杀之后，文件尾必然是半个包。解析器见到半截包会把
 * **整份**判成「已损坏」、对话列表直接空掉，所以要先自己裁到最后一个完整包。
 * ================================================================== */
log("2. 尾部残包");
{
  const pk = (type, body) => {
    const b = Buffer.alloc(5 + body.length);
    b[0] = type;
    b.writeUInt32LE(body.length, 1);
    body.copy(b, 5);
    return b;
  };
  const full = Buffer.concat([pk(230, Buffer.from("aa")), pk(235, Buffer.from("bbb"))]);

  let r = gui.trimToLastPacket(full.subarray(0, full.length));
  ok(r.buf.length === full.length && r.trimmed === false, "完整文件不裁");

  r = gui.trimToLastPacket(full.subarray(0, full.length - 1));
  ok(r.buf.length === 7 && r.trimmed === true, "砍掉 1 字节 -> 裁到第一个包", `实际 ${r.buf.length}`);

  r = gui.trimToLastPacket(full.subarray(0, 3));
  ok(r.buf.length === 0 && r.trimmed === true, "只剩半个包头 -> 裁成空");

  // 长度字段比文件还大（正好切在长度字段中间读到的垃圾值）不能被当成合法包
  const lying = Buffer.alloc(5);
  lying[0] = 230;
  lying.writeUInt32LE(9999, 1);
  r = gui.trimToLastPacket(lying);
  ok(r.buf.length === 0, "长度字段超出文件 -> 不算完整包");
}

/* ================================================================== *
 * 3. 文件名校验（挡路径穿越）
 * ================================================================== */
log("3. 文件名");
{
  ok(gui.safeName("a.yrp3d") === "a.yrp3d", "普通文件名通过");
  ok(gui.safeName("示例房-09-25「16：57：48」.yrp3d") !== null, "# 和中文括号的文件名通过");
  ok(gui.safeName("../../config.json") === null, "..\\..\\config.json 被拒");
  ok(gui.safeName("..\\..\\config.json") === null, "Windows 反斜杠版本被拒");
  ok(gui.safeName("C:config.json") === null, "带冒号被拒");
  ok(gui.safeName("a.txt") === null, "非 .yrp3d 被拒");
  ok(gui.safeName("") === null, "空名字被拒");
}

/* ================================================================== *
 * 4. HTTP：token 和页面
 * ================================================================== */
log("4. token 与页面");
const TOKEN = "0123456789abcdef0123456789abcdef";
let srv = null;
let port = 0;
let sse = null;
let fake = null;

const base = () => `http://127.0.0.1:${port}`;
async function api(p, { method = "GET", body, token = TOKEN } = {}) {
  const url = base() + p + (p.includes("?") ? "&" : "?") + "t=" + token;
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}

try {
  ({ server: srv } = gui.createServer(TOKEN));
  port = await gui.listenOn(srv, 0);

  let r = await api("/api/state", { token: "deadbeef" });
  ok(r.status === 401, "错误 token 访问 /api/* -> 401", `实际 ${r.status}`);

  r = await api("/api/state", { token: "" });
  ok(r.status === 401, "没有 token 访问 /api/* -> 401", `实际 ${r.status}`);

  // 页面本身也要 token：只挡 /api/ 的话，DNS rebinding 能先取回带 token 的页面
  // 再拿它打接口，等于没挡
  let res = await fetch(base() + "/");
  ok(res.status === 401, "没有 token 访问 / -> 401", `实际 ${res.status}`);

  res = await fetch(base() + "/?t=" + TOKEN);
  const html = await res.text();
  ok(res.status === 200, "带 token 拿到页面");
  ok(res.headers.get("content-type").includes("charset=utf-8"), "页面按 utf-8 下发");
  ok(!html.includes("__TOKEN__"), "占位符被替换掉了");
  ok(html.includes(TOKEN), "页面里嵌进了 token");
  ok(html.includes("EventSource"), "页面里有 SSE 客户端代码");

  // 第一次跑（两个配置文件都还不存在）时，界面必须拿到**填好的默认值**。
  // 这里要是返回 null，页面就一个字段都不填 —— 默认值等于白设，用户看到
  // 一片空白还以为要自己查。这条断言就是冲着这个来的。
  for (const f of ["config.json", "observer.json"]) {
    try { fs.unlinkSync(path.join(TMP, f)); } catch (_) {}
  }
  r = await api("/api/config");
  ok(r.status === 200, "GET /api/config 200", `实际 ${r.status}`);
  ok(
    r.body.proxy &&
      r.body.proxy.remoteHost === proxy.DEFAULTS.remoteHost &&
      r.body.proxy.remotePort === proxy.DEFAULTS.remotePort &&
      r.body.proxy.listenPort === proxy.DEFAULTS.listenPort,
    "没有配置文件时，代理侧返回填好的默认值（不是 null）",
    JSON.stringify(r.body.proxy)
  );
  ok(
    r.body.observer &&
      r.body.observer.host === observer.DEFAULTS.host &&
      r.body.observer.port === observer.DEFAULTS.port,
    "没有配置文件时，观战侧返回填好的默认值（不是 null）",
    JSON.stringify(r.body.observer)
  );

  // 文件**坏掉**是另一回事：这时候不能悄悄塞默认值，否则用户会以为配置没丢。
  fs.writeFileSync(path.join(TMP, "config.json"), "{ 这不是 JSON");
  r = await api("/api/config");
  ok(r.body.proxy === null, "配置文件坏掉时返回 null（让用户重填，而不是假装没事）", JSON.stringify(r.body.proxy));
  try { fs.unlinkSync(path.join(TMP, "config.json")); } catch (_) {}

  r = await api("/api/nope");
  ok(r.status === 404, "不存在的接口 -> 404");

  // 界面里拖进来的文件在浏览器里解析，靠的就是这个路由把同一份哨兵块发下去
  res = await fetch(base() + "/parser.js");
  ok(res.status === 401, "没有 token 访问 /parser.js -> 401", `实际 ${res.status}`);

  res = await fetch(base() + "/parser.js?t=" + TOKEN);
  const bundle = await res.text();
  ok(res.status === 200, "带 token 拿到解析块", `实际 ${res.status}`);
  ok((res.headers.get("content-type") || "").includes("text/javascript"),
    "解析块按 js 下发", res.headers.get("content-type"));
  // token 跨重启不变，不标 no-store 的话改了 chat-extractor.html 会像没生效
  ok(res.headers.get("cache-control") === "no-store",
    "解析块不许缓存", res.headers.get("cache-control"));
  ok(bundle.includes("window.YRP_PARSER"), "解析块挂到 window.YRP_PARSER 上");
  ok(!bundle.includes("__TOKEN__"), "解析块里没漏占位符");
  // 裸发的话顶层 const 挂不到 window，而且同名重复声明是 SyntaxError
  ok(bundle.includes('"use strict"') && bundle.includes("})();"),
    "解析块包在严格模式的 IIFE 里（不能裸发）");

  // 这个页面握着 API token，注入点必须维持在 1 个（render() 里那个高亮，
  // 两边都过了 esc）。照抄 chat-extractor.html 的 toast 会一口气加 4 个。
  const page = fs.readFileSync(path.join(HERE, "gui.html"), "utf8");
  const hits = page.split("\n").map((l, i) => [i + 1, l])
    .filter(([, l]) => l.includes(".innerHTML"));
  ok(hits.length === 1, "gui.html 里 .innerHTML 恰好 1 处",
    hits.map(([n, l]) => `${n}: ${l.trim()}`).join("\n       "));

  // gui.js 只替换**第一处**占位符（不是全局替换），所以页面里只能有一处。
  // 多出来的那处在 TOKEN 那行之后不要紧，但要是有人把它挪到前面 —— 比如在
  // 注释里顺手写了一句 —— 被替换的就变成注释，页面拿到的 token 是字面量
  // "__TOKEN__"，所有接口 401，而上面那条「占位符被替换掉了」只会说结果不说原因。
  const ph = page.split("\n").map((l, i) => [i + 1, l])
    .filter(([, l]) => l.includes("__TOKEN__"));
  ok(ph.length === 1, "gui.html 里占位符只出现一次（换掉第一处的人就是拿到 token 的人）",
    ph.map(([n, l]) => `${n}: ${l.trim()}`).join("\n       "));

  // 按钮、绑定、quitScreen 的 id 列表三处要一起删：漏了绑定 $() 返回 null，
  // null.onclick 会抛在 init() 之前，整个界面一条日志都出不来
  ok(!/id="open-tool"|"open-tool"/.test(page),
    "旧的「用 chat-extractor.html 打开」删干净了");
  for (const id of ["exp-txt", "exp-each", "exp-json", "exp-csv", "exp-copy",
                    "exp-dir", "sel-all", "sel-none", "pick-files", "pick-dir",
                    "strip-sys", "strip-obs", "toast", "drop", "sel-count"])
    ok(page.includes(`id="${id}"`), `页面上有 #${id}`);

  r = await api("/api/recordings");
  ok(r.status === 200 && Array.isArray(r.body.list) && r.body.list.length === 0,
    "空目录 -> 空列表", JSON.stringify(r.body));

  /* ---------------- 5. 整条链路 ---------------- */
  log("5. 观战全流程");

  // 假 srvpro：坐下 -> 让座 -> 发对话，然后**不关连接**，
  // 这样「停止」走的是真实路径（硬杀），而不是解析收尾日志
  const chats = [];
  fake = await new Promise((resolve) => {
    const s = net.createServer((sock) => {
      const feed = splitter((type, payload) => {
        if (type === P.JOIN_GAME) {
          sock.write(frame(P.JOIN_GAME, Buffer.from([0x62, 0x13])));
          sock.write(frame(P.TYPE_CHANGE, Buffer.from([1]))); // 先占个玩家位
        } else if (type === P.TOOBSERVER) {
          sock.write(frame(P.TYPE_CHANGE, Buffer.from([7]))); // 切观战
          const enter = (name, pos) => {
            const b = Buffer.alloc(41);
            u16z(name, 40).copy(b, 0);
            b[40] = pos;
            sock.write(frame(P.PLAYER_ENTER, b));
          };
          enter("房主", 0);
          enter("挑战者", 1);
          const chat = (pt, msg) => {
            const m = u16z(msg);
            const pl = Buffer.alloc(2 + m.length);
            pl.writeUInt16LE(pt, 0);
            m.copy(pl, 2);
            chats.push(msg);
            sock.write(frame(P.CHAT, pl));
          };
          chat(0, "你好");
          chat(7, "围观一下");
        }
        void payload;
      });
      sock.on("data", feed);
      sock.on("error", () => {});
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
  });

  // 先把 SSE 挂上，否则子进程启动那几行日志已经播过去了
  sse = openSSE(base() + "/api/events?t=" + TOKEN);
  await wait(150);

  r = await api("/api/start", {
    method: "POST",
    body: {
      mode: "observer",
      cfg: { host: "127.0.0.1", port: fake.port, room: "GUI测试房", name: "界面测试", version: 4962 },
    },
  });
  ok(r.status === 200 && r.body.ok, "POST /api/start 成功", JSON.stringify(r.body));

  r = await api("/api/state");
  ok(r.body.running.observer === true, "状态变成运行中");

  // 重复启动必须被挡住，否则一个按钮点两下会留下两个进程
  r = await api("/api/start", {
    method: "POST",
    body: { mode: "observer", cfg: { host: "127.0.0.1", port: fake.port, room: "GUI测试房", version: 1 } },
  });
  ok(r.status === 400, "重复启动被拒", JSON.stringify(r.body));

  // 配置落盘了，而且回读得出来（子进程靠它跳过交互式提问）
  const cfgFile = path.join(TMP, "observer.json");
  ok(fs.existsSync(cfgFile), "observer.json 写出来了");
  const saved = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  ok(saved.port === fake.port && saved.room === "GUI测试房", "写进去的是界面上的值");

  const gotChats = await until(() => chats.length >= 2);
  ok(gotChats !== null, "子进程连上了假服务器并让了座");

  const gotLog = await until(() => sse.events.some((e) => e.ev.t === "log"));
  ok(gotLog, "SSE 收到了日志", JSON.stringify(sse.events.slice(0, 3)));

  const rec = await until(async () => {
    const x = await api("/api/recordings");
    return x.body.list.length ? x.body : null;
  });
  ok(rec !== null, "录像文件出现在列表里");
  ok(rec && rec.anyRunning === true, "列表标着正在录", JSON.stringify(rec && rec.anyRunning));
  const name = rec ? rec.list[0].name : "";
  ok(name.startsWith("GUI测试房-"), "文件名带房间名前缀", name);

  // 边录边看：这就是「录完直接看」的实时形态
  r = await api("/api/recording?name=" + encodeURIComponent(name));
  ok(r.status === 200 && r.body.ok, "录制中的文件也能解析", JSON.stringify(r.body).slice(0, 200));
  ok(r.body.running === true, "解析结果标着录制中");
  ok(JSON.stringify(r.body.seats) === JSON.stringify({ 0: "房主", 1: "挑战者" }),
    "座位名从 0x20 包里解出来了", JSON.stringify(r.body.seats));
  ok(r.body.chats.map((c) => `${c.who}/${c.kind}`).join(",") === "房主/player,观战者/observer",
    "说话者和分类都对", JSON.stringify(r.body.chats.map((c) => `${c.who}/${c.kind}`)));

  /* ---------------- 6. 停止 ---------------- */
  log("6. 停止");
  r = await api("/api/stop", { method: "POST", body: { mode: "observer" } });
  ok(r.status === 200 && r.body.ok, "POST /api/stop 成功");

  const stopped = await until(async () => (await api("/api/state")).body.running.observer === false);
  ok(stopped, "状态回到未运行（以进程 exit 事件为准，不靠收尾日志）");

  const exited = sse.events.some((e) => e.ev.t === "proc" && e.ev.running === false);
  ok(exited, "SSE 播了 proc running:false");

  r = await api("/api/stop", { method: "POST", body: { mode: "observer" } });
  ok(r.status === 400, "没在跑时停止 -> 报错而不是崩");

  /* ---------------- 7. 截断的文件 ---------------- */
  log("7. 截断的录像");
  const full = fs.readFileSync(path.join(TMP, "replays", name));
  const chopped = "截断-测试.yrp3d";
  fs.writeFileSync(path.join(TMP, "replays", chopped), full.subarray(0, full.length - 3));

  const whole = (await api("/api/recording?name=" + encodeURIComponent(name))).body;
  r = await api("/api/recording?name=" + encodeURIComponent(chopped));
  ok(r.status === 200 && r.body.ok, "尾部半个包 -> 仍然解析成功", JSON.stringify(r.body).slice(0, 200));
  ok(r.body.trimmed === true, "标了 trimmed");
  ok(r.body.parsedSize < r.body.size, "解析长度小于文件长度");
  // 文件是以对话包结尾的，砍掉 3 字节正好把最后那条对话切没。
  // 关键是「丢的只能是尾部那一条」，前面的一条都不能少 —— 所以拿完整文件
  // 的结果做前缀比对，而不是写死条数（包序变了测试不该跟着红）。
  const msgs = (x) => x.chats.map((c) => c.msg);
  ok(JSON.stringify(msgs(r.body)) === JSON.stringify(msgs(whole).slice(0, -1)),
    "只丢尾部那一条，前面的完整保留",
    `截断后 ${JSON.stringify(msgs(r.body))} / 完整 ${JSON.stringify(msgs(whole))}`);
  ok(r.body.running === false, "停了之后不再标录制中");

  // 界面独有的字段：列表里显示的是整文件大小，解析长度另算一格，
  // 导出 JSON 里不该出现 parsedSize（它不在 buildJson 的白名单里）
  ok(r.body.size === fs.statSync(path.join(TMP, "replays", chopped)).size,
    "size 是整文件大小（和列表里显示的一致），不是解析长度",
    `${r.body.size} vs 文件 ${fs.statSync(path.join(TMP, "replays", chopped)).size}`);
  ok(Number.isInteger(r.body.packets) && r.body.packets > 0,
    "响应里带上了包数", String(r.body.packets));

  /* ---------------- 7b. 导出：界面按钮走到的那几个函数 ---------------- *
   *
   * 用真的 /api/recording 响应喂 normalizeServer + 构建函数，覆盖「服务端录像」
   * 这条路径。注意**不能**拿这个截断文件去和 chat-extractor.html 的结果逐字节
   * 比对：chat-extractor 直接读文件、尾部半个包会让它整份判成损坏（ok:false），
   * 而界面先 trimToLastPacket 所以这里是 ok:true。这是有意的差异，不是 bug。
   */
  log("7b. 导出格式（端到端）");
  {
    const { normalizeServer, exportGroups, buildCsv, buildMergedTxt, buildPerFileTxt } =
      loadExtractor(["normalizeServer", "exportGroups", "buildCsv", "buildMergedTxt",
                     "buildPerFileTxt"]);

    const norm = normalizeServer(r.body);
    ok(norm.ok && norm.file === chopped && norm.chats.length === r.body.chats.length,
      "normalizeServer 把响应转成了 extract() 的形状", JSON.stringify(norm).slice(0, 160));
    ok(norm.trimmed === true && norm.running === false,
      "trimmed / running 一路带到界面（构建函数不看它们，所以不进导出文件）");

    const csv = buildCsv([norm], {});
    const rows = csv.split("\r\n");
    ok(rows[0] === "文件,偏移,说话者类型,说话者,消息",
      "CSV 表头逐字节一致（这几个字段有意不加引号）", rows[0]);
    ok(rows.length === r.body.chats.length + 1, "CSV 行数 = 对话数 + 表头", String(rows.length));
    const one = r.body.chats[0];
    ok(rows[1] === `"${chopped}",0x${one.offset.toString(16)},${one.playerType},"${one.who}","${one.msg}"`,
      "CSV 数据行的字段顺序和引号规则都对", rows[1]);
    ok(!csv.includes("trimmed") && !csv.includes("parsedSize"),
      "界面专有字段没漏进 CSV");

    const groups = exportGroups([norm], {});
    ok(groups.length === 1 && groups[0].file === chopped,
      "exportGroups 保留了有对话的文件");
    const txt = buildMergedTxt(groups);
    ok(txt === "### " + chopped + "\n" +
        r.body.chats.map((c) => `${c.who}: ${c.msg}`).join("\n"),
      "合并 TXT 的 ### 头行和说话者前缀都对", JSON.stringify(txt));
    ok(buildPerFileTxt(groups[0]) === r.body.chats.map((c) => `${c.who}: ${c.msg}`).join("\n"),
      "分文件 TXT = 合并 TXT 去掉头行");

    // 上传的文件根本没进服务端，所以「服务器上的录像」和「本机文件」在构建函数
    // 眼里必须长得一模一样 —— 本机那份就是 extract() 的返回值
    const local = { ok:true, file:"本机.yrp3d", size:9, packets:1, seats:{},
                    chats:[{offset:0, playerType:0, who:"甲", kind:"player", seat:0, msg:"本机的"}] };
    ok(buildCsv([norm, local], {}).split("\r\n").length === 3,
      "两种来源混在一起导出时行数对得上");
  }

  /* ---------------- 8. 路径穿越 ---------------- */
  log("8. 路径穿越");
  r = await api("/api/recording?name=" + encodeURIComponent("../../config.json"));
  ok(r.status === 400, "../../config.json 被拒", `实际 ${r.status}`);
  r = await api("/api/recording?name=" + encodeURIComponent("..\\..\\observer.json"));
  ok(r.status === 400, "..\\\\..\\\\observer.json 被拒", `实际 ${r.status}`);
  r = await api("/api/recording?name=" + encodeURIComponent("不存在的.yrp3d"));
  ok(r.status === 400 && /读不到/.test(r.body.error), "不存在的文件给出可读的报错", JSON.stringify(r.body));

  /* ---------------- 9. 坏配置不挂死 ---------------- */
  log("9. 坏配置");
  fs.writeFileSync(path.join(TMP, "observer.json"), "{ 这不是 JSON");
  r = await api("/api/config");
  ok(r.status === 200 && r.body.observer === null, "配置坏了 -> 报 null，不是 500 也不是挂住",
    JSON.stringify(r.body));
  r = await api("/api/start", { method: "POST", body: { mode: "observer", cfg: { host: "x", port: 1, room: "r", version: 1 } } });
  ok(r.status === 200, "配置坏了之后还能正常启动（会覆盖掉那个坏文件）");
  await api("/api/stop", { method: "POST", body: { mode: "observer" } });
  await until(async () => (await api("/api/state")).body.running.observer === false);
} catch (e) {
  failed++;
  console.log(`  FAIL 抛异常了：${e.stack}`);
} finally {
  sse?.close();
  fake?.server.close();
  if (srv) await new Promise((r) => srv.close(r));
}

/* ================================================================== *
 * 10. 探活（「双击第二次 = 重新打开页面」靠它）
 * ================================================================== */
log("10. 探活");
{
  // 上面那个服务已经关了，这里自己起一个 —— 探的就是「活着的界面」
  const { server: s2 } = gui.createServer(TOKEN);
  const p2 = await gui.listenOn(s2, 0);

  const live = await gui.probeExisting(`http://127.0.0.1:${p2}/?t=${TOKEN}`);
  ok(live === true, "活着的界面探得出来");

  const wrong = await gui.probeExisting(`http://127.0.0.1:${p2}/?t=deadbeefdeadbeefdeadbeefdeadbeef`);
  ok(wrong === false, "token 不对就不认（端口上蹲着别的程序也不会误判）");

  await new Promise((r) => s2.close(r));
  ok((await gui.probeExisting(`http://127.0.0.1:${p2}/?t=${TOKEN}`)) === false,
    "关掉之后同一个地址探不到（地址文件过期了要能识别出来）");

  const dead = await gui.probeExisting("http://127.0.0.1:1/?t=" + TOKEN);
  ok(dead === false, "连不上就是 false，不抛异常");

  ok((await gui.probeExisting("不是个地址")) === false, "地址是垃圾也不抛异常");
  // 地址文件是明文的，被人改成别的机器就变成浏览器带着 token 去打外网了
  ok((await gui.probeExisting("http://example.com/?t=" + TOKEN)) === false,
    "非本机地址一律拒绝");
}

/* ================================================================== *
 * 11. 退出：起一个真的 gui.js 子进程，点退出，确认它真的退了
 *
 * 只能对着子进程测 —— /api/quit 走的是 process.exit，在测试进程里调
 * 会把跑测试的这个进程自己杀掉。
 * ================================================================== */
log("11. 退出（子进程级）");
{
  const dir = path.join(TMP, "quit");
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, [path.join(HERE, "gui.js"), "--no-open"], {
    cwd: HERE,
    env: { ...process.env, YRP_DATA_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));

  const exited = new Promise((r) => child.on("exit", (code) => r(code)));

  const urlFile = path.join(dir, "gui-url.txt");
  const url = await until(() => {
    try {
      return fs.readFileSync(urlFile, "utf8").trim() || null;
    } catch (_) {
      return null;
    }
  });
  ok(!!url, "启动后把地址写进了 gui-url.txt", out);

  // 地址里的端口是随机的（7912 可能被占），从地址文件里拿
  const u = new URL(url);
  const q = async (p, method = "GET") =>
    (await fetch(`http://127.0.0.1:${u.port}${p}${p.includes("?") ? "&" : "?"}t=${u.searchParams.get("t")}`,
      { method })).json();

  ok((await q("/api/state")).ok === true, "服务起来了");

  // 起一个观战子进程，验证「退出」会把它一起带走
  const fakeServer = net.createServer((sock) => sock.on("data", () => {}).on("error", () => {}));
  await new Promise((r) => fakeServer.listen(0, "127.0.0.1", r));
  const fport = fakeServer.address().port;
  let r = await fetch(`http://127.0.0.1:${u.port}/api/start?t=${u.searchParams.get("t")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "observer",
      cfg: { host: "127.0.0.1", port: fport, room: "退出测试", name: "测试", version: 4962 },
    }),
  });
  ok((await r.json()).ok === true, "观战跑起来了");
  ok((await q("/api/state")).running.observer === true, "状态是运行中");

  const quit = await fetch(`http://127.0.0.1:${u.port}/api/quit?t=${u.searchParams.get("t")}`,
    { method: "POST" });
  const body = await quit.json();
  ok(quit.status === 200 && body.ok === true, "POST /api/quit 返回 ok", JSON.stringify(body));
  ok(Array.isArray(body.stopped) && body.stopped.includes("observer"),
    "响应里说明带走了哪个子进程", JSON.stringify(body.stopped));

  const code = await Promise.race([exited, wait(6000).then(() => "超时")]);
  ok(code === 0, "gui.js 自己退出了（不是被杀的）", `实际 ${code}\n${out}`);
  ok(!fs.existsSync(urlFile), "退出时把地址文件删了（下次启动才会重新起，而不是去探一个死地址）");

  fakeServer.close();
  // 端口应该马上就能重新监听
  const again = net.createServer();
  const reusable = await new Promise((r) => {
    again.once("error", () => r(false));
    again.listen(Number(u.port), "127.0.0.1", () => r(true));
  });
  ok(reusable, "端口被释放了");
  again.close();
}

/* ================================================================== *
 * 12. _parser.js 找不到标记时要指名道姓
 *
 * 原来那套 indexOf(...) 定位方式，返回 -1 会切出一个空串，
 * 报出来的错完全看不出哪里坏了。用一个副本测，不动真文件。
 * ================================================================== */
log("12. _parser.js 的报错");
{
  const dir = path.join(TMP, "parser");
  fs.mkdirSync(dir, { recursive: true });
  // _shipped.js 也要一起拷：_parser.js 靠它读 chat-extractor.html，而它按
  // **自己所在目录**找那个文件 —— 两个一起放进临时目录，读到的正好是下面
  // 写出来的假页面。只拷一个的话 require("./_shipped.js") 会直接找不到。
  for (const f of ["_parser.js", "_shipped.js"]) {
    fs.copyFileSync(path.join(HERE, "..", f), path.join(dir, f));
  }
  const page = path.join(dir, "chat-extractor.html");
  const require2 = createRequire(path.join(dir, "x.js"));

  const good = `<html><script>
/* @parser:begin
 *
 * 说明文字
 */
function extract(){ return 1; }
/* @parser:end */
const x = 1;
</script></html>`;
  const noBegin = good.replace("/* @parser:begin", "/* 有人手滑删了");
  const noEnd = good.replace("/* @parser:end */", "/* 这个是删了 */");

  const err = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

  fs.writeFileSync(page, noBegin, "utf8");
  let m = err(() => require2("./_parser.js").loadExtractor(["extract"]));
  ok(m && m.includes("@parser:begin") && m.includes("chat-extractor.html"),
    "缺 begin 标记 -> 报错点名是哪个文件、哪个标记", m);

  fs.writeFileSync(page, noEnd, "utf8");
  m = err(() => require2("./_parser.js").loadExtractor(["extract"]));
  ok(m && m.includes("@parser:end"), "缺 end 标记 -> 报错点名", m);

  fs.writeFileSync(page, good, "utf8");
  const mod = require2("./_parser.js").loadExtractor(["extract"]);
  ok(typeof mod.extract === "function" && mod.extract() === 1, "标记齐全时抠得出函数（多余的行被丢掉）");

  m = err(() => require2("./_parser.js").loadExtractor(["extract", "根本没有这个函数"]));
  ok(m && m.includes("根本没有这个函数"), "要的函数不存在 -> 报错点名是哪一个", m);
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(failed ? `\n${failed} 个失败` : "\n全部通过");
process.exit(failed ? 1 : 0);

/* ---------------- SSE 客户端 ---------------- */
// 只要诊断日志，所以在 http 层手抠 data: 行 —— node 里没有 EventSource
function openSSE(url) {
  const events = [];
  let buf = "";
  const req = http.get(url, (res) => {
    if (res.statusCode !== 200) events.push({ ev: { bad: res.statusCode } });
    res.setEncoding("utf8");
    res.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let data = null, id = null;
        for (const l of raw.split("\n")) {
          if (l.startsWith("data: ")) data = l.slice(6);
          else if (l.startsWith("id: ")) id = Number(l.slice(4));
        }
        if (data) {
          try { events.push({ id, ev: JSON.parse(data) }); } catch (_) {}
        }
      }
    });
    res.on("error", () => {});
  });
  req.on("error", () => {});
  return { events, close: () => req.destroy() };
}
