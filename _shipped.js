/* ------------------------------------------------------------------ *
 * 随程序一起走的数据文件
 *
 * gui.html 和 chat-extractor.html 是**运行时才读**的：
 *   - 平时（开发、测试、双击 .bat）它们在磁盘上，紧挨着读它们的那个 .js
 *   - 打成单个 exe（Node SEA）之后，它们是烘进 exe 的「资源」，
 *     磁盘上没有这两个文件，`fs.readFileSync` 必然 ENOENT
 *
 * 这个模块就是那条分叉唯一该出现的地方。
 *
 * **SEA 分支故意不回退读盘。** 回退看着稳，实际是把一个明确的「资源没打进 exe」
 * 变成一次 ENOENT，而 gui.js 那边是把读解析块失败咽成一条界面横幅的
 * （proxy/gui.js 里 loadExtractor 的 try/catch）—— 结果是界面照常起来、
 * 只有查看和导出是死的，排查时完全看不出跟资源有关。
 * 宁可让 getAsset 抛，并且把资源名打出来。
 * ------------------------------------------------------------------ */
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * 每个随程序走的文件在**源码树里**的位置，相对本文件。
 *
 * 只有这张表是可信的。调用方那根「我旁边的 gui.html」路径在打包产物里是错的：
 * gui.js 运行时的 __dirname 是「运行时数据该落在哪」（exe 旁边），
 * 不是「源文件在哪」。两件事在打包后正好指向不同的目录。
 *
 * 用本文件的 __dirname 当锚点，三种形态都对：
 *   - 平时没打包：本文件就在 yrp-tools/          → yrp-tools/proxy/gui.html ✓
 *   - 用 node 跑产物：__DIRS 给的就是上一级      → 同上 ✓
 *   - 打成 exe：走资源，这条路根本不执行
 * 加一个随程序走的文件，要同时改这里和 _bundle.mjs 的 ASSETS。
 */
const SOURCE_PATHS = {
  "gui.html": "proxy/gui.html",
  "chat-extractor.html": "chat-extractor.html",
};

// node:sea 在 20.12 之前不存在，require 会抛。低版本 Node 一律当「不是 SEA」。
function trySea() {
  try {
    return require("node:sea");
  } catch (_) {
    return null;
  }
}

/** 当前这个进程是不是从 SEA exe 里跑起来的。 */
function isSea(sea) {
  const s = sea || trySea();
  return !!(s && typeof s.isSea === "function" && s.isSea());
}

/**
 * 当前这个进程是不是**打包产物**（不管是 exe，还是用普通 node 跑 build/sea-main.js）。
 *
 * 和 isSea() 是**两个不同的问题**，别合并：
 *   - isSea()     ——「随程序走的文件是烘在二进制里的吗」→ readShipped 用
 *   - isBundled() ——「磁盘上还有没有同级的那几个 .js」→ gui.js 起子进程用
 * 用普通 node 跑 build/sea-main.js 时，两个答案正好相反：HTML 在磁盘上读得到，
 * 但 build/ 里没有 proxy.js —— gui.js 要是按 isSea() 判断，会去 spawn 一个
 * 不存在的 build/proxy.js。标记由 _bundle.mjs 生成时写死在产物开头。
 */
function isBundled() {
  return isSea() || globalThis.__YRP_BUNDLED__ === true;
}

/**
 * 读一个「随程序走」的文件。
 *
 * @param {string} name  资源名（打包时写进 sea-config.json 的 key，就是裸文件名）
 * @param {object} [sea] 注入用的假的 node:sea，只有测试会传
 * @returns {string} 文件内容（utf8）
 */
function readShipped(name, sea) {
  // 路径从表里查，不从调用方传 —— 见 SOURCE_PATHS 的注释
  const rel = SOURCE_PATHS[name];
  if (!rel) throw new Error(`_shipped.js 的 SOURCE_PATHS 里没有 "${name}"（加文件时要同步加）`);

  if (isSea(sea)) {
    const s = sea || trySea();
    try {
      return s.getAsset(name, "utf8");
    } catch (err) {
      throw new Error(
        `exe 里没有名为 "${name}" 的资源：${err.message}\n` +
          `它是打包时烘进去的（见 PACKAGING.md）。改过源文件必须重新打包才会生效。`
      );
    }
  }
  return fs.readFileSync(path.join(__dirname, rel), "utf8");
}

module.exports = { readShipped, isSea, isBundled, SOURCE_PATHS };
