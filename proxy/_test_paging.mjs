// 录像列表分页的测试。
//
//   node proxy/_test_paging.mjs
//
// 分页是纯前端的（后端不加 limit/offset，见 gui.html 里 PER_PAGE 上面的说明），
// 所以这里没有服务器、没有 Electron、没有 DOM —— 从 gui.html 里把 pageMeta()
// 抠出来直接跑。和 _test_parser.mjs 抠哨兵块是同一个套路。
//
// 为什么值得单测：pageMeta 是这段功能里**唯一有分支的东西**，而且它的输入是
// 「会随时间变的录像数量」和「一个可能停在任何地方的页码」。越界的组合不测就
// 只有用户能发现 —— 表现是列表空白但 #n-rec 还在说「有 25 个」。
//
// 另外钉住一份**跨文件的一致性**：electron 版和主分支（yrp-tools/）的
// gui.html 里各有一份 pageMeta，是拷过去改的，**没有共同来源**，全靠人同步。
// 飘了不会报错，只会让两个版本翻页翻得不一样。和 _test_api.mjs 里
// 「三份 DEFAULTS 必须一致」是同一种病。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const ELECTRON_GUI = path.join(HERE, "gui.html");
// 主分支：命令行那套（yrp-tools/），2026-09-26 按要求一起加了分页。
// 它**没有**退出按钮那件事是另一码事，和这里无关。
const MAIN_GUI = path.join(REPO, "yrp-tools", "proxy", "gui.html");

let failed = 0;
function ok(cond, what, extra) {
  if (cond) console.log(`  ok   ${what}`);
  else {
    failed++;
    console.log(`  FAIL ${what}${extra ? `\n       ${extra}` : ""}`);
  }
}
const log = (s) => console.log(`\n${s}`);
/** 短路用：这个文件真的读不出来就别往下跑，后面全是假失败 */
const die = (msg) => {
  console.log(`\n${msg}`);
  process.exit(1);
};

/* ------------------------------------------------------------------ *
 * 抠函数。用**函数的整个定义**当提取单位（从签名到顶格的收尾大括号），
 * 不靠行号 —— 行号会随任何一次编辑漂移，那样测试就变成了「记得改测试」。
 * ------------------------------------------------------------------ */
function grab(src, name, args) {
  const re = new RegExp(`function ${name}\\(${args}\\)\\{[\\s\\S]*?\\n\\}`);
  const m = src.match(re);
  if (!m) return null;
  return m[0];
}
/** 函数表达式立即可调用。抠出来的是 `function f(){...}`，加括号变成表达式 */
function compile(text) {
  return new Function(`return (${text})`)();
}

/* 查「代码里还有没有某个东西」之前**必须先把注释去掉**。
 * 这个坑真踩过两次：一次是注释里提了 ic_launcher，结果「不许引用 ic_launcher」
 * 误报；另一次就是下面那条 $("quit") —— 它出现在一段**解释为什么要删它**的
 * 注释里，于是「删干净了没有」永远报错。
 * 三行只处理本文里出现的注释形式，不追求通用。 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, "") // HTML 注释
    .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释
    .replace(/^[ \t]*\/\/.*$/gm, ""); // 整行注释
}

if (!fs.existsSync(ELECTRON_GUI)) die(`找不到 ${ELECTRON_GUI}`);
const electronSrc = fs.readFileSync(ELECTRON_GUI, "utf8");
// 结构性断言全部对着**去注释版**跑，原因见 stripComments 上面那段
const electronCode = stripComments(electronSrc);

log("1. 抠得出 pageMeta");
const electronFn = grab(electronSrc, "pageMeta", "total, page, per");
ok(electronFn !== null, "electron 版 gui.html 里有 pageMeta");
if (!electronFn) die("抠不到函数，后面的断言没有意义 —— 先看是不是签名改了");

let pageMeta;
try {
  pageMeta = compile(electronFn);
  ok(typeof pageMeta === "function", "抠出来的那段能跑");
} catch (e) {
  die(`抠出来的那段跑不了：${e.message}`);
}

/* ------------------------------------------------------------------ *
 * 2. 边界
 * ------------------------------------------------------------------ */
log("2. pageMeta 的边界");
const per = 10;
/** 一条断言把整个返回值比一遍 —— 漏比一个字段就是漏一个 bug 面 */
function same(total, page, want, label) {
  const got = pageMeta(total, page, per);
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  ok(g === w, label, g === w ? "" : `得到 ${g}，期望 ${w}`);
}

// 空列表：pages 必须是 1 而不是 0，否则「一页以上才显示」那个判断会翻车
same(0, 1, { page: 1, pages: 1, from: 0, to: 0 }, "空列表：1 页，切出来是空的");

// 正好装满一页 —— 这条最容易写出 pages = 2 的 off-by-one
same(10, 1, { page: 1, pages: 1, from: 0, to: 10 }, "正好一页：不产生第 2 页");
same(11, 1, { page: 1, pages: 2, from: 0, to: 10 }, "多一条：第 1 页，共 2 页");
same(11, 2, { page: 2, pages: 2, from: 10, to: 11 }, "最后一页只有半页");

// 用户报的那个场景：数据多到要翻好几页
same(100, 7, { page: 7, pages: 10, from: 60, to: 70 }, "100 条第 7 页");
same(25, 3, { page: 3, pages: 3, from: 20, to: 25 }, "25 条的末页只剩 5 条");

/* 越界。**夹到末页而不是跳回第 1 页** —— 删掉的通常是旧文件，
   删完停在原地继续看比被弹回开头舒服。这条改掉了要同步改注释。 */
same(11, 99, { page: 2, pages: 2, from: 10, to: 11 }, "页码超过末页：夹到末页");
same(11, 3, { page: 2, pages: 2, from: 10, to: 11 }, "只多一页也夹到末页");

/* 页码是垃圾值。这些**真的会发生**：S.page -= 1 连点两次「上一页」
   就能减到 0，而 pageMeta 的返回值会被写回 S.page（renderRecs 里那句
   `S.page = m.page`），所以夹取是这套东西唯一的安全网。 */
same(11, 0, { page: 1, pages: 2, from: 0, to: 10 }, "页码 0：当第 1 页（连点「上一页」会到这）");
same(11, -5, { page: 1, pages: 2, from: 0, to: 10 }, "页码是负数");
same(11, null, { page: 1, pages: 2, from: 0, to: 10 }, "页码是 null");
same(11, undefined, { page: 1, pages: 2, from: 0, to: 10 }, "页码是 undefined");
same(11, NaN, { page: 1, pages: 2, from: 0, to: 10 }, "页码是 NaN");
same(11, "3", { page: 2, pages: 2, from: 10, to: 11 }, "页码是字符串（input 里读出来就是字符串）");
same(11, 2.9, { page: 2, pages: 2, from: 10, to: 11 }, "页码是小数：向下取整");

/* 一段「连续翻页」的模拟 —— 单点断言全对但拼起来错是常见的，
   比如 from/to 用了旧页码。这里就把「翻完一圈」整体跑一遍。 */
{
  const total = 25;
  const seen = [];
  for (let p = 1; p <= 4; p++) {
    const m = pageMeta(total, p, per);
    seen.push(`${m.page}:${m.from}-${m.to}`);
  }
  ok(
    seen.join(" ") === "1:0-10 2:10-20 3:20-25 3:20-25",
    "连续翻页覆盖 0-25 且不重不漏，越界那次停在末页",
    seen.join(" ")
  );
  // 每一页的区间必须首尾相接：上一条证明了「这个总数下对」，这条证明
  // 「换任何总数都对」—— 25 是个巧合的话不会在这里露馅，下面会
  for (const n of [0, 1, 9, 10, 11, 19, 20, 21, 100, 137]) {
    const pages = pageMeta(n, 1, per).pages;
    let covered = 0;
    let contiguous = true;
    let prevTo = 0;
    for (let p = 1; p <= pages; p++) {
      const m = pageMeta(n, p, per);
      if (m.from !== prevTo) contiguous = false;
      if (m.to !== Math.min(m.from + per, n)) contiguous = false;
      prevTo = m.to;
      covered += m.to - m.from;
    }
    ok(contiguous && covered === n, `总数 ${n}：${pages} 页首尾相接且正好覆盖 ${n} 条`);
  }
}

/* ------------------------------------------------------------------ *
 * 3. 每页多少条
 * ------------------------------------------------------------------ */
log("3. 每页 10 条");
{
  const m = electronSrc.match(/const PER_PAGE = (\d+);/);
  ok(m !== null, "gui.html 里有 PER_PAGE");
  ok(m && Number(m[1]) === 10, "默认每页 10 条（用户要求的）", m ? `实际 ${m[1]}` : "");
}

/* ------------------------------------------------------------------ *
 * 4. renderRecs 真的只画当前页
 *
 * 光有 pageMeta 而 renderRecs 忘了用它，界面表现**完全一样**（全画出来了）。
 * 所以这条得单独钉：不仅要有切片，而且要切在正确的循环上。
 * ------------------------------------------------------------------ */
log("4. renderRecs 用了它");
{
  ok(/const m = pageMeta\(rows\.length, S\.page, PER_PAGE\);/.test(electronCode),
    "renderRecs 里拿 rows 总数和 S.page 算了一次");
  ok(/S\.page = m\.page;/.test(electronCode),
    "把夹过的页码写回 S.page（不写回的话控件显示第 7 页而画的是第 3 页）");
  ok(/for \(const r of rows\.slice\(m\.from, m\.to\)\)\{/.test(electronCode),
    "行循环切到了这一页的区间上");
  // rows.length 是**总数**（rows 装着全部行，切页只是在渲染时 slice），所以
  // 「不是本页条数」这条性质没变。它也不能退回到 S.srv.length + S.local.size ——
  // 导入的录像在磁盘上有一份孪生，被 renderRecs 藏掉了，两边各算一次就重复计数。
  ok(/"n-rec"\)\.textContent = rows\.length;/.test(electronCode),
    "#n-rec 仍然是**总数**（不是本页条数 —— 否则会让人以为录像丢了）");
  ok(!/"n-rec"\)\.textContent = S\.srv\.length \+ S\.local\.size/.test(electronCode),
    "不是被藏起来的磁盘副本重复计一次的老写法");
  ok(/updatePager\(m\);/.test(electronCode), "每轮渲染都刷一次页码控件");
}

/* 自动跟随：录制中会自动选中最新的那个。分页之后它在第 1 页，
   不翻回去就是「选中了一个当前页看不见的东西」。 */
log("5. 自动跟随会翻回第 1 页");
{
  // 条件里盯的是 `first`（第一条**看得见**的服务器录像），不是 r.list[0] ——
  // 录制进行中导入一个录像时，刚写进去的副本 mtime 最新会排到 list[0]，而它
  // 正好是被藏掉的那条，用 list[0] 会「自动选中」一条用户根本看不见的条目。
  const m = electronCode.match(
    /if \(r\.anyRunning && first && S\.sel !== top\)\{[\s\S]*?\n  \}\n\}/
  );
  ok(m !== null, "找得到自动跟随那一段");
  if (m) {
    const seg = m[0];
    ok(/S\.page = 1;/.test(seg), "跟着最新那个走之前先把页码翻回第 1 页");
    // 顺序有讲究：markSelected() 是扫**已经画出来的** .rec 打高亮的
    ok(seg.indexOf("renderRecs();") < seg.indexOf("select(top, true);"),
      "先 renderRecs 再 select —— 反了的话选中了却没有一行是亮的");
    ok(/S\.sel !== top/.test(seg),
      "仍然有「已经跟上了就别再动」的守卫（否则每 2 秒把正在翻旧录像的人拽回第 1 页）");
  }
}

/* ------------------------------------------------------------------ *
 * 6. 主分支那份必须逐字相同
 *
 * 两份是拷过去改的，没有共同来源。飘了不报错，只让两个版本翻页翻得不一样。
 * 而且**只比 pageMeta 的函数体**，不比周围注释 —— 主分支的注释本来就
 * 和 electron 版不同（那边写给命令行用户看），比注释是自找麻烦。
 * ------------------------------------------------------------------ */
log("6. 主分支（yrp-tools/）的那份和 electron 版逐字相同");
if (!fs.existsSync(MAIN_GUI)) {
  console.log(`   （跳过：${MAIN_GUI} 不在）`);
} else {
  const mainSrc = fs.readFileSync(MAIN_GUI, "utf8");
  const mainCode = stripComments(mainSrc);
  const mainFn = grab(mainSrc, "pageMeta", "total, page, per");
  ok(mainFn !== null, "主分支里也有 pageMeta");
  if (mainFn) {
    ok(
      mainFn === electronFn,
      "两份 pageMeta 的函数体逐字相同",
      mainFn === electronFn ? "" : `主分支那份是：\n${mainFn}`
    );
  }
  // 主分支也要真用上它，不然「加了分页」只是句空话
  ok(/rows\.slice\(m\.from, m\.to\)/.test(mainCode), "主分支的 renderRecs 也切了页");
  const fp = mainCode.match(/const PER_PAGE = (\d+);/);
  ok(fp !== null && Number(fp[1]) === 10, "主分支也是每页 10 条");
  /* 主分支的「退出界面」按钮**必须留着**：那一版是 START.vbs 拉起来的
     无窗口常驻服务，「隐藏启动之后没有窗口可关，退出只能从这儿点」。
     这条是反面断言 —— 别顺手把它也删了。 */
  ok(/id="quit"/.test(mainCode), "主分支的「退出界面」按钮还在（它是那一版唯一的退出路径）");
}

/* 反过来：electron 版**必须没有** #quit —— 安卓共用这个文件，
   而安卓上点它会崩。 */
log("7. electron 版没有「退出界面」按钮");
{
  ok(!/id="quit"/.test(electronCode), "HTML 里没有 #quit");
  ok(!/\$\("quit"\)/.test(electronCode),
    "也没有 $(\"quit\") 的残留 —— 只删 HTML 的话这个 .onclick= 会抛 TypeError，整个界面白屏");
}

/* ------------------------------------------------------------------ *
 * 8. 三份 HTML 都得有分页控件
 *
 * android 的 www/index.html 是 build-web.mjs 从 electron 版拷出来的，
 * 这里只查它存在且带控件 —— 「逐字节相同」是 _test_shared_sync.mjs 的事。
 * ------------------------------------------------------------------ */
log("8. 三份界面文件都有分页控件");
{
  const targets = [
    ["electron", ELECTRON_GUI],
    ["主分支", MAIN_GUI],
    ["安卓", path.join(REPO, "yrp-tools-android", "www", "index.html")],
  ];
  for (const [label, p] of targets) {
    if (!fs.existsSync(p)) {
      ok(false, `${label}：找得到 ${path.relative(REPO, p)}`);
      continue;
    }
    const src = fs.readFileSync(p, "utf8");
    const ids = ["pager", "pg-prev", "pg-info", "pg-next"].filter(
      (id) => !src.includes(`id="${id}"`)
    );
    ok(ids.length === 0, `${label}：分页控件齐全`, ids.length ? `缺 ${ids.join(", ")}` : "");

    /* updatePager 是靠 .hidden 藏那一行的，而 .hidden 是 gui.html 自己的
       class 规则（不是浏览器内置的）—— 少了它分页条会永远显示在屏幕上。 */
    ok(/\.hidden\s*\{\s*display\s*:\s*none/.test(src), `${label}：.hidden 的 CSS 规则在`);

    /* 整页的内联脚本要能**解析**。上面那些都是正则匹配 —— 少个括号照样全绿，
       而真机上的表现是整个界面白屏（这段脚本和 init() 是同一个 <script>）。
       我这次改的就是这段脚本，所以值得在这儿钉一次。 */
    const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    ok(scripts.length > 0, `${label}：找得到内联脚本`);
    if (scripts.length) {
      const code = scripts[scripts.length - 1][1];
      let err = null;
      try {
        new Function(code);
      } catch (e) {
        err = e.message;
      }
      ok(err === null, `${label}：内联脚本能解析（${code.split("\n").length} 行）`, err || "");
    }
  }
}

/* ------------------------------------------------------------------ *
 * 9. 脚本里 $("x") 引用的每个 id，HTML 里都得真有
 *
 * 这是上面那些「分页控件齐全」的正经版本。id 对不上的后果不是「少个功能」，
 * 而是 `$("pager").classList` 直接在 renderRecs 里抛 TypeError —— 录像**列表
 * 整个画不出来**，而且异常发生在每 2 秒的轮询里，控制台刷屏、界面一片空。
 * 我这次加的代码里 $() 全是字面量字符串，所以这条能整页扫，不用挑函数。
 *
 * 顺带也覆盖了「删掉 #quit 却留下绑定」那个坑 —— 一条通则管两类 bug。
 * ------------------------------------------------------------------ */
log("9. 脚本引用的 id 在 HTML 里都存在");
{
  for (const [label, p] of [
    ["electron", ELECTRON_GUI],
    ["主分支", MAIN_GUI],
    ["安卓", path.join(REPO, "yrp-tools-android", "www", "index.html")],
  ]) {
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, "utf8");
    const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    // 同样要先去注释：`$("quit")` 正出现在一段**解释为什么删掉它**的注释里，
    // 不去的话这条断言查的是我自己写的说明文字（这已经是第三次踩了）
    const code = scripts.length ? stripComments(scripts[scripts.length - 1][1]) : "";

    // $("x") 和 getElementById("x") 两种写法都算
    const used = new Set();
    for (const m of code.matchAll(/(?:\$|getElementById)\(\s*"([^"]+)"\s*\)/g)) used.add(m[1]);
    ok(used.size > 20, `${label}：扫到 ${used.size} 个 $() 引用（抠法没坏）`);

    const defined = new Set([...src.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const orphan = [...used].filter((id) => !defined.has(id));
    ok(
      orphan.length === 0,
      `${label}：${used.size} 个引用全都有对应的元素`,
      orphan.length ? `这些 id 在 HTML 里不存在：${orphan.join(", ")}` : ""
    );
  }
}

/* ------------------------------------------------------------------ *
 * 10. 选文件的处理器必须**先把 FileList 拷成数组，再清 value**
 *
 * 这是用户真机上报的「选完文件完全没反应」的根因。2026-09-26 用 CDP 挂在
 * 手机里那个正在跑的 WebView 上直接量出来的：
 *
 *   el.files = <2 个文件>;
 *   const fs = el.files;   // 此时 length 是 2
 *   el.value = "";         // ← 同一个 FileList 被清空
 *   fs.length;             // 0
 *
 * 原来的写法就是这个顺序，于是 addLocalFiles 收到空列表；而它那句
 * 「这些文件里没有 .yrp3d 录像」带着 `if (files.length)` 守卫，files.length
 * 也是 0 —— **连横幅都不弹**，看起来就是点了完全没反应。
 *
 * 桌面版一直靠拖放（走 dataTransfer 那条分支），所以这行代码在桌面上从没被
 * 走到过；手机上没有拖放，点击是唯一的选文件方式，必然撞上。
 *
 * ⚠️ 这里的假 DOM **是照着浏览器语义实现的**（files 每次 get 返回同一个数组，
 * value 的 setter 把它清空）。写成「files 每次返回一份新拷贝」的话，
 * 这条测试就会永远绿 —— 那正是这个 bug 能活到现在的原因。
 * ------------------------------------------------------------------ */
log("10. 选文件：先把 FileList 拷成数组，再清 value");
{
  /** 假 input：files 返回**同一个**数组（浏览器就是这样，早先抓到手里的
   *  那个引用会被一起清空），value 的 setter 清空它。 */
  function makeInput(names) {
    const fileList = [...names];
    return {
      el: {
        get files() {
          return fileList;
        },
        set value(_) {
          fileList.length = 0;
        },
      },
      fileList,
    };
  }

  /** 把 `$("id").onchange = (e) => {...};` 整段抠出来（含收尾大括号） */
  function grabHandler(src, id) {
    const m = src.match(
      new RegExp(`\\$\\("${id}"\\)\\.onchange = (\\(e\\) => \\{[\\s\\S]*?\\n\\};)`)
    );
    return m ? m[1] : null;
  }

  /** 真跑一遍，记下 addLocalFiles 收到几个文件、以及 value 有没有被清掉 */
  function run(src, id) {
    const handlerSrc = grabHandler(src, id);
    if (!handlerSrc) return null;
    const { el, fileList } = makeInput(["a.yrp3d", "b.yrp3d"]);
    let received = null;
    const addLocalFiles = (fs) => {
      received = [...fs].map((f) => f.name);
      return Promise.resolve(); // 真实现是 async，处理器后面挂着 .catch
    };
    const fn = new Function("addLocalFiles", "banner", `return ${handlerSrc}`)(
      addLocalFiles,
      () => {}
    );
    fn({ target: el });
    return { received, valueCleared: fileList.length === 0 };
  }

  const guis = [
    ["electron", ELECTRON_GUI],
    ["主分支", MAIN_GUI],
    ["安卓", path.join(REPO, "yrp-tools-android", "www", "index.html")],
  ];

  for (const [label, p] of guis) {
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, "utf8");
    /* 两个输入框都要查：选文件和选文件夹是同一个坑的两份拷贝 */
    for (const [id, what] of [["file-input", "选文件"], ["dir-input", "选文件夹"]]) {
      const r = run(src, id);
      if (!r) {
        ok(false, `${label}：找得到 $("${id}").onchange`);
        continue;
      }
      ok(
        r.received !== null && r.received.length === 2,
        `${label}：${what} —— 两个文件原样交到了 addLocalFiles`,
        r.received === null
          ? "处理器根本没调用 addLocalFiles"
          : `只收到 ${r.received.length} 个（收到 0 个就是 value="" 抢在拷贝前面把 FileList 清了）`
      );
      /* 清 value 这件事本身**不能省**：不清的话同一个文件再选一次不触发 change。
         所以这里钉的是「清得掉」，而不是「别清」。 */
      ok(
        r.valueCleared,
        `${label}：${what} —— value 确实被清掉了（同一个文件才能再选一次）`
      );
      /* 顺序：拷贝（`[...`）必须出现在清 value 之前。
         这条是**故意**盯着实现写法的 —— 上面那条行为断言足以抓到 bug，但它的
         失败信息只说「收到 0 个」；这条直接把「拷成数组这一步没了/挪后了」指出来。
         ⚠️ 别退化成查 `e.target.files` 和 `e.target.value` 谁在前 —— 那个在
         有 bug 的版本里**照样通过**（两句话都还在，错的只是中间少了一次拷贝），
         等于一条永远绿的断言。这条改成查 `[...` 之后，变异测试里会红。 */
      const h = stripComments(grabHandler(src, id) || "");
      const spreadAt = h.indexOf("[...");
      const clearAt = h.indexOf("e.target.value");
      ok(
        spreadAt >= 0 && spreadAt < clearAt,
        `${label}：${what} —— 先把 FileList 拷成数组（[...）再清 value`,
        clearAt < 0
          ? "处理器里找不到清 value 那句"
          : spreadAt < 0
            ? "处理器里没有 [... 这一步拷贝 —— FileList 会被下一句清空"
            : "拷贝出现在清 value 之后，等于没拷"
      );
    }
  }
}

console.log(failed ? `\n${failed} 个失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
