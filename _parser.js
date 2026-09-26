/* ------------------------------------------------------------------ *
 * 共用的解析块加载器
 *
 * chat-extractor.html 是**产品本体**，共享的解析逻辑和导出格式就写在页面里。
 * 测试、proxy/observer 和界面都不想重写一份（那份分类规则——type 7 = 观战者、
 * 9 = 具名观战、>=10 = 服务器——一旦复制就会各自漂移），所以统一从这里把那段
 * 代码抠出来跑。
 *
 * 抠的范围由 chat-extractor.html 里两行哨兵注释划出来：
 *     /* @parser:begin ... /* @parser:end
 * 改那段代码时哨兵不要动，也**不要在这段里引用下面定义的东西**——
 * 它会被整段抠出来单独执行，脱离原页面的作用域。
 *
 * **同一份切片，两种包装**：
 *   - Node（测试 / proxy / observer / gui.js）：new Function(src + return {...})
 *   - 浏览器（proxy/gui.html）：IIFE 挂到 window.YRP_PARSER
 * 浏览器侧必须包起来而不是裸发，理由见 browserSource() 的注释。
 *
 * 用法：
 *   const { loadExtractor } = require("../_parser.js");
 *   const { extract } = loadExtractor();
 *   extract("文件名", fs.readFileSync(p));   // Buffer 直接可以
 * ------------------------------------------------------------------ */
"use strict";

const path = require("path");

const { readShipped } = require("./_shipped.js");

// 这根路径只在**平时**（开发/测试）是真的。打成 exe 之后资源是烘进去的，
// 磁盘上没有这个文件（见 _shipped.js）。它仍然要是一根像样的路径字符串：
// 下面几处报错文案和 module.exports 都在用它。
const HTML = path.join(__dirname, "chat-extractor.html");
const HTML_ASSET = "chat-extractor.html";
const BEGIN = "/* @parser:begin";
const END = "/* @parser:end */";

// 按要导出的名字缓存。界面/代理/观战只要 extract，_test_parser.mjs 还要探内部函数。
const cache = new Map();

// 真正算「发布接口」的只有这两个，其余是给 _test_parser.mjs 探内部行为用的。
const DEFAULT_NAMES = ["extract", "PARSE_FAIL"];

// 浏览器侧需要的全部名字。哨兵块里加了新函数而忘了往这儿加，是这套东西最容易
// 漏的一种错——_test_parser.mjs 会逐个断言它们真的挂到了 window.YRP_PARSER 上。
const BROWSER_NAMES = [
  "extract", "PARSE_FAIL", "isSystem",
  "withBom", "stamp", "withStamp", "exportBaseName",
  "filterChats", "exportGroups",
  "buildMergedTxt", "buildPerFileTxt", "buildJson", "buildCsv",
  "normalizeServer", "gatherSources",
];

let srcCache = null;

/**
 * chat-extractor.html 里哨兵块之间的**裸源码**（含两行哨兵注释本身）。
 *
 * 失败时**必须抛错而不是返回半个东西**：indexOf 返回 -1 时 slice(-1, e) 会切出
 * 一个空串，new Function("") 看着没事，等到真去解析录像才炸，那时完全看不出原因。
 */
function parserSource() {
  if (srcCache != null) return srcCache;

  const html = readShipped(HTML_ASSET);
  const b = html.indexOf(BEGIN);
  const e = html.indexOf(END);

  if (b < 0 || e < 0) {
    const missing = [b < 0 ? BEGIN : null, e < 0 ? END : null].filter(Boolean).join(" 和 ");
    throw new Error(
      `${path.basename(HTML)} 里找不到哨兵 ${missing}。\n` +
        `解析块靠这两行注释定位，改那段代码时别把它们删掉（见 _parser.js 顶部说明）。`
    );
  }
  if (e < b) {
    throw new Error(`${path.basename(HTML)} 里 ${END} 出现在 ${BEGIN} 之前，解析块范围不对。`);
  }

  // 从 begin 注释的开头切到 end 注释的结尾：两个哨兵都自带完整的 /* */，
  // 所以切出来本身就是合法 JS，接上 return 就能构造。
  return (srcCache = html.slice(b, e + END.length));
}

/** Node 包装：把切片当成函数体，末尾补一句 return。 */
function wrapNode(src, names) {
  return src + `\nreturn {${names.join(", ")}};\n`;
}

/**
 * 浏览器包装：IIFE + 显式挂到 window。
 *
 * 不能把切片当裸脚本发出去，三个原因：
 *   1. 顶层 `function` 会变成 window 的属性，但顶层 `const` 只进全局词法环境 ——
 *      裸发的话 window.extract 是 undefined，而裸标识符 extract(...) 又能用，
 *      守卫极易写错。
 *   2. 本页内联脚本有 "use strict"，独立脚本没有，两边行为可能悄悄分叉。
 *   3. 同名 const 重复声明是 SyntaxError，且是后编译的那个脚本整个不执行，
 *      <script> 只丢一个没有任何信息的 error 事件 —— 又一个静默半坏。
 * 包起来之后，页面里唯一可能撞的名字只有 window.YRP_PARSER，可以断言。
 */
function browserSource(src, names) {
  const want = names || BROWSER_NAMES;
  return (
    "/* 由 _parser.js 从 chat-extractor.html 的 @parser 哨兵块生成，不要直接编辑。 */\n" +
    'window.YRP_PARSER = (function(){\n"use strict";\n' +
    src +
    `\nreturn {${want.join(", ")}};\n})();\n`
  );
}

/**
 * 从 chat-extractor.html 里抠出解析块并构造（Node 侧）。
 *
 * @param {string[]} [names] 要导出的名字，默认 extract + PARSE_FAIL
 */
function loadExtractor(names) {
  const want = names || DEFAULT_NAMES;
  const key = want.join(",");
  const hit = cache.get(key);
  if (hit) return hit;

  let mod;
  try {
    mod = new Function(wrapNode(parserSource(), want))();
  } catch (err) {
    throw new Error(
      `从 ${path.basename(HTML)} 抠出来的解析块编译失败：${err.message}\n` +
        `多半是这段里引用了外面定义的东西，或者哨兵被挪到了别的代码中间。`
    );
  }

  // 少一个都要立刻说清楚是哪个 —— 缺了 extract 却等到解析录像时才炸，
  // 那时候的错误信息跟这里完全对不上。
  const missing = want.filter((n) => mod[n] === undefined);
  if (missing.length) {
    throw new Error(
      `从 ${path.basename(HTML)} 抠出来的解析块里没有：${missing.join("、")}\n` +
        `要么是名字改了，要么是它被挪到哨兵范围之外了。`
    );
  }

  cache.set(key, mod);
  return mod;
}

module.exports = {
  loadExtractor, parserSource, wrapNode, browserSource,
  BROWSER_NAMES, DEFAULT_NAMES, HTML, BEGIN, END,
};
