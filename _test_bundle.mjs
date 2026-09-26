// 打包器的测试。**不需要 postject，也不打 exe** —— 直接拿普通 node 跑产物
// build/sea-main.js，验的是那套自制 require 和 --role= 派发。
//
// 为什么不打真 exe 也够：产物和 exe 里跑的是**同一个脚本**，差别只在
//   - 资源从磁盘读还是从 getAsset 读（靠 isSea() 分叉，这里用假的 node:sea 测）
//   - __dirname 是 build/ 还是 exe 目录（两种都由 __DIRS 归一，行为一致）
// 真 exe 的冒烟在 _test_sea.mjs 里，那条才是「封装成功」的最终证明。
//
//   node _test_bundle.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { buildBundle, MODULES, ASSETS, cleanSource } from "./_bundle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failed = 0;
function ok(cond, what, extra) {
  if (cond) console.log(`  ok   ${what}`);
  else {
    failed++;
    console.log(`  FAIL ${what}${extra ? `\n       ${extra}` : ""}`);
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await wait(step);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "yrp-bundle-"));
const BUILD = path.join(HERE, "build");

// 开始之前先拍一张快照：这个测试要断言「跑产物不会把运行时数据漏到它旁边」，
// 而手工跑过一次产物的人（不设 YRP_DATA_DIR）会在 build/ 里留下 token 和地址文件。
// 拿绝对值比会被这种历史残留冤枉，所以只比「这次新增的」。
const buildBefore = fs.readdirSync(BUILD);

// ---------------------------------------------------------------------------
console.log("\n=== 1. 生成产物 ===");

const { out } = buildBundle();
const src = fs.readFileSync(out, "utf8");

ok(fs.existsSync(out), "产物生成了");
ok(src.length > 10000, "产物不是空壳", `只有 ${src.length} 字节`);
// 剥 #! 是必须的：三个入口文件首行都是 #!，留着就是整个脚本 SyntaxError
ok(!/^#!/.test(src.split("\n").slice(1).join("\n")), "内联的模块没有残留 #!");
ok(src.includes("globalThis.__YRP_BUNDLED__ = true"), "产物里写了 isBundled 的标记");

for (const id of MODULES) {
  ok(src.includes(`__defs[${JSON.stringify(id)}]`), `模块表里有 ${id}`);
}
// 逐个核对 __DIRS 真的是两套值，不是统一一个
const dirsInSrc = JSON.parse(src.match(/const __DIRS = (\{[\s\S]*?\});/)[1]);
ok(dirsInSrc["_parser.js"] === "..", "_parser.js 的 __dirname 是上一级（平时 = yrp-tools/）");
ok(dirsInSrc["proxy/gui.js"] === "", "gui.js 的 __dirname 是锚点本身（打包后 = exe 目录）");
ok(
  dirsInSrc["_parser.js"] !== dirsInSrc["proxy/gui.js"],
  "两种模块拿到的 __dirname 确实不同 —— 这是不能引第三方打包器的原因"
);

// ---------------------------------------------------------------------------
console.log("\n=== 2. cleanSource：只剥 BOM 和 #!，不碰别的 ===");

ok(cleanSource("#!/usr/bin/env node\nok();") === "ok();", "剥掉 #!");
ok(cleanSource("#!/usr/bin/env node\r\nok();") === "ok();", "CRLF 的 #! 也剥掉");
ok(cleanSource("﻿ok();") === "ok();", "剥掉 BOM");
ok(
  cleanSource('const s = "/* @parser:begin";\n') === 'const s = "/* @parser:begin";\n',
  "注释里的字面量原样保留（所以绝不能用正则去扫源码）"
);

// ---------------------------------------------------------------------------
console.log("\n=== 3. readShipped / isBundled ===");

delete globalThis.__YRP_BUNDLED__; // 测试进程不是打包产物
const { readShipped, isSea, isBundled, SOURCE_PATHS } = require("./_shipped.js");

ok(isBundled() === false, "普通 node 里 isBundled() 为假");
ok(isSea() === false, "普通 node 里 isSea() 为假");

// 路径由 SOURCE_PATHS 一处说了算，锚点是本文件的 __dirname。这条钉住的是
// 「调用方传来的 __dirname 不可信」——gui.js 打包后那根路径指向 exe 目录，
// 而 gui.html 在源码树里，两者根本不是一回事。
const diskFile = path.join(HERE, "chat-extractor.html");
ok(readShipped("chat-extractor.html") === fs.readFileSync(diskFile, "utf8"), "非 SEA 时读磁盘");
ok(
  readShipped("gui.html") === fs.readFileSync(path.join(HERE, "proxy", "gui.html"), "utf8"),
  "gui.html 也能从源码树里读到（不靠调用方的 __dirname）"
);
ok(
  Object.keys(SOURCE_PATHS).sort().join() === Object.keys(ASSETS).sort().join(),
  "_shipped.js 的 SOURCE_PATHS 和 _bundle.mjs 的 ASSETS 键完全一致",
  `${JSON.stringify(SOURCE_PATHS)} vs ${JSON.stringify(ASSETS)}`
);

let threw = null;
try {
  readShipped("没注册过的文件.html");
} catch (e) {
  threw = e;
}
ok(threw !== null, "没注册的名字直接抛，不会静默读到别的东西");

// 假的 node:sea：验证 SEA 分支真的去调 getAsset，而且**不回退读盘**
const calls = [];
const fakeSea = {
  isSea: () => true,
  getAsset: (name, enc) => {
    calls.push([name, enc]);
    return `内容:${name}`;
  },
};
ok(readShipped("gui.html", fakeSea) === "内容:gui.html", "SEA 时走 getAsset");
ok(calls.length === 1 && calls[0][0] === "gui.html", "传进去的正是资源名", JSON.stringify(calls));

const boomSea = {
  isSea: () => true,
  getAsset: () => {
    throw new Error("no such asset");
  },
};
threw = null;
try {
  readShipped("gui.html", boomSea);
} catch (e) {
  threw = e;
}
ok(threw !== null, "资源取不到时**抛错**，而不是退回去读磁盘");
ok(
  threw && threw.message.includes("gui.html") && threw.message.includes("PACKAGING.md"),
  "报错点出了资源名，并指向 PACKAGING.md（不然排查时完全看不出跟资源有关）",
  threw && threw.message
);

// ---------------------------------------------------------------------------
console.log("\n=== 4. --role= 派发 ===");

const DATA = path.join(TMP, "data");
fs.mkdirSync(DATA, { recursive: true });
// 故意把 remoteHost 写成空串：proxy.js 会走到「配置不全」那条分支，
// 是**主函数真的跑起来了**的明确证据（而且不碰网络、秒退）。
//
// ⚠️ 必须显式写空串，不能只写 `{}`。proxy.js 的 DEFAULTS 里现在有真服务器地址，
// 光给 `{}` 的话配置是「完整」的，proxy.js 会真的去 listen —— 这里就变成
// 挂死到超时，而不是退出码 1。（同理：DEFAULTS 改回空地址后，这条也别改回去，
// 显式写空串在两种情况下都对。）
fs.writeFileSync(path.join(DATA, "config.json"), JSON.stringify({ remoteHost: "" }));
fs.writeFileSync(
  path.join(DATA, "observer.json"),
  JSON.stringify({ host: "127.0.0.1", port: 1, room: "t", name: "t" })
);

function run(role, extra = [], ms = 20000) {
  return new Promise((resolve) => {
    const args = role === null ? [out, ...extra] : [out, `--role=${role}`, ...extra];
    const p = spawn(process.execPath, args, {
      env: { ...process.env, YRP_DATA_DIR: DATA },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    p.stdout.setEncoding("utf8");
    p.stderr.setEncoding("utf8");
    p.stdout.on("data", (c) => (stdout += c));
    p.stderr.on("data", (c) => (stderr += c));
    const t = setTimeout(() => p.kill(), ms);
    p.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}

const bad = await run("nope");
ok(bad.code === 2, "未知角色 exit 2（不能降级成 gui）", `实际 exit=${bad.code}`);
ok(bad.stderr.includes("未知角色") && bad.stderr.includes("gui / proxy / observer"), "报错列出了可用角色", bad.stderr);

const prox = await run("proxy");
ok(prox.code === 1, "role=proxy 跑起来了（配置不全时 proxy.js 退出码就是 1）", `exit=${prox.code}\n${prox.stdout}`);
ok(
  prox.stdout.includes("config.json 里没写") || prox.stdout.includes("远程服务器"),
  "输出是 proxy.js 的，不是别的模块的",
  prox.stdout
);
ok(
  !prox.stdout.includes("观战记录") && !prox.stdout.includes("界面已启动"),
  "只有 proxy 的 main 跑了 —— 没有同时跑 gui / observer"
);

// 这条是本文件里最重要的一条：observer.js 顶层 require 了 proxy.js，
// 如果 __MAIN 设置得不对，proxy.js 的 require.main === module 会误判为真，
// 两个 main 一起跑。
const obs = await run("observer");
ok(obs.code === 0, "role=observer 正常结束", `exit=${obs.code}\n${obs.stdout}`);
ok(obs.stdout.includes("观战结束"), "observer 的 main 跑了");
ok(
  !obs.stdout.includes("config.json 里没写"),
  "**proxy.js 的 main 没跑** —— observer 只是把 proxy.js 当库 require 进来",
  obs.stdout
);

// ---------------------------------------------------------------------------
console.log("\n=== 5. --role= 必须被剥干净 ===");

// proxy.js 的 DUMP 是模块级 process.argv.slice(2).includes("--dump") 算的。
// 剥晚了（比如放在 boot 之后）这里就会丢，而且毫无提示。
const dumpDir = path.join(TMP, "dump");
fs.mkdirSync(dumpDir, { recursive: true });
// 同上：显式清空 remoteHost，否则 proxy.js 会真的 listen 起来，这里就等不到 exit
fs.writeFileSync(path.join(dumpDir, "config.json"), JSON.stringify({ remoteHost: "" }));
const dumpRun = await new Promise((resolve) => {
  const p = spawn(process.execPath, [out, "--role=proxy", "--dump"], {
    env: { ...process.env, YRP_DATA_DIR: dumpDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (c) => (stdout += c));
  p.on("exit", (code) => resolve({ code, stdout }));
});
const dumpFiles = fs.existsSync(path.join(dumpDir, "replays"))
  ? fs.readdirSync(path.join(dumpDir, "replays"))
  : [];
ok(
  dumpFiles.some((f) => f.includes("_dump_")),
  "--dump 穿过派发到达了 proxy.js（说明 --role= 被剥掉了，而且剥在 boot 之前）",
  `replays/ 里是 ${JSON.stringify(dumpFiles)}`
);
ok(!dumpRun.stdout.includes("--role="), "proxy.js 自己的输出里没有 --role=", dumpRun.stdout);

// ---------------------------------------------------------------------------
console.log("\n=== 6. role=gui：整个界面从产物里起来 ===");

const guiData = path.join(TMP, "gui");
fs.mkdirSync(guiData, { recursive: true });
const gp = spawn(process.execPath, [out, "--role=gui", "--no-open"], {
  env: { ...process.env, YRP_DATA_DIR: guiData },
  stdio: ["ignore", "pipe", "pipe"],
});
let guiOut = "", guiErr = "";
gp.stdout.setEncoding("utf8");
gp.stderr.setEncoding("utf8");
gp.stdout.on("data", (c) => (guiOut += c));
gp.stderr.on("data", (c) => (guiErr += c));

const urlFile = path.join(guiData, "gui-url.txt");
const url = await until(() => {
  try {
    return fs.readFileSync(urlFile, "utf8").trim() || null;
  } catch {
    return null;
  }
});
ok(!!url, "界面起来了并写下了地址", guiOut + guiErr);

if (url) {
  const base = url.replace(/\/\?.*$/, "");
  const token = new URL(url).searchParams.get("t");

  const page = await (await fetch(url)).text();
  ok(page.includes("<title"), "GET / 返回的是真正的页面");
  // gui.js 只替换第一处占位符 —— 产物里那份 HTML 要是和磁盘那份不一样，
  // 页面就会拿到字面量 __TOKEN__，表现是「页面正常但每个按钮都报 token 不对」
  ok(!page.includes("__TOKEN__"), "页面里的 __TOKEN__ 被替换掉了");
  ok(page.includes(token), "页面上带的就是这次的 token");

  const noTok = await fetch(`${base}/`);
  ok(noTok.status === 401, "不带 token 取页面是 401");

  const ps = await fetch(`${base}/parser.js?t=${token}`);
  const psText = await ps.text();
  ok(ps.status === 200, "/parser.js 200");
  ok(psText.includes("@parser:begin"), "解析块是从**产物的资源**里切出来的");
  ok(psText.includes("window.YRP_PARSER"), "浏览器包装还在");

  // 这条证明 _parser.js 的 __DIRS 在产物里解析对了：产物在 build/，
  // chat-extractor.html 在上一级。解析不出来的话上面那两条会红成「横幅」形态。
  ok(psText.includes("function extract"), "解析块的内容是完整的");
}

// 这里**故意不测**「界面起子进程」那条路：产物是用普通 node 跑的，
// process.execPath 是 node.exe 而不是产物本身，spawn 出去只会起一个没有脚本的
// node。自举（再跑一遍自己）只有真 exe 才成立，由 _test_sea.mjs 负责。
// 别为了在这儿补上而给 gui.js 加一条只有测试走得到的分支。

// ---------------------------------------------------------------------------
console.log("\n=== 7. 产物真的不碰同级目录（YRP_DATA_DIR 隔离仍然成立）===");

const stray = fs.readdirSync(BUILD).filter((f) => !buildBefore.includes(f));
ok(stray.length === 0, "这次跑产物没有往它旁边漏运行时数据", JSON.stringify(stray));
ok(!fs.existsSync(path.join(HERE, "replays")), "没有在 yrp-tools/ 里建 replays/");
ok(!fs.existsSync(path.join(HERE, "config.json")), "没有在 yrp-tools/ 里建 config.json");

gp.kill();
await wait(300);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
