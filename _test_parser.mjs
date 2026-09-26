// Verify the parser embedded in chat-extractor.html against the real .yrp3d files.
// Extracts the pure-function section out of the HTML so we test the shipped code,
// not a re-typed copy of it — the extraction itself lives in _parser.js, shared
// with the proxy/observer test suites and the GUI.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// scripts live here; the sample replays sit in the workspace root one level up
const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = process.argv[2] || join(HERE, "..");
const require = createRequire(import.meta.url);

const P = require("./_parser.js");

// this suite also pokes at the parser's internals, hence the extra names
const mod = P.loadExtractor([
  "extract", "parseYrp3d", "u16z", "classify", "isSystem", "speakerLabel",
  "relayedName", "PARSE_FAIL",
  "withBom", "stamp", "withStamp", "exportBaseName", "filterChats", "exportGroups",
  "buildMergedTxt", "buildPerFileTxt", "buildJson", "buildCsv",
  "normalizeServer", "gatherSources",
]);

let fail = 0;

// The plain `got !== want` compares below print both sides raw, which renders \r\n
// and \n identically -- a CRLF regression in the CSV would fail without saying why.
// Anything byte-sensitive uses this instead.
function eq(got, want, what){
  if (got === want) return;
  console.log(`!! ${what}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`);
  fail++;
}

// player_type 7 is TYPE_OBSERVER (srvpro data/constants.json NETPLAYER). It used to
// fall through to the generic branch and render as "系统7", which made spectator
// chatter look like it was missing from the replay.
const seats = {0: "A", 1: "B"};
const cases = [
  [mod.classify(7), "observer", "classify(7)"],
  [mod.speakerLabel(7, seats).name, "观战者", "speakerLabel(7)"],
  [mod.classify(0), "player", "classify(0)"],
  // the seat index must not leak into the visible label -- it stays on the tooltip
  [mod.speakerLabel(0, seats, "").name, "A", "player label is the bare name"],
  [mod.speakerLabel(0, seats, "").seat, 0, "player label carries the seat"],
  [mod.speakerLabel(7, seats, "").seat, undefined, "non-players have no seat"],
  [mod.classify(8), "tip", "classify(8)"],
  [mod.classify(11), "server", "classify(11)"],
  [mod.isSystem("observer"), false, "isSystem(observer)"],
  [mod.isSystem("player"), false, "isSystem(player)"],
  [mod.isSystem("tip"), true, "isSystem(tip)"],
  [mod.isSystem("server"), true, "isSystem(server)"],
  // player_type 9 is how srvpro relays spectator chat when display_watchers is on;
  // the speaker's name rides inside the text as "<name>: <message>".
  [mod.classify(9), "observer", "classify(9)"],
  [mod.speakerLabel(9, seats, "老王: 你好").name, "观战者「老王」", "relayed name"],
  [mod.speakerLabel(9, seats, "没有冒号").name, "观战者", "relay without a prefix"],
  [mod.speakerLabel(7, seats, "老王: 你好").name, "观战者", "type 7 carries no name"],
  [mod.relayedName("a: b: c"), "a", "first separator wins"],
  [mod.relayedName(": 开头就是冒号"), null, "empty name is not a name"],
];
for (const [got, want, what] of cases){
  if (got !== want){ console.log(`!! ${what} = ${got}, want ${want}`); fail++; }
}
console.log(`speaker-label cases: ${cases.length - fail}/${cases.length} ok`);
/* 样例是可选的。没有样例时下面「真解析」和「垃圾输入」两节**跳过**而不是崩掉：
 * 仓库 clone 下来本来就不含任何录像，而黄金字符串那几节（导出格式）不依赖样例。 */
let samples = [];
try { samples = readdirSync(SAMPLES); } catch (_) {}
let obs = 0;
const found = samples.filter(n => /\.yrp3d$/i.test(n));
if (!found.length)
  console.log(`(no .yrp3d samples found in ${SAMPLES} —— 跳过「真解析」「垃圾输入」两节；`
              + "\n 想看那两节就传一个装了 .yrp3d 的目录：node _test_parser.mjs <目录>)");

for (const f of found){
  const r = mod.extract(f, new Uint8Array(readFileSync(join(SAMPLES, f))));
  if (!r.ok){ console.log(`!! ${f}: ${r.error}`); fail++; continue; }
  console.log(`== ${f}`);
  console.log(`   ${r.size} bytes, ${r.packets} packets, seats 0=${r.seats[0]} 1=${r.seats[1]}` +
              `, embedded=${r.hasEmbedded ? r.embeddedSize : "none"}`);
  for (const c of r.chats) console.log(`   ${c.who.padEnd(12)} ${c.msg}`);
  obs += r.chats.filter(c => c.kind === "observer").length;
}
if (found.length && !obs)
  console.log("(note: no spectator chat in these samples -- nothing to check for type 7)");

// Anything that is not a .yrp3d packet stream -- a standard .yrp, a truncated
// file, a random binary -- must come back as one uniform parse failure, with no
// format-specific special-casing in the UI.
const junk = found.length ? [
  [samples.find(n => /\.yrp$/i.test(n)), "standard .yrp"],
  [null, "truncated packet stream"],
] : [];
for (const [name, what] of junk){
  let bytes;
  if (name) bytes = new Uint8Array(readFileSync(join(SAMPLES, name)));
  else {
    const src = samples.find(n => /\.yrp3d$/i.test(n));
    bytes = new Uint8Array(readFileSync(join(SAMPLES, src))).slice(0, 40);
  }
  const r = mod.extract(name || "(truncated)", bytes);
  console.log(`== ${what}: ok=${r.ok} error=${r.error || "-"}`);
  if (r.ok) { console.log(`   !! ${what} should not have parsed`); fail++; }
  else if (r.error !== mod.PARSE_FAIL) { console.log(`   !! error is not the uniform message`); fail++; }
  if (r.kind && r.kind !== "yrp3d") { console.log(`   !! unexpected kind ${r.kind}`); fail++; }
}

/* ---------- export formats ---------- *
 *
 * These live in the shared block so proxy/gui.html builds byte-identical files.
 * The expectations below are golden LITERALS, not re-derived logic: if a format
 * changes, the literal has to change too, on purpose.
 *
 * Note what is deliberately NOT asserted: that the GUI and chat-extractor.html
 * export the same bytes for the same real file. They do not -- the GUI trims a
 * half-written packet off the tail (trimToLastPacket) and the standalone page
 * refuses the file outright. That difference is intended, so only the builders
 * are pinned here.
 */
const FIX = [
  {ok:true, file:"a.yrp3d", size:10, packets:3, seats:{0:"A",1:"B"}, chats:[
    {offset:255, playerType:0, who:"A",         kind:"player",   seat:0,    msg:"你好"},
    {offset:300, playerType:8, who:"LIGHTBLUE", kind:"tip",      seat:null, msg:"Tip: 开始"},
    {offset:320, playerType:7, who:"观战者",     kind:"observer", seat:null, msg:"围观"},
  ]},
  {ok:true,  file:"b.yrp3d", size:7, packets:1, seats:{0:"A",1:"B"}, chats:[]},
  {ok:false, file:"c.yrp3d", size:3, error:mod.PARSE_FAIL},
];

let nExp = 0;
const exp = (got, want, what) => { nExp++; eq(got, want, what); };

// The header cells are NOT quoted -- the original built them with ["文件",...].join(",").
// Only the per-row text fields go through q(). Kept as-is rather than "fixed", so
// exports stay byte-identical to what chat-extractor.html has always produced.
// ...and neither are the 偏移 / 说话者类型 columns: only 文件/说话者/消息 go through q().
const CSV_HEAD = '文件,偏移,说话者类型,说话者,消息';
exp(mod.buildCsv(FIX, {}),
  CSV_HEAD + "\r\n" +
  '"a.yrp3d",0xff,0,"A","你好"\r\n' +
  '"a.yrp3d",0x12c,8,"LIGHTBLUE","Tip: 开始"\r\n' +
  '"a.yrp3d",0x140,7,"观战者","围观"',
  "CSV 逐字节（\\r\\n 行间、行内无裸 \\n、偏移是 0x 十六进制）");
exp(mod.buildCsv(FIX, {strip:true}),
  CSV_HEAD + "\r\n" + '"a.yrp3d",0xff,0,"A","你好"\r\n' + '"a.yrp3d",0x140,7,"观战者","围观"',
  "CSV 受「排除系统消息」影响（以前不受）");
exp(mod.buildCsv(FIX, {noObs:true}),
  CSV_HEAD + "\r\n" + '"a.yrp3d",0xff,0,"A","你好"\r\n' + '"a.yrp3d",0x12c,8,"LIGHTBLUE","Tip: 开始"',
  "CSV 受「排除观战发言」影响（以前不受）");
exp(mod.buildCsv([{ok:true, file:'x"y.yrp3d', chats:[
  {offset:1, playerType:0, who:'A"B', kind:"player", seat:0, msg:'他说"你好",然后走了'}]}], {}),
  CSV_HEAD + '\r\n"x""y.yrp3d",0x1,0,"A""B","他说""你好"",然后走了"',
  "CSV 的双引号按 RFC4180 转义（字段里带逗号也只靠引号，不加空格）");
exp(mod.buildCsv([{ok:true, file:"e.yrp3d", chats:[]}], {}), "", "CSV 没有数据行时返回空串");
exp(mod.buildCsv([], {}), "", "CSV 空输入返回空串");
exp(mod.buildCsv([{ok:false, file:"c.yrp3d"}], {}), "", "CSV 跳过解析失败的文件");

exp(mod.buildMergedTxt(mod.exportGroups(FIX, {})),
  "### a.yrp3d\nA: 你好\nLIGHTBLUE: Tip: 开始\n观战者: 围观",
  "合并 TXT 逐字节（文件标题 + 每行 who: msg）");
exp(mod.buildMergedTxt([{file:"a", chats:[{who:"A", msg:"1"}]},
                        {file:"b", chats:[{who:"B", msg:"2"}]}]),
  "### a\nA: 1\n\n### b\nB: 2", "合并 TXT 两份之间空一行");
exp(mod.buildMergedTxt([]), "", "合并 TXT 空输入返回空串");

exp(mod.buildPerFileTxt({file:"a", chats:[{who:"A", msg:"1"}, {who:"B", msg:"2"}]}),
  "A: 1\nB: 2", "分文件 TXT 逐字节");
exp(mod.buildPerFileTxt({file:"a", chats:[]}), "", "分文件 TXT 无对话返回空串");

exp(JSON.stringify(mod.exportGroups([{ok:true, file:"a", chats:[]}], {})), "[]",
  "exportGroups 丢掉无对话的文件");
exp(JSON.stringify(mod.exportGroups([{ok:false, file:"b"}], {})), "[]",
  "exportGroups 丢掉解析失败的文件");
exp(JSON.stringify(mod.exportGroups([{ok:true, file:"c", chats:[{kind:"tip", who:"X", msg:"m"}]}], {strip:true})), "[]",
  "exportGroups 丢掉过滤后为空的文件");
exp(JSON.stringify(mod.exportGroups(FIX, {}).map(g => g.file)), '["a.yrp3d"]',
  "exportGroups 只留真有话要说的文件");
const IN = [{ok:true, file:"c", chats:[{kind:"tip", who:"X", msg:"m"}, {kind:"player", who:"A", msg:"p"}]}];
mod.exportGroups(IN, {strip:true});
exp(IN[0].chats.length, 2, "exportGroups 不修改入参");

exp(JSON.parse(mod.buildJson([{ok:true, file:"b", size:7, packets:1, seats:{0:"A",1:"B"}, chats:[]}], {})).length, 1,
  "JSON 保留零对话的文件（与 exportGroups 相反，这是有意的）");
exp(mod.buildJson([{ok:false, file:"c"}], {}), "[]", "JSON 丢掉解析失败的文件");
exp(JSON.parse(mod.buildJson([], {})).length, 0, "JSON 空输入仍是合法 JSON");
exp(Object.keys(JSON.parse(mod.buildJson([{ok:true, file:"a", size:1, packets:1, seats:{},
  chats:[{offset:1, playerType:0, who:"A", kind:"player", seat:0, msg:"m"}]}], {}))[0]).join(","),
  "file,size,packets,seats,chats", "JSON 每份文件的字段名");
exp(Object.keys(JSON.parse(mod.buildJson([{ok:true, file:"a", size:1, packets:1, seats:{},
  chats:[{offset:1, playerType:0, who:"A", kind:"player", seat:0, msg:"m"}]}], {}))[0].chats[0]).join(","),
  "offset,playerType,speaker,seat,kind,message", "JSON 每条对话的字段名");
exp(JSON.parse(mod.buildJson(FIX, {strip:true}))[0].chats.length, 2,
  "JSON 受勾选框影响（以前不受）");
exp(mod.buildJson(FIX, {}).charCodeAt(0) === 0xFEFF, false, "构建函数自己不带 BOM");

exp(mod.withBom("a").charCodeAt(0), 0xFEFF, "withBom 加上 BOM");
exp(JSON.stringify([...new TextEncoder().encode(mod.withBom("a")).slice(0, 3)]), "[239,187,191]",
  "BOM 的 UTF-8 字节");
exp(mod.withBom("").length, 1, "withBom 空串只剩 BOM");

// Local-time constructor on purpose: new Date("2026-09-25T14:30:12") is parsed as
// UTC and this would pass here and fail for anyone east or west of us.
exp(mod.stamp(new Date(2026, 8, 25, 14, 30, 12)), "20260925-143012", "stamp 用本地时间");
exp(mod.stamp(new Date(2026, 0, 1, 0, 0, 0)), "20260101-000000", "stamp 各段补零");
exp(mod.withStamp("a.yrp3d", "S"), "a_S.yrp3d", "withStamp 插在最后一个点前");
exp(mod.withStamp("a.b.yrp3d", "S"), "a.b_S.yrp3d", "withStamp 只看最后一个点");
exp(mod.withStamp("a", "S"), "a_S", "withStamp 无扩展名");
exp(mod.exportBaseName("示例房-09-25「16：57：48」.yrp3d"), "示例房-09-25「16：57：48」",
  "exportBaseName 中文与全角冒号");
exp(mod.exportBaseName("x.yrp"), "x", "exportBaseName 也认 .yrp（旧正则漏掉，会导出成 x.yrp_chat_*.txt）");
exp(mod.exportBaseName("x.YRP3D"), "x", "exportBaseName 大小写不敏感");
exp(mod.exportBaseName("noext"), "noext", "exportBaseName 无扩展名原样");

const CS = [{kind:"player"}, {kind:"observer"}, {kind:"tip"}, {kind:"server"}];
exp(mod.filterChats(CS, {}).map(c => c.kind).join(","), "player,observer,tip,server", "不勾时全都留");
exp(mod.filterChats(CS, {strip:true}).map(c => c.kind).join(","), "player,observer", "排除系统公告，保留观战");
exp(mod.filterChats(CS, {noObs:true}).map(c => c.kind).join(","), "player,tip,server", "排除观战，保留系统");
exp(mod.filterChats(CS, {strip:true, noObs:true}).map(c => c.kind).join(","), "player", "两个都勾只剩玩家");
exp(mod.filterChats(null, {}).length, 0, "chats 缺失时返回空数组而不是抛错");

exp(JSON.stringify(mod.normalizeServer({ok:true, name:"a.yrp3d", size:9, parsedSize:5, packets:2,
    seats:{0:"A",1:"B"}, chats:[{who:"A"}], trimmed:true, running:true})),
  JSON.stringify({ok:true, file:"a.yrp3d", size:9, packets:2, seats:{0:"A",1:"B"},
                  chats:[{who:"A"}], trimmed:true, running:true}),
  "normalizeServer 把 /api/recording 的响应改成 extract() 的形状");
exp(mod.normalizeServer({ok:true, name:"a.yrp3d", size:9}).chats.length, 0, "normalizeServer 补上空 chats");
exp(mod.normalizeServer({ok:false, name:"a.yrp3d", error:"解析失败"}).error, "解析失败",
  "normalizeServer 透传服务端的错误信息");
exp(mod.normalizeServer({ok:false, name:"a.yrp3d"}).file, "a.yrp3d", "失败时仍带文件名");
exp(mod.normalizeServer(null).ok, false, "normalizeServer 容错 null");
exp(mod.normalizeServer(null).error, mod.PARSE_FAIL, "没有错误信息时兜底用 PARSE_FAIL");

const io = {read: async (k) => {
  if (k === "boom") throw new Error("读不动");
  if (k === "bad")  return {ok:false, file:k, error:"解析失败"};
  return {ok:true, file:k, chats:[{who:"A", msg:k}]};
}};
const gathered = await mod.gatherSources(["ok1", "bad", "boom", "ok2"], io);
exp(gathered.length, 4, "gatherSources 一个源失败不影响其余");
exp(gathered[0].ok && gathered[3].ok, true, "成功的源照常返回");
exp(gathered[1].error, "解析失败", "解析失败的源原样保留，错误信息不被覆盖");
exp(/读不动/.test(gathered[2].error), true, "抛异常的源降级成 ok:false");
exp(gathered[2].file, "boom", "降级时把 key 当文件名记下来");

/* ---------- 同一份切片，两个包装 ---------- */
const src = P.parserSource();
exp(/^\/\* @parser:begin/.test(src), true, "parserSource 从哨兵注释开头切起");
exp(/@parser:end \*\/\s*$/.test(src), true, "parserSource 切到哨兵注释结尾为止");
exp(src === P.parserSource(), true, "parserSource 结果被缓存");

const nodeSrc = P.wrapNode(src, P.BROWSER_NAMES);
const viaWrap = new Function(nodeSrc)();
exp(P.BROWSER_NAMES.every(n => viaWrap[n] !== undefined), true, "wrapNode 导出 BROWSER_NAMES 里的每个名字");

const browserSrc = P.browserSource(src, P.BROWSER_NAMES);
const fakeWin = {};
new Function("window", browserSrc)(fakeWin);
const missingInBrowser = P.BROWSER_NAMES.filter(n => fakeWin.YRP_PARSER[n] === undefined);
exp(missingInBrowser.join(","), "",
  "browserSource 导出每个名字（往哨兵块加了函数却忘了加进 BROWSER_NAMES，就是这里报）");
// the sentinel block is served inside a <script>, so a literal closing tag in it
// would truncate chat-extractor.html's inline script mid-block
exp(browserSrc.indexOf("</script") < 0, true, "浏览器包装里没有字面 </script");
exp(browserSrc.indexOf('"use strict"') > 0, true, "浏览器包装带 use strict");
exp(typeof fakeWin.YRP_PARSER.extract, "function", "浏览器包装里的 extract 是函数");

console.log(`export-format + wrapper cases: ${nExp} checks`);

console.log(fail ? `\nFAILED (${fail})` : "\nall good");
process.exit(fail ? 1 : 0);
