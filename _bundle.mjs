/* ------------------------------------------------------------------ *
 * 打包器：把 5 个模块合并成一个 CJS 脚本（Node SEA 只吃单脚本）
 *
 * SEA 里 require("./别的文件.js") 从磁盘加载是**不可用**的，所以界面的
 * 「起个子进程」也必须变成「再跑一遍自己」，用 --role= 挑活干。
 *
 * 这里自写一个最小 require 而不是引打包器，原因有两个：
 *   - 不引第三方依赖（这个目录一直是零依赖的）
 *   - 每个模块要拿到**不同的 __dirname**（见下面 __DIRS）。esbuild/webpack
 *     会把所有 __dirname 统一成产物所在目录，这个问题照样存在。
 *
 * 产物：build/sea-main.js（生成物，**不要手改**）
 *
 * 三条容易踩的：
 *   1. 三个入口文件首行都是 #! —— 内联进函数体就成了语法错误，必须剥掉
 *   2. **只做「剥 #!」和「按 function(){ ... } 拼接」两件事，绝不解析源码**。
 *      _parser.js 的头部注释里就有一行长得像 require("../_parser.js") 的文字，
 *      gui.js 里也有一句 "/* @parser:begin" 字面量 —— 任何正则扫源码的做法
 *      都会把它们当成真代码。所以这里不做静态扫描，正确性靠运行时
 *      （__resolve 找不到就抛）和 _test_bundle.mjs（三个角色都真跑一遍）。
 *   3. __cwd 必须**模块加载期同步求值**。proxy.js / observer.js / gui.js 的 DATA
 *      都是加载时算的，延后求值会让 _test_gui.mjs 的临时目录隔离**静默失效**，
 *      测试开始往真实 replays/ 里写东西
 * ------------------------------------------------------------------ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "build");
const OUT = path.join(OUT_DIR, "sea-main.js");

/** 参与打包的模块，键是「相对 yrp-tools/ 的路径」，也是内联 id。 */
export const MODULES = [
  "_parser.js",
  "_shipped.js",
  "proxy/proxy.js",
  "proxy/observer.js",
  "proxy/gui.js",
];

/**
 * 每个模块运行时要拿到的 __dirname，**相对产物自己的目录**。
 *
 * 产物在 yrp-tools/build/，跑起来时：
 *   - 平时（node build/sea-main.js）：锚点是 yrp-tools/build/
 *   - 打成 exe 之后：锚点就是 exe 所在目录（SEA 里 __dirname 如此）
 * 两种情况下：
 *   - proxy/* 拿到锚点本身 —— 打包后这就是「exe 旁边」，运行时数据
 *     （replays/、config.json、gui-token.txt…）正好落在那里
 *   - 两个根模块拿到上一级 —— 平时正好是 yrp-tools/，于是 _parser.js 找得到
 *     chat-extractor.html；打包后这一级是死路径，但那时它走资源、根本不读盘
 */
export const DIRS = {
  "_parser.js": "..",
  "_shipped.js": "..",
  "proxy/proxy.js": "",
  "proxy/observer.js": "",
  "proxy/gui.js": "",
};

/**
 * 随程序走的文件：资源名 → 在源码树里的位置（相对 yrp-tools/）。
 *
 * 资源名必须和 _shipped.js 的 SOURCE_PATHS 的键**完全一致**——那边靠这个名字查路径，
 * 这边靠它写 sea-config.json 的 assets。
 */
export const ASSETS = {
  "gui.html": "proxy/gui.html",
  "chat-extractor.html": "chat-extractor.html",
};

/** --role= 的白名单。没有表外的兜底，见生成代码里的注释。 */
export const ROLES = {
  gui: "proxy/gui.js",
  proxy: "proxy/proxy.js",
  observer: "proxy/observer.js",
};

/** 去掉开头的 BOM 和 #! —— 两者都只在**源文件第一行**合法，内联后都会变语法错误。 */
export function cleanSource(src) {
  return src.replace(/^﻿/, "").replace(/^#![^\n]*\r?\n/, "");
}

/**
 * 生成 build/sea-main.js。
 * @returns {{out: string}} 产物的绝对路径
 */
export function buildBundle() {
  const chunks = [];
  for (const id of MODULES) {
    const src = cleanSource(fs.readFileSync(path.join(HERE, id), "utf8"));
    // 模块源代码**原样**贴进来。函数体第一句若是 "use strict" 仍算指令序言，
    // 严格语义和原来一致。
    chunks.push(
      `__defs[${JSON.stringify(id)}] = function(module, exports, require, __dirname, __filename){\n` +
        src +
        `\n};\n`
    );
  }

  const out = `/* 由 _bundle.mjs 生成 —— 不要手改，改了下次打包就没了。
 * 源文件：${MODULES.join("、")}
 */
"use strict";

const __path = require("path");

// 告诉 _shipped.js「我是打包产物」——磁盘上没有同级的 .js 可 require（SEA 固
// 然如此，用普通 node 跑本文件时也一样，因为 build/ 里只有这一个文件）。
globalThis.__YRP_BUNDLED__ = true;

// 产物自己的目录。平时是 yrp-tools/build/，打成 exe 之后是 exe 所在目录。
// **必须在这里就求值**，不能挪进任何函数里 —— 见 _bundle.mjs 顶部第 3 条。
const __cwd = __dirname;

const __DIRS = ${JSON.stringify(DIRS, null, 2)};

const __defs = Object.create(null);
const __cache = Object.create(null);
let __MAIN = null;

${chunks.join("\n")}
function __join(base, spec) {
  const out = [];
  for (const part of ((base ? base + "/" : "") + spec).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!out.length) throw new Error("bundle: 相对路径 " + spec + " 越出了模块根目录");
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

function __resolve(fromId, spec) {
  if (spec.charAt(0) !== ".") return null;
  const dir = fromId.includes("/") ? fromId.slice(0, fromId.lastIndexOf("/")) : "";
  let id = __join(dir, spec);
  if (!id.endsWith(".js")) id += ".js";
  return __defs[id] ? id : null;
}

function __run(id, m) {
  const def = __defs[id];
  if (!def) throw new Error("bundle: 没有模块 " + id + "（__DIRS / MODULES 对不上？）");
  if (m.loaded) throw new Error("bundle: 模块 " + id + " 被跑了两次");

  const dir = __path.resolve(__cwd, __DIRS[id] || "");
  const req = function(spec) {
    if (spec.charAt(0) === ".") {
      const hit = __resolve(id, spec);
      // **不回退到真的 require**：SEA 下它必然失败，而 gui.js 是把
      // loadExtractor 的异常咽成一条界面横幅的 —— 界面照常起来、
      // 只有查看和导出是死的，报错信息还指不到这里。
      if (!hit) throw new Error(
        "bundle: " + id + ' 里 require("' + spec + '") 找不到内联模块。' +
        "改过文件名就得同步改 _bundle.mjs 的 MODULES。"
      );
      return __load(hit);
    }
    return require(spec);
  };
  req.main = __MAIN;
  req.resolve = function(spec) {
    const hit = spec.charAt(0) === "." ? __resolve(id, spec) : null;
    return hit || spec;
  };

  def(m, m.exports, req, dir, __path.join(dir, __path.basename(id)));
  m.loaded = true;
}

function __load(id) {
  const hit = __cache[id];
  if (hit) return hit.exports;
  const m = { exports: {}, id: id, loaded: false };
  __cache[id] = m;
  __run(id, m);
  return m.exports;
}

/**
 * 跑入口模块。
 *
 * __MAIN 必须在模块体执行**之前**设好，而且和 __cache 里登记的是**同一个对象** ——
 * 三个入口靠 require.main === module 认自己，弄错了要么两个 main 一起跑，
 * 要么一个都不跑（后者更坏：界面是纯事件驱动的，不跑 main 就没有任何待处理句柄，
 * 进程直接静默退出、零输出，双击的人只看到"什么都没发生"）。
 */
function boot(entryId) {
  if (!__defs[entryId]) throw new Error("bundle: 角色映射到了不存在的模块 " + entryId);
  const m = { exports: {}, id: entryId, loaded: false };
  __cache[entryId] = m;
  __MAIN = m;
  __run(entryId, m);
  if (__MAIN !== m) throw new Error("bundle: __MAIN 被改过，require.main 已经不可信");
  return m;
}

const __ROLES = ${JSON.stringify(ROLES, null, 2)};

let __entry = __ROLES.gui;
const __ri = process.argv.findIndex(function(a) { return a.indexOf("--role=") === 0; });
if (__ri >= 0) {
  const __role = process.argv[__ri].slice(7);
  // **不能降级成 gui**：role 拼错时子进程会起第二个界面，第二个界面探到
  // 第一个还活着就 reopen() 然后 exit 0 —— 父进程以为起好了，
  // 用户看到的是"界面已经在跑了"，完全不知道观战没起来。
  if (!__ROLES[__role]) {
    console.error("未知角色：" + __role + "（可用：" + Object.keys(__ROLES).join(" / ") + "）");
    process.exit(2);
  }
  // 必须在 boot 之前剥掉：proxy.js 的 argv 是**模块级**算的，晚一步 --dump 就没了
  process.argv.splice(__ri, 1);
  __entry = __ROLES[__role];
}

boot(__entry);
`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, out);
  return { out: OUT };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { out } = buildBundle();
  console.log(`已生成 ${path.relative(HERE, out).replace(/\\/g, "/")}（${fs.statSync(out).size} 字节）`);
  for (const id of MODULES) console.log(`  ${id}`);
}
