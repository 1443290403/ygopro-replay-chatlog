// 共享文件同步的守卫。
//
//   node tests/_test_shared_sync.mjs
//
// 查三件事，全都对着「会不会静默用错东西」：
//   1. build-web.mjs 跑得通，而且 www/index.html 和源版 gui.html
//      **只差垫片那一行**（不是「差不多」，是逐字节）
//   2. www/ 里每份拷贝都和它在 Electron 版里的源头逐字节相同 ——
//      防的是「有人图省事直接在 www/ 里改了一份」
//   3. 没有过期：源头文件不能比同步出来的那份更新 ——
//      防的是「改了 gui.html 忘了重新同步，APK 里还是旧的」
//
// 这个文件**不**重复 build-web.mjs 的清单，反过来从 www/ 出发去源头找 ——
// 清单只留一份真相，这里做的是交叉验证而不是抄一遍。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.resolve(HERE, "..", "yrp-tools-electron");
const WWW = path.join(HERE, "www");

let fail = 0;
const ok = (cond, what, extra = "") => {
  if (cond) console.log(`  ok   ${what}`);
  else {
    fail++;
    console.log(`  FAIL ${what}${extra ? `\n       ${extra}` : ""}`);
  }
};
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/* ---------- 1. 先跑同步 ---------- */
console.log("1. 跑 build-web.mjs");
try {
  const out = execFileSync(process.execPath, [path.join(HERE, "scripts", "build-web.mjs")], {
    cwd: HERE,
    encoding: "utf8",
  });
  ok(true, "同步脚本退出码 0");
  // 它自己那套断言也必须全绿，出现 FAIL 就算它 exit 0 也是坏的
  ok(!/FAIL/.test(out), "同步脚本自己的断言没有 FAIL", out.split("\n").filter((l) => /FAIL/.test(l)).join("\n"));
} catch (e) {
  ok(false, "同步脚本跑通", (e.stdout || "") + (e.stderr || ""));
}

/* ---------- 2. index.html 只差那一行 ---------- */
console.log("\n2. www/index.html 的生成");
const SHIM = '<script src="yrp-shim.js"></script>';
const gui = fs.readFileSync(path.join(SRC, "proxy", "gui.html"), "utf8");
const idx = fs.readFileSync(path.join(WWW, "index.html"), "utf8");

ok(idx.split(SHIM).length - 1 === 1, "垫片标签恰好一次");
ok(idx.indexOf(SHIM) < idx.indexOf("<script>"), "垫片在唯一那段内联脚本之前");
ok(idx.replace(SHIM + "\n", "") === gui, "去掉这一行后和源版 gui.html 逐字节相同");

/* ---------- 3. 拷贝逐字节对得上源头 ---------- */
console.log("\n3. www/ 里的拷贝 vs Electron 版源头");
/* 手写的（安卓独有，没有源头）*/
const HAND_WRITTEN = new Set(["index.html", "yrp-shim.js", "nodejs/index.js", "nodejs/package.json"]);

const walk = (dir, base = dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((ent) => {
    const p = path.join(dir, ent.name);
    return ent.isDirectory() ? walk(p, base) : [path.relative(base, p).replace(/\\/g, "/")];
  });

let checked = 0;
for (const rel of walk(WWW)) {
  if (HAND_WRITTEN.has(rel)) continue;
  const dest = path.join(WWW, rel);
  const name = path.basename(rel);
  // 源头候选：同名文件在 Electron 版根目录，或在它的 proxy/ 下
  const candidates = [path.join(SRC, rel), path.join(SRC, name), path.join(SRC, "proxy", name)];
  const hit = candidates.find((c) => fs.existsSync(c) && sha(fs.readFileSync(c)) === sha(fs.readFileSync(dest)));
  if (hit) {
    checked++;
    console.log(`  ok   ${rel.padEnd(30)} == ${path.relative(SRC, hit).replace(/\\/g, "/")}`);
  } else {
    ok(false, `${rel} 在源头找得到对应且逐字节相同`, candidates.map((c) => path.relative(SRC, c)).join(" | "));
  }
}
ok(checked > 0, `至少核对了 1 份拷贝（实际 ${checked} 份）`);

/* ---------- 4. 有没有过期 ---------- */
console.log("\n4. 同步是不是最新的");
let stale = 0;
for (const rel of walk(WWW)) {
  if (HAND_WRITTEN.has(rel)) continue;
  const dest = path.join(WWW, rel);
  const name = path.basename(rel);
  for (const c of [path.join(SRC, rel), path.join(SRC, name), path.join(SRC, "proxy", name)]) {
    if (fs.existsSync(c) && sha(fs.readFileSync(c)) === sha(fs.readFileSync(dest))) {
      if (fs.statSync(c).mtimeMs > fs.statSync(dest).mtimeMs + 1000) {
        stale++;
        ok(false, `${rel} 比源头旧（改了源头没重新同步？）`, path.relative(SRC, c));
      }
      break;
    }
  }
}
ok(stale === 0, stale === 0 ? "所有拷贝都不比源头旧" : `${stale} 份过期`);

console.log(fail ? `\nFAILED (${fail})` : "\n全部通过");
process.exit(fail ? 1 : 0);
