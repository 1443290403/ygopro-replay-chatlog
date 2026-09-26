/* ------------------------------------------------------------------ *
 * --selftest：打成一个 exe 之后的冒烟自检
 *
 * 只在 main.js 的 `--selftest` 分支里 require，平时一行都不跑。
 *
 * 它做的是「把观察者子进程指向**外层测试起的假 srvpro**，等录像落盘、解析出
 * 对话，然后关窗口」。剩下的两件事由外层 `_test_electron.mjs` 判定：
 *   - 进程自己退掉了（读退出码）
 *   - **录制子进程真的死了** —— 外层握着那条 TCP 连接，连接断了才算数
 * 这就是用户点名要的那条行为的直接覆盖点。
 *
 * 「还在录的时候关窗会弹确认框」这条**故意不测** —— 模态框没法自动点，
 * 只能靠人验收（见计划 §九）。
 *
 * 会话数据全在临时目录里（main.js 在 --selftest 下把 YRP_DATA_DIR 指过去），
 * 碰不到真实的 proxy/replays/。
 * ------------------------------------------------------------------ */
"use strict";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 15000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await wait(step);
  }
}

// say 由 main.js 注入（同时进 stdout 和数据目录里的 selftest.log）——
// 打包态拿不到 stdout，报告得靠那个文件传出来。见 main.js 的 report()。
module.exports = async function selftest({ api, win, app, say, port }) {
  let done = false;
  const fail = (why) => {
    if (done) return;
    done = true;
    say("FAIL " + why);
    app.exit(1);
  };

  // 兜底：卡住的话别让外层测试干等到超时，给个能读的结论
  const bail = setTimeout(() => fail("20 秒还没走完，卡住了"), 20000);
  bail.unref?.();

  const seen = [];
  api.subscribe((ev) => seen.push(ev));

  try {
    // 1. 起观察者，指向外层那个假 srvpro
    const started = api.handlers["proc:start"]({
      mode: "observer",
      cfg: { host: "127.0.0.1", port, room: "自检房", name: "自检", version: 4962 },
    });
    if (!started.ok) return fail("起不了观察者：" + started.error);
    say("ok 起了观察者子进程");

    // 2. 子进程活着 + 有日志。日志能过来 = stdio 那条管道是通的
    if (!(await until(() => seen.some((e) => e.t === "proc" && e.running === true))))
      return fail("没收到 proc running:true");
    say("ok 收到 proc running:true");

    if (!(await until(() => seen.some((e) => e.t === "log")))) return fail("没收到任何日志");
    say("ok 收到子进程日志");

    // 3. 录像落盘 —— 说明子进程真的连上了假服务器并写下了字节
    const rec = await until(async () => {
      const r = await api.handlers["recordings:list"]();
      return r.list.length ? r : null;
    });
    if (!rec) return fail("等了 15 秒还没有录像文件");
    say(`ok 录像落盘：${rec.list[0].name}（${rec.list[0].size} 字节）`);

    // 4. 解析出来 —— 整条链路走通（子进程 → socket → .yrp3d → 解析器）
    const parsed = await until(async () => {
      try {
        const r = await api.handlers["recording:parse"]({ name: rec.list[0].name });
        return r.chats && r.chats.length >= 2 ? r : null;
      } catch (_) {
        return null; // 刚连上时包还没写完，解析不出来很正常
      }
    });
    if (!parsed) return fail("解析出来不到 2 条对话");
    say(`ok 解析出 ${parsed.chats.length} 条对话，座位 ${JSON.stringify(parsed.seats)}`);

    /* 4b. 导入的录像要真的存进录像目录，而且列表里**只出现「本机」那一条**
     *
     * 这一步必须走 win.webContents.executeJavaScript —— 前面几步全在 Node 侧，
     * 验的都是 api.js；而这一段要验的恰恰是**渲染出来的行**（磁盘那份有没有被
     * 藏掉、#n-rec 是不是重复计了、「本机」那句说明对不对）。api.js 全绿而界面
     * 显示错，正是这个功能最容易出的毛病。
     *
     * 用来导入的字节就是**刚刚录下来的那一条**：真录像、真解析器、真落盘。
     * 自己造样本的话，样本解析不过（result.ok=false）就整段空跑了，而且
     * 看起来还是绿的。 */
    const fs2 = require("fs");
    const path2 = require("path");
    const dir = (await api.handlers["replays:getDir"]()).dir;
    const srcBytes = fs2.readFileSync(path2.join(dir, rec.list[0].name));

    const ui = await win.webContents.executeJavaScript(`(async () => {
      const bin = atob(${JSON.stringify(srcBytes.toString("base64"))});
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await addLocalFiles([new File([u8], "自检导入.yrp3d", { lastModified: 1700000000000 })]);
      // addLocalFiles 末尾那句 select() 没有 await，说明文字可能还没写上去
      await select([...S.local.keys()].pop());
      const mine = [...S.local.values()].pop();
      return {
        keys: [...document.querySelectorAll("#recs .rec")].map((n) => n.dataset.key),
        nRec: Number($("n-rec").textContent),
        savedAs: mine && mine.savedAs,
        note: $("view-note").textContent
      };
    })()`);

    if (!ui.savedAs) return fail("界面说没存进录像目录（savedAs 是空的）");
    if (ui.savedAs !== "自检导入.yrp3d") return fail("落盘名不对：" + ui.savedAs);
    const landed = path2.join(dir, ui.savedAs);
    if (!fs2.existsSync(landed)) return fail("磁盘上没有那个副本：" + landed);
    if (!fs2.readFileSync(landed).equals(srcBytes)) return fail("副本的字节和源文件不一样");
    if (ui.keys.includes("s:" + ui.savedAs))
      return fail("磁盘那份没被藏起来，同一局录像在列表里出现了两次");
    if (ui.keys.filter((k) => k.startsWith("u:")).length !== 1)
      return fail("「本机」那行不是 1 条：" + JSON.stringify(ui.keys));
    if (ui.nRec !== ui.keys.length)
      return fail(`#n-rec 说是 ${ui.nRec}，实际画了 ${ui.keys.length} 行（藏掉的那份被重复计了？）`);
    if (!ui.note.includes("已存进录像目录"))
      return fail("选中时的说明还是「本机文件，只在这个页面里」：" + ui.note);
    say(`ok 导入落盘并被藏好：录像目录 ${fs2.readdirSync(dir).filter((f) => f.endsWith(".yrp3d")).length} 个文件，列表里 ${ui.keys.length} 行`);

    // 5. 关窗口 = 退出。剩下的交给 window-all-closed → app.quit()
    done = true;
    clearTimeout(bail);
    say("ready");
    win.close();
  } catch (e) {
    fail("抛异常了：" + (e && e.stack ? e.stack : e));
  }
};
