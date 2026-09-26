// 封装成功的**最终证明**：真打一个 exe 出来，起它，点它的接口。
//
// 慢（要复制 87MB 的 node.exe 再注入 blob，十几秒），所以不在日常那几套里，
// 改过打包相关的东西、或者要发版本之前手动跑：
//
//   node _test_sea.mjs
//
// 这个文件覆盖的是**只有真 exe 才成立**的东西：
//   - 资源真的烘进二进制了（磁盘上没有 gui.html，界面还是能开）
//   - 界面起子进程时「再跑一遍自己」成立（普通 node 跑产物时这条根本不成立，
//     见 _test_bundle.mjs 末尾的说明）
//   - 运行时数据落在 exe 旁边而不是别处（发布包就靠这个）
//   - SEA 那行 ExperimentalWarning 被压掉了
// 其它（require 垫片、角色派发、argv）在 _test_bundle.mjs 里跑，快得多。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildExeOnly, rmrf } from "./build-release.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let failed = 0;
function ok(cond, what, extra) {
  if (cond) console.log(`  ok   ${what}`);
  else {
    failed++;
    console.log(`  FAIL ${what}${extra ? `\n       ${extra}` : ""}`);
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 150) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await wait(step);
  }
}

// ---------------------------------------------------------------------------
console.log("\n=== 1. 打 exe ===");
const exe = buildExeOnly({ quiet: true });
const exeSize = fs.statSync(exe).size;
ok(exeSize > 50 * 1024 * 1024, "exe 打出来了", `${(exeSize / 1024 / 1024).toFixed(1)} MB`);
// node.exe 的副本 + 一段 blob。只比 node.exe 大一点点就说明 blob 没进去。
ok(exeSize > fs.statSync(process.execPath).size, "exe 比 node.exe 大（blob 注入进去了）");

// ---------------------------------------------------------------------------
console.log("\n=== 2. 角色派发（exe 里那份）===");

const bad = spawnSync(exe, ["--role=nope"], { encoding: "utf8" });
ok(bad.status === 2, "未知角色 exit 2", `exit=${bad.status}`);
ok((bad.stderr || "").includes("未知角色"), "报错走的是 stderr", bad.stderr);

// 不带 --role= 时缺省是界面。这条同时验证「双击 exe 就出界面」这个预期行为。
// 界面上限端口是 7912，这里用 YRP_DATA_DIR 隔离，免得跟真的界面打架。

// ---------------------------------------------------------------------------
console.log("\n=== 3. 从 exe 起界面（资源必须来自二进制）===");

// 把 exe 单独拷到一个空目录再跑：这就是发布包的样子，旁边**只有 exe**，
// 没有 gui.html、没有 chat-extractor.html、没有 .js。
const REL = fs.mkdtempSync(path.join(os.tmpdir(), "yrp-sea-"));
const relExe = path.join(REL, "yrp.exe");
fs.copyFileSync(exe, relExe);

// 故意**不设 YRP_DATA_DIR**：就是要验证运行时数据落在 exe 旁边。
// SEA 里 __dirname 就是 exe 所在目录，发布包靠的正是这个。
const gp = spawn(relExe, ["--role=gui", "--no-open"], { stdio: ["ignore", "pipe", "pipe"] });
let guiOut = "", guiErr = "";
gp.stdout.setEncoding("utf8");
gp.stderr.setEncoding("utf8");
gp.stdout.on("data", (c) => (guiOut += c));
gp.stderr.on("data", (c) => (guiErr += c));

const urlFile = path.join(REL, "gui-url.txt");
const url = await until(() => {
  try {
    return fs.readFileSync(urlFile, "utf8").trim() || null;
  } catch {
    return null;
  }
});
ok(!!url, "exe 起来了，而且地址文件就在 exe 旁边（发布包依赖这一点）", guiOut + guiErr);
ok(fs.existsSync(path.join(REL, "gui-token.txt")), "token 也落在 exe 旁边");
ok(
  !fs.readdirSync(REL).includes("gui.html") && !fs.readdirSync(REL).includes("chat-extractor.html"),
  "旁边确实没有那两个 HTML —— 页面只可能来自烘进 exe 的资源"
);

// 子进程的 stderr 会被界面转发成红色日志，那行 warning 不压掉就是每次起停刷一条
ok(!guiErr.includes("ExperimentalWarning"), "SEA 的 ExperimentalWarning 被压掉了", guiErr.slice(0, 300));

if (url) {
  const base = url.replace(/\/\?.*$/, "");
  const token = new URL(url).searchParams.get("t");

  const page = await (await fetch(url)).text();
  ok(page.includes("<title"), "GET / 返回真正的页面");

  // 界面只 replace 第一处 __TOKEN__。烘进去的那份 HTML 要是和磁盘那份不一致，
  // 页面会拿到字面量 __TOKEN__ —— 表现是「页面正常但每个按钮都报 token 不对」。
  ok(!page.includes("__TOKEN__"), "页面里没有残留的 __TOKEN__ 占位符");
  ok(page.includes(token), "页面上带的是这次的 token");
  ok((await fetch(`${base}/`)).status === 401, "不带 token 取页面是 401");

  const ps = await fetch(`${base}/parser.js?t=${token}`);
  const psText = await ps.text();
  ok(ps.status === 200, "/parser.js 200");
  ok(psText.includes("@parser:begin") && psText.includes("function extract"), "解析块完整");
  ok(psText.includes("window.YRP_PARSER"), "浏览器包装还在");

  // parserError 非 null 就是「界面照常起来，但查看和导出全废」那种静默半坏
  const st = await (await fetch(`${base}/api/state?t=${token}`)).json();
  ok(st.parserError === null, "界面上报的 parserError 是 null", JSON.stringify(st));

  // -------------------------------------------------------------------------
  console.log("\n=== 4. exe 自己起子进程（这条只有真 exe 能测）===");

  // 先挂 SSE 再启动，免得漏掉子进程最开始那几行
  const events = [];
  const ctrl = new AbortController();
  const es = await fetch(`${base}/api/events?t=${token}`, { signal: ctrl.signal });
  const reader = es.body.getReader();
  const dec = new TextDecoder();
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of dec.decode(value).split("\n")) {
          if (line.startsWith("data:")) {
            try {
              events.push(JSON.parse(line.slice(5)));
            } catch {}
          }
        }
      }
    } catch {}
  })();

  // 观战端连一个必然连不上的端口：几秒内自己跑完退出，不碰网络也不留下录像
  const start = await fetch(`${base}/api/start?t=${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "observer",
      cfg: { host: "127.0.0.1", port: 1, room: "冒烟测试", name: "冒烟测试" },
    }),
  });
  ok(start.status === 200, "/api/start 起来了观战端", JSON.stringify(await start.json()));

  const sawLine = await until(
    () => events.some((e) => e.mode === "observer" && String(e.text || "").includes("正在观战记录")),
    15000
  );
  ok(
    !!sawLine,
    "**exe 把子进程拉起来了** —— 这证明它用 --role= 重新执行了自己",
    events.filter((e) => e.mode === "observer").map((e) => e.text).join("\n")
  );

  // 子进程是打包形态，提示语不该再教人敲 node / 找上一级目录
  const obsText = events.filter((e) => e.mode === "observer").map((e) => String(e.text || "")).join("\n");
  ok(
    !obsText.includes("..\\chat-extractor.html"),
    "观战端的收尾提示是打包形态的（不指向不存在的上一级）",
    obsText
  );

  await until(
    () => events.some((e) => e.mode === "observer" && String(e.text || "").includes("观战结束")),
    15000
  );
  ctrl.abort();

  // -------------------------------------------------------------------------
  console.log("\n=== 5. 退出 ===");
  await fetch(`${base}/api/quit?t=${token}`, { method: "POST" });
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => {
      gp.kill();
      resolve("超时");
    }, 8000);
    gp.on("exit", (c) => {
      clearTimeout(t);
      resolve(c);
    });
  });
  ok(code === 0, "点退出之后 exe 自己退了（不是被杀的）", `实际 ${code}`);
}

// ---------------------------------------------------------------------------
console.log("\n=== 6. 启动器 ===");

// START.vbs 是 **UTF-16LE + BOM**（里面全是中文，ANSI 存会乱码），.bat 是纯 ASCII。
// 按 utf8 读 UTF-16 会得到一串夹着 NUL 的乱码，includes("yrp.exe") 永远为假 ——
// 这个坑让下面三条断言一开始全红，而文件本身是对的。
const readAll = (f) => {
  const b = fs.readFileSync(path.join(HERE, "proxy", f));
  return b[0] === 0xff && b[1] === 0xfe ? b.toString("utf16le") : b.toString("utf8");
};

// 这几个名字同时出现在 build-release.mjs 的 LAUNCHERS 里，改名要一起改
const bats = { "proxy.bat": "proxy", "observer.bat": "observer", "gui-console.bat": "gui" };
for (const [f, role] of Object.entries(bats)) {
  const s = readAll(f);
  ok(s.includes(`--role=${role}`), `${f} 传了 --role=${role}`);
  // 顺序反了的话，没装 Node 的机器会先撞上 "where node" 的报错分支就 exit 了，
  // 永远走不到 exe —— 正好把要解决的场景挡死。
  const iExe = s.indexOf('if exist "yrp.exe"');
  const iNode = s.indexOf("where node");
  ok(iExe >= 0 && iNode > iExe, `${f} 是**先找 exe 再找 node**（顺序反了就没装 Node 的机器直接卡死）`);
}

const vbs = readAll("START.vbs");
ok(vbs.includes("yrp.exe"), "START.vbs 会用同目录的 exe");
ok(vbs.includes("node gui.js"), "START.vbs 保留了 node 回退（开发时用）");
// 正常的界面要退出得在页面里点，绝不会自己一声不吭退出。不看这条的话，
// 「blob 被剥掉 → 进程静默 exit 0 → 双击没反应」这种最难查的形态就漏过去了。
ok(
  vbs.includes("tail = \"\"") && /rc <> 0 Or tail = ""/.test(vbs),
  "START.vbs 把「退出码 0 但没有任何输出」也判成失败"
);

// 不用 fs.rmSync：临时目录路径里有非 ASCII 时它会静默不删，留下 ~90MB 的 exe 副本
rmrf(REL);
console.log(failed ? `\n${failed} 项失败\n` : "\n全部通过\n");
process.exit(failed ? 1 : 0);
