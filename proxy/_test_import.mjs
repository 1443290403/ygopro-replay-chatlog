// 导入的录像存一份到录像目录 —— 的测试。
//
//   node proxy/_test_import.mjs
//
// 这个功能横跨四份文件，全都是**拷来拷去、没有共同来源**的：
//
//   浏览器侧   gui.html（electron 真本）/ yrp-tools/proxy/gui.html（主分支）
//   宿主侧     proxy/api.js（electron + 安卓共用）/ yrp-tools/proxy/gui.js（主分支）
//
// 其中 api.js 和安卓那份是逐字节拷贝（build-web.mjs），gui.html 那两份靠人同步。
// 飘了不会报错，只会让**某一端静默地不落盘** —— 用户看到的是「导入了，但重开就没了」。
// 和 _test_api.mjs 里「三份 DEFAULTS 必须一致」、_test_paging.mjs 里
// 「两份 pageMeta 逐字相同」是同一种病。
//
// 测试分三层：纯函数（抠出来跑）/ 宿主函数（require 进来跑真行为）/ 跨文件一致性。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const ELECTRON_GUI = path.join(HERE, "gui.html");
const MAIN_GUI = path.join(REPO, "yrp-tools", "proxy", "gui.html");
const API_JS = path.join(HERE, "api.js");
const MAIN_GUI_JS = path.join(REPO, "yrp-tools", "proxy", "gui.js");

let failed = 0;
function ok(cond, what, extra) {
  if (cond) console.log(`  ok   ${what}`);
  else {
    failed++;
    console.log(`  FAIL ${what}${extra ? `\n       ${extra}` : ""}`);
  }
}
const log = (s) => console.log(`\n${s}`);
const die = (msg) => {
  console.log(`\n${msg}`);
  process.exit(1);
};

/* 抠函数。用**函数的整个定义**当提取单位（从签名到顶格的收尾大括号），不靠行号 ——
 * 行号会随任何一次编辑漂移，那样测试就变成了「记得改测试」。
 * 比 _test_paging.mjs 那份多容忍一个 `\)\s*\{`：api.js 的风格是 `function f(s) {`，
 * gui.html 里是 `function f(s){`，同一个正则要能同时啃下两种。 */
function grab(src, name, args) {
  const re = new RegExp(`function ${name}\\(${args}\\)\\s*\\{[\\s\\S]*?\\n\\}`);
  const m = src.match(re);
  return m ? m[0] : null;
}
const compile = (text) => new Function(`return (${text})`)();

/* 把抠出来的函数绑上它引用的外部变量，返回一个可直接调用的函数。
   ⚠️ 不能写成 new Function("S", `return (${f})`) 然后指望调用时传进去 ——
   内层函数里那个 `S` 会解析到**外层函数的参数**上（闭包），调用时传的实参根本
   进不去。必须在外层就把值喂好。 */
function bind(text, deps) {
  const names = Object.keys(deps);
  return new Function(...names, `return (${text})`)(...names.map((n) => deps[n]));
}

if (!fs.existsSync(ELECTRON_GUI)) die(`找不到 ${ELECTRON_GUI}`);
if (!fs.existsSync(MAIN_GUI)) die(`找不到 ${MAIN_GUI}`);

const electronSrc = fs.readFileSync(ELECTRON_GUI, "utf8");
const mainSrc = fs.readFileSync(MAIN_GUI, "utf8");
const apiSrc = fs.readFileSync(API_JS, "utf8");
const mainJsSrc = fs.readFileSync(MAIN_GUI_JS, "utf8");

/* 宿主函数直接 require 进来跑真行为。YRP_DATA_DIR 先指到临时目录 —— api.js 在
 * **加载期**就会拿它算路径，绝不能让它落到用户真实的 proxy/ 上。 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "yrp-import-"));
process.env.YRP_DATA_DIR = TMP;
delete process.env.YRP_REPLAYS_DIR;
const require_ = createRequire(import.meta.url);
let api;
try {
  api = require_(API_JS);
} catch (e) {
  die(`api.js 加载不了：${e.message}`);
}

/* ------------------------------------------------------------------ *
 * 1. b64Of —— 和 Buffer 对拍
 * ------------------------------------------------------------------ */
log("1. b64Of 和 Buffer 对拍");
{
  const fn = grab(electronSrc, "b64Of", "bytes");
  if (!fn) die("抠不到 b64Of —— 别把签名改了");
  // B64_CHUNK 是块外常量，得当成参数喂进去（这也是它被钉住的地方）
  const chunk = Number((electronSrc.match(/const B64_CHUNK = (\d+);/) || [])[1]);
  ok(chunk === 32768, "B64_CHUNK 是 32768", String(chunk));
  const b64Of = bind(fn, { B64_CHUNK: chunk, btoa });

  // 32768 / 32769 是**专打 B64_CHUNK 边界**的：32768 不是 3 的倍数，所以只要
  // 实现退化成「每段各自 btoa 再拼」，这两条会立刻红。真实录像只有几 KB，
  // 撞不上这个边界，所以只能靠这里钉。
  for (const n of [0, 1, 2, 3, 1023, 4096, 32768, 32769, 65536]) {
    const u8 = Uint8Array.from({ length: n }, (_, i) => i % 256);
    ok(b64Of(u8) === Buffer.from(u8).toString("base64"), `长度 ${n} 和 Buffer 对拍`);
  }
  // 全 0xFF 和全 0x00：只有一个字节值参与时最容易掩盖位运算错误
  for (const v of [0, 255, 128]) {
    const u8 = new Uint8Array(5000).fill(v);
    ok(b64Of(u8) === Buffer.from(u8).toString("base64"), `全 ${v} 的 5000 字节对拍`);
  }
  ok(b64Of(new Uint8Array(0)) === "", "0 字节编成空串（宿主必须接受它）");
}

/* ------------------------------------------------------------------ *
 * 2. importName —— 全角冒号绝对不许动
 * ------------------------------------------------------------------ */
log("2. importName 洗文件名");
{
  const fn = grab(electronSrc, "importName", "name");
  if (!fn) die("抠不到 importName —— 别把签名改了");
  const importName = compile(fn);

  // ★ 这条是重点：用户真实录像名就长这样，全角「：」是合法的 Windows 文件名字符，
  //   洗掉了名字就对不上，用户在列表里会认不出来
  ok(
    importName("09-25「16：23：49」.yrp3d") === "09-25「16：23：49」.yrp3d",
    "★ 全角「：」原样不动",
    importName("09-25「16：23：49」.yrp3d")
  );
  ok(importName("示例房-09-25「18：13：29」.yrp3d") === "示例房-09-25「18：13：29」.yrp3d", "# 和全角括号也不动");
  // 安卓的 DISPLAY_NAME 可能带 ASCII 冒号，而宿主的 safeName 见到 `:` 一律拒
  ok(importName("a:b.yrp3d") === "a_b.yrp3d", "ASCII 冒号洗成下划线", importName("a:b.yrp3d"));
  ok(importName("a/b.yrp3d") === "a_b.yrp3d", "ASCII 斜杠洗掉", importName("a/b.yrp3d"));
  ok(importName("a\\b.yrp3d") === "a_b.yrp3d", "反斜杠洗掉", importName("a\\b.yrp3d"));
  ok(importName('a*b?"<>|.yrp3d') === "a_b_____.yrp3d", "其余非法字符都洗掉", importName('a*b?"<>|.yrp3d'));
  ok(importName("") === "", "空名洗成空串（调用方靠它以 .yrp3d 结尾来判定不落盘）");
  ok(importName(null) === "", "null 不炸");
}

/* ------------------------------------------------------------------ *
 * 3. savedNames —— 只收存盘成功过的
 * ------------------------------------------------------------------ */
log("3. savedNames");
{
  const fn = grab(electronSrc, "savedNames", "");
  if (!fn) die("抠不到 savedNames —— 别把签名改了");

  const S = {
    local: new Map([
      ["u:0:a.yrp3d", { name: "a.yrp3d", savedAs: null }], // 没存进去的
      ["u:1:b.yrp3d", { name: "b.yrp3d", savedAs: "b.yrp3d" }], // 存进去了
      ["u:2:b.yrp3d", { name: "b.yrp3d", savedAs: "b_2.yrp3d" }], // 重名被改过名
    ]),
  };
  const got = bind(fn, { S })();
  ok(got.size === 2, "只收有 savedAs 的", String(got.size));
  ok(got.has("b.yrp3d") && got.has("b_2.yrp3d"), "用的是宿主**实际写进去**的名字");
  ok(!got.has("a.yrp3d"), "没存进去的不算（它磁盘上本来就没有）");
  ok(bind(fn, { S: { local: new Map() } })().size === 0, "空的时候是空集合");
}

/* ------------------------------------------------------------------ *
 * 4. 宿主函数 decodeB64 / writeCopy —— 跑真行为
 * ------------------------------------------------------------------ */
log("4. decodeB64");
{
  const d = api.decodeB64;
  ok(d("") !== null && d("").length === 0, "★ 空串解出 0 字节（proxy.js 真会产出 0 字节录像）");
  // 说明为什么不能直接用 Buffer.from：它对垃圾字符是**静默丢弃**的
  ok(Buffer.from("QUJD!!!", "base64").toString() === "ABC", "（前提）Buffer.from 自己会静默丢弃垃圾字符");
  ok(d("QUJD!!!") === null, "★ 所以 decodeB64 必须把这种拒掉，不能写进去半截录像");
  ok(d("AAA") === null, "长度不是 4 的倍数被拒");
  ok(d("AAA==AAA") === null, "= 出现在中间（形状不对）被拒");
  ok(d(null) === null && d(123) === null, "非字符串被拒");
  const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
  ok(d(bytes.toString("base64")).equals(bytes), "正常内容解得回来");
  ok(d(Buffer.alloc(300).toString("base64")).length === 300, "300 字节（带补位）解得回来");
}

log("5. writeCopy —— ★ 绝不覆盖");
{
  const dir = path.join(TMP, "replays");
  fs.mkdirSync(dir, { recursive: true });
  const p = (n) => path.join(dir, n);
  const b1 = Buffer.from([1, 2, 3]);
  const b2 = Buffer.from([9, 9, 9, 9]);

  let r = api.writeCopy(dir, "a.yrp3d", b1, 1700000000000);
  ok(r.name === "a.yrp3d" && r.size === 3, "第一次就用原名", JSON.stringify(r));
  ok(fs.readFileSync(p("a.yrp3d")).equals(b1), "内容逐字节相同");
  ok(Math.abs(fs.statSync(p("a.yrp3d")).mtimeMs - 1700000000000) < 2000, "★ mtime 被保留成源时间");

  r = api.writeCopy(dir, "a.yrp3d", b2, NaN);
  ok(r.name === "a_2.yrp3d", "★ 同名退到 _2（后缀照抄 proxy.js 的 uniquePath）", r.name);
  ok(fs.readFileSync(p("a.yrp3d")).equals(b1), "★★ 原来那份字节没被改动（用户数据安全）");
  ok(fs.readFileSync(p("a_2.yrp3d")).equals(b2), "_2 是新内容");
  ok(fs.statSync(p("a_2.yrp3d")).mtimeMs > Date.now() - 60000, "非法 mtime（NaN）退回「现在」");

  // 名字本身就带编号时：剥掉再排，不该出现 a_2_2
  r = api.writeCopy(dir, "a_2.yrp3d", b2, 0);
  ok(r.name === "a_3.yrp3d", "★ 从 a_2 倒入时不会堆出 a_2_2", r.name);
  ok(fs.statSync(p("a_3.yrp3d")).mtimeMs > Date.now() - 60000, "0 也是非法 mtime，退回「现在」");

  ok(api.writeCopy(dir, "empty.yrp3d", Buffer.alloc(0), 1).size === 0, "0 字节写得进去");
  ok(fs.existsSync(p("empty.yrp3d")), "0 字节文件真的存在");
}

/* ------------------------------------------------------------------ *
 * 6. 跨文件一致性 —— 这一节才是这个文件存在的理由
 * ------------------------------------------------------------------ */
log("6. 跨文件一致性（飘了就是某一端静默不落盘）");
{
  const same = (label, a, b) =>
    ok(!!a && !!b && a === b, label, a === b ? "" : `\n--- 这一份 ---\n${a}\n--- 那一份 ---\n${b}`);

  // gui.html：electron 真本 ↔ 主分支（靠人同步）
  for (const [name, args] of [
    ["b64Of", "bytes"],
    ["importName", "name"],
    ["savedNames", ""],
    ["addLocalFiles", "files"],
  ]) {
    same(`两份 ${name} 逐字相同`, grab(electronSrc, name, args), grab(mainSrc, name, args));
  }
  // saveCopies 是**唯一**允许有差异的：通道名不同（主分支是 HTTP 路径）
  const norm = (s) => (s || "").replace('post("recordings:import"', 'post("/api/import"');
  same("两份 saveCopies 除通道名外逐字相同", norm(grab(electronSrc, "saveCopies", "items")), grab(mainSrc, "saveCopies", "items"));
  ok(
    /post\("recordings:import"/.test(grab(electronSrc, "saveCopies", "items") || ""),
    "electron 版走通道名"
  );
  ok(
    /post\("\/api\/import"/.test(grab(mainSrc, "saveCopies", "items") || ""),
    "主分支走 HTTP 路径"
  );

  // api.js ↔ 主分支 gui.js（两套后端，没有共享模块，各写各的）
  for (const [name, args] of [
    ["decodeB64", "s"],
    ["writeCopy", "dir, name, buf, mtime"],
  ]) {
    same(`api.js 和主分支 gui.js 的 ${name} 逐字相同`, grab(apiSrc, name, args), grab(mainJsSrc, name, args));
  }

  // 上限：界面那份只为提前给一句人话，但和宿主的**真正闸门**不能对不上
  const num = (src, re) => {
    const m = src.match(re);
    return m ? m[1] : null;
  }
  const guiMax = num(electronSrc, /const IMPORT_MAX = (\d+) \* 1024 \* 1024;/);
  const mainMax = num(mainSrc, /const IMPORT_MAX = (\d+) \* 1024 \* 1024;/);
  const apiMax = num(apiSrc, /const IMPORT_MAX_BYTES = (\d+) \* 1024 \* 1024;/);
  const apiFiles = num(apiSrc, /const IMPORT_MAX_FILES = (\d+);/);
  ok(guiMax && apiMax && guiMax === apiMax, "界面和宿主的单文件上限一致", `界面 ${guiMax} / 宿主 ${apiMax}`);
  ok(mainMax && apiMax && mainMax === apiMax, "主分支界面的上限也一致", `主分支 ${mainMax}`);
  ok(apiFiles === "50", "单批个数上限是 50", String(apiFiles));
}

/* ------------------------------------------------------------------ *
 * 7. 结构断言：三份界面都真的接了这套
 * ------------------------------------------------------------------ */
log("7. 结构断言");
{
  for (const [label, src] of [
    ["electron", electronSrc],
    ["主分支", mainSrc],
  ]) {
    ok(/S\.local\.set\(key, \{ name:f\.name, result, savedAs:null \}\)/.test(src), `${label}：S.local 里存了 savedAs`);
    ok(/const saved = savedNames\(\);/.test(src), `${label}：renderRecs/refresh 用了 savedNames()`);
    ok(/saved\.has\(f\.name\)/.test(src), `${label}：磁盘副本被藏掉`);
    ok(/\$\("n-rec"\)\.textContent = rows\.length;/.test(src), `${label}：#n-rec 用 rows.length（不是两边各算一次）`);
    ok(/r\.list\.find\(\(f\) => !saved\.has\(f\.name\)\)/.test(src), `${label}：自动跟随盯第一条**看得见**的`);
    ok(/const liveTop = srv\[0\];/.test(src), `${label}：「录制中」标在看得见的那条上`);
    ok(/mine\.savedAs/.test(src), `${label}：选中时的说明区分「已存进录像目录」`);

    // ★ 反面断言：清空按钮绝不能去删磁盘上的东西 —— 重启后分不出哪些是导入的、
    //   哪些是用户自己录的，删了就连真实录像一起删了
    const clear = grab(src, "clearLocal", "");
    ok(!!clear, `${label}：抠得到 clearLocal`);
    ok(!/unlink|rmdir|rmSync|writeFile|deleteFile/.test(clear || ""), `★ ${label}：clearLocal 不碰磁盘`);
    ok(/savedNames/.test(src) && !/S\.imported/.test(src), `${label}：藏名单是从 S.local 现算的，不是常驻 Set`);
  }
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch (_) {}

console.log(failed ? `\n${failed} 条 FAIL` : "\n全过");
process.exit(failed ? 1 : 0);
