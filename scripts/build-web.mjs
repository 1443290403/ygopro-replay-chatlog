#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * 把 Electron 版里那批「两边共用」的文件同步进 www/，并生成 www/index.html。
 *
 * 这个脚本是 **www/ 唯一的产出者**。手工往 www/ 里放文件没有意义 —— 下次
 * 构建就被这里覆盖掉，而且 _test_shared_sync.mjs 会把「www/ 和同步结果不一致」
 * 报成失败。
 *
 * 为什么是「白名单拷贝」而不是「整目录复制」：
 *   整目录复制会把 proxy/config.json（用户的第三方服务器地址）、
 *   proxy/observer.json、proxy/replays/ 里用户的录像一起打进 APK。
 *   Electron 版是靠 electron-builder 的 files 白名单挡住的（package.json:21-33），
 *   **安卓版没有 electron-builder**，所以这份清单就是唯一的防线。
 *   加文件要同时改这里，别图省事改成递归复制 —— 那会把用户数据打进发布包，
 *   而且包照常能跑，完全看不出来。
 *
 * 布局不是随便定的：`api.js:35` 是 `require("../_parser.js")`，`_parser.js:28` 是
 * `require("./_shipped.js")`，`_shipped.js` 的 SOURCE_PATHS 又是相对它自己。
 * 所以 www/nodejs/ 必须是 Electron 版**根目录的同构副本**：
 *   _shipped.js / _parser.js / chat-extractor.html 三兄弟同级，proxy/ 是它们的子目录。
 *   这样这 6 个文件一个字都不用改。
 * ------------------------------------------------------------------ */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.resolve(HERE, "..", "yrp-tools-electron");
const WWW = path.join(HERE, "www");
const NODEJS = path.join(WWW, "nodejs");

/* 白名单：来源（相对 SRC）→ 去处（相对 HERE）。
 * 反面清单见 NEVER_COPY，两个都要维护。 */
const COPIES = [
  ["_shipped.js", "www/nodejs/_shipped.js"],
  ["_parser.js", "www/nodejs/_parser.js"],
  ["chat-extractor.html", "www/nodejs/chat-extractor.html"],
  ["chat-extractor.html", "www/chat-extractor.html"],
  ["proxy/api.js", "www/nodejs/proxy/api.js"],
  ["proxy/observer.js", "www/nodejs/proxy/observer.js"],
  ["proxy/proxy.js", "www/nodejs/proxy/proxy.js"],
  // gui.html 两份：一份原样放 nodejs/（_shipped.js 的 SOURCE_PATHS 里有 "gui.html"，
  // 那张表查不到就抛），一份注入垫片后当界面用。
  ["proxy/gui.html", "www/nodejs/proxy/gui.html"],
];

/* 这些**永远不许**出现在 www/ 或 APK 里。命中即失败，不是警告。 */
const NEVER_COPY = ["config.json", "observer.json", "settings.json", "replays", "gui-token.txt"];

const SHIM_TAG = '<script src="yrp-shim.js"></script>';

let failed = 0;
const ok = (cond, what, extra = "") => {
  if (cond) console.log(`  ok   ${what}`);
  else {
    failed++;
    console.log(`  FAIL ${what}${extra ? `\n       ${extra}` : ""}`);
  }
};
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
const show = (p) => path.relative(HERE, p).replace(/\\/g, "/");

console.log(`源：${SRC}`);
console.log(`目标：${show(WWW)}\n`);

/* ---------- 1. 源必须齐全 ---------- */
console.log("1. 源文件");
ok(fs.existsSync(path.join(SRC, "proxy", "gui.html")), "Electron 版的源码树在");
let missing = 0;
for (const [rel] of COPIES) {
  if (!fs.existsSync(path.join(SRC, rel))) {
    missing++;
    console.log(`       ✗ 找不到 ${rel}`);
  }
}
ok(missing === 0, `${COPIES.length} 个共享文件都找得到`, `缺 ${missing} 个`);

/* ---------- 2. 拷贝（白名单，逐个文件） ---------- */
console.log("\n2. 同步（白名单拷贝）");
fs.mkdirSync(path.join(NODEJS, "proxy"), { recursive: true });

for (const [rel, out] of COPIES) {
  const from = path.join(SRC, rel);
  const to = path.join(HERE, out);
  const buf = fs.readFileSync(from);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, buf);
  console.log(`  ${rel.padEnd(24)} -> ${out.padEnd(28)} ${String(buf.length).padStart(7)} B  ${sha(buf)}`);
}

/* ---------- 3. 生成 www/index.html ---------- */
console.log("\n3. 生成 www/index.html（源版 + 一行垫片）");
const guiSrc = fs.readFileSync(path.join(SRC, "proxy", "gui.html"), "utf8");
ok(!guiSrc.includes(SHIM_TAG), "源版 gui.html 里没有这行垫片（否则会插成两行）");

const at = guiSrc.indexOf("</head>");
ok(at > 0, "源版 gui.html 里有 </head>", "没有的话垫片没法插在正确位置");

/* 插在 </head> 之前：整页唯一的内联 <script> 在 367 行，垫片必须先跑，
 * 否则 gui.html 的 init() 摸到的 window.yrp 还是 undefined。 */
const indexHtml = guiSrc.slice(0, at) + SHIM_TAG + "\n" + guiSrc.slice(at);
fs.writeFileSync(path.join(WWW, "index.html"), indexHtml, "utf8");

ok(indexHtml.split(SHIM_TAG).length - 1 === 1, "垫片标签恰好出现 1 次");
ok(indexHtml.indexOf(SHIM_TAG) < indexHtml.indexOf("<script>"), "垫片在内联 <script> 之前");
/* 唯一的差异就是这一行 —— 去掉垫片后应当逐字节相同。
 * 这条防的是「将来有人改了 www/index.html 而没改源版」。 */
ok(indexHtml.replace(SHIM_TAG + "\n", "") === guiSrc, "除了这一行，index.html 和源版逐字节相同");

/* ---------- 4. 哨兵块 ---------- */
console.log("\n4. 哨兵块（解析库的唯一真相）");
/* 哨兵文字**从 _parser.js 里读**，不硬编码 —— 那边改了这里自动跟上。
 * _parser.js 是 CJS，用 createRequire 加载；它读 chat-extractor.html 是懒的，
 * 加载期不会碰文件系统（_shipped.js 的 SOURCE_PATHS 只是一张表）。 */
const req = createRequire(import.meta.url);
let BEGIN = "/* @parser:begin";
let END = "/* @parser:end */";
try {
  ({ BEGIN, END } = req(path.join(NODEJS, "_parser.js")));
  console.log(`  哨兵（读自 _parser.js）：${BEGIN}  …  ${END}`);
} catch (e) {
  console.log(`  ⚠️ 读 _parser.js 失败，退回硬编码值：${e.message}`);
}
const ce = fs.readFileSync(path.join(SRC, "chat-extractor.html"), "utf8");
const b = ce.indexOf(BEGIN);
const e = ce.indexOf(END);
ok(b > 0, `chat-extractor.html 里有 ${BEGIN}`);
ok(e > b, `${END} 在它之后（顺序反了 _parser.js 会抛）`);
ok(sha(fs.readFileSync(path.join(WWW, "chat-extractor.html"))) === sha(Buffer.from(ce)),
  "拷过去的便携页和源版逐字节相同");

/* ---------- 5. 反面断言：用户数据一个都不许进来 ---------- */
console.log("\n5. 反面断言（用户数据不进包）");
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((ent) => {
    const p = path.join(dir, ent.name);
    return ent.isDirectory() ? walk(p) : [p];
  });
const all = walk(WWW);
ok(all.length > 0, `www/ 里有 ${all.length} 个文件（否则下面的断言全是空跑）`);

for (const bad of NEVER_COPY) {
  const hit = all.filter((p) => path.basename(p) === bad || p.split(path.sep).includes(bad));
  ok(hit.length === 0, `不该有 ${bad}`, hit.map(show).join(", "));
}

/* 拿用户**真实配置里的值**当泄漏标志 —— 比硬编码字符串准。
 *
 * 扫的是 room / name / hostPort，**不含服务器地址**：地址是作者自己写进默认值的
 * （代理和观战都是 mygo.superpre.pro），公开的，不当秘密；
 * 房间名和昵称才是真正私密的。
 *
 * ⚠️ 所以改那两个默认地址**不会**让这一段变红 —— 别以为它守住了地址。
 *    `hostPort` 这个键现在的 observer.json 里并不存在，等于只有 room / name 在起作用。 */
console.log("\n   用真实配置里的私密值再扫一遍：");
for (const f of ["observer.json", "config.json"]) {
  const p = path.join(SRC, "proxy", f);
  if (!fs.existsSync(p)) {
    console.log(`   （跳过 ${f}：文件不在）`);
    continue;
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_) {
    console.log(`   （跳过 ${f}：不是合法 JSON）`);
    continue;
  }
  /* room 可能是 "房间名$密码"，两截都要扫 */
  const values = [cfg.room, cfg.name, cfg.hostPort]
    .filter((v) => typeof v === "string" && v.trim().length >= 2)
    .flatMap((v) => [v, ...v.split("$")])
    .filter((v) => v.trim().length >= 2);
  if (!values.length) {
    console.log(`   （跳过 ${f}：没有可用的标志值）`);
    continue;
  }
  let hitCount = 0;
  for (const v of values) {
    const hit = all.filter((p) => {
      if (!/\.(js|html|json|mjs|css|txt)$/.test(p)) return false;
      return fs.readFileSync(p, "utf8").includes(v);
    });
    if (hit.length) {
      hitCount++;
      ok(false, `产物里不该出现 ${f} 里的值（长度 ${v.length}，不打印原文）`, hit.map(show).join(", "));
    }
  }
  if (!hitCount) ok(true, `${values.length} 个标志值都没出现在产物里（${f}）`);
}

/* ---------- 6. 手写的那几个 + 它们依赖的契约 ---------- */
console.log("\n6. 手写的文件与它们依赖的契约");

/* 这几个不在 COPIES 里（它们是安卓版独有的新东西，不是从 Electron 版拷的），
 * 但少了任何一个构建出来的 APK 都是废的，所以在这儿盯着。 */
for (const rel of ["www/yrp-shim.js", "www/nodejs/index.js", "www/nodejs/package.json"]) {
  const p = path.join(HERE, rel);
  ok(fs.existsSync(p), `${rel} 在`, fs.existsSync(p) ? "" : "（这个文件是手写的，不经同步）");
  if (fs.existsSync(p)) console.log(`       ${String(fs.statSync(p).size).padStart(7)} B`);
}

try {
  const pkg = JSON.parse(fs.readFileSync(path.join(NODEJS, "package.json"), "utf8"));
  ok(pkg.main === "index.js", "www/nodejs/package.json 的 main 指向 index.js", `实际是 ${pkg.main}`);
} catch (e) {
  ok(false, "www/nodejs/package.json 能解析", e.message);
}

/* ------------------------------------------------------------------ *
 * 下面这些是**跨仓库的隐式契约**，是这个方案里最容易烂掉的地方。
 *
 * 安卓侧那个「假 ChildProcess」（www/nodejs/index.js）是照着 api.js 的
 * **调用契约**写的，不是靠改 api.js 改出来的：
 *   - 它靠 args[0] 的文件名判断自己在跑哪个模式
 *   - 它靠 args 里有没有 --dump 决定要不要开抓包
 *   - 它靠 env.YRP_REPLAYS_DIR 决定录像写哪儿
 *   - 它靠 opts.spawn 这个注入点才存在
 *
 * 任何一条在 api.js 里改了，安卓侧都会**静默**失配（起不来、或者录到
 * 别的目录去）。所以在这儿钉住 —— 改的人会当场看见红字，而不是等真机上
 * 用户发现「怎么一个录像都没有」。
 * ------------------------------------------------------------------ */
console.log("\n   跨仓库契约（api.js 必须还是这个形状）：");
const apiSrc = fs.readFileSync(path.join(SRC, "proxy", "api.js"), "utf8");
const contract = [
  [/mode\s*===\s*"proxy"\s*\?\s*"proxy\.js"\s*:\s*"observer\.js"/, "脚本名仍是 proxy.js / observer.js"],
  [/"--dump"/, "dump 仍然走 --dump"],
  [/\bdump\s*\?\s*\["--dump"\]\s*:\s*\[\]/, "proc:start 仍然这么拼 --dump"],
  [/YRP_REPLAYS_DIR:\s*outDir/, "录像目录仍然由 YRP_REPLAYS_DIR 传下去"],
  [/opts\.spawn\s*\|\|\s*nodeSpawn/, "spawn 的注入点还在"],
  [/YRP_DATA_DIR:\s*DATA/, "数据目录仍然由 YRP_DATA_DIR 传下去"],
  // 反面：不能再出现直接解构 require("child_process") 的写法 ——
  // 那在安卓上会**加载期**就抛，整个 api.js 都用不了
  [/const\s*\{\s*spawn\s*\}\s*=\s*require\("child_process"\)/, "没有退回到直接解构 child_process", true],
];
for (const [re, what, invert] of contract) {
  const hit = re.test(apiSrc);
  ok(invert ? !hit : hit, what);
}

/* ------------------------------------------------------------------ *
 * 垫片依赖的 gui.html 元素。全在 www/yrp-shim.js 的 adjustDom() 里，
 * 而且全都写着「找不到就跳过」—— 那是为了桌面和测试环境不报错。
 * 代价是 gui.html 一改 id，安卓上的功能就**整个消失而没有任何报错**：
 * 拖放那块不响应点击（用户只能干瞪眼）、「录像存到」又冒出来显示一串
 * /data/user/0/... 的路径。所以在这儿钉住 id 本身。
 * ------------------------------------------------------------------ */
console.log("\n   垫片依赖的 gui.html 元素：");
const shimNeeds = [
  ["drop", "拖放区（安卓上整块改成可点击）"],
  ["pick-files", "「选择文件…」按钮（垫片要把它搬进 #drop）"],
  ["pick-clear-local", "「清空拖入的文件」（垫片要留着它）"],
  ["file-input", "垫片去掉它的 accept，整块点击也是点它"],
  ["rec-target", "「录像存到：…」（垫片要藏掉它）"],
  ["exp-target", "「导出到：…」（垫片要改它的文案）"],
];
for (const [id, why] of shimNeeds) {
  ok(guiSrc.includes(`id="${id}"`), `gui.html 里还有 #${id} —— ${why}`);
}

/* 分页。垫片不碰它，但三端要一致，而 www/ 是拷出来的 —— 在这儿再确认一遍
 * 拷过来的那份真是带分页的，而不只是源版带。 */
console.log("\n   分页（三端共用同一份实现）：");
for (const [re, what] of [
  [/function pageMeta\(total, page, per\)\{/, "pageMeta 在（页码夹取 + 切片全在它里面）"],
  [/const PER_PAGE = 10;/, "每页 10 条"],
  [/rows\.slice\(m\.from, m\.to\)/, "renderRecs 真的只画当前页"],
  [/function updatePager\(m\)\{/, "updatePager 在（页码文案 + 按钮禁用）"],
  [/id="pg-prev"/, "#pg-prev 在"],
  [/id="pg-next"/, "#pg-next 在"],
  [/id="pg-info"/, "#pg-info 在"],
]) {
  ok(re.test(guiSrc), what);
}
ok(!/id="quit"/.test(guiSrc), "「退出界面」按钮已经拿掉（安卓上点它会让 App 崩，见 gui.html 里的说明）");

/* 导入的录像存一份到录像目录。这条路**只能**走 recordings:import 那个 IPC 通道：
 * 安卓的桥是纯 JSON，api.js 那边对 args 直接 JSON.stringify，所以界面必须先把
 * 字节 base64 编好再送过来（本地 HTTP 那套在安卓上根本不存在）。 */
console.log("\n   导入落盘（三端共用同一份实现）：");
for (const [re, what] of [
  [/function b64Of\(bytes\)\{/, "b64Of 在（字节 -> base64，过桥的唯一形式）"],
  [/const B64_CHUNK = 32768;/, "分块常量在（最后只调一次 btoa）"],
  [/function importName\(name\)\{/, "importName 在（洗文件名）"],
  [/function savedNames\(\)\{/, "savedNames 在（把磁盘那份藏掉）"],
  [/saved\.has\(f\.name\)/, "renderRecs 真的藏了磁盘副本"],
  [/post\("recordings:import"/, "走的是 recordings:import 通道（不是本地 HTTP 那条）"],
]) {
  ok(re.test(guiSrc), what);
}
// api.js 是共用的那一份，通道必须在
ok(/["']recordings:import["']/.test(apiSrc), "api.js 里有 recordings:import 通道");
ok(
  /const IMPORT_MAX_BYTES = 8 \* 1024 \* 1024;/.test(apiSrc),
  "宿主侧的单文件上限还是 8MB（改小会让真实用户的录像导不进来）"
);
// 反面：主分支走的是本地 HTTP 路径 /api/import，那条在安卓上**不存在** ——
// 漏进 www/ 就是复制粘贴事故，表现是「点了导入没反应」
const leaked = [];
for (const f of walk(WWW)) {
  try {
    if (fs.readFileSync(f, "utf8").includes('"/api/import"')) leaked.push(path.relative(WWW, f));
  } catch (_) {}
}
ok(leaked.length === 0, "www/ 里没有主分支的 /api/import 路径", leaked.join(", "));

console.log(
  failed === 0
    ? `\n同步完成（${COPIES.length} 个文件，www/ 共 ${walk(WWW).length} 个）。`
    : `\n${failed} 个失败 —— 构建没完成，别往下走。`
);
process.exit(failed === 0 ? 0 : 1);
