// End-to-end check over real sockets: a fake srvpro, the real proxy, a fake
// client. Verifies three things the unit tests can't --
//   1. traffic is forwarded byte-for-byte (the proxy must be invisible to the duel)
//   2. the .yrp3d lands on disk when the connection closes
//   3. that file parses in chat-extractor.html with the right names and labels
//
//   node _test_e2e.mjs
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import net from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const proxy = require("./proxy.js");

let fail = 0;
const check = (got, want, what) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.log(`!! ${what} = ${a}, want ${b}`); fail++; }
};

const STOC_TYPE_CHANGE = 0x13, STOC_CHAT = 0x19;
const STOC_HS_PLAYER_ENTER = 0x20, STOC_HS_PLAYER_CHANGE = 0x21;
const CTOS_PLAYER_INFO = 0x10, CTOS_CHAT = 0x16;

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
const chat = (playerType, msg) => {
  const m = u16(msg);
  const b = Buffer.alloc(2 + m.length);
  b.writeUInt16LE(playerType, 0);
  m.copy(b, 2);
  return frame(STOC_CHAT, b);
};
const enter = (name, pos) => {
  const b = Buffer.alloc(41);
  u16(name).copy(b, 0, 0, 40);
  b[40] = pos;
  return frame(STOC_HS_PLAYER_ENTER, b);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (emitter, ev) => new Promise((r) => emitter.once(ev, r));

const outDir = mkdtempSync(join(tmpdir(), "yrp-e2e-"));

// ---- fake srvpro: greets, relays chat, echoes the client's own ----
const fromClient = [];
const server = net.createServer((sock) => {
  sock.on("data", (c) => {
    fromClient.push(Buffer.from(c));
    // echo a CTOS_CHAT back as STOC_CHAT with our seat, like the kernel does
    for (let o = 0; o + 3 <= c.length; ) {
      const len = c.readUInt16LE(o);
      if (len < 1 || o + len + 2 > c.length) break;
      if (c[o + 2] === CTOS_CHAT) {
        const msg = proxy.decodeU16z(c.subarray(o + 3, o + 2 + len));
        sock.write(chat(0, msg));
      }
      o += len + 2;
    }
  });
  // hello: I am seat 0, opponent is seat 1, and here comes a spectator
  sock.write(frame(STOC_TYPE_CHANGE, Buffer.from([0x00])));
  sock.write(enter("RLX", 0));
  sock.write(enter("新人", 1));
  sock.write(chat(1, "你好"));
  sock.write(chat(7, "围观一下"));
});

let prox = null;
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const remotePort = server.address().port;

  prox = proxy.start(
    { remoteHost: "127.0.0.1", remotePort, listenPort: 0, recordOwnChat: false },
    outDir
  );
  if (!prox.listening) await once(prox, "listening");
  const localPort = prox.address().port;

  // ---- fake client ----
  const client = net.connect(localPort, "127.0.0.1");
  const got = [];
  client.on("data", (c) => got.push(Buffer.from(c)));
  await once(client, "connect");

  const sent = Buffer.concat([
    frame(CTOS_PLAYER_INFO, u16("RLX")),
    frame(CTOS_CHAT, u16("大家好")),
  ]);
  client.write(sent);
  await wait(400);

  // 1. passthrough -- the server must see exactly what the client sent
  const seen = Buffer.concat(fromClient);
  check(seen.equals(sent), true, "client bytes reach the server unchanged");

  // 2. the client gets the server's greeting plus its own echo
  const back = Buffer.concat(got);
  check(back.includes(chat(1, "你好")), true, "server chat reaches the client");

  client.destroy();
  await once(client, "close");
  await wait(400);

  // 3. the recording
  const files = readdirSync(outDir).filter((f) => f.endsWith(".yrp3d"));
  check(files.length, 1, "exactly one recording for one connection");
  check(/^\d\d-\d\d「\d\d：\d\d：\d\d」\.yrp3d$/.test(files[0]), true, `filename shape (${files[0]})`);

  const extractor = require("../_parser.js").loadExtractor();
  const r = extractor.extract(files[0], new Uint8Array(readFileSync(join(outDir, files[0]))));

  check(r.ok, true, "the recording parses as .yrp3d");
  check(r.seats, { 0: "RLX", 1: "新人" }, "seat names resolved from 0x20 packets");
  check(
    r.chats.map((c) => `${c.who}/${c.kind}`),
    ["新人/player", "观战者/observer", "RLX/player"],
    "speakers: opponent, spectator, then my own echo"
  );
  check(r.chats.map((c) => c.msg), ["你好", "围观一下", "大家好"], "messages in order");
} finally {
  if (prox) prox.close();
  server.close();
  await wait(100);
  rmSync(outDir, { recursive: true, force: true });
}

console.log(fail ? `\nFAILED (${fail})` : "\nall good");
process.exit(fail ? 1 : 0);
