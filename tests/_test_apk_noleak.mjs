// 对**真制品**的反向断言：APK 里一个字节的用户数据都不许有。
//
//   node tests/_test_apk_noleak.mjs [apk 路径]
//
// 为什么非得查 APK 而不是查 www/：build-web.mjs 的白名单保证的是「拷过去的
// 那几份」，而 APK 里还有 android/app/src/main/assets/public 这个**中间副本**
// 和别的构建步骤。真有东西漏进去，只有拆开最终那个包才看得见。
//
// 分两层：
//   1. 路径层 —— 不许有 config.json / observer.json / replays/ 这类名字
//   2. 内容层 —— 拿用户**真实配置里的值**（房间名、昵称）去扫包里所有文本条目。
//      这一层才是重点：文件名可以改，值改不了。值只在失败信息里报长度，
//      不打印原文。
//
// 没有 APK 时**跳过而不是失败** —— 第一次构建之前 npm test 也该是绿的。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.resolve(HERE, "..", "yrp-tools-electron");
const DEFAULT_APK = path.join(HERE, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");

let fail = 0;
const ok = (cond, what, extra = "") => {
  if (cond) console.log(`  ok   ${what}`);
  else {
    fail++;
    console.log(`  FAIL ${what}${extra ? `\n       ${extra}` : ""}`);
  }
};

const apk = process.argv[2] || process.env.YRP_APK || DEFAULT_APK;
if (!fs.existsSync(apk)) {
  console.log(`（跳过：没有 APK —— ${path.relative(HERE, apk)}）`);
  console.log("  先跑 `npm run apk` 造一个出来。");
  process.exit(0);
}
console.log(`APK：${path.relative(HERE, apk)}  ${(fs.statSync(apk).size / 1048576).toFixed(1)} MB\n`);

/* ------------------------------------------------------------------ *
 * 极简 ZIP 读取器。**不依赖 unzip 命令** —— 那东西在别人的机器上不一定有，
 * 而这条断言是隐私的唯一防线，不能因为缺个外部程序就静默不跑。
 * 只读中央目录，然后按需解压单个条目。
 * ------------------------------------------------------------------ */
function readZip(buf) {
  // EOCD 在文件末尾，最多再跟 64KB 注释
  let eocd = -1;
  const from = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是 ZIP（找不到 EOCD）");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // 中央目录起始偏移
  const entries = [];

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`第 ${n} 个中央目录项签名不对`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, method, compSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    entries,
    // 单个条目的内容。method 8 = deflate，0 = 原样存
    read(e) {
      const q = e.localOff;
      if (buf.readUInt32LE(q) !== 0x04034b50) throw new Error(`本地头签名不对：${e.name}`);
      const nameLen = buf.readUInt16LE(q + 26);
      const extraLen = buf.readUInt16LE(q + 28);
      const start = q + 30 + nameLen + extraLen;
      const raw = buf.subarray(start, start + e.compSize);
      return e.method === 0 ? raw : zlib.inflateRawSync(raw);
    },
  };
}

const zip = readZip(fs.readFileSync(apk));
console.log(`ZIP 里有 ${zip.entries.length} 个条目\n`);

/* ------------------------------------------------------------------ *
 * 1. 路径层
 * ------------------------------------------------------------------ */
console.log("1. 路径层：这些名字一个都不该出现");
{
  const names = zip.entries.map((e) => e.name);
  // assets/capacitor.config.json 是 Capacitor **自己的**配置（appId / webDir），
  // 和用户的 proxy/config.json 同名不同物，所以按**路径**排除而不是按文件名
  const isCapacitorOwn = (n) => n === "assets/capacitor.config.json";

  for (const bad of ["config.json", "observer.json", "settings.json", "gui-token.txt"]) {
    const hit = names.filter((n) => !isCapacitorOwn(n) && path.basename(n) === bad);
    ok(hit.length === 0, `没有 ${bad}`, hit.join(", "));
  }
  const replays = names.filter((n) => n.includes("replays/"));
  ok(replays.length === 0, "没有 replays/ 目录", replays.slice(0, 5).join(", "));

  ok(
    names.some((n) => n === "assets/capacitor.config.json"),
    "（对照组）Capacitor 自己的 capacitor.config.json 在，说明上面不是空跑"
  );
  ok(names.some((n) => /^lib\/[^/]+\/libnode\.so$/.test(n)), "libnode.so 在（这是个能跑的包，不是空壳）");
  ok(names.some((n) => n === "assets/public/nodejs/index.js"), "Node 项目在");
}

/* ------------------------------------------------------------------ *
 * 2. 内容层：拿用户真实配置里的值去扫
 * ------------------------------------------------------------------ */
console.log("\n2. 内容层：用真实配置里的私密值扫包里的文本");
{
  const values = [];
  for (const f of ["observer.json", "config.json"]) {
    const p = path.join(SRC, "proxy", f);
    if (!fs.existsSync(p)) continue;
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (_) {
      continue;
    }
    // room 可能是「房间名$密码」，两截都算；hostPort / name 同理
    for (const v of [cfg.room, cfg.name, cfg.hostPort]) {
      if (typeof v !== "string") continue;
      for (const piece of [v, ...v.split("$")]) {
        if (piece.trim().length >= 2) values.push(piece);
      }
    }
  }

  if (!values.length) {
    console.log("   （用户配置里没有可用的标志值，这一层跳过）");
  } else {
    // 只扫文本类型的条目，二进制（.so / .png / .dex）扫了没意义还慢
    const TEXT = /\.(js|html|json|mjs|css|txt|xml|gradle|properties|conf|md)$/i;
    const scan = zip.entries.filter((e) => TEXT.test(e.name));
    console.log(`   扫 ${scan.length} 个文本条目，${values.length} 个标志值（值不打印，只报长度）`);

    const hits = [];
    for (const e of scan) {
      let text;
      try {
        text = zip.read(e).toString("utf8");
      } catch (_) {
        continue; // 解不开的条目跳过（不该有，但不是这条断言的事）
      }
      for (const v of values) {
        if (text.includes(v)) hits.push(`${e.name} <- 长度 ${v.length} 的值`);
      }
    }
    ok(hits.length === 0, "用户配置里的值一个都没进包", hits.slice(0, 10).join("\n       "));

    /* 对照组：拿一个**确定在包里**的值去扫一遍，证明上面的扫描真的在扫。
     * 少了这条，「扫了 0 个条目」和「扫了 50 个都没命中」看起来一模一样。 */
    const sentinel = "yrp-tools";
    const found = scan.some((e) => {
      try {
        return zip.read(e).toString("utf8").includes(sentinel);
      } catch (_) {
        return false;
      }
    });
    ok(found, `（对照组）确定在包里的字串 "${sentinel}" 扫得到 —— 扫描逻辑是活的`);
  }
}

/* ------------------------------------------------------------------ *
 * 3. 包里的 web 和仓库里的 www/ 逐字节一致
 *
 * 为什么放在这个文件里：和上面两层是同一个问题——「最终那个包里到底是什么」。
 * 而且这条直接盯着一类**真实踩过的坑**：改完 www/ 忘了重新 `cap sync`，
 * 于是手机上跑的还是上一版。表现是「代码明明改了却没生效」，非常难查，
 * 因为本地测试（读的是 www/）全绿。
 *
 * 有了它，`npm test` 在跑过 `npm run apk` 的机器上就能自动确认
 * 「我打包进去的就是我现在看的这份」。
 * ------------------------------------------------------------------ */
console.log("\n3. 包里的 web 与仓库 www/ 逐字节一致");
{
  const walk = (d, base = "") =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]
    );

  const local = walk(path.join(HERE, "www"));
  const inApk = new Map(zip.entries.filter((e) => e.name.startsWith("assets/public/")).map((e) => [e.name.slice("assets/public/".length), e]));

  /* Capacitor 自己往 assets/public 塞的，仓库里没有，不算差异 */
  const CAPACITOR_OWN = new Set(["cordova.js", "cordova_plugins.js"]);

  const missing = local.filter((f) => !inApk.has(f));
  ok(missing.length === 0, `www/ 里 ${local.length} 个文件全在包里`, missing.join(", "));

  const extra = [...inApk.keys()].filter((f) => f !== "nodejs" && !local.includes(f) && !CAPACITOR_OWN.has(f));
  ok(extra.length === 0, "包里没有仓库里没有的 web 文件", extra.join(", "));

  const diff = [];
  for (const f of local) {
    const e = inApk.get(f);
    if (!e) continue;
    try {
      if (!zip.read(e).equals(fs.readFileSync(path.join(HERE, "www", f)))) diff.push(f);
    } catch (err) {
      diff.push(`${f}（读不出来：${err.message}）`);
    }
  }
  ok(diff.length === 0, "内容逐字节相同（说明这次 APK 是最新 www/ 打出来的）", diff.join("\n       "));

  /* 具体钉一下那个**导致这次重建的**修正还在不在。
   * 上面的一致性断言理论上已经覆盖了它，但那条依赖 www/ 本身是对的 ——
   * 万一哪天有人把垫片改回去，这里会直接说清楚是哪一条。 */
  const shim = inApk.get("yrp-shim.js");
  if (shim) {
    const text = zip.read(shim).toString("utf8");
    ok(/function\s+invokeNode\s*\(/.test(text), "垫片里还有 invokeNode（app:quit 的递归修正没被改回去）");
    ok(/localHandlers\[["']app:quit["']\][\s\S]{0,400}?invokeNode\(/.test(text), "app:quit 本地实现走的是 invokeNode 而不是 invoke");
    ok(/\.unref\?\.\(\)/.test(text), "ready 兜底定时器带 unref（测试进程不会被吊住）");
  } else {
    ok(false, "包里有 yrp-shim.js");
  }
}

/* ------------------------------------------------------------------ *
 * 4. 前台服务真进了包，而且是在**合并之后**
 *
 * 光看 android/app/src/main/AndroidManifest.xml 不够：那只是输入。
 * Gradle 的 manifest merger 会把个各插件、各 flavor 的清单合起来，
 * 合并的规则里有覆盖、有去重，还可能在 targetSdk 的约束下报错或丢弃。
 * 「源文件里写了」和「装到手机上生效」是两件事。
 *
 * 优先读 Gradle 落盘的**合并结果**（纯文本，能看清楚是谁声明的）；
 * 读不到就退到直接扫 APK 里的二进制 manifest 的字符串池 —— 弱一些
 * （只能证明字符串在），但任何时候都能跑。
 * ------------------------------------------------------------------ */
console.log("\n4. 前台服务在合并后的清单里");
{
  const manifestText = (() => {
    const root = path.join(HERE, "android", "app", "build", "intermediates");
    if (!fs.existsSync(root)) return null;
    const hits = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "AndroidManifest.xml" && /merged_manifest|packaged_manifest/i.test(p)) hits.push(p);
      }
    };
    walk(root);
    // debug 那份
    const pick = hits.find((p) => /debug/i.test(p)) || hits[0];
    return pick ? fs.readFileSync(pick, "utf8") : null;
  })();

  if (manifestText) {
    console.log("   （读的是 Gradle 的合并产物，不是源文件）");
    const svc = manifestText.match(/<service[^>]*AndroidForegroundService[\s\S]*?(?:\/>|<\/service>)/);
    ok(svc !== null, "合并后的清单里有 AndroidForegroundService");
    if (svc) {
      ok(/foregroundServiceType="specialUse"/.test(svc[0]), "而且类型是 specialUse（没被 merger 改掉）");
      ok(
        /PROPERTY_SPECIAL_USE_FGS_SUBTYPE/.test(svc[0]),
        "specialUse 必需的 property 跟着它一起进来了（Android 14+ 没有它会直接抛）"
      );
    }
    ok(
      /android:name="android\.permission\.FOREGROUND_SERVICE_SPECIAL_USE"/.test(manifestText),
      "FOREGROUND_SERVICE_SPECIAL_USE 权限在（不只是写在源文件里）"
    );
    ok(/android:name="android\.permission\.WAKE_LOCK"/.test(manifestText), "WAKE_LOCK 权限在");
    ok(
      /NotificationActionBroadcastReceiver/.test(manifestText),
      "通知按钮的 receiver 在（插件的接收器得宿主显式声明）"
    );
  }

  /* 插件有没有真的注册进 JS 桥。这一条**必须单独查**：垫片里凡是碰插件的
   * 地方都写着「没有这个插件就静默跳过」（那是为了桌面和测试环境），
   * 于是「插件没注册」的表现是**功能整个不存在但一切看着正常** ——
   * 观战照跑，息屏照样被系统冻住，导出按钮点了没反应。
   * 源码里 package.json 有依赖、Gradle 也编了，但 JS 侧没注册，是可能的。 */
  const pluginsEntry = zip.entries.find((e) => e.name === "assets/capacitor.plugins.json");
  ok(pluginsEntry !== undefined, "APK 里有 capacitor.plugins.json");
  if (pluginsEntry) {
    const pkgs = JSON.parse(zip.read(pluginsEntry).toString("utf8")).map((p) => p.pkg);
    for (const [pkg, why] of [
      ["@capawesome/capacitor-nodejs", "整个 App 靠它跑 Node"],
      ["@capawesome-team/capacitor-android-foreground-service", "没它的话息屏会被系统冻住，而且毫无提示"],
      ["@capacitor/filesystem", "导出靠它写文件"],
      ["@capacitor/share", "导出后把文件发出去靠它"],
      ["@capacitor/clipboard", "复制对话靠它"],
    ]) {
      ok(pkgs.includes(pkg), `${pkg} 注册了（${why}）`);
    }
  }

  if (!manifestText) {
    /* 退路。用字符串池扫 —— 合并清单一读不到，至少还能证明这些字串真在 APK 里。
     * 这条**不能**当成上面那几条的等价物，所以措辞上写清楚验的是什么。 */
    const entry = zip.entries.find((e) => e.name === "AndroidManifest.xml");
    ok(entry !== undefined, "APK 里有 AndroidManifest.xml");
    if (entry) {
      const raw = zip.read(entry);
      console.log("   （合并清单读不到，退到扫 APK 里的二进制清单字符串池 —— 只能证明字符串在）");
      for (const s of ["specialUse", "FOREGROUND_SERVICE_SPECIAL_USE", "PROPERTY_SPECIAL_USE_FGS_SUBTYPE", "AndroidForegroundService"]) {
        ok(raw.includes(Buffer.from(s, "utf8")) || raw.includes(Buffer.from(s, "utf16le")), `二进制清单里有 "${s}"`);
      }
    }
  }
}

console.log(fail ? `\nFAILED (${fail})` : "\n全部通过");
process.exit(fail ? 1 : 0);
