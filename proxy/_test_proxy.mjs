// Unit tests for proxy.js -- frame splitting, packet decoding, and the .yrp3d
// the recorder produces. The last part is the important one: it feeds the
// recorder's real output through the parser embedded in chat-extractor.html,
// so a change that breaks the product fails here.
//
//   node _test_proxy.mjs
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const proxy = require("./proxy.js");

let fail = 0;
const check = (got, want, what) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.log(`!! ${what} = ${a}, want ${b}`); fail++; }
};

// ---- helpers to synthesise wire frames ----
const STOC_CHAT = 0x19, STOC_HS_PLAYER_ENTER = 0x20, CTOS_PLAYER_INFO = 0x10;

// [uint16 LE length = 1 + payload][uint8 type][payload]
const frame = (type, payload) => {
  const b = Buffer.alloc(3 + payload.length);
  b.writeUInt16LE(1 + payload.length, 0);
  b[2] = type;
  payload.copy(b, 3);
  return b;
};
const u16 = (s) => {
  const b = Buffer.alloc((s.length + 1) * 2);
  for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), i * 2);
  return b;
};
const chatPayload = (playerType, msg) => {
  const m = u16(msg);
  const b = Buffer.alloc(2 + m.length);
  b.writeUInt16LE(playerType, 0);
  m.copy(b, 2);
  return b;
};
// 41 bytes: 40-byte UTF-16LE name + 1-byte pos
const enterPayload = (name, pos) => {
  const b = Buffer.alloc(41);
  u16(name).copy(b, 0, 0, 40);
  b[40] = pos;
  return b;
};

/* ---------------- frame splitting ---------------- */

// A frame arriving split across two TCP reads must be reassembled, not dropped.
{
  const got = [];
  const feed = proxy.makeSplitter((t, p) => got.push([t, Buffer.from(p)]));
  const stream = Buffer.concat([
    frame(STOC_CHAT, chatPayload(1, "你好")),
    frame(STOC_HS_PLAYER_ENTER, enterPayload("RLX", 0)),
  ]);
  feed(stream.subarray(0, 4)); // split mid-header
  check(got.length, 0, "no packet before the frame is complete");
  feed(stream.subarray(4));
  check(got.length, 2, "both packets after reassembly");
  check(got[0][0], STOC_CHAT, "first type");
  check(got[0][1].readUInt16LE(0), 1, "player_type survives the split");
  check(proxy.decodeU16z(got[0][1], 2), "你好", "chat text survives the split");
  check(got[1][0], STOC_HS_PLAYER_ENTER, "second type");
  check(proxy.decodeU16z(got[1][1]), "RLX", "seat name");
  check(got[1][1][40], 0, "seat position");
}

// Byte-at-a-time is the worst case a socket can hand us.
{
  const got = [];
  const feed = proxy.makeSplitter((t, p) => got.push(t));
  const stream = Buffer.concat([frame(STOC_CHAT, chatPayload(0, "a")), frame(STOC_CHAT, chatPayload(7, "b"))]);
  for (const byte of stream) feed(Buffer.from([byte]));
  check(got, [STOC_CHAT, STOC_CHAT], "one byte at a time");
}

// A zero length field means the stream desynced; stop rather than spin forever.
{
  let calls = 0;
  const feed = proxy.makeSplitter(() => calls++);
  feed(Buffer.from([0, 0, 0x19, 1, 2, 3]));
  check(calls, 0, "a desynced stream produces no packets");
}

// Empty frames can't happen (length is 1 + payload) but must not throw if they do.
{
  const got = [];
  const feed = proxy.makeSplitter((t, p) => got.push(t));
  feed(frame(STOC_CHAT, Buffer.alloc(0)));
  check(got, [STOC_CHAT], "payload-less frame still yields its type");
}

/* ---------------- .yrp3d output -> the real extractor ---------------- */

const extractor = require("../_parser.js").loadExtractor();

const dir = mkdtempSync(join(tmpdir(), "yrp-proxy-"));
try {
  const rec = new proxy.Recorder(dir);
  // Seats fill in one at a time and get corrected mid-duel -- exactly the case
  // that used to break the extractor (it concatenated every name packet).
  rec.seats[0] = "RLX"; rec.nameDirty = true;
  rec.chat(0, "第一句");
  rec.seats[1] = "悠悠"; rec.nameDirty = true;
  rec.chat(1, "换人前");
  rec.seats[1] = "新人"; rec.nameDirty = true;
  rec.chat(1, "换人后");
  rec.chat(7, "观战路过");
  rec.chat(8, "Tip: 测试");
  rec.close();

  const r = extractor.extract(rec.name, new Uint8Array(readFileSync(rec.file)));
  check(r.ok, true, "the recorder's output parses as .yrp3d");
  check(r.seats, { 0: "RLX", 1: "新人" }, "latest name table wins");
  check(r.chats.length, 5, "all five messages survive");
  const names = r.chats.map((c) => `${c.who}/${c.kind}`);
  check(
    names,
    ["RLX/player", "新人/player", "新人/player", "观战者/observer", "LIGHTBLUE/tip"],
    "speaker labels and kinds"
  );
  check(r.chats.map((c) => c.msg), ["第一句", "换人前", "换人后", "观战路过", "Tip: 测试"], "text round-trip");
  // type 8 is labelled by its COLORS name -- that is what the shipped extractor
  // already does for MDPro3 files, so the proxy output stays consistent with it.
  // the seat index has to stay available for the tooltip even though the label hides it
  check(r.chats.filter((c) => c.kind === "player").map((c) => c.seat), [0, 1, 1], "seat indices");

  // A proxy file with no chat at all (just a name table) must still be valid.
  const empty = new proxy.Recorder(dir);
  empty.seats[0] = "一个人"; empty.nameDirty = true;
  empty.flushNames();
  empty.close();
  const e = extractor.extract(empty.name, new Uint8Array(readFileSync(empty.file)));
  check(e.ok, true, "a chat-less recording parses");
  check(e.chats.length, 0, "and has no chat");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\nFAILED (${fail})` : "\nall good");
process.exit(fail ? 1 : 0);
