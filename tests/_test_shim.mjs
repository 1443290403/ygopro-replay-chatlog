// 垫片（www/yrp-shim.js）的契约测试：**不碰安卓**，普通 node 就能跑。
//
//   node tests/_test_shim.mjs
//
// 垫片是安卓版唯一一段「从没被执行过」的代码 —— 桌面版对应的是 preload.js，
// 而它没有安卓上的替身。这里用一个假的 Capacitor + 一个极简的假 DOM 把它
// 整个跑一遍，验的是**和 gui.html 的契约**（不是实现细节）：
//
//   1. on() 必须**同步**返回取消函数 —— gui.html:455 是
//      `offEvents = window.yrp.on(...)`，然后 connect() 里 `if (offEvents) offEvents()`。
//      返回 Promise 的话，界面一重载就抛 "offEvents is not a function"。
//   2. 每条 invoke 都得配上自己的回复 —— 界面在 2 秒轮询录像列表和录像详情，
//      串了几乎看不出来（表现是「点 A 显示出 B 的内容」）。
//   3. 需要安卓原生能力的那几个通道不能在垫片里漏下去给 Node
//      （Node 运行时碰不到剪贴板和分享面板）。
//   4. 藏起来的按钮 id 在 gui.html 里**真的存在** —— 不存在的表现是
//      「按钮还在，点了没反应」，比报错难查得多。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHIM_SRC = fs.readFileSync(path.join(HERE, "www", "yrp-shim.js"), "utf8");
const GUI_SRC = fs.readFileSync(path.join(HERE, "www", "index.html"), "utf8");

let fail = 0;
const ok = (cond, what, extra = "") => {
  if (cond) console.log(`  ok   ${what}`);
  else {
    fail++;
    console.log(`  FAIL ${what}${extra ? `\n       ${extra}` : ""}`);
  }
};
const eq = (got, want, what) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  ok(a === b, what, a === b ? "" : `得到 ${a}，期望 ${b}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 极简假 DOM
 *
 * 只实现垫片真正用到的东西：getElementById / createElement / replaceChildren /
 * 事件冒泡 / closest。选择器**不做通用匹配**，closest 只认 "#id"、".class"
 * 和标签名三种 —— 垫片里只用到了标签名那一种（`closest("button")`）。
 *
 * 为什么值得写这么多：垫片的 adjustDom() 会**搬家**（见 www/yrp-shim.js 里
 * 「安卓没有拖放」那一段）。把 #pick-files 这种已经被 gui.html 绑过事件的节点
 * 搬进 #drop，和「新建一个同名同 id 的按钮」在真机上差别巨大 —— 前者点了有用，
 * 后者**点了没反应而且不报错**。这个区别只有假 DOM 才验得出来。
 * ------------------------------------------------------------------ */
function makeEl(tag, id) {
  return {
    tagName: String(tag).toUpperCase(),
    id: id || "",
    className: "",
    style: {},
    attrs: {},
    textContent: null,
    parent: null,
    children: [],
    handlers: {}, // addEventListener 挂的
    clicks: 0,
    removeAttribute(k) {
      delete this.attrs[k];
    },
    getAttribute(k) {
      return this.attrs[k];
    },
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    addEventListener(type, fn) {
      (this.handlers[type] || (this.handlers[type] = [])).push(fn);
    },
    appendChild(kid) {
      const c = typeof kid === "string" ? mkText(kid) : kid;
      // 已经是别人家的孩子就先摘下来 —— 和真 DOM 一样，一个节点只有一个爹
      if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c);
      c.parent = this;
      this.children.push(c);
      return c;
    },
    append(...kids) {
      for (const k of kids) this.appendChild(k);
    },
    /* replaceChildren 的语义：先清空，再把给的东西按顺序放进来。
       给的是**已有节点就搬过去**（同一个对象，事件处理器跟着走），不是克隆。 */
    replaceChildren(...kids) {
      for (const c of this.children) c.parent = null;
      this.children = [];
      this.textContent = null;
      for (const k of kids) this.appendChild(k);
    },
    click() {
      this.clicks++;
      this.dispatch("click", this);
    },
    /* 事件从自己往上冒。on<type>（gui.html 用的写法）和 addEventListener
       （垫片用的写法）都得支持 —— #drop 上现在两种都有。 */
    dispatch(type, target) {
      const ev = { type, target: target || this, _stop: false, stopPropagation: () => { ev._stop = true; } };
      for (let n = this; n && !ev._stop; n = n.parent) {
        for (const fn of n.handlers[type] || []) {
          if (ev._stop) break;
          fn(ev);
        }
        const inline = n["on" + type];
        if (inline && !ev._stop) inline(ev);
      }
      return ev;
    },
    closest(sel) {
      for (let n = this; n; n = n.parent) {
        if (sel.startsWith("#") && n.id === sel.slice(1)) return n;
        if (sel.startsWith(".") && String(n.className).split(/\s+/).includes(sel.slice(1))) return n;
        if (!sel.startsWith("#") && !sel.startsWith(".") && n.tagName === sel.toUpperCase()) return n;
      }
      return null;
    },
  };
}
const mkText = (s) => {
  const t = makeEl("#text");
  t.textContent = String(s);
  return t;
};

/* 从 www/index.html 里抠出全部 id，尽量接近真的 gui.html */
const guiIds = [...GUI_SRC.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

/* 每个 id 的**标签名**也要抠出来：`closest("button")` 靠它区分
   「点的是块空白」还是「点的是里面的按钮」。全建成 div 的话那个判断就废了，
   而它是「点一下只弹一次选择器」的关键。 */
const guiTags = new Map(
  [...GUI_SRC.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"/g)].map((m) => [m[2], m[1]])
);

function makeDom(ids) {
  const nodes = new Map(ids.map((id) => [id, makeEl(guiTags.get(id) || "div", id)]));
  const document = {
    readyState: "complete", // 直接走 adjustDom()，不用等 DOMContentLoaded
    addEventListener() {},
    getElementById: (id) => nodes.get(id) || null,
    createElement: (tag) => makeEl(tag),
  };

  /* 照 gui.html 的样子把结构也摆上。**装饰内容也要摆** —— #drop 里本来除了
     那三个按钮，还有提示文字和一个 <b>.yrp3d</b>（见 gui.html 的 #drop）。
     只摆按钮的话，垫片那句「捞出带 id 的子元素放回去」面对的是一个没有
     杂物的盒子，漏删 / 误删就都看不出来。 */
  const drop = nodes.get("drop");
  if (drop) {
    drop.appendChild(mkText("把 "));
    const b = makeEl("b");
    b.textContent = ".yrp3d";
    drop.appendChild(b);
    drop.appendChild(mkText(" 文件或整个文件夹拖到这里 —— 也可以"));
    for (const id of ["pick-files", "pick-dir", "pick-clear-local"]) {
      const n = nodes.get(id);
      if (n) drop.appendChild(n);
    }
  }

  /* gui.html 里那几条真实存在的绑定。少了它们，「垫片搬完家之后按钮还能用吗」
     就没法验 —— 而那是这次改动最核心的一条。写法照着 gui.html 抄：
     那边用的是 el.onclick = …（不是 addEventListener）。 */
  const finput = nodes.get("file-input");
  const pickFiles = nodes.get("pick-files");
  if (finput && pickFiles) pickFiles.onclick = () => finput.click();
  const clearLocal = nodes.get("pick-clear-local");
  if (clearLocal) clearLocal.onclick = () => { clearLocal.cleared = (clearLocal.cleared || 0) + 1; };

  return { nodes, document };
}

/* ------------------------------------------------------------------ *
 * 假 Capacitor
 * ------------------------------------------------------------------ */
const sent = []; // Nodejs.send 收到的
const listeners = {}; // Nodejs.addListener 注册的
const calls = { clipboard: [], share: [], getUri: [], exitApp: 0 };

const fakeNodejs = {
  send: async (o) => {
    sent.push(o);
  },
  addListener: async (ev, fn) => {
    listeners[ev] = fn;
  },
  isReady: async () => ({ ready: true }),
};

const Cap = {
  Plugins: {
    Nodejs: fakeNodejs,
    Clipboard: {
      write: async (o) => {
        calls.clipboard.push(o);
      },
    },
    Filesystem: {
      getUri: async (o) => {
        calls.getUri.push(o);
        return { uri: "file:///data/user/0/local.yrp.tools/files/" + o.path };
      },
    },
    Share: {
      share: async (o) => {
        calls.share.push(o);
      },
    },
    App: {
      exitApp: () => {
        calls.exitApp++;
      },
    },
  },
};

/* ------------------------------------------------------------------ *
 * 在 vm 里跑垫片 —— 用一个干净的上下文，不让它碰到测试进程的全局
 * ------------------------------------------------------------------ */

/** 再造一份垫片，配不同的插件集。用来验「没有某个插件时会怎样」。 */
function makeSandbox(plugins) {
  const d = makeDom(guiIds);
  const s = {
    window: { Capacitor: { Plugins: plugins } },
    document: d.document,
    navigator: { clipboard: { writeText: async () => {} } },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    String,
    Number,
    Array,
    Object,
    Map,
    Set,
    Error,
  };
  s.globalThis = s;
  vm.createContext(s);
  vm.runInContext(SHIM_SRC, s, { filename: "yrp-shim.js" });
  return { yrp: s.window.yrp, dom: d };
}

// dom 必须取 makeSandbox 返回的那一份 —— 垫片改的是**它自己那个** document
const { yrp, dom } = makeSandbox(Cap.Plugins);

console.log("1. 契约形状（gui.html 只认这两样）");
ok(yrp && typeof yrp.invoke === "function", "window.yrp.invoke 在");
ok(yrp && typeof yrp.on === "function", "window.yrp.on 在");

/* gui.html:394 `return window.yrp.invoke(ch, args)` —— 必须返回 Promise */
{
  const p = yrp.invoke("state:get", {});
  ok(p && typeof p.then === "function", "invoke 返回 Promise");
  await wait(10);
}

/* gui.html:455 —— **同步**拿取消函数 */
{
  const off = yrp.on("yrp:event", () => {});
  ok(typeof off === "function", "on() 同步返回取消函数（不是 Promise）");
  off();
}

console.log("\n2. invoke -> Node -> reply 的配对");
{
  sent.length = 0;
  const p1 = yrp.invoke("state:get", { a: 1 });
  const p2 = yrp.invoke("config:get", {});
  await wait(20);

  eq(sent.length, 2, "两条都发出去了");
  eq(sent[0].eventName, "invoke", "通道名是 invoke");
  const r1 = sent[0].args[0];
  const r2 = sent[1].args[0];
  ok(typeof r1.id === "number" && r1.id !== r2.id, "每条带一个自增 id");
  eq(r1.ch, "state:get", "通道名原样带上");
  eq(r1.args, { a: 1 }, "参数原样带上");

  // **乱序**回复：第二条先回。串了的话 p1 会拿到 p2 的结果
  listeners.message({ eventName: "reply", args: [{ id: r2.id, result: { ok: true, who: "p2" } }] });
  listeners.message({ eventName: "reply", args: [{ id: r1.id, result: { ok: true, who: "p1" } }] });

  eq(await p1, { ok: true, who: "p1" }, "先发的拿到自己那条（乱序也不串）");
  eq(await p2, { ok: true, who: "p2" }, "后发的也是");
}

console.log("\n3. 事件转发");
{
  const got = [];
  const off = yrp.on("yrp:event", (ev) => got.push(ev));
  listeners.message({ eventName: "event", args: [{ t: "log", kind: "info", text: "x" }] });
  listeners.message({ eventName: "event", args: [{ t: "proc", mode: "observer", running: true }] });
  eq(got.length, 2, "两条事件都到了订阅者");
  eq(got[0], { t: "log", kind: "info", text: "x" }, "事件形状原样透传（和桌面版一致）");

  off();
  listeners.message({ eventName: "event", args: [{ t: "log", text: "y" }] });
  eq(got.length, 2, "取消订阅后不再收到");

  // 订阅者抛异常不能拖垮别的订阅者
  const other = [];
  const bad = yrp.on("yrp:event", () => {
    throw new Error("我是坏的订阅者");
  });
  const good = yrp.on("yrp:event", (ev) => other.push(ev));
  listeners.message({ eventName: "event", args: [{ t: "log", text: "z" }] });
  eq(other.length, 1, "前一个订阅者抛异常，后面的照样收到");
  bad();
  good();
}

console.log("\n4. 走安卓原生、不下发给 Node 的通道");
{
  sent.length = 0;

  eq(await yrp.invoke("clipboard:write", { text: "复制我" }), { ok: true }, "clipboard:write 成功");
  eq(calls.clipboard, [{ string: "复制我" }], "走的是 @capacitor/clipboard");

  const r = await yrp.invoke("shell:openFile", { name: "对话.txt" });
  eq(r, { ok: true }, "shell:openFile 成功");
  eq(calls.getUri.length, 1, "先问 Filesystem 要 URI");
  eq(calls.getUri[0].path, "export/对话.txt", "路径形状是 export/<文件名>（必须和 Node 侧写的一致）");
  eq(calls.getUri[0].directory, "DATA", "目录是 DATA（= app.datadir()）");
  eq(calls.share.length, 1, "然后交给系统分享面板");
  eq(calls.share[0].files.length, 1, "分享的是那个文件");
  ok(/^file:\/\//.test(calls.share[0].files[0]), "给的是 file:// URI（Share 只认这个）");

  /* 文件名里的路径分隔符必须被剥掉。断言的是**性质**而不是具体字符串：
   * 只要「结果一定在 export/ 这一层里」成立就够，剥成什么样是次要的。 */
  const bad = await yrp.invoke("shell:openFile", { name: "../../etc/passwd" });
  eq(bad, { ok: true }, "带路径的文件名不崩");
  {
    const p = calls.getUri[calls.getUri.length - 1].path;
    ok(p.startsWith("export/"), `仍在 export/ 下（${p}）`);
    ok(!p.slice("export/".length).includes("/"), "不会再往下钻一层（没跑出 export/）");
  }

  const rev = await yrp.invoke("shell:reveal", {});
  eq(rev.ok, false, "shell:reveal 明确失败而不是假装成功");
  ok(/没有「打开文件夹」/.test(rev.error), "而且给了人话的理由");

  eq(sent.length, 0, "这四个通道**一个都没**发给 Node");
}

console.log("\n5. app:quit：先停干净的，再退");
{
  sent.length = 0;
  calls.exitApp = 0;
  const p = yrp.invoke("app:quit", {});
  await wait(10);
  eq(sent.length, 1, "先让 Node 侧收摊");
  eq(sent[0].args[0].ch, "app:quit", "发的正是 app:quit");
  eq(calls.exitApp, 0, "Node 还没回的时候**不能**退 App（录像最后那个包会丢）");

  listeners.message({
    eventName: "reply",
    args: [{ id: sent[0].args[0].id, result: { ok: true, stopped: ["observer"] } }],
  });
  eq(await p, { ok: true, stopped: ["observer"] }, "回复原样透传（界面要拿 stopped）");
  await wait(250);
  eq(calls.exitApp, 1, "Node 回完之后才退 App");
}

console.log("\n5b. 录像那几个通道**必须**下发给 Node（垫片不许自作主张）");
{
  /* 垫片的 localHandlers 是**拦在** invoke 最前面的一层。往里加错一条，
   * 表现是「点了没反应」或者更糟 —— 导入的录像静默地不落盘（垫片自己
   * 又没地方写文件），而界面照样显示成功。
   *
   * 这条断言正是「导入的录像存进录像目录」那个功能的安卓命门：落盘全靠
   * Node 侧的 api.js，字节要 base64 编好**真的过一遍 JSON 桥**。
   * 断言的是行为（发没发下去）而不是去读 localHandlers 那个对象 ——
   * 它在垫片里是个模块内的 const，从外面根本看不到。 */
  const CH = [
    "recordings:list",
    "recording:parse",
    ["recordings:import", { files: [{ name: "a.yrp3d", data: "QUJD", mtime: 1 }] }],
  ];
  for (const item of CH) {
    const ch = Array.isArray(item) ? item[0] : item;
    const args = Array.isArray(item) ? item[1] : {};
    sent.length = 0;
    const p = yrp.invoke(ch, args);
    await wait(10);
    eq(sent.length, 1, `${ch} 发给了 Node`);
    if (sent.length) {
      eq(sent[0].args[0].ch, ch, `${ch} 的通道名原样`);
      // ★ base64 字符串必须原封不动地过桥 —— 它是唯一能过 JSON 的二进制形式
      eq(JSON.stringify(sent[0].args[0].args), JSON.stringify(args), `${ch} 的参数原样过桥（JSON 可序列化）`);
    }
    // 收尾：回一个结果，别让 promise 永远挂着
    if (sent.length) {
      listeners.message({
        eventName: "reply",
        args: [{ id: sent[0].args[0].id, result: { ok: true, list: [], saved: [], failed: [] } }],
      });
    }
    eq((await p).ok, true, `${ch} 的回复透传`);
  }
}

console.log("\n6. 界面适配（藏按钮 / 去掉 accept）");
{
  const HIDDEN = ["reveal", "rec-dir", "rec-reset", "exp-dir", "pick-dir"];
  for (const id of HIDDEN) {
    const n = dom.nodes.get(id);
    ok(n && n.style.display === "none", `#${id} 被藏起来了`,
       n ? `display=${n.style.display}` : "gui.html 里没有这个 id");
  }
  // 藏起来而不是删掉：gui.html 还会给它们挂事件、读它们的值
  for (const id of HIDDEN) ok(dom.nodes.has(id), `#${id} 还在（只是隐藏，没被删）`);

  const keep = ["pick-files", "file-input", "exp-target"];
  for (const id of keep) ok(dom.nodes.has(id), `#${id} 在 gui.html 里存在（垫片盯着它的 id）`);

  eq(dom.nodes.get("file-input").attrs.accept, undefined,
     "file-input 的 accept 被去掉了（安卓认不出 .yrp3d 会让选择器空掉）");
  ok(/应用内部/.test(dom.nodes.get("exp-target").textContent || ""), "导出目标的文案改了");

  /* 上面每一条都依赖「id 真的在 gui.html 里」。id 不存在时垫片是**静默**
   * 什么都不做的（藏不掉而已，不该打断用户），所以必须在这里红一次。 */
  ok(guiIds.length > 50, `从 index.html 里抠到 ${guiIds.length} 个 id（抠法没坏）`);
}

console.log("\n7. 没有 Node 插件时不能把界面卡死");
{
  const s2 = makeSandbox({});
  const r = await s2.yrp.invoke("state:get", {});
  ok(r && r.ok === false, "invoke 立刻回一个 ok:false");
  ok(/Node 运行时/.test(r.error || ""), "而不是让界面的 Promise 永远挂着");
  ok(typeof s2.yrp.on("yrp:event", () => {}) === "function", "on() 在这个情况下也照样同步返回函数");
}

/* ------------------------------------------------------------------ *
 * 8. 前台服务：观战期间不能被系统冻住
 *
 * 安卓把 Node 跑在后台线程上，那**不是**前台服务 —— 息屏或切后台之后系统
 * 照样会冻结甚至杀掉它。观战是长时间挂机，被杀的表现是「录到一半断了而且
 * 毫无提示」。这一节验的是那条常驻通知真的会跟着观战起停。
 *
 * 起停由 proc 事件驱动（唯一真相），所以这里也是喂 proc 事件来验证，
 * 而不是直接调内部函数 —— 后者改了也没人知道接线断了。
 * ------------------------------------------------------------------ */
console.log("\n8. 前台服务跟着 proc 事件起停");
{
  const fgs = { started: [], channels: [], stopped: 0, perm: "granted" };
  const y = makeSandbox({
    Nodejs: fakeNodejs, // 复用同一个假桥，这样 listeners.message 能被覆盖
    ForegroundService: {
      checkPermissions: async () => ({ display: fgs.perm }),
      requestPermissions: async () => ({ display: fgs.perm }),
      createNotificationChannel: async (o) => {
        fgs.channels.push(o);
      },
      startForegroundService: async (o) => {
        fgs.started.push(o);
      },
      stopForegroundService: async () => {
        fgs.stopped++;
      },
    },
  }).yrp;
  await wait(10);

  // 造一个「Node 侧推上来一条事件」的入口。用 addListener 注册的那个回调，
  // 所以走的是真路径（onMessage -> syncKeepAlive -> emit）。
  const fire = (ev) => listeners.message({ eventName: "event", args: [ev] });

  const seen = [];
  y.on("yrp:event", (ev) => seen.push(ev));

  fire({ t: "log", kind: "info", text: "无关事件" });
  await wait(10);
  eq(fgs.started.length, 0, "普通日志**不会**起服务");

  // 代理模式的 proc 事件也不该起 —— 安卓上根本不跑代理
  fire({ t: "proc", mode: "proxy", running: true });
  await wait(10);
  eq(fgs.started.length, 0, "proxy 模式的 proc 事件不会起服务");

  fire({ t: "proc", mode: "observer", running: true });
  await wait(30);
  eq(fgs.started.length, 1, "开始观战 -> 起了前台服务");
  eq(fgs.channels.length, 1, "先建了通知频道");

  const o = fgs.started[0];
  eq(o.id, 1, "通知 id 固定");
  eq(o.smallIcon, "ic_stat_yrp", "用的是自己那个单色小图标");
  /* ⚠️ 这两条 2026-09-26 反过来了。
   * 原来钉的是 `silent===true` + `importance===2`，理由写的是「常驻通知不该
   * 打扰人」—— 断言本身没错，错的是它把一个**用户看不见的通知**当成了正确
   * 行为，于是谁也不知道录制中状态栏什么都没有。
   * 用户真机实测：Low + silent 会被归进「静默通知」，不显示、不报错。
   * 现在钉反面，并且**必须**同时钉 importance —— 光改 silent 不够，
   * 因为悬浮横幅只由 importance 决定。 */
  eq(o.silent, false, "不是静默（silent 映射的是 setOnlyAlertOnce）");
  const ch = fgs.channels[0];
  eq(ch.importance, 4, "频道是 Importance.High —— Low/Default 都出不来悬浮横幅");
  eq(ch.id, "yrp_observer_v2", "换了新频道 id（importance 建完改不了，复用老 id 等于没改）");
  eq(o.serviceType, 1073741824, "类型是 specialUse（1073741824）");
  ok(
    /正在录制/.test(o.title || "") && /中断|停/.test(o.body || ""),
    `通知标题/正文是人话（${o.title} / ${o.body}）`
  );
  eq(seen.length, 3, "三条事件照样转给了界面（起服务没把事件吞掉）");

  // **幂等**：在录的时候又来了一个 running:true（比如 api.js 重发），
  // 不能重复起，否则会有两条通知
  fire({ t: "proc", mode: "observer", running: true });
  await wait(30);
  eq(fgs.started.length, 1, "重复的 running:true 不会起第二次");

  fire({ t: "proc", mode: "observer", running: false });
  await wait(30);
  eq(fgs.stopped, 1, "停止观战 -> 收掉前台服务");

  // 停了之后再收到 running:false 不能重复调
  fire({ t: "proc", mode: "observer", running: false });
  await wait(30);
  eq(fgs.stopped, 1, "重复的 running:false 不会重复收");

  // 再起一次要能起来（用户重新开始观战）
  fire({ t: "proc", mode: "observer", running: true });
  await wait(30);
  eq(fgs.started.length, 2, "停了之后还能再起");
  fire({ t: "proc", mode: "observer", running: false });
  await wait(30);

  /* 通知权限被拒**不能**影响观战 —— 用户点了个「不允许」，录像还得照录，
   * 只是状态栏没那条通知。把这条钉住，是因为「请求权限失败就中断」是很
   * 容易顺手写出来的逻辑，而它的后果是用户完全无法理解为什么录不了。 */
  fgs.perm = "denied";
  fgs.started.length = 0;
  fire({ t: "proc", mode: "observer", running: true });
  await wait(40);
  eq(fgs.started.length, 1, "通知权限被拒，前台服务照样起");
  fire({ t: "proc", mode: "observer", running: false });
  await wait(30);
}

/* 上面那一节验的是「逻辑对不对」，但垫片里那个图标名 `ic_stat_yrp` 和
 * manifest 里的 specialUse 都是**字符串契约**：写错了 JS 这边全绿，
 * 手机上却是通知不显示 / startForeground 抛异常。所以拿源码对一遍。
 * 这几条不依赖安卓构建，改坏了立刻就红。 */
console.log("\n9. 垫片和原生侧的字符串契约");
{
  const read = (p) => {
    try {
      return fs.readFileSync(path.join(HERE, p), "utf8");
    } catch (_) {
      return null;
    }
  };

  const icon = read("android/app/src/main/res/drawable/ic_stat_yrp.xml");
  ok(icon !== null, "res/drawable/ic_stat_yrp.xml 存在（垫片里小图标写的就是这个名字）");
  if (icon) {
    // 注释里会提到 ic_launcher（解释为什么不能用它），所以先剥掉注释再查引用，
    // 否则这条断言查的是自己写的说明文字
    const body = icon.replace(/<!--[\s\S]*?-->/g, "");
    ok(/<vector/.test(body), "是个 vector（不是位图，位图取 alpha 会糊）");
    ok(!/@(mipmap|drawable)\/ic_launcher/.test(body), "没引用 ic_launcher（自适应图标取 alpha 会成白块）");
    ok(/android:fillColor="#FFFFFFFF"/.test(body), "画的是白色（状态栏小图标只取 alpha）");
  }

  const mf = read("android/app/src/main/AndroidManifest.xml");
  ok(mf !== null, "AndroidManifest.xml 读得到");
  if (mf) {
    const wants = [
      ["FOREGROUND_SERVICE_SPECIAL_USE", /android:name="android\.permission\.FOREGROUND_SERVICE_SPECIAL_USE"/],
      ["FOREGROUND_SERVICE", /android:name="android\.permission\.FOREGROUND_SERVICE"/],
      ["WAKE_LOCK", /android:name="android\.permission\.WAKE_LOCK"/],
      ["POST_NOTIFICATIONS", /android:name="android\.permission\.POST_NOTIFICATIONS"/],
      [
        "service 声明",
        /<service[\s\S]*?AndroidForegroundService[\s\S]*?foregroundServiceType="specialUse"/,
      ],
      ["receiver 声明", /<receiver[\s\S]*?NotificationActionBroadcastReceiver/],
      [
        "PROPERTY_SPECIAL_USE_FGS_SUBTYPE",
        /android:name="android\.app\.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"[\s\S]*?android:value="[^"]{8,}"/,
      ],
    ];
    for (const [what, re] of wants) ok(re.test(mf), `manifest 里有 ${what}`);

    // property 得待在 <service> 里面，跑到 </service> 外面就不生效了
    const svc = mf.match(/<service[\s\S]*?<\/service>/);
    ok(svc !== null && /PROPERTY_SPECIAL_USE_FGS_SUBTYPE/.test(svc[0]),
       "那个 property 在 <service> 标签**内部**");
  }

  // 垫片里写的那个数字必须真是 specialUse。写错的话 Java 侧会拿它当别的类型，
  // 表现是 startForeground 抛 SecurityException 而 manifest 看着完全正常。
  ok(/FGS_TYPE_SPECIAL_USE = 1073741824/.test(SHIM_SRC), "垫片里的 specialUse 常量还是 1073741824");
}

/* ------------------------------------------------------------------ *
 * 10. 拖放区在安卓上改成纯点击
 *
 * 用户原话：「手机端没有拖动文件上传功能，只需要点击上传即可」。
 * 安卓 WebView 没有拖放，而 gui.html 那块虚线框写着「拖到这里 —— 也可以
 * [选择文件…]」，用户看着它就会去点，点了没反应。
 *
 * 改法必须走**搬家**（把已有节点搬进 #drop）而不是新建按钮 —— 新建的话
 * gui.html 绑在 #pick-files 上的处理器留在那个已经不在页面上的旧节点上，
 * 表现是「按钮在，点了没反应」，比报错还难查。
 * ------------------------------------------------------------------ */
console.log("\n10. 拖放区改成纯点击（安卓没有拖放）");
{
  const drop = dom.nodes.get("drop");
  ok(drop !== null, "#drop 在（垫片找不到它就是整个功能静默不生效）");
  const text = (drop.children || []).map((c) => c.textContent || "").join(" ");
  ok(!/拖/.test(text), "文案里不再有「拖」字", `实际是「${text}」`);
  ok(/点/.test(text), "明说了要点哪里", `实际是「${text}」`);

  /* ⚠️ 这**一整段**是一个不变式，不是三条独立断言 —— 2026-09-26 补的。
   *
   * 原来这里钉的是「#pick-dir 没搬进来」，我把它当成正确行为写进了测试。
   * 实际那句 replaceChildren(hint, pick-files, pick-clear-local) 漏了
   * #pick-dir，等于把它**从 DOM 里删了**。测试不但没拦住，反而把这个 bug
   * 钉成了「预期」—— 这是「断言写反了比没有断言更糟」的实例。
   *
   * 真正该钉的是：**#drop 里凡是带 id 的元素，重画之后一个都不能少。**
   * 少了不是「少个按钮」，而是 gui.html 里 $("x") 返回 null、下一行
   * `.onclick =` 抛 TypeError，而它和 init() 同一个 <script> —— 后面全部
   * 不执行，表现是整个界面半死。 */
  {
    /* 拿 gui.html 真正引用过的 id 当标准，而不是手写清单。
       手写清单就是刚才漏掉 #pick-dir 的原因。 */
    const referenced = new Set(
      [...GUI_SRC.matchAll(/(?:\$|getElementById)\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1])
    );
    const inDrop = new Set(["pick-files", "pick-dir", "pick-clear-local"]);
    const want = [...inDrop].filter((id) => referenced.has(id));
    ok(want.length === 3, `gui.html 确实引用过这三个按钮（实际 ${want.join(", ")}）`);
    for (const id of want) {
      const n = dom.nodes.get(id);
      ok(n && n.parent === drop,
        `#${id} 重画之后**还在 #drop 里**（不在就是被 replaceChildren 删了）`);
    }
    // 装饰内容必须真的被清掉，否则「清干净了」这条是假的
    const txt = drop.children.map((c) => c.textContent || "").join("");
    ok(!/拖/.test(txt), "原来那段「拖到这里」没了", `实际：「${txt}」`);
    ok(!/文件夹/.test(txt), "「整个文件夹」也没了（安卓上 webkitdirectory 不工作）");
  }

  const pick = dom.nodes.get("pick-files");
  ok(drop.children.includes(pick), "#pick-files 还是原来那个节点对象（事件处理器跟着走）");
  const clear = dom.nodes.get("pick-clear-local");
  ok(drop.children.includes(clear), "#pick-clear-local 也留着（清空本机文件的唯一入口）");
  ok(/点这里选择/.test(drop.children[0].textContent || ""),
    "第一行是新提示（不是原来那段文字）", `实际：「${drop.children[0].textContent}」`);

  const fi = dom.nodes.get("file-input");
  ok(fi !== null, "#file-input 在（整块点击最后点的是它）");

  let before = fi.clicks;
  drop.dispatch("click", drop);
  eq(fi.clicks - before, 1, "点 #drop 的空白处 -> 弹出文件选择器");

  // 点里面的按钮不能弹两次 —— 那个按钮自己就会开选择器，不拦就是两份
  before = fi.clicks;
  pick.dispatch("click", pick);
  eq(fi.clicks - before, 1, "点里面的「选择文件…」只弹一次（不是两次）");

  const c0 = clear.cleared || 0;
  clear.dispatch("click", clear);
  eq((clear.cleared || 0) - c0, 1, "搬家之后 gui.html 绑在 #pick-clear-local 上的处理器照样触发");
}

/* ------------------------------------------------------------------ *
 * 11. Node 起得慢：失败不留缓存、监听不重复挂
 *
 * 这两条对应真机上踩到的一个 bug：安卓冷启动要加载 54 MB 的 libnode.so，
 * 慢的时候超过旧实现的 20 秒上限，而**那次失败被永久缓存了** —— 此后每一次
 * invoke 都直接失败，哪怕 Node 下一秒就起来了。第一次 invoke 恰好是
 * config:get，于是界面上的表现是「配置读不出来、三个输入框全是空的」，
 * 而且看着像界面是好的（按钮绑定在 init() 外面），极难往超时上想。
 * ------------------------------------------------------------------ */
console.log("\n11. Node 起得慢也不能把整个会话判死刑");
{
  const slow = { probes: 0, msgListeners: 0 };
  const ids = [];
  const bridge = {
    send: async (o) => {
      const id = o.args[0].id;
      ids.push(id);
      // 立刻回一条，证明「等到之后」这条路是通的
      listeners.message({ eventName: "reply", args: [{ id, result: { ok: true, late: true } }] });
    },
    addListener: async (ev, fn) => {
      if (ev === "message") slow.msgListeners++;
      listeners[ev] = fn;
    },
    // 头两次探都说「还没好」—— 模拟 libnode.so 还在加载
    isReady: async () => ({ ready: ++slow.probes > 2 }),
  };
  const y = makeSandbox({ Nodejs: bridge }).yrp;

  const r = await y.invoke("config:get", {});
  ok(r && r.ok === true && r.late === true,
     "探了 3 次才起来，invoke 仍然成功（失败没有被缓存）");
  ok(slow.probes >= 3, `确实重探了（共 ${slow.probes} 次）—— 上面那条不是碰巧过的`);

  const after = slow.probes;
  const r2 = await y.invoke("recordings:list", {});
  ok(r2 && r2.ok === true, "起来之后的第二次 invoke 正常");
  eq(slow.probes, after, "成功那次被缓存了：再 invoke 不会重新探");
  eq(ids.length, 2, "两次 invoke 都真的发到了 Node 侧");

  /* 监听器只许挂一份。**这条必须查源码形状**：重挂的时机是「ready 超时之后
     重试」，而超时是 60 秒，测试里等不起。旧写法把 addListener 放在
     ensureReady 里面，于是重试一次就挂成两份 —— 表现是每条日志在界面上
     出现两次、每个事件被分发两次，而不是任何形式的报错。 */
  const body = SHIM_SRC.match(/function ensureReady\(\)\s*\{[\s\S]*?\n  \}/);
  ok(body !== null, "抠得到 ensureReady 的函数体");
  ok(body !== null && !/addListener/.test(body[0]),
     "ensureReady 里没有 addListener（重试不会把监听挂成两份）");
  ok(/const listening = Nodejs/.test(SHIM_SRC),
     "消息监听是模块加载时挂一次（const listening，不在可重试的那部分里）");
  ok(/ready = null;/.test(SHIM_SRC),
     "失败路径把 ready 置空，让下一次调用重新探 —— 这就是「不缓存失败」本身");
  ok(/READY_TIMEOUT_MS = 60000/.test(SHIM_SRC),
     "超时是 60 秒（20 秒对 54 MB 的 libnode.so 太紧）");
  ok(/await Nodejs\.isReady\(\)/.test(SHIM_SRC),
     "用轮询 isReady() 而不是监听 ready 事件（事件可能在挂监听之前就发过了）");
}

console.log(fail ? `\nFAILED (${fail})` : "\n全部通过");
process.exit(fail ? 1 : 0);
