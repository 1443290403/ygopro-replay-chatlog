/* ------------------------------------------------------------------ *
 * 随程序一起走的数据文件
 *
 * gui.html 和 chat-extractor.html 是**运行时才读**的。读取入口集中在这里，
 * 好处是「它们在源码树的哪个位置」只有一张表说了算 —— 调用方那根
 * 「我旁边的 gui.html」路径是靠不住的：`api.js` 运行时的 `__dirname` 是
 * 源码目录，但界面里那些拼出来的路径是**数据目录**，两者不是一回事。
 *
 * 这里曾经还有第二个分支：打成 Node SEA 单 exe 时，这两个文件是烘在二进制里、
 * 磁盘上没有的，得走 `node:sea` 的资源接口。那套封装已经整个换成 Electron
 * （asar 关掉、文件平铺），磁盘上永远是真文件，所以分支连同 isSea()/isBundled()
 * 一起删掉了 —— 留着的话就是一条永远走不到、也没人测的死路。
 * ------------------------------------------------------------------ */
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * 每个随程序走的文件在源码树里的位置，相对本文件。
 *
 * 只有这张表是可信的：用本文件的 __dirname 当锚点，开发态和打包态都落在
 * 同一份源码树上（`resources/app/` 就是这棵树的平铺副本）。
 * 加一个随程序走的文件，要同时改这里。
 */
const SOURCE_PATHS = {
  "gui.html": "proxy/gui.html",
  "chat-extractor.html": "chat-extractor.html",
};

/**
 * 读一个「随程序走」的文件。
 *
 * @param {string} name 资源名，就是裸文件名（SOURCE_PATHS 的键）
 * @returns {string} 文件内容（utf8）
 */
function readShipped(name) {
  // 路径从表里查，不从调用方传 —— 见 SOURCE_PATHS 的注释
  const rel = SOURCE_PATHS[name];
  if (!rel) throw new Error(`_shipped.js 的 SOURCE_PATHS 里没有 "${name}"（加文件时要同步加）`);
  return fs.readFileSync(path.join(__dirname, rel), "utf8");
}

module.exports = { readShipped, SOURCE_PATHS };
