#!/usr/bin/env electron
/* ------------------------------------------------------------------ *
 * 对话记录 —— Electron 主进程
 *
 * 一个窗口就是整个程序。关掉窗口 = 程序退出 + 录制子进程一起收摊，
 * 不需要浏览器、不需要 .vbs 启动器、也不需要知道「那个黑窗口别关」。
 *
 * 三件事只在**这个文件**里：
 *   1. 数据目录定在哪（§ DATA）
 *   2. 窗口和「关窗时还在录就确认一句」
 *   3. 把 api.js 的通道表挂到 ipcMain 上，并把系统能力注入进去
 * 真正的逻辑（配置、子进程、解析、导出）全在 api.js，那里面一行 Electron 都没有。
 * ------------------------------------------------------------------ */
"use strict";

const { app, BrowserWindow, dialog, shell, clipboard, ipcMain } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HERE = __dirname;

// 冒烟自检模式。只在 `_test_electron.mjs` 里用，见 selftest.js。
const SELFTEST = process.argv.includes("--selftest");

/* ================================================================== *
 * 数据落在哪
 *
 * ⚠️ **这三行必须在 require("./api.js") 之前。** api.js / gui.js / proxy.js /
 * observer.js 的路径都是**模块加载时**算出来的，顺序反了不报错，只会静默
 * 用错目录 —— 打包态会把只读的 resources/app/ 当数据目录，测试则会往真实的
 * proxy/replays/ 里写东西。
 *
 * 打包态 = `app.getPath("userData")`，也就是 `%APPDATA%\yrp-tools\`。
 *
 * ⚠️ **不能用 exe 所在目录。** 现在是 NSIS 安装包，而安装器升级时会先跑旧版的
 * 卸载器 —— 那个动作就是「把安装目录整个删掉再装新的」。实测过：装在安装目录里的
 * 录像和配置，覆盖安装一次没一次，卸载更是全清。所以配置落在用户目录下。
 *
 * 录像还有一层：它默认在 `%APPDATA%\yrp-tools\replays\`，但**界面里能改到任意位置**
 * （存进同目录的 settings.json，由 api.js 自己读）。改哪都行，反正不跟着安装目录走。
 *
 * 开发态（`npx electron .`）仍是 proxy/ —— 那 19 个录像和配置零迁移。
 * ================================================================== */
const argOf = (name) => {
  const a = process.argv.find((s) => s.startsWith(name));
  return a ? a.slice(name.length) : "";
};
const DATA = SELFTEST
  ? // 自检绝不能在真实的 replays/ 和 config.json 上跑。
    // 目录由外层测试指定（它得知道去哪儿读报告）；没指定就自己开一个，
    // 方便手工 `electron . --selftest` 时看一眼。
    argOf("--selftest-data=") || fs.mkdtempSync(path.join(os.tmpdir(), "yrp-selftest-"))
  : app.isPackaged
    ? app.getPath("userData")
    : HERE;
process.env.YRP_DATA_DIR = DATA;

const { createApi } = require("./api.js");

/* ------------------------------------------------------------------ *
 * 自检的报告往哪儿写
 *
 * **不能只靠 stdout。** 只要这个进程不是被测试直接 spawn 的（比如将来又出
 * portable 包：那种 exe 是个 NSIS 壳，它把真正的 exe 解压到 %TEMP% 再起，
 * 那孩子的 stdout 接不回外层测试的管道），表现就是「自检明明跑完了，日志
 * 一条都读不到」，看着像自检根本没跑。所以同时写一份到数据目录，外层读文件。
 * 现在装的是 NSIS 安装包、由测试直接 spawn，两条路都通 —— 但文件这条更稳。
 *
 * 开发态（`npx electron .`）两种都看得到，手工跑的时候照样是刷屏的。
 * ------------------------------------------------------------------ */
function report(line) {
  const s = `${line}\n`;
  process.stdout.write(s);
  if (!SELFTEST) return;
  try {
    fs.appendFileSync(path.join(DATA, "selftest.log"), s);
  } catch (_) {}
}

let win = null;
let api = null;
// 已经在退出的路上：要么用户点了「退出界面」，要么刚才那个确认框已经确认过。
// 有它才不会退一次问两遍（关窗问一遍、before-quit 再问一遍）。
let quitting = false;

/* ------------------------------------------------------------------ *
 * 「还在录」的确认框
 *
 * 返回 true = 用户确认要退。**关窗（×）和「退出界面」按钮共用这一个**，
 * 否则两处问的话不一样，用户会以为踩到了两套逻辑。
 * ------------------------------------------------------------------ */
function confirmQuit() {
  // 自检里没有人在旁边点按钮，模态框会把它挂死。这条路要靠人验收。
  if (SELFTEST) return true;
  const choice = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
    type: "warning",
    buttons: ["继续录制", "退出并停止录制"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "还在录制",
    message: "现在还在录。退出会一起停掉录制。",
    detail: "已经录到的内容不会丢 —— 每条对话都是当场落盘的。继续录的那部分就不会被记下来了。",
  });
  return choice === 1;
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */
function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 900,
    minHeight: 560,
    // 和页面里的 --bg 一致：不然窗口出现的那一瞬间会白闪一下
    backgroundColor: "#0f1117",
    show: false,
    webPreferences: {
      preload: path.join(HERE, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.loadFile(path.join(HERE, "gui.html"));

  if (SELFTEST) {
    // 界面里的报错平时只出现在 DevTools 里，测试看不见。转出来 —— 不然
    // 「window.yrp 不存在」这类问题会表现成「窗口起来了，但点什么都没反应」。
    win.webContents.on("console-message", (...a) => {
      const d = a[1];
      report(`[renderer] ${d && typeof d === "object" ? d.message : a[2]}`);
    });
    win.webContents.on("did-fail-load", (_e, code, desc, url) => {
      report(`[renderer] FAIL 页面没加载出来 ${code} ${desc} ${url}`);
    });
  }

  // 界面里不该开出第二个窗口。toast 那类东西要是残留了 target=_blank，
  // 这里拦掉比 `action:"allow"` 开出一个没有 preload 的裸窗口强。
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  win.on("close", (e) => {
    if (quitting || !api || !api.anyRunning()) return;
    if (!confirmQuit()) return e.preventDefault();
    quitting = true;
  });

  win.on("closed", () => {
    win = null;
  });
}

/* ------------------------------------------------------------------ *
 * 把 api.js 的通道表挂上去
 * ------------------------------------------------------------------ */
function registerIpc() {
  const handlers = {
    ...api.handlers,

    // 窗口先自己抢回前台，再交给 api.js 那段提窗口的脚本。
    // 脚本**不能删** —— 它是唯一能「判定」到底提到前面没有的机制，界面靠
    // 它决定要不要说「看一下任务栏」（见 api.js 里 RAISE_SCRIPT 的注释）。
    "shell:reveal": async () => {
      if (win && !win.isDestroyed()) win.focus();
      return api.handlers["shell:reveal"]();
    },

    "app:quit": async () => {
      if (api.anyRunning() && !confirmQuit()) return { ok: false, canceled: true };
      quitting = true;
      const r = api.handlers["app:quit"]();
      // 先把响应发回渲染进程，再退 —— 顺序反了界面那边只会看到连接断掉
      setImmediate(() => app.quit());
      return r;
    },
  };

  for (const [ch, fn] of Object.entries(handlers)) {
    ipcMain.handle(ch, async (_e, args) => {
      try {
        return await fn(args);
      } catch (e) {
        // 约定：handler 失败靠 throw，这里统一包成 {ok:false, error} ——
        // 界面里那些 `if (!r.ok) banner(r.error)` 一个字都不用改。
        // 带 payload 的（失败结果里有 trimmed/running 这类字段）整份发回去。
        if (e && e.payload) return e.payload;
        return { ok: false, error: (e && e.message) || String(e) };
      }
    });
  }
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
function start() {
  api = createApi({
    // 子进程还是独立进程（崩溃隔离保住了），但现在 process.execPath 是
    // electron.exe —— 不带这个变量会把 proxy.js 当成一个 Electron 应用起，
    // 弹出一个没有任何内容的 GUI 窗口。带上它就退化成纯 node，
    // **开发态和打包态走的是同一条代码路径**。
    childEnv: { ELECTRON_RUN_AS_NODE: "1" },

    pickDir: async () => {
      const r = await dialog.showOpenDialog(win, {
        title: "选一个导出目录",
        buttonLabel: "导出到这里",
        properties: ["openDirectory", "createDirectory"],
      });
      return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
    },
    defaultExportDir: () => app.getPath("downloads"),
    // openPath 成功时 resolve 一个空串，失败时 resolve 一句人话 —— 转成异常，
    // 界面才能把它摆在横幅上
    openFile: async (p) => {
      const err = await shell.openPath(p);
      if (err) throw new Error(err);
    },
    clipboard: (t) => clipboard.writeText(t),
  });

  // 子进程的日志「按行分类」之后从这里推给窗口
  api.subscribe((ev) => {
    if (win && !win.isDestroyed()) win.webContents.send("yrp:event", ev);
  });

  registerIpc();
  createWindow();

  if (SELFTEST) {
    // 把数据目录打出来：排查时想知道东西到底落在哪
    report(`[selftest] data ${DATA}`);

    // 上面那个 DATA 在自检态**一定是临时目录**（见文件开头），所以它证明不了
    // 「真正跑起来的时候数据会落在 %APPDATA%」这件事 —— 冒烟测试偏要验的就是
    // 那一条，因为落在安装目录里 = 用户升一次级丢一次录像。
    // 这里把生产判断的两个**输入**原样报出去，由外层自己断言，而不是在这儿
    // 把那个三目再算一遍（那样只是把实现抄一遍，实现错了也跟着一起错）。
    report(`[selftest] ispackaged ${app.isPackaged}`);
    report(`[selftest] userdata ${app.getPath("userData")}`);

    // 等页面加载完再跑：这样「界面自己有没有报错」也一并被冒烟覆盖到
    win.webContents.once("did-finish-load", () => {
      const say = (s) => report(`[selftest] ${s}`);
      require("./selftest.js")({ api, win, app, say, port: Number(argOf("--selftest-port=")) })
        .catch((e) => {
          report("[selftest] FAIL " + (e && e.stack ? e.stack : e));
          app.exit(1);
        });
    });
  }

  // 录制子进程不是 Electron 的 utilityProcess，不会被自动回收 ——
  // 这几条路每条都得走 killAll，漏一条就留下占着端口的孤儿进程。
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    quitting = true;
    api.killAll();
  });
  app.on("will-quit", () => api.killAll());
  process.on("exit", () => api.killAll());
}

// 第二个实例直接让位，把已有窗口提到前面。
// 这替代了原来「地址文件 + 探活 + 重新打开浏览器」那一整套 ——
// 两个界面会抢同一批录像文件，所以只能有一个。
// 自检不走单实例锁：不然机器上正开着这个程序时，测试会一启动就让位退出
if (!SELFTEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(start);
}
