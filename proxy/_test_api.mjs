// 界面后端（api.js）的测试。起假 srvpro + 真的录制子进程，整条链路走一遍：
// 开始观战 → 收到日志事件 → 假服务器发对话 → 停止 → 录像列表里出现文件
// → 解析出的座位名/说话者分类都对 → 导出写到指定目录。
//
// **不需要装 Electron**：api.js 里一行 electron 都没有，系统能力全靠注入，
// 这里传的是假的。所以日常那几套测试仍然是 `node xxx.mjs` 就完事。
//
// YRP_DATA_DIR 指向临时目录，所以这个测试**不会碰**真实的 config.json /
// observer.json / 录像目录 —— 子进程是 spawn 出去的，环境变量能传下去。
//
//   node _test_api.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "yrp-api-"));

// 必须在 require api.js 之前设置：那些路径是模块加载时算出来的
process.env.YRP_DATA_DIR = TMP;
// 录像目录**不**从环境读（那是 api.js 传给子进程的，方向是反的），但子进程
// 会读它 —— 这台机器的 shell 里要是恰好留着一条，子进程就会写到别处去。
// 清掉，保证下面那段断言的是「这个测试自己安排的目录」。
delete process.env.YRP_REPLAYS_DIR;

const require = createRequire(import.meta.url);
const { createApi, DEFAULTS, validate, trimToLastPacket, safeName } = require("./api.js");
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

const log = (t) => console.log(`\n${t}`);

/* ================================================================== *
 * 建一个后端实例
 *
 * 系统能力全是假的 —— 真实现只有 main.js 那边有。这里记下调用参数，
 * 好断言「主进程到底收到了什么」。
 * ================================================================== */
const EXPORT_DEFAULT = path.join(TMP, "下载");
const EXPORT_PICKED = path.join(TMP, "自选目录");
const calls = { pick: 0, opened: [], clip: [] };
let pickResult = EXPORT_PICKED;

const api = createApi({
  pickDir: async () => (++calls.pick, pickResult),
  defaultExportDir: () => EXPORT_DEFAULT,
  openFile: async (p) => calls.opened.push(p),
  clipboard: async (t) => calls.clip.push(t),
});

const events = [];
api.subscribe((ev) => events.push(ev));

/* handler 失败是 throw，这里翻成和以前 HTTP 响应体一样的形状 ——
   断言本身就不用改：以前 r.body 是响应体，现在 r 就是返回值。 */
async function call(ch, args) {
  try {
    return await api.handlers[ch](args);
  } catch (e) {
    return e.payload || { ok: false, error: e.message };
  }
}

/* ================================================================== *
 * 1. 校验（CLI 覆盖不到，只有界面这条路径会走）
 * ================================================================== */
log("1. 表单校验");
{
  let v = validate("observer", { host: "h", port: 7911, room: "房", name: "n", version: 4962 });
  ok(v.cfg && v.cfg.port === 7911, "正常参数通过");

  v = validate("observer", { host: "h", port: "abc", room: "房", version: 1 });
  ok(!!v.error && !v.cfg, "端口不是数字 -> 报错", JSON.stringify(v));

  v = validate("observer", { host: "h", port: 99999, room: "房", version: 1 });
  ok(!!v.error, "端口超范围 -> 报错");

  v = validate("observer", { host: "h", port: 7911, room: "", version: 1 });
  ok(!!v.error, "房间名空 -> 报错");

  // 19 字上限是协议决定的，spawn 这条路径走不到 observer.js 里那条警告，
  // 所以界面必须自己补。漏了的话房间名会被静默截断、录到别人的空房间。
  const long = "一二三四五六七八九十一二三四五六七八九十";
  v = validate("observer", { host: "h", port: 7911, room: long, name: "n", version: 1 });
  ok(v.warn && v.warn.length === 1, "超长房间名给警告", JSON.stringify(v.warn));
  const short = "一二三四五六七八九十一二三四五六七八九";
  v = validate("observer", { host: "h", port: 7911, room: short, name: "n", version: 1 });
  ok(v.warn && v.warn.length === 0, "正好 19 字不警告");

  v = validate("proxy", { remoteHost: "", remotePort: 7911, listenPort: 7911 });
  ok(!!v.error, "代理缺服务器地址 -> 报错");
  v = validate("proxy", { remoteHost: "h", remotePort: 7911, listenPort: 7911 });
  ok(v.cfg && v.cfg.remoteHost === "h", "代理正常参数通过");
}

/* ================================================================== *
 * 1b. 三份 DEFAULTS 必须一致
 *
 * proxy.js / observer.js / api.js 各有一份默认值，**没有共同来源**，全靠人同步。
 * 不一致的后果是静默的：界面用预填值把 config.json 写下去，子进程读到的却是
 * 另一套 —— 表现为「界面上明明填的 A，却连去了 B」，很难往默认值上想。
 * 所以这里直接把它钉死；改了服务器地址只改一处就会红。
 * ================================================================== */
log("1b. DEFAULTS 一致性");
{
  ok(
    DEFAULTS.proxy.remoteHost === proxy.DEFAULTS.remoteHost &&
      DEFAULTS.proxy.remotePort === proxy.DEFAULTS.remotePort &&
      DEFAULTS.proxy.listenPort === proxy.DEFAULTS.listenPort,
    "界面和 proxy.js 的代理默认值一致",
    `界面 ${JSON.stringify(DEFAULTS.proxy)} / proxy.js ${JSON.stringify(proxy.DEFAULTS)}`
  );
  ok(
    DEFAULTS.observer.host === observer.DEFAULTS.host &&
      DEFAULTS.observer.port === observer.DEFAULTS.port &&
      DEFAULTS.observer.name === observer.DEFAULTS.name,
    "界面和 observer.js 的观战默认值一致",
    `界面 ${JSON.stringify(DEFAULTS.observer)} / observer.js ${JSON.stringify(observer.DEFAULTS)}`
  );
  /* 上面那条只比「三份是不是一样」，改了地址三份一起改它照绿。所以这里把
     **字面值**也钉住：观战预填的就是 mygo.superpre.pro（2026-09-26 晚用户要求，
     原来预填的是 mygo2.superpre.pro）。 */
  ok(
    DEFAULTS.observer.host === "mygo.superpre.pro" && observer.DEFAULTS.host === "mygo.superpre.pro",
    "观战预填的地址是 mygo.superpre.pro",
    `界面 ${DEFAULTS.observer.host} / observer.js ${observer.DEFAULTS.host}`
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

  let r = trimToLastPacket(full.subarray(0, full.length));
  ok(r.buf.length === full.length && r.trimmed === false, "完整文件不裁");

  r = trimToLastPacket(full.subarray(0, full.length - 1));
  ok(r.buf.length === 7 && r.trimmed === true, "砍掉 1 字节 -> 裁到第一个包", `实际 ${r.buf.length}`);

  r = trimToLastPacket(full.subarray(0, 3));
  ok(r.buf.length === 0 && r.trimmed === true, "只剩半个包头 -> 裁成空");

  // 长度字段比文件还大（正好切在长度字段中间读到的垃圾值）不能被当成合法包
  const lying = Buffer.alloc(5);
  lying[0] = 230;
  lying.writeUInt32LE(9999, 1);
  r = trimToLastPacket(lying);
  ok(r.buf.length === 0, "长度字段超出文件 -> 不算完整包");
}

/* ================================================================== *
 * 3. 文件名校验（挡路径穿越）
 * ================================================================== */
log("3. 文件名");
{
  ok(safeName("a.yrp3d") === "a.yrp3d", "普通文件名通过");
  ok(safeName("示例房-09-25「16：57：48」.yrp3d") !== null, "# 和中文括号的文件名通过");
  ok(safeName("../../config.json") === null, "..\\..\\config.json 被拒");
  ok(safeName("..\\..\\config.json") === null, "Windows 反斜杠版本被拒");
  ok(safeName("C:config.json") === null, "带冒号被拒");
  ok(safeName("a.txt") === null, "非 .yrp3d 被拒");
  ok(safeName("") === null, "空名字被拒");
}

/* ================================================================== *
 * 4. 页面和解析块的静态约束
 *
 * 这些不是「测试代码好看不好看」的事：占位符、id、innerHTML 三样漏一个，
 * 表现都是「界面起了但一条日志都没有」或者「悄悄地能注入」。
 * ================================================================== */
log("4. 页面与解析块");
{
  // 界面里拖进来的文件在窗口里解析，靠的就是这个通道把同一份哨兵块发下去
  const r = await call("parser:get");
  ok(r.ok && typeof r.source === "string", "parser:get 拿得到解析块");
  ok(r.source.includes("window.YRP_PARSER"), "解析块挂到 window.YRP_PARSER 上");
  // 裸发的话顶层 const 挂不到 window，而且同名重复声明是 SyntaxError
  ok(r.source.includes('"use strict"') && r.source.includes("})();"),
    "解析块包在严格模式的 IIFE 里（不能裸发）");
  ok(!r.source.includes("__TOKEN__"), "解析块里没漏占位符");

  const page = fs.readFileSync(path.join(HERE, "gui.html"), "utf8");

  // 对话内容来自别的玩家（录像来自第三方服务器），进 innerHTML 就是注入点。
  // 只允许 render() 里那个高亮，两边都过了 esc。
  const hits = page.split("\n").map((l, i) => [i + 1, l])
    .filter(([, l]) => l.includes(".innerHTML"));
  ok(hits.length === 1, "gui.html 里 .innerHTML 恰好 1 处",
    hits.map(([n, l]) => `${n}: ${l.trim()}`).join("\n       "));

  // 按钮、绑定两处要一起删：漏了绑定 $() 返回 null，
  // null.onclick 会抛在 init() 之前，整个界面一条日志都出不来
  ok(!/id="open-tool"|"open-tool"/.test(page),
    "旧的「用 chat-extractor.html 打开」删干净了");
  for (const id of ["exp-txt", "exp-each", "exp-json", "exp-csv", "exp-copy",
                    "exp-dir", "sel-all", "sel-none", "pick-files", "pick-dir",
                    "strip-sys", "strip-obs", "toast", "drop", "sel-count",
                    "reveal", "rec-dir", "rec-reset", "rec-target"])
    ok(page.includes(`id="${id}"`), `页面上有 #${id}`);

  // HTTP 那一套必须真的没了。留一半最坏 —— 比如 fetch 还在，报的却是
  // 「不是合法 JSON」，排查方向直接跑偏。
  for (const gone of ["__TOKEN__", "new EventSource", "showDirectoryPicker",
                      "fetch(", "createObjectURL", "navigator.clipboard"])
    ok(!page.includes(gone), `页面里没有 ${gone}`);
  ok(page.includes("window.yrp"), "页面走的是 preload 那个口子");
}

/* ================================================================== *
 * 4b. 配置读取（没有文件 / 文件坏掉 / 正常）
 * ================================================================== */
log("4b. 配置读取");
{
  // 第一次跑（两个配置文件都还不存在）时，界面必须拿到**填好的默认值**。
  // 这里要是返回 null，页面就一个字段都不填 —— 默认值等于白设，用户看到
  // 一片空白还以为要自己查。这条断言就是冲着这个来的。
  for (const f of ["config.json", "observer.json"]) {
    try { fs.unlinkSync(path.join(TMP, f)); } catch (_) {}
  }
  let r = await call("config:get");
  ok(r.ok, "config:get 成功", JSON.stringify(r));
  ok(
    r.proxy &&
      r.proxy.remoteHost === proxy.DEFAULTS.remoteHost &&
      r.proxy.remotePort === proxy.DEFAULTS.remotePort &&
      r.proxy.listenPort === proxy.DEFAULTS.listenPort,
    "没有配置文件时，代理侧返回填好的默认值（不是 null）",
    JSON.stringify(r.proxy)
  );
  ok(
    r.observer &&
      r.observer.host === observer.DEFAULTS.host &&
      r.observer.port === observer.DEFAULTS.port,
    "没有配置文件时，观战侧返回填好的默认值（不是 null）",
    JSON.stringify(r.observer)
  );

  // 文件**坏掉**是另一回事：这时候不能悄悄塞默认值，否则用户会以为配置没丢。
  fs.writeFileSync(path.join(TMP, "config.json"), "{ 这不是 JSON");
  r = await call("config:get");
  ok(r.proxy === null, "配置文件坏掉时返回 null（让用户重填，而不是假装没事）", JSON.stringify(r.proxy));
  try { fs.unlinkSync(path.join(TMP, "config.json")); } catch (_) {}
}

/* ================================================================== *
 * 5. 整条链路
 * ================================================================== */
log("5. 观战全流程");

// 假 srvpro：坐下 -> 让座 -> 发对话，然后**不关连接**，
// 这样「停止」走的是真实路径（硬杀），而不是解析收尾日志
const chats = [];
const fake = await new Promise((resolve) => {
  const s = net.createServer((sock) => {
    const feed = splitter((type) => {
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
    });
    sock.on("data", feed);
    sock.on("error", () => {});
  });
  s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
});

{
  let r = await call("state:get");
  ok(r.ok && r.running.observer === false, "起手是未运行");

  r = await call("proc:start", {
    mode: "observer",
    cfg: { host: "127.0.0.1", port: fake.port, room: "GUI测试房", name: "界面测试", version: 4962 },
  });
  ok(r.ok, "proc:start 成功", JSON.stringify(r));

  r = await call("state:get");
  ok(r.running.observer === true, "状态变成运行中");

  // 重复启动必须被挡住，否则一个按钮点两下会留下两个进程
  r = await call("proc:start", {
    mode: "observer",
    cfg: { host: "127.0.0.1", port: fake.port, room: "GUI测试房", version: 1 },
  });
  ok(!r.ok, "重复启动被拒", JSON.stringify(r));

  // 配置落盘了，而且回读得出来（子进程靠它跳过交互式提问）
  const cfgFile = path.join(TMP, "observer.json");
  ok(fs.existsSync(cfgFile), "observer.json 写出来了");
  const saved = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  ok(saved.port === fake.port && saved.room === "GUI测试房", "写进去的是界面上的值");

  const gotChats = await until(() => chats.length >= 2);
  ok(gotChats !== null, "子进程连上了假服务器并让了座");

  const gotLog = await until(() => events.some((e) => e.t === "log"));
  ok(gotLog, "收到了日志事件", JSON.stringify(events.slice(0, 3)));

  // 窗口 reload（Ctrl+R）之后靠它把日志面板灌回来。窗口不会「重连」，
  // 所以这里不带 id 协议 —— 要的就是「现在缓冲里有什么」。
  r = await call("log:backlog");
  ok(r.ok && r.events.some((e) => e.t === "log"), "log:backlog 给得出已经播过的日志");
  ok(r.truncated === false, "没挤爆缓冲时不谎报 truncated");

  const rec = await until(async () => {
    const x = await call("recordings:list");
    return x.list.length ? x : null;
  });
  ok(rec !== null, "录像文件出现在列表里");
  ok(rec && rec.anyRunning === true, "列表标着正在录", JSON.stringify(rec && rec.anyRunning));
  const name = rec ? rec.list[0].name : "";
  ok(name.startsWith("GUI测试房-"), "文件名带房间名前缀", name);

  // 边录边看：这就是「录完直接看」的实时形态
  r = await call("recording:parse", { name });
  ok(r.ok, "录制中的文件也能解析", JSON.stringify(r).slice(0, 200));
  ok(r.running === true, "解析结果标着录制中");
  ok(JSON.stringify(r.seats) === JSON.stringify({ 0: "房主", 1: "挑战者" }),
    "座位名从 0x20 包里解出来了", JSON.stringify(r.seats));
  ok(r.chats.map((c) => `${c.who}/${c.kind}`).join(",") === "房主/player,观战者/observer",
    "说话者和分类都对", JSON.stringify(r.chats.map((c) => `${c.who}/${c.kind}`)));

  /* ---------------- 6. 停止 ---------------- */
  log("6. 停止");
  r = await call("proc:stop", { mode: "observer" });
  ok(r.ok, "proc:stop 成功");

  const stopped = await until(async () => (await call("state:get")).running.observer === false);
  ok(stopped, "状态回到未运行（以进程 exit 事件为准，不靠收尾日志）");

  const exited = events.some((e) => e.t === "proc" && e.running === false);
  ok(exited, "播了 proc running:false");

  r = await call("proc:stop", { mode: "observer" });
  ok(!r.ok, "没在跑时停止 -> 报错而不是崩");

  /* ---------------- 7. 截断的文件 ---------------- */
  log("7. 截断的录像");
  const full = fs.readFileSync(path.join(TMP, "replays", name));
  const chopped = "截断-测试.yrp3d";
  fs.writeFileSync(path.join(TMP, "replays", chopped), full.subarray(0, full.length - 3));

  const whole = await call("recording:parse", { name });
  r = await call("recording:parse", { name: chopped });
  ok(r.ok, "尾部半个包 -> 仍然解析成功", JSON.stringify(r).slice(0, 200));
  ok(r.trimmed === true, "标了 trimmed");
  ok(r.parsedSize < r.size, "解析长度小于文件长度");
  // 文件是以对话包结尾的，砍掉 3 字节正好把最后那条对话切没。
  // 关键是「丢的只能是尾部那一条」，前面的一条都不能少 —— 所以拿完整文件
  // 的结果做前缀比对，而不是写死条数（包序变了测试不该跟着红）。
  const msgs = (x) => x.chats.map((c) => c.msg);
  ok(JSON.stringify(msgs(r)) === JSON.stringify(msgs(whole).slice(0, -1)),
    "只丢尾部那一条，前面的完整保留",
    `截断后 ${JSON.stringify(msgs(r))} / 完整 ${JSON.stringify(msgs(whole))}`);
  ok(r.running === false, "停了之后不再标录制中");

  // 界面独有的字段：列表里显示的是整文件大小，解析长度另算一格，
  // 导出 JSON 里不该出现 parsedSize（它不在 buildJson 的白名单里）
  ok(r.size === fs.statSync(path.join(TMP, "replays", chopped)).size,
    "size 是整文件大小（和列表里显示的一致），不是解析长度",
    `${r.size} vs 文件 ${fs.statSync(path.join(TMP, "replays", chopped)).size}`);
  ok(Number.isInteger(r.packets) && r.packets > 0,
    "响应里带上了包数", String(r.packets));

  /* ---------------- 7b. 导出：界面按钮走到的那几个函数 ---------------- *
   *
   * 用真的 recording:parse 响应喂 normalizeServer + 构建函数，覆盖「服务端录像」
   * 这条路径。注意**不能**拿这个截断文件去和 chat-extractor.html 的结果逐字节
   * 比对：chat-extractor 直接读文件、尾部半个包会让它整份判成损坏（ok:false），
   * 而界面先 trimToLastPacket 所以这里是 ok:true。这是有意的差异，不是 bug。
   */
  log("7b. 导出格式（端到端）");
  {
    const { normalizeServer, exportGroups, buildCsv, buildMergedTxt, buildPerFileTxt } =
      loadExtractor(["normalizeServer", "exportGroups", "buildCsv", "buildMergedTxt",
                     "buildPerFileTxt"]);

    const norm = normalizeServer(r);
    ok(norm.ok && norm.file === chopped && norm.chats.length === r.chats.length,
      "normalizeServer 把响应转成了 extract() 的形状", JSON.stringify(norm).slice(0, 160));
    ok(norm.trimmed === true && norm.running === false,
      "trimmed / running 一路带到界面（构建函数不看它们，所以不进导出文件）");

    const csv = buildCsv([norm], {});
    const rows = csv.split("\r\n");
    ok(rows[0] === "文件,偏移,说话者类型,说话者,消息",
      "CSV 表头逐字节一致（这几个字段有意不加引号）", rows[0]);
    ok(rows.length === r.chats.length + 1, "CSV 行数 = 对话数 + 表头", String(rows.length));
    const one = r.chats[0];
    ok(rows[1] === `"${chopped}",0x${one.offset.toString(16)},${one.playerType},"${one.who}","${one.msg}"`,
      "CSV 数据行的字段顺序和引号规则都对", rows[1]);
    ok(!csv.includes("trimmed") && !csv.includes("parsedSize"),
      "界面专有字段没漏进 CSV");

    const groups = exportGroups([norm], {});
    ok(groups.length === 1 && groups[0].file === chopped,
      "exportGroups 保留了有对话的文件");
    const txt = buildMergedTxt(groups);
    ok(txt === "### " + chopped + "\n" +
        r.chats.map((c) => `${c.who}: ${c.msg}`).join("\n"),
      "合并 TXT 的 ### 头行和说话者前缀都对", JSON.stringify(txt));
    ok(buildPerFileTxt(groups[0]) === r.chats.map((c) => `${c.who}: ${c.msg}`).join("\n"),
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
  r = await call("recording:parse", { name: "../../config.json" });
  ok(!r.ok, "../../config.json 被拒", `实际 ${JSON.stringify(r)}`);
  r = await call("recording:parse", { name: "..\\..\\observer.json" });
  ok(!r.ok, "..\\\\..\\\\observer.json 被拒");
  r = await call("recording:parse", { name: "不存在的.yrp3d" });
  ok(!r.ok && /读不到/.test(r.error), "不存在的文件给出可读的报错", JSON.stringify(r));

  /* ---------------- 9. 坏配置不挂死 ---------------- */
  log("9. 坏配置");
  fs.writeFileSync(path.join(TMP, "observer.json"), "{ 这不是 JSON");
  r = await call("config:get");
  ok(r.ok && r.observer === null, "配置坏了 -> 报 null，不是报错也不是挂住",
    JSON.stringify(r));
  r = await call("proc:start", { mode: "observer", cfg: { host: "x", port: 1, room: "r", version: 1 } });
  ok(r.ok, "配置坏了之后还能正常启动（会覆盖掉那个坏文件）");
  await call("proc:stop", { mode: "observer" });
  await until(async () => (await call("state:get")).running.observer === false);
}

/* ================================================================== *
 * 10. 导出：目录从哪儿来、怎么挡
 *
 * 渲染进程不该有能力往任意路径写文件、或者让主进程去打开任意一个路径 ——
 * 界面里那些文件名来自第三方服务器，是别人能左右的东西。
 * ================================================================== */
log("10. 导出");
{
  const read = (d, f) => fs.readFileSync(path.join(d, f), "utf8");

  // 没选过目录 -> 落在默认目录
  let r = await call("export:write", { files: [{ name: "第一次.txt", text: "甲" }] });
  ok(r.ok && r.dir === EXPORT_DEFAULT, "没选目录时写到默认目录", JSON.stringify(r));
  ok(r.written.join() === "第一次.txt", "回报写了哪些文件");
  ok(read(EXPORT_DEFAULT, "第一次.txt") === "甲", "文件内容对得上");

  // 选了目录 -> 落在所选目录，而且调用方**看不到也改不了**这个决定
  calls.pick = 0;
  r = await call("export:pickDir");
  ok(calls.pick === 1, "pickDir 被调了一次");
  ok(r.ok && r.dir === EXPORT_PICKED, "选了目录就把目录发下来", JSON.stringify(r));

  r = await call("export:write", {
    dir: "C:\\Windows",   // 调用方瞎指定的目录必须被无视
    files: [{ name: "第二次.txt", text: "乙" }, { name: "第二个.csv", text: "丙" }],
  });
  ok(r.ok && r.dir === EXPORT_PICKED, "写到了所选目录，而不是调用方指定的那个", JSON.stringify(r));
  ok(read(EXPORT_PICKED, "第二次.txt") === "乙" && read(EXPORT_PICKED, "第二个.csv") === "丙",
    "两个文件都写对了");
  ok(!fs.existsSync(path.join(EXPORT_DEFAULT, "第二次.txt")), "默认目录里没有多出东西");

  // 用户点取消不是错误
  pickResult = null;
  r = await call("export:pickDir");
  ok(r.canceled === true, "取消选目录 -> canceled，不是报错", JSON.stringify(r));
  pickResult = EXPORT_PICKED;

  // 文件名挡穿越，而且**整批不写** —— 写一半再报错会留下用户不知道的文件
  r = await call("export:write", { files: [{ name: "好的.txt", text: "x" },
                                          { name: "../跑出去.txt", text: "y" }] });
  ok(!r.ok, "导出名带 .. 被拒", JSON.stringify(r));
  ok(!fs.existsSync(path.join(EXPORT_PICKED, "好的.txt")), "整批都没写（不留半批）");
  ok(!fs.existsSync(path.join(EXPORT_PICKED, "..", "跑出去.txt")), "确实没写出去");
  for (const bad of ["a.exe", "a.bat", "a.txt.exe", "C:evil.txt"])
    ok(!(await call("export:write", { files: [{ name: bad, text: "" }] })).ok,
      `导出名 ${bad} 被拒`);

  // 打开刚写的文件：路径由**主进程**拼，渲染进程只说文件名
  calls.opened = [];
  r = await call("shell:openFile", { name: "第二次.txt" });
  ok(r.ok && r.path === path.join(EXPORT_PICKED, "第二次.txt"), "按文件名拼出绝对路径", JSON.stringify(r));
  ok(calls.opened.length === 1 && calls.opened[0] === r.path, "交给系统打开的就是这个路径");

  r = await call("shell:openFile", { name: "../../../../windows/win.ini" });
  ok(!r.ok, "打开时同样挡穿越", JSON.stringify(r));
  r = await call("shell:openFile", { name: "没有这个.txt" });
  ok(!r.ok && /不在了/.test(r.error), "打开不存在的文件给出可读的报错", JSON.stringify(r));

  // 剪贴板
  calls.clip = [];
  r = await call("clipboard:write", { text: "甲: 你好" });
  ok(r.ok && calls.clip[0] === "甲: 你好", "剪贴板写进去了");
  r = await call("clipboard:write", {});
  ok(r.ok && calls.clip[1] === "", "没给内容也不会崩");
}

/* ================================================================== *
 * 11. 退出：子进程必须跟着走
 *
 * 这条是用户点名要的 —— 关程序的时候后台录制脚本要自己停掉。
 * 「关窗口 → 进程真的退了」由 _test_electron.mjs 覆盖（那边起的是真程序），
 * 这里覆盖「收摊这一步点到了哪些子进程」。
 * ================================================================== */
log("11. 退出带走子进程");
{
  const held = [];
  const fakeServer = net.createServer((sock) => {
    held.push(sock);
    sock.on("error", () => {});
  });
  await new Promise((r) => fakeServer.listen(0, "127.0.0.1", r));
  const fport = fakeServer.address().port;

  let r = await call("proc:start", {
    mode: "observer",
    cfg: { host: "127.0.0.1", port: fport, room: "退出测试", name: "测试", version: 4962 },
  });
  ok(r.ok, "观战跑起来了");
  ok((await call("state:get")).running.observer === true, "状态是运行中");

  const connected = await until(() => held.length === 1);
  ok(connected, "子进程确实连上了（不然下面那条等于没测）");

  r = await call("app:quit");
  ok(r.ok, "app:quit 返回 ok", JSON.stringify(r));
  ok(Array.isArray(r.stopped) && r.stopped.includes("observer"),
    "响应里说明带走了哪个子进程", JSON.stringify(r.stopped));

  // 连接断了才叫「真的死了」—— 只看状态位的话，一个还在跑的进程也能被标成已停
  const gone = await until(() => held.every((s) => s.destroyed));
  ok(gone, "子进程的连接断了（进程真的没了）");

  const off = await until(async () => (await call("state:get")).running.observer === false);
  ok(off, "状态回到未运行");

  fakeServer.close();
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

/* ================================================================== *
 * 13. 录像目录是可以改的
 *
 * 为什么要有这一段：打包成安装包之后，**升级会把安装目录整个删掉重建**
 * （NSIS 先跑旧卸载器，实测过），所以录像必须能搬走。而「接口说改了」和
 * 「子进程真的写到新地方了」是两回事 —— 只改界面显示、子进程还在往老地方
 * 写，表现是「一直在录，可列表里一个文件都不出来」，这种半坏最难发现。
 * 所以下面既测接口，也起一个**真的**观战子进程，看文件实际落在哪。
 * ================================================================== */
log("13. 录像目录可改");
{
  const SETTINGS = path.join(TMP, "settings.json");
  const DEF = path.join(TMP, "replays"); // = DEFAULT_OUTDIR（DATA 下的 replays）
  // 目录名故意带中文：用户挑的目录完全可能叫「自选录像」，这条路径要真的走过
  // mkdir / 写文件 / readdir 才算数。
  const PICKED = path.join(TMP, "自选录像");
  try { fs.unlinkSync(SETTINGS); } catch (_) {}
  // ⚠️ 这里**别**写 `fs.rmSync(PICKED, ...)` 清场。TMP 是 mkdtempSync 出来的，
  // 每次跑都是新的，PICKED 不可能事先存在，清场本来就是多余的。
  // 而它在这台机器上会真的把进程打死（Node v23.11.1 / Windows：rmSync 一个
  // **不存在**的中文路径 → 访问违例 SIGSEGV，退出码 139，try/catch 也兜不住）。
  // 定位过程记在这条注释里免得后人再踩：crash 紧跟在本段 log() 之后，
  // 把所有断言都吞掉，看着像「第 13 段整个没跑」。

  // 系统能力注入成假的：pickDir 返回什么就是「用户在对话框里选了什么」
  const mk = (picked) => createApi({ pickDir: async () => picked });
  const on = async (inst, ch, args) => {
    try { return await inst.handlers[ch](args); }
    catch (e) { return e.payload || { ok: false, error: e.message }; }
  };
  const savedDir = () => {
    try { return JSON.parse(fs.readFileSync(SETTINGS, "utf8")).replaysDir; }
    catch (_) { return undefined; }
  };

  let a = mk(null);
  let r = await on(a, "replays:getDir");
  ok(r.ok && path.resolve(r.dir) === path.resolve(DEF), "默认落在数据目录下的 replays/", JSON.stringify(r));
  ok(r.custom === false && r.writable === true, "默认目录：不算自定义、可写", JSON.stringify(r));

  // 用户在对话框里点了取消 —— 和 export:pickDir 一样，不是错误
  r = await on(a, "replays:pickDir");
  ok(r.canceled === true, "点取消走 canceled，目录不变", JSON.stringify(r));

  a = mk(PICKED);
  r = await on(a, "replays:pickDir");
  ok(r.ok && path.resolve(r.dir) === path.resolve(PICKED), "换成了新目录", JSON.stringify(r));
  ok(r.custom === true, "标成自定义");
  ok(savedDir() === PICKED, "settings.json 里存下了新目录", String(savedDir()));

  // ⚠️ 本段的重点：**换一个新实例**读得回来才算真存下了。只改内存的话
  // 这里会退回默认 —— 用户看到的就是「改完当时管用，重启又回去了」。
  const b = mk(null);
  r = await on(b, "replays:getDir");
  ok(path.resolve(r.dir) === path.resolve(PICKED), "重建实例后还是新目录（真持久化了）", JSON.stringify(r));

  // 列表得跟着换目录走，不能继续列老目录里的东西
  fs.mkdirSync(DEF, { recursive: true });
  fs.writeFileSync(path.join(PICKED, "新目录里的.yrp3d"), "x");
  fs.writeFileSync(path.join(DEF, "老目录里的.yrp3d"), "x");
  r = await on(b, "recordings:list");
  ok(r.list.length === 1 && r.list[0].name === "新目录里的.yrp3d",
    "列表列的是新目录", JSON.stringify(r.list.map((f) => f.name)));

  /* ---------------- 录制中不给改 ---------------- *
   * 子进程已经把旧目录写死了，这时候换掉 = 界面看新目录、子进程写旧目录 */
  const held = [];
  const srv = net.createServer((sock) => {
    held.push(sock);
    // ⚠️ **必须真的回一个包。** 观战端是收到**第一个**服务器包才 new Session 的
    // （observer.js 的 onPacket -> ensureSession），而 Recorder 的构造函数就是
    // 开录像文件那一刻（proxy.js:172-178）。只握住连接、什么都不发的话，
    // 下面「文件落在新目录了没」永远等不到 —— 那不是产品没往新目录写，
    // 是压根没开始录，这条断言会假红。
    sock.on("data", splitter((type) => {
      if (type === P.JOIN_GAME) sock.write(frame(P.JOIN_GAME, Buffer.from([0x62, 0x13])));
    }));
    sock.on("error", () => {});
  });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));

  r = await on(b, "proc:start", {
    mode: "observer",
    cfg: { host: "127.0.0.1", port: srv.address().port, room: "换目录测试", version: 4962 },
  });
  ok(r.ok, "起一个真的观战子进程", JSON.stringify(r));
  ok(await until(() => held.length === 1), "子进程连上了假服务器");

  r = await on(b, "replays:pickDir");
  ok(!r.ok && /停下来/.test(r.error), "录制中改目录被拒", JSON.stringify(r));

  // 文件**真的**落在新目录里 —— 这才是「改到了」的证据。只看 replays:getDir
  // 的返回值的话，子进程还在往老地方写也一样能过。
  const landed = await until(async () => {
    const x = await on(b, "recordings:list");
    return x.list.find((f) => f.name.startsWith("换目录测试-")) || null;
  });
  ok(landed !== null, "子进程把录像写进了新目录，不是只改了界面显示");
  if (landed) {
    ok(fs.existsSync(path.join(PICKED, landed.name)), "文件在新目录里", landed.name);
    ok(!fs.existsSync(path.join(DEF, landed.name)), "老目录里没有它", landed.name);
  }

  await on(b, "proc:stop", { mode: "observer" });
  ok(await until(() => held.every((s) => s.destroyed)), "子进程停了");

  r = await on(b, "replays:resetDir");
  ok(r.ok && path.resolve(r.dir) === path.resolve(DEF), "恢复默认回到 replays/", JSON.stringify(r));
  // 只改内存的话，下次启动读回 settings.json 又是自定义那个 —— 按钮等于坏的
  ok(savedDir() === undefined, "settings.json 里那条真的删掉了（不是只改内存）", String(savedDir()));
  r = await on(mk(null), "replays:getDir");
  ok(path.resolve(r.dir) === path.resolve(DEF), "重建实例后确实是默认目录");

  // 写不进去的目录要**当场**报错，而不是等录完才发现什么都没录上。
  // 拿「父级是个文件」的路径来构造必然失败的情况 —— 跨平台，不依赖权限设置。
  const blocker = path.join(TMP, "这是个文件");
  fs.writeFileSync(blocker, "");
  r = await on(mk(path.join(blocker, "子目录")), "replays:pickDir");
  ok(!r.ok && /写不进去/.test(r.error), "选了个写不进去的目录 -> 当场报错", JSON.stringify(r));
  ok(savedDir() === undefined, "失败的目录没被存进设置（不然下次启动带着坏设置起来）");

  // settings.json 坏了当「没设过」，回落到默认目录 —— 它只是一个路径，
  // 不该因为它坏掉就让整个录像功能不可用。（config.json 坏了要报出来，见 4b 段）
  fs.writeFileSync(SETTINGS, "{ 这不是 JSON", "utf8");
  r = await on(mk(null), "replays:getDir");
  ok(r.ok && path.resolve(r.dir) === path.resolve(DEF), "settings.json 坏了 -> 回落默认目录，不崩", JSON.stringify(r));

  try { fs.unlinkSync(SETTINGS); } catch (_) {}
  srv.close();
}

/* ================================================================== *
 * 14. 导入本机录像：在录像目录里存一份
 *
 * 用户要的是「重启之后还在列表里」。验收断言就是第 3 条 —— 新起一个实例
 * （进程内状态全新，等于重启），列表里**依然**有它。
 *
 * 全部在 TMP 里，一个字节都不碰用户真实的 replays/。
 * ================================================================== */
log("14. 导入本机录像");
{
  const REPS = path.join(TMP, "replays"); // 默认目录（settings.json 已在 13 段清掉）
  const inst = createApi({});
  const on = async (i, ch, args) => {
    try { return await i.handlers[ch](args); }
    catch (e) { return e.payload || { ok: false, error: e.message }; }
  };
  const call14 = (ch, args) => on(inst, ch, args);
  const b64 = (b) => Buffer.from(b).toString("base64");
  const bytes = Buffer.from([0, 1, 2, 253, 254, 255, 10, 13]);
  const names = () => fs.readdirSync(REPS).filter((n) => n.endsWith(".yrp3d")).sort();
  const imp = (files) => call14("recordings:import", { files });

  // ① 落盘 + 字节相同 + 出现在列表里
  let r = await imp([{ name: "导入测试.yrp3d", data: b64(bytes), mtime: 1700000000000 }]);
  ok(r.ok && r.saved.length === 1, "导入成功", JSON.stringify(r));
  ok(r.saved[0].name === "导入测试.yrp3d", "落盘名就是原名", JSON.stringify(r.saved));
  ok(r.saved[0].i === 0, "回传的下标是请求数组下标", String(r.saved[0].i));
  // ⚠️ 先 existsSync 再 readFileSync，**不要**直接读：落点错了的话直接读会抛
  // ENOENT，把这一段后面所有断言一起吞掉（表现成「第 14 段整个没跑」），
  // 而真正该红的那条恰恰在最后 —— 见本文件第 13 段那条踩过的注释。
  const landed = path.join(REPS, "导入测试.yrp3d");
  ok(fs.existsSync(landed), "★ 真的落进了录像目录（平铺，不能是子目录 —— listRecordings 不递归）");
  ok(fs.existsSync(landed) && fs.readFileSync(landed).equals(bytes), "★ 字节逐字节相同");
  let L = await call14("recordings:list");
  ok(L.list.some((f) => f.name === "导入测试.yrp3d"), "出现在 recordings:list 里");
  ok(!L.list.some((f) => f.name === "导入测试.yrp3d" && f.size !== bytes.length), "列表里的 size 对得上");

  // ② ★★★ 整个功能的验收断言：换个实例（=重启）它还在
  //    进程内状态全是新的，活下来的只可能是磁盘上那个文件。
  const after = createApi({});
  const L2 = await on(after, "recordings:list");
  ok(L2.list.some((f) => f.name === "导入测试.yrp3d"), "★★★ 新实例（=重启）里依然在列表里（这就是用户要的）");

  // ③ ★★ 绝不覆盖用户自己的录像
  //    先放一份「用户自己录的」，再导入一个**同名但内容不同**的 —— 必须改名，
  //    而且原来那份字节前后一模一样。
  const mineName = "用户自己录的.yrp3d";
  const mine = Buffer.from("USER-OWN-RECORDING-BYTES");
  fs.writeFileSync(path.join(REPS, mineName), mine);
  r = await imp([{ name: mineName, data: b64(Buffer.from("SOMETHING-ELSE")) }]);
  ok(r.saved[0].name === "用户自己录的_2.yrp3d", "★ 同名改成 _2", JSON.stringify(r.saved));
  ok(fs.readFileSync(path.join(REPS, mineName)).equals(mine), "★★ 用户自己那份字节没被改动");
  const dup = path.join(REPS, "用户自己录的_2.yrp3d");
  ok(fs.existsSync(dup) && fs.readFileSync(dup).toString() === "SOMETHING-ELSE", "_2 是新内容");

  // ④ 再来一次 → _3（不比对内容，按用户的决定：同名就改名）
  r = await imp([{ name: mineName, data: b64(Buffer.from("THIRD")) }]);
  ok(r.saved[0].name === "用户自己录的_3.yrp3d", "第三次是 _3", JSON.stringify(r.saved));
  ok(fs.readFileSync(path.join(REPS, mineName)).equals(mine), "第一份还是没动");

  // ⑤ 0 字节必须成功：proxy.js 开录像用的是 openSync(file,"w")，磁盘上真有这种
  r = await imp([{ name: "空录像.yrp3d", data: "" }]);
  ok(r.ok && r.saved.length === 1 && r.saved[0].size === 0, "0 字节被接受", JSON.stringify(r));

  // ⑥ 拒绝路径：逐条 ok:false，且磁盘上什么都没多
  const before = names().join(",");
  for (const [f, what] of [
    [{ name: "../evil.yrp3d", data: b64(bytes) }, "路径穿越"],
    [{ name: "a/b.yrp3d", data: b64(bytes) }, "带斜杠"],
    [{ name: "C:evil.yrp3d", data: b64(bytes) }, "带盘符"],
    [{ name: "x.yrp", data: b64(bytes) }, "扩展名不对（.yrp 不落盘）"],
    [{ name: "x.yrp3d", data: "!!!!" }, "坏 base64（Buffer.from 会静默吞掉，必须拒）"],
    [{ name: "x.yrp3d", data: b64(bytes) + "=" }, "长度对不上的 base64"],
    [{ name: "x.yrp3d", data: b64(Buffer.alloc(8 * 1024 * 1024 + 1)) }, "超过单文件上限"],
    [{ name: "", data: b64(bytes) }, "空文件名"],
  ]) {
    const q = await imp([f]);
    ok(!q.ok && !!q.error, `拒绝：${what}`, JSON.stringify(q).slice(0, 160));
  }
  ok(names().join(",") === before, "★ 被拒的一个都没在磁盘上留东西", names().join(","));

  // ⑦ 整批过大 / 个数过多
  const many = await imp(Array.from({ length: 51 }, (_, i) => ({ name: `f${i}.yrp3d`, data: b64(bytes) })));
  ok(!many.ok && /最多/.test(many.error), "51 个被拒", JSON.stringify(many));
  const huge = await imp(Array.from({ length: 5 }, (_, i) => ({
    name: `b${i}.yrp3d`, data: b64(Buffer.alloc(4 * 1024 * 1024)),
  })));
  ok(!huge.ok, "整批加起来超过 16MB 被拒", JSON.stringify(huge).slice(0, 120));

  // ⑧ mtime：保留成源时间，所以它不会插到列表最前面去冒充「最新那条」
  const newest = (await call14("recordings:list")).list[0];
  const old = (await call14("recordings:list")).list.find((f) => f.name === "导入测试.yrp3d");
  ok(Math.abs(old.mtime - 1700000000000) < 2000, "mtime 被保留成源时间", String(old.mtime));
  ok(newest.name !== "导入测试.yrp3d", "去年的 mtime 不会让它抢到 list[0]（界面「跟随最新」就是看这个）", newest.name);

  // ⑨ 同批里单个文件写不进去 → 进 failed，不连累同批其它文件
  //    （名字超过文件系统上限 → ENAMETOOLONG，跨平台，不依赖权限）
  r = await imp([
    { name: "z".repeat(300) + ".yrp3d", data: b64(bytes) },
    { name: "同批另一个.yrp3d", data: b64(bytes) },
  ]);
  ok(r.ok && r.saved.length === 1 && r.saved[0].name === "同批另一个.yrp3d", "同批另一个照常落盘", JSON.stringify(r.saved));
  ok(r.failed.length === 1 && r.failed[0].i === 0 && !!r.failed[0].error, "写不进去的进 failed 且带对下标", JSON.stringify(r.failed));

  // ⑩ ★ 录制进行中导入：写一份**和正在录的那个同名**的文件 —— 这是最坏情况，
  //    正好撞上「先 existsSync 再 writeFileSync」那个窗口会毁掉人家一条录像的场景。
  //    writeCopy 用 "wx" 只新建不覆盖，所以必须在录制中真的验一次。
  const held = [];
  const srv = net.createServer((sock) => {
    held.push(sock);
    sock.on("data", splitter((type) => {
      if (type === P.JOIN_GAME) sock.write(frame(P.JOIN_GAME, Buffer.from([0x62, 0x13])));
    }));
    sock.on("error", () => {});
  });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  r = await call14("proc:start", {
    mode: "observer",
    cfg: { host: "127.0.0.1", port: srv.address().port, room: "导入测试房", version: 4962 },
  });
  ok(r.ok, "起一个真的观战子进程", JSON.stringify(r));
  ok(await until(() => held.length === 1), "子进程连上了假服务器");

  const rec = await until(async () => {
    const x = await call14("recordings:list");
    return x.list.find((f) => f.name.startsWith("导入测试房-")) || null;
  });
  ok(rec !== null, "⚠️ 前置：子进程真的开始录了（不然下面那条等于没测）");
  if (rec) {
    const recBytes = fs.readFileSync(path.join(REPS, rec.name));
    const q = await imp([{ name: rec.name, data: b64(Buffer.from("IMPORT-DURING-RECORDING")) }]);
    ok(q.ok && q.saved[0].name !== rec.name, "★ 录制中导入同名文件：换了名字落盘", JSON.stringify(q.saved));
    ok(fs.existsSync(path.join(REPS, rec.name)), "★ 正在录的那个文件还在");
    const nowBytes = fs.readFileSync(path.join(REPS, rec.name));
    ok(nowBytes.subarray(0, recBytes.length).equals(recBytes), "★★ 正在录的那条录像字节没被截断/覆盖");
    const L3 = await call14("recordings:list");
    ok(L3.list.some((f) => f.name === rec.name), "它还在列表里");
    ok(L3.anyRunning === true, "录制状态没被这次导入搅乱");
  }
  await call14("proc:stop", { mode: "observer" });
  ok(await until(() => held.every((s) => s.destroyed)), "子进程停了");
  srv.close();
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(failed ? `\n${failed} 个失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
