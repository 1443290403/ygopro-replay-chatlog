/* ------------------------------------------------------------------ *
 * 一条命令打出可以发出去的成品：单个 exe + 启动器 + 说明
 *
 *   node build-release.mjs
 *
 * 产物在 release/yrp-tools-<日期>/ 。全过程在 build/ 里中转，不碰源码目录，
 * 也不碰你的 config.json / observer.json / replays（那些在 proxy/ 底下）。
 *
 * 原理和手工步骤写在 PACKAGING.md —— 这个脚本坏了的话照那份文档能重做一遍。
 * ------------------------------------------------------------------ */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { buildBundle, ASSETS } from "./_bundle.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build");
const RELEASE_ROOT = path.join(HERE, "release");
const NODE_EXE = process.execPath;

// Windows 上 postject 要求显式给出这个哨兵；Node 官方文档里就是这个常量，
// 不是每个版本都变的东西。（macOS 还要 --macho-segment-name，这里用不上。）
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

// 发布包的白名单。**只能一项项拷，不能整个目录拷** —— proxy/ 底下有使用者的
// config.json / observer.json（写着第三方服务器地址）和他自己的 replays/。
// 名字要和 proxy/ 里实际存在的文件一致，对不上会在 assemble 里报「启动器不在了」。
const LAUNCHERS = ["START.vbs", "proxy.bat", "observer.bat", "gui-console.bat"];
// 源文件是给仓库看的名字，拷进发布包时改成使用者一眼能认的 README.txt
const DOC = "RELEASE-README.txt";
const DOC_AS = "README.txt";

let step = 0;
let quiet = false;
const log = (msg) => {
  if (!quiet) console.log(msg);
};
const say = (msg) => {
  step++;
  log(`\n[${step}] ${msg}`);
};
const die = (msg) => {
  console.error(`\n!! ${msg}\n`);
  process.exit(1);
};

function sha(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12);
}

/* ------------------------------------------------------------------ *
 * 递归删目录 —— 自己走一遍，不用 fs.rmSync
 *
 * 两个坑叠在一起，所以这里不能用现成的：
 *
 * 1. `fs.rmSync(dir, {recursive:true, force:true})` 在**路径里含任何非 ASCII
 *    成分**时（目录名是中文，或者它自己在一个中文名的父目录下）**既不删也不抛错**，
 *    直接静默返回。`force: true` 把错误吞了，所以外面完全看不出来。
 *    本机 Windows 上可复现：ASCII 目录删得掉，中文目录一个文件都不动。
 *    使用者的目录叫 `D:\我的工具\yrp-tools\` 就会撞上。
 * 2. 就算走通了，删不掉也可能是因为文件被占着，需要重试。
 *
 * 而「组装发布包」这步的正确性完全建立在目录是空的之上 —— 静默失败等于把使用者的
 * observer.json（第三方服务器地址）和 replays/ 一起发出去。
 *
 * 实测踩过一次：发布目录里留着一张真录像和一整套配置，脚本照常往下走，
 * 全靠组装末尾那条白名单断言才拦住。那是**最后一道**防线，不是第一道。
 * 所以这里删完必须验，验不过宁可报错退出。
 * ------------------------------------------------------------------ */

// lstatSync 不跟随符号链接 —— 跟随的话一个指向目录的链接会被当成目录递归下去，
// 把链接**外面**的东西删掉。遇到链接一律当文件删。
//
// 导出是给 _test_sea.mjs 回收临时目录用的（它要删 ~90MB 的 exe 副本，
// 用裸 rmSync 在中文临时目录下会静默留下垃圾）。
export function rmrf(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (_) {
    return; // 已经没了
  }
  if (!st.isDirectory()) {
    fs.unlinkSync(p);
    return;
  }
  for (const name of fs.readdirSync(p)) rmrf(path.join(p, name));
  fs.rmdirSync(p);
}

function nukeDir(dir) {
  if (!fs.existsSync(dir)) return;
  // 短暂的文件占用（刚被杀掉的进程、杀毒软件在扫新写出来的 exe）重试几次就能过
  for (let i = 0; i < 5; i++) {
    try {
      rmrf(dir);
    } catch (_) {}
    if (!fs.existsSync(dir)) return;
    const t = Date.now();
    while (Date.now() - t < 300); // 同步小睡，占用消失得很快
  }
  die(
    `删不掉 ${dir}\n` +
      `  里面还剩：${(() => { try { return fs.readdirSync(dir).join("、"); } catch (_) { return "(读不出来)"; } })()}\n` +
      `  多半是有程序占着这些文件 —— START.vbs / 代理 / 观战 全关掉再跑一次。\n` +
      `  关不掉就手动把这个文件夹删了，再重跑。\n` +
      `  （发布目录同时也是运行时的数据目录，跑过一次就会在里面留下 replays/ 和配置。）`
  );
}

/* ------------------------------------------------------------------ *
 * 1. postject
 * ------------------------------------------------------------------ */
function findPostject() {
  try {
    require.resolve("postject");
    return { cmd: "npx", args: ["postject"], how: "本地 node_modules" };
  } catch (_) {}
  // 没装就借 npx 现拉一个。构建机联网即可，**使用者那边不需要任何东西**。
  const probe = spawnSync("npx", ["--yes", "postject", "--help"], { encoding: "utf8", shell: true });
  if (probe.status === 0) return { cmd: "npx", args: ["--yes", "postject"], how: "npx 临时拉取" };
  die(
    "找不到 postject，npx 也拉不下来。\n" +
      "  它只在**构建机**上需要，装法：cd 到本目录，跑 npm i -D postject\n" +
      "  或者确保网络能访问 npm registry（npx --yes postject 会临时拉一个）。\n" +
      `  npx 的报错：${(probe.stderr || "").trim().split("\n").slice(-3).join(" / ")}`
  );
}

/* ------------------------------------------------------------------ *
 * 2. 生成脚本 + 构建期检查
 * ------------------------------------------------------------------ */
function assertBundle() {
  const { out } = buildBundle();

  // 语法检查。这条专抓「#! 没剥干净」和拼接处的破损 —— 两者都会让 exe
  // 一启动就死，而且是「双击了没反应」那种最难描述的形态。
  const chk = spawnSync(NODE_EXE, ["--check", out], { encoding: "utf8" });
  if (chk.status !== 0) die(`产物语法检查没过（多半是 #! 没剥干净）：\n${chk.stderr}`);

  for (const [name, rel] of Object.entries(ASSETS)) {
    const disk = fs.readFileSync(path.join(HERE, rel));
    if (!disk.length) die(`资源 ${name}（${rel}）是空的`);
    // 界面只 replace 第一处 __TOKEN__。产物里那份 HTML 要是和磁盘那份不一致、
    // 又恰好把占位符排在了前面，页面会拿到字面量 __TOKEN__ ——
    // 表现为「页面正常打开，但每个按钮都报 token 不对」。磁盘那份有测试盯着，
    // 烘进去的这份没有，所以在构建期补上。
    if (name === "gui.html") {
      const n = (disk.toString("utf8").match(/__TOKEN__/g) || []).length;
      if (n !== 1) die(`proxy/gui.html 里 __TOKEN__ 出现了 ${n} 处，必须恰好 1 处`);
    }
    if (name === "chat-extractor.html") {
      const s = disk.toString("utf8");
      if (!s.includes("/* @parser:begin") || !s.includes("/* @parser:end */")) {
        die("chat-extractor.html 里少了 @parser 哨兵，资源烘进去也用不了");
      }
    }
    log(`  ${name.padEnd(22)} ← ${rel}  ${disk.length} 字节 ${sha(disk)}`);
  }
  log(`  产物                    → build/sea-main.js  ${fs.statSync(out).size} 字节 ${sha(fs.readFileSync(out))}`);
  return out;
}

/* ------------------------------------------------------------------ *
 * 3. 资源 → blob → 注入 exe
 * ------------------------------------------------------------------ */
function buildExe(mainJs, postject) {
  const blob = path.join(BUILD, "sea-prep.blob");
  const exe = path.join(BUILD, "yrp.exe");
  const slash = (p) => p.split(path.sep).join("/");

  // 全部用绝对路径：sea-config.json 里的相对路径按哪个目录解析，
  // 各个 Node 版本的说法不一致，绝对路径没有这个歧义。
  const cfgPath = path.join(BUILD, "sea-config.json");
  fs.writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        main: slash(mainJs),
        output: slash(blob),
        // 压掉启动时那行 ExperimentalWarning。界面把子进程的 stderr 当红色日志
        // 转发，这行会变成一条每次起停都刷的没用的红字（子进程那边另有
        // NODE_NO_WARNINGS 兜底）。
        disableExperimentalSEAWarning: true,
        assets: Object.fromEntries(Object.entries(ASSETS).map(([k, v]) => [k, slash(path.join(HERE, v))])),
      },
      null,
      2
    )
  );

  const blobRun = spawnSync(NODE_EXE, ["--experimental-sea-config", cfgPath], { encoding: "utf8" });
  if (blobRun.status !== 0) die(`生成 blob 失败：\n${blobRun.stderr || blobRun.stdout}`);
  if (!fs.existsSync(blob)) die("blob 没生成出来");
  log(`  blob  ${fs.statSync(blob).size} 字节`);

  // exe 就是**本机 node.exe 的副本**再注射一段 blob。所以使用者的运行时版本
  // 等于构建机的 Node 版本 —— 升级 Node 要重新打包。
  fs.copyFileSync(NODE_EXE, exe);
  log(`  复制 ${path.basename(NODE_EXE)} → build/yrp.exe`);

  const inj = spawnSync(
    postject.cmd,
    [...postject.args, exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", SENTINEL],
    { encoding: "utf8", shell: true }
  );
  // postject 在「签名被破坏」时会往 stderr 抱怨但不影响结果，只看退出码
  if (inj.status !== 0) die(`postject 注入失败：\n${inj.stderr || inj.stdout}`);
  log(`  注入完成 ${fs.statSync(exe).size} 字节`);
  return exe;
}

/* ------------------------------------------------------------------ *
 * 4. 组装发布包
 * ------------------------------------------------------------------ */
function assemble(exe) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const dir = path.join(RELEASE_ROOT, `yrp-tools-${stamp}`);
  nukeDir(dir);
  fs.mkdirSync(dir, { recursive: true });

  fs.copyFileSync(exe, path.join(dir, "yrp.exe"));
  for (const f of LAUNCHERS) {
    const src = path.join(HERE, "proxy", f);
    if (!fs.existsSync(src)) die(`启动器 ${f} 不在了`);
    fs.copyFileSync(src, path.join(dir, f));
  }
  // 便携版。它在发布包里**不参与运行**（exe 用的是烘进去的那份），
  // 放在这儿是为了能单独拷给别人。
  fs.copyFileSync(path.join(HERE, ASSETS["chat-extractor.html"]), path.join(dir, "chat-extractor.html"));
  fs.copyFileSync(path.join(HERE, DOC), path.join(dir, DOC_AS));

  // 白名单的反面：确认没把使用者的东西带出去。
  //
  // 这条断言不是多余的：**发布目录同时就是运行时的数据目录**（exe 把 replays/ 、
  // config.json 写在它自己旁边）。只要在发布目录里双击跑过一次，这些东西就会出现，
  // 而它们含使用者的第三方服务器地址和录像。手滑把这个目录 zip 出去 = 泄了。
  //
  // 正常流程下 assemble 开头会把整个目录删干净重建，所以这条永远不会响；
  // 响了就说明清理没做干净（比如有进程占着文件导致删除半途失效）。
  //
  // ⚠️ 名单里的名字改了一个字就等于把防线拆了 —— 下面的泄漏产物一旦改名，
  //    这里必须同步。这几项和 proxy/ 里那些常量是一对，改名时要一起改。
  const bad = [
    "config.json",       // 代理配置：第三方服务器地址
    "observer.json",     // 观战配置：同上
    "gui-token.txt",
    "gui-url.txt",       // 界面地址
    "gui-error.log",     // 非正常退出时留下，里面是路径和报错
    "replays",           // 使用者的录像本体
    "build",             // 中转产物，万一被拷进来
  ];
  const leaked = bad.filter((f) => fs.existsSync(path.join(dir, f)));
  if (leaked.length) {
    die(
      `发布包里混进了本机数据：${leaked.join("、")}\n` +
        `  多半是你在发布目录里双击跑过一次（exe 会把 replays/ 和配置写在自己旁边）。\n` +
        `  这些文件含你的第三方服务器地址和录像，**绝对不能发出去**。\n` +
        `  处理：先把界面/代理全关掉（有进程占着文件就删不干净），然后重跑一次打包。`
    );
  }

  const files = fs.readdirSync(dir).sort();
  const total = files.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  log(`  ${path.relative(HERE, dir).replace(/\\/g, "/")}/`);
  for (const f of files) console.log(`    ${f}`);
  log(`  合计 ${(total / 1024 / 1024).toFixed(1)} MB（打包成 7z/zip 大约 30 MB）`);
  return dir;
}

/* ------------------------------------------------------------------ *
 * 对外的两步。拆开是为了让 _test_sea.mjs 能只打 exe、不打发布包
 * （发布包那步会把一整个目录删掉重建，测试里没必要）。
 * ------------------------------------------------------------------ */

/** 打 exe。@returns {string} build/yrp.exe 的绝对路径 */
export function buildExeOnly(opts = {}) {
  quiet = !!opts.quiet;
  say("找 postject");
  const postject = findPostject();
  log(`  用 ${postject.how}`);
  say("生成脚本并做构建期检查");
  const mainJs = assertBundle();
  say("生成 blob 并注入 exe");
  return buildExe(mainJs, postject);
}

/** 打 exe 再组装发布包。@returns {{exe: string, dir: string}} */
export function buildAll(opts = {}) {
  quiet = !!opts.quiet;
  step = 0;
  log("打包 对话记录工具 → 单个 exe");
  const exe = buildExeOnly({ quiet });
  say("组装发布包");
  const dir = assemble(exe);
  log(
    `\n好了。\n` +
      `  跑一遍冒烟测试： node _test_sea.mjs\n` +
      `  发出去之前手动确认一遍：在**没装 Node** 的机器上双击 START.vbs\n`
  );
  log(`  刚打出来的：${dir}\n`);
  return { exe, dir };
}

// 被 _test_sea.mjs import 时不要自动跑
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  buildAll();
}
