// Electron 版的冒烟测试：起真的程序，走完整条链路，然后**关窗口**。
//
//   node _test_electron.mjs           只跑开发态（快，用 node_modules 里的 electron）
//   node _test_electron.mjs --packaged  先打包，再对 release/electron/ 里的 exe 跑一遍
//
// 这条路为什么值得单独存在：它覆盖的是**打包后才可能坏、而平时测不出来**的东西 ——
// preload 有没有被带进包、gui.html 在不在、子进程被 spawn 得起来吗
// （process.execPath 在打包态是那个 exe，不是 node）。
//
// 判定「录制子进程真的死了」用的是**这条连接本身**：假 srvpro 跑在这个测试
// 进程里，子进程连着它。子进程要是被漏掉了，那条 socket 会一直开着。
// 这比查进程列表稳（不用装依赖、也不会误伤别的 node 进程）。
//
// ⚠️ 这台机器的 shell 里**本来就带着 ELECTRON_RUN_AS_NODE=1**（VSCode 扩展宿主
// 传下来的）。不清掉的话 electron.exe 会以纯 node 身份跑起来，报
// `Cannot read properties of undefined (reading 'isPackaged')`，看着像代码写错了。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PACKAGED = process.argv.includes("--packaged");
const PKG_OUT = path.join(HERE, "release", "electron");
// 这一次实际用的输出目录 —— 正常就等于 PKG_OUT。只有 PKG_OUT 里的暂存目录
// 被别的进程攥住删不掉时才会临时换一个，理由见 build()。
let OUT = PKG_OUT;

let failed = 0;
function ok(cond, what, extra) {
  if (cond) console.log(`  ok   ${what}`);
  else {
    failed++;
    console.log(`  FAIL ${what}${extra ? `\n       ${extra}` : ""}`);
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 假 srvpro ---------------- */
const P = { TYPE_CHANGE: 0x13, CHAT: 0x19, PLAYER_ENTER: 0x20, JOIN_GAME: 0x12, TOOBSERVER: 0x21 };

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

// 连上来就演一遍「坐下 → 让座 → 两条对话」，然后**不关连接**：
// 这条连接要一直挂到子进程死掉为止。
// probe 跟着每个 server 单独发出去 —— 打包态要起**两次**程序（一次用临时数据目录、
// 一次用真实的 %APPDATA%），两个 probe 混在一起就分不清是谁的连接断了。
function startFakeSrvpro() {
  const probe = { connected: false, closed: false, chats: 0 };
  return new Promise((resolve) => {
    const s = net.createServer((sock) => {
      probe.connected = true;
      sock.on("close", () => (probe.closed = true));
      sock.on("error", () => {});
      sock.on("data", splitter((type) => {
        if (type === P.JOIN_GAME) {
          sock.write(frame(P.JOIN_GAME, Buffer.from([0x62, 0x13])));
          sock.write(frame(P.TYPE_CHANGE, Buffer.from([1])));
        } else if (type === P.TOOBSERVER) {
          sock.write(frame(P.TYPE_CHANGE, Buffer.from([7])));
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
            probe.chats++;
            sock.write(frame(P.CHAT, pl));
          };
          chat(0, "你好");
          chat(7, "围观一下");
        }
      }));
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port, probe }));
  });
}

/* ---------------- 跑一次程序 ---------------- */
function runApp(exe, args, timeout = 90000) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve) => {
    const child = spawn(exe, args, { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const t = setTimeout(() => child.kill(), timeout);
    t.unref?.();
    child.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

/* ---------------- 装 / 卸 NSIS 包 ---------------- */
// 都是静默的（/S）。**从 node 里 spawn，不要走 bash** —— Git Bash 会把 `/S`
// 当成路径改写掉（MSYS 的路径转换），表现是「安装器弹了个窗口，测试挂在那儿」。
function runQuiet(exe, args, timeout = 300000) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve) => {
    const c = spawn(exe, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    c.stdout.setEncoding("utf8");
    c.stderr.setEncoding("utf8");
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => c.kill(), timeout);
    c.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

async function waitUntil(fn, ms = 60000, step = 200) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await wait(step);
  }
}

// NSIS 的 `/D=` 必须是**最后一个**参数，且**不能带引号** —— 带引号的话那个引号
// 会被当成路径的一部分。node 的 spawn 不经 shell，只要路径里没有空格就不会被
// 加引号。所以这里显式挡一下：有空格就换个目录，别让测试莫名其妙地装到
// 一个字面量叫 `"C:\...` 的目录里去。
async function installTo(setup, dir) {
  if (/\s/.test(dir)) throw new Error(`安装目录不能带空格（/D= 的坑）：${dir}`);
  const { code } = await runQuiet(setup, ["/S", `/D=${dir}`]);
  // ⚠️ 静默安装的进程**可能先于文件写完就退出**了，不能装完立刻断言。
  const exe = await waitUntil(() => fs.existsSync(path.join(dir, "yrp-tools.exe")));
  return { code, exe: exe ? path.join(dir, "yrp-tools.exe") : null };
}

// 卸载器的名字是 electron-builder 生成的（`Uninstall yrp-tools.exe`），
// 别写死 —— 它会跟着 productName 变。
function uninstallerIn(dir) {
  try {
    return fs.readdirSync(dir).find((n) => /^uninstall.*\.exe$/i.test(n));
  } catch (_) {
    return null;
  }
}

/* ---------------- 打包 ---------------- */

/* 删一棵目录树，返回有没有删干净。
   Windows 上删不掉一个刚写出来的文件是家常便饭：杀软的实时防护正在扫它、
   索引器正在读它、上一个进程的句柄还没放干净。这类占用**经常几秒就自己没了**，
   所以别一上来就当成硬失败 —— maxRetries/retryDelay 是 fs.rm 自带的线性退避重试
   （它认 EBUSY / EPERM / ENOTEMPTY 这几种，正好是这里会遇到的）。 */
function rmTree(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    return true;
  } catch (_) {
    return false;
  }
}

function build() {
  console.log("\n0. 打包（electron-builder，慢）");
  OUT = PKG_OUT;

  // ⚠️ **先把上一次的暂存目录清掉，这是必须的。**
  // electron-builder 把 electron 解压到 `win-unpacked.tmp`，再用 rename 换成
  // `win-unpacked`。目标目录要是还在、或者正卡在 Windows 的「待删除」状态里
  // （它自己刚删过一遍，句柄还没放干净），rename 就报：
  //     EPERM: operation not permitted, rename '...win-unpacked.tmp' -> '...win-unpacked'
  // 报错位置在 extractArchive 里，**看着像 electron 包下载坏了**，很容易查错方向。
  // 上一次构建被 Ctrl+C 或者被杀掉时，最容易留下这种半截目录。
  for (const n of ["win-unpacked", "win-unpacked.tmp"]) {
    const p = path.join(PKG_OUT, n);
    if (!fs.existsSync(p)) continue;
    console.log(`       清掉上一次的暂存目录 ${n}`);
    if (rmTree(p)) continue;

    // 重试过还是删不掉，就**别硬撞了**。那个目录攥不到手里，electron-builder
    // 必然在 rename 那一步失败，整个 --packaged 会一轮又一轮地卡在这儿 ——
    // 而这事儿跟源码一个字的关系都没有。换一个干净的输出目录接着跑，
    // 源码、产物、白名单断言全都不受影响。
    // 实测踩过：win-unpacked.tmp/resources/default_app.asar 被第三方杀软的
    // 实时防护攥了 5 分钟以上，重试 20 次也没松手。
    OUT = fs.mkdtempSync(path.join(HERE, "release", "electron-"));
    console.log(`       ⚠️ ${n} 被别的进程占着，删不掉，这次改用 ${path.relative(HERE, OUT)}`);
    console.log("          （占用者多半是杀软或索引器。它们迟早会松手，");
    console.log(`            届时把 ${path.relative(HERE, PKG_OUT)} 里的 win-unpacked* 手工删掉即可。）`);
    break;
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // 用 node 去跑那个 .js —— Windows 不能直接 exec 一个 .js（EFTYPE）。
  // 这里起的是 node 自己，所以 ELECTRON_RUN_AS_NODE 清不清都一样。
  const cli = require.resolve("electron-builder/out/cli/cli.js");
  const r = spawn(process.execPath, [cli, "--win", "nsis",
    // 显式指定，别依赖 package.json 里那个值 —— 换目录时它得跟着变
    `--config.directories.output=${OUT}`], {
    env, cwd: HERE, stdio: "inherit",
  });
  return new Promise((res) => r.on("exit", (code) => res(code)));
}

/* ---------------- 打包产物里不许出现用户数据 ---------------- */
function checkNoLeak() {
  console.log("\n5. 打包产物里没有用户数据");
  const app = path.join(OUT, "win-unpacked", "resources", "app");
  if (!fs.existsSync(app)) {
    ok(false, "resources/app 存在", app);
    return;
  }

  // 这几样漏出去就是**静默**的：发布包照常能跑，只是把第三方服务器地址和
  // 用户自己的录像一起发出去了。electron-builder 的默认值是「全都要」，
  // 所以 files 白名单是唯一的防线，必须在这儿反问一句。
  for (const bad of ["proxy/config.json", "proxy/observer.json", "proxy/replays",
                     "dev", "build", "release", "node_modules",
                     // 测试和开发文档一律不进发布包：前者会连带把测试用的
                     // 假数据、临时目录逻辑一起发出去，后者是给维护者看的
                     "proxy/_test_api.mjs", "_test_electron.mjs", "_test_parser.mjs",
                     "PACKAGING.md", "README.md", "USAGE.md", "SHARING.md",
                     // 上一代的 HTTP 界面服务端，现在这个版本里根本不该存在
                     "proxy/gui.js"])
    ok(!fs.existsSync(path.join(app, bad)), `不该有 ${bad}`);

  // 反过来：少一个就是「界面起得来，但查看/导出是死的」这种半坏
  for (const need of ["proxy/main.js", "proxy/api.js", "proxy/preload.js", "proxy/selftest.js",
                      "proxy/gui.html", "chat-extractor.html", "package.json"])
    ok(fs.existsSync(path.join(app, need)), `必须有 ${need}`);

  // 白名单里没有 *.md，但 package.json 是强制带的 —— 确认没夹带整份源码树
  const top = fs.readdirSync(app).sort();
  ok(top.length <= 5, "app 根目录只有打包必需的那几项", top.join(", "));
  console.log(`       app 根目录：${top.join(", ")}`);
}

/* ================================================================== */
(async () => {
  let exe = require("electron"); // electron 包导出的就是可执行文件路径
  let installDir = null;
  let setup = null;
  const trash = []; // 退出前要收掉的临时目录

  if (PACKAGED) {
    const code = await build();
    if (code !== 0) {
      failed++;
      console.log(`  FAIL 打包失败，退出码 ${code}`);
      process.exit(1);
    }
    checkNoLeak();

    /* ---------------- 6. 装成一个真正的程序 ---------------- *
     * 从这一步起，跑的就是**用户装完之后的那个 exe** —— 不再是 release/ 里那个
     * 免安装产物。两者的差别是有意义的：装上之后数据在 %APPDATA%，而以前
     * 免安装版的数据在 exe 旁边。见 main.js 顶部的注释。 */
    console.log("\n6. 静默装到临时目录");
    setup = path.join(OUT, "yrp-tools-Setup.exe");
    ok(fs.existsSync(setup), "安装包出来了", setup);
    if (!fs.existsSync(setup)) {
      console.log("       没有安装包，后面没法测。");
      process.exit(1);
    }

    installDir = fs.mkdtempSync(path.join(os.tmpdir(), "yrp-inst-"));
    trash.push(installDir);
    const inst = await installTo(setup, installDir);
    ok(!!inst.exe, "装上了（yrp-tools.exe 出现在安装目录里）", `安装器退出码 ${inst.code}`);
    if (!inst.exe) {
      console.log("       没装上，后面没法测。");
      process.exit(1);
    }
    exe = inst.exe;
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yrp-smoke-"));
  trash.push(dataDir);

  console.log(`\n1-4. 起程序并走完整条链路（${PACKAGED ? "打包产物" : "开发态"}）`);
  const fake = await startFakeSrvpro();
  console.log(`       假 srvpro 在 127.0.0.1:${fake.port}`);

  // 开发态要一个 "." 指出应用目录；打包产物自己知道在哪，多给一个反而多余
  const args = PACKAGED ? [] : ["."];
  args.push("--selftest", `--selftest-port=${fake.port}`, `--selftest-data=${dataDir}`);

  const { code, out } = await runApp(exe, args);
  fake.server.close();

  // 报告有两条出口：stdout 和数据目录里的 selftest.log。**两条都要通** ——
  // 只信 stdout 的话，程序在 flush 之前崩掉就什么都读不到，表现成「自检没跑」
  // （上一代 portable 的 NSIS 壳就是这样：它把真正的 exe 解到 %TEMP% 再起，
  // 孩子的 stdout 根本接不回这条管道）。只信文件的话，出问题的时侯连实时输出都没有。
  const logFile = path.join(dataDir, "selftest.log");
  const fromFile = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  const text = fromFile || out;
  const line = (s) => (text.split("\n").find((l) => l.includes(s)) || "").trim();

  ok(fromFile.length > 0, "自检把报告写进了数据目录（stdout 之外的第二条出口）",
    "数据目录里没有 selftest.log");

  const show = text.trim() || "(没有任何输出)";
  ok(text.length > 0, "拿到了自检报告", `日志文件和 stdout 都是空的\n${out.trim()}`);

  // 界面自己有没有报错 —— 打包后最容易坏的就是这一层（preload 没带进去、
  // window.yrp 不存在），而它的表现是「窗口起来了，点什么都没反应」
  const bad = text.split("\n").filter((l) =>
    l.startsWith("[renderer]") && /Uncaught|TypeError|ReferenceError|FAIL/.test(l));
  ok(bad.length === 0, "界面自己没报错", bad.join("\n       "));
  ok(!text.includes("[selftest] FAIL"), "自检没有失败项", line("FAIL"));

  ok(text.includes("[selftest] data "), "自检用的是临时目录");
  ok(!!line("ok 起了观察者子进程"), "观察者子进程起得来");
  ok(!!line("ok 收到 proc running:true"), "收到了 proc running:true");
  ok(!!line("ok 收到子进程日志"), "子进程的日志能穿过 IPC 到界面");
  ok(!!line("ok 录像落盘"), "录像真的写出来了");
  ok(!!line("ok 导入落盘并被藏好"), "导入的录像存进了录像目录、列表里只留「本机」那条（界面层）", line("FAIL"));
  const pc = line("ok 解析出");
  ok(/ok 解析出 [2-9]\d* 条对话/.test(pc), "录下来的文件解析得出对话（整条链路）", pc);
  ok(text.includes("[selftest] ready"), "自检走到了关窗口那一步");

  ok(code === 0, "关窗口之后程序自己退了（退出码 0）", `实际 ${code}\n${show}`);

  // 关窗口 = 子进程跟着死。判据是那条连到假服务器的 socket 断了。
  for (let i = 0; i < 30 && !fake.probe.closed; i++) await wait(100);
  ok(fake.probe.connected, "录制子进程确实连上过假服务器（不然下一条等于没测）");
  ok(fake.probe.closed, "关窗口之后录制子进程真的死了（TCP 连接断了）");

  /* ================================================================ *
   * 7. 用户数据不跟着安装目录走
   *
   * 这一整段的由来：免安装（portable）那版把 replays/ 和 config.json 放在 exe
   * 旁边 —— 而 NSIS 安装包**升级时会先跑旧版卸载器，也就是把安装目录整个删掉
   * 再装新的**（实测过，见 PACKAGING.md）。装在安装目录里的东西，
   * 覆盖装一次没一次。所以数据必须落在 %APPDATA%\\yrp-tools\\，而
   * 安装目录必须能被随便删。
   *
   * 下面三件事分别钉住这条链的三环：
   *   a) 打包态**真的**把数据放在 %APPDATA% 下（不是嘴上说说）
   *   b) 覆盖安装之后数据还在
   *   c) 卸载之后数据还在
   * ================================================================ */
  if (PACKAGED) {
    const APPDATA_DIR = path.join(process.env.APPDATA, "yrp-tools");
    const replaysDir = path.join(APPDATA_DIR, "replays");
    const logFile2 = path.join(APPDATA_DIR, "selftest.log");
    // 只收掉**我们自己造出来的**东西：这个目录是用户的真实数据目录，
    // 里面本来就有的话（比如用户已经装过在用），一个字节都不许动。
    const hadReplays = fs.existsSync(replaysDir);
    const hadLog = fs.existsSync(logFile2);

    console.log("\n7a. 打包态的数据目录");
    const fake2 = await startFakeSrvpro();
    // ⚠️ **故意不给 --selftest-data** —— 就是要看它自己会挑哪儿。
    // 给了的话数据被指到临时目录，这一条就变成了自说自话。
    const run2 = await runApp(exe, ["--selftest", `--selftest-port=${fake2.port}`]);
    fake2.server.close();

    const field = (k) => (run2.out.match(new RegExp(`\\[selftest\\] ${k} (.*)`)) || [])[1];
    const dat = field("data");

    // ⚠️ 这几条**不能**拿 `[selftest] data` 当答案：自检态的 DATA 一定是临时目录
    // （main.js 开头那段），拿它去比 %APPDATA% 永远不相等。要验的是「真正跑起来
    // 会落到哪儿」，所以这里断言的是**生产判断的两个输入**：
    //
    //   ispackaged —— 要是 false，生产代码会走 `: HERE` 那一支，也就是**安装目录**。
    //                 而那正是升级时会被整个删掉的地方。这一条是本次改动的地基。
    //   userdata   —— app.getPath("userData") 来自 package.json 的 productName，
    //                 名字改了它就跟着变，所以得钉住。
    const isPackaged = field("ispackaged");
    const userData = field("userdata");
    ok(isPackaged === "true", "打包态的 app.isPackaged 是 true（否则数据会落到安装目录）",
      `实际 ${isPackaged}`);
    ok(!!userData && path.resolve(userData) === path.resolve(APPDATA_DIR),
      "app.getPath(\"userData\") 就是 %APPDATA%\\yrp-tools", `实际 ${userData}`);
    ok(!!userData && !path.resolve(userData).startsWith(path.resolve(installDir)),
      "所以生产态的数据目录不在安装目录里（升级不会连录像一起删）", String(userData));
    ok(run2.code === 0, "不给 --selftest-data 也能跑完整个自检", `退出码 ${run2.code}`);
    // 自检跑过一轮，临时目录是它自己开的 —— 顺手确认它确实没写生产目录
    ok(!fs.existsSync(path.join(APPDATA_DIR, "selftest.log")) || hadLog,
      "自检没有往真实数据目录里写日志", `dat=${dat}`);
    // 没给 --selftest-data 时，程序自己开了个临时目录装报告，收尾得带上。
    // 只收 tmp 底下的 —— 万一哪天 dat 报成别的地方，绝不能顺手把它删了。
    if (dat && path.resolve(dat).startsWith(path.resolve(os.tmpdir()))) trash.push(dat);

    console.log("\n7b. 覆盖安装之后用户数据还在");
    // 假装用户录了一局（用中文名，和真实录像一个样）
    fs.mkdirSync(replaysDir, { recursive: true });
    const marker = path.join(replaysDir, "别删我-09-25「20：06：52」.yrp3d");
    fs.writeFileSync(marker, "假装这是一局录像");

    const again = await installTo(setup, installDir);
    ok(!!again.exe, "第二次安装（覆盖）装上了");
    ok(fs.existsSync(marker), "覆盖安装之后录像还在（这条就是这次改动的全部意义）");

    console.log("\n7c. 卸载之后用户数据还在");
    const un = uninstallerIn(installDir);
    ok(!!un, "找到卸载器", `安装目录里：${fs.readdirSync(installDir).join(", ")}`);
    if (un) {
      await runQuiet(path.join(installDir, un), ["/S"]);
      // ⚠️ 等的是**目录本身**消失，不是等 yrp-tools.exe 消失。
      // NSIS 的卸载器会先把自己复制到 %TEMP% 再重启一份，真正删文件的是那一份，
      // 所以 `runQuiet` 返回时活儿往往才刚开始。原先等 exe、然后立刻断言目录 ——
      // 中间那一下就是竞态，会间歇性地红（撞上过一次）。
      // 这台机器上还有第二重慢：杀软在扫刚装好的那些文件，句柄不放就删不掉。
      await waitUntil(() => !fs.existsSync(installDir), 60000);
    }
    let left = "";
    try { left = fs.readdirSync(installDir).join(", "); } catch (_) {}
    ok(fs.existsSync(marker), "卸载之后录像还在（卸载器不许碰用户数据）");
    ok(!fs.existsSync(installDir), "卸载把安装目录本身收干净了", left ? `还剩：${left}` : "");

    // 收拾我们造出来的东西 —— 判据是「跑之前有没有」
    try {
      fs.unlinkSync(marker);
      if (!hadReplays) fs.rmSync(replaysDir, { recursive: true, force: true });
      if (!hadLog) fs.rmSync(logFile2, { force: true });
    } catch (e) {
      console.log(`       (清理 %APPDATA% 下的测试残留时出错：${e.message})`);
    }
    if (hadReplays || hadLog) {
      console.log("       注意：%APPDATA%\\yrp-tools 里本来就有东西，只清掉了本次新建的文件");
    }
  }

  // 清理这次冒烟留下的临时目录（录像、配置、报告都在里面）
  for (const d of trash) {
    if (!path.resolve(d).startsWith(path.resolve(os.tmpdir()))) continue;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
})()
  .catch((e) => {
    failed++;
    console.log(`  FAIL 抛异常了：${e.stack}`);
  })
  .finally(() => {
    console.log(failed ? `\n${failed} 个失败` : "\n全部通过");
    // 走了备用输出目录的话，**这一轮的新安装包在那儿，不在 release/electron/**。
    // 那儿留着的是上一次构建的旧包 —— 不说清楚就会有人拿旧的当新的用。
    if (OUT !== PKG_OUT) {
      console.log(`\n⚠️ 这一轮的产物在 ${path.relative(HERE, OUT)}（不是 ${path.relative(HERE, PKG_OUT)}）：`);
      console.log(`     ${path.join(OUT, "yrp-tools-Setup.exe")}`);
      console.log(`   ${path.relative(HERE, PKG_OUT)} 里那个是旧包，别用。`);
    }
    process.exit(failed ? 1 : 0);
  });
