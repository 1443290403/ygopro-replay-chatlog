"""
.yrp3d (MDPro3 / YGOPro-Unity replay) packet walker + chat extractor.

Container format (from ygopro-yrp3d-encode):
    uint8  packet type
    uint32 payload length   (little-endian)
    uint8[length] payload
...repeated until EOF. No magic, no version, no checksum.

Packet types:
    <low ids>   raw ocgcore GameMessage ids
    230  0xE6   sibyl_chat   -> uint32 player_type + utf16le NUL-terminated message
    231  0xE7   sibyl_replay -> a complete standard .yrp/.yrp2 byte stream
    235  0xEB   sibyl_name
    236  0xEC   sibyl_quit
"""
import struct, sys, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SIBYL_CHAT = 230
SIBYL_REPLAY = 231
SIBYL_NAME = 235
SIBYL_QUIT = 236

path = sys.argv[1] if len(sys.argv) > 1 else "09-25「13：09：46」.yrp3d"
d = open(path, "rb").read()
print("file: %s   size: %d\n" % (path, len(d)))


def utf16z(b):
    parts = []
    for i in range(0, len(b) - 1, 2):
        c = b[i] | (b[i + 1] << 8)
        if c == 0:
            break
        parts.append(chr(c))
    return "".join(parts)


# ---- walk the packet stream ----
packets = []
o = 0
while o < len(d):
    if o + 5 > len(d):
        print("!! truncated packet header at 0x%x" % o)
        break
    ptype = d[o]
    length = struct.unpack_from("<I", d, o + 1)[0]
    if o + 5 + length > len(d):
        print("!! packet @0x%x type=%d claims length %d but only %d bytes left"
              % (o, ptype, length, len(d) - o - 5))
        break
    packets.append((o, ptype, d[o + 5:o + 5 + length]))
    o += 5 + length

print("walked %d packets, ended at 0x%x of 0x%x  %s\n"
      % (len(packets), o, len(d), "** CLEAN EOF **" if o == len(d) else "** DESYNC **"))

from collections import Counter
c = Counter(p[1] for p in packets)
names = {SIBYL_CHAT: "sibyl_chat", SIBYL_REPLAY: "sibyl_replay",
         SIBYL_NAME: "sibyl_name", SIBYL_QUIT: "sibyl_quit"}
print("packets by type:")
for t, n in sorted(c.items()):
    print("   type %-4d %-14s x%d" % (t, names.get(t, "(GameMessage)"), n))

# ---- name packets ----
print("\n--- sibyl_name (235) ---")
for off, t, pl in packets:
    if t == SIBYL_NAME:
        print("  @0x%04x len=%d" % (off, len(pl)))
        for i in range(0, len(pl) - 99, 100):          # 100-byte name slots
            nm = utf16z(pl[i:i + 100])
            if nm:
                print("       slot %d: %r" % (i // 100, nm))

# ---- CHAT ----
print("\n--- sibyl_chat (230) ---")
chats = []
for off, t, pl in packets:
    if t != SIBYL_CHAT:
        continue
    if len(pl) < 6:
        print("  @0x%04x  too short: %s" % (off, pl.hex()))
        continue
    ptype = struct.unpack_from("<I", pl, 0)[0]
    msg = utf16z(pl[4:])
    chats.append((off, ptype, msg))
    print("  @0x%04x  player=%-3d  %r" % (off, ptype, msg))

print("\n>>> %d chat message(s) found" % len(chats))

# ---- embedded replay ----
print("\n--- sibyl_replay (231) ---")
for off, t, pl in packets:
    if t == SIBYL_REPLAY:
        magic = pl[:4]
        print("  @0x%04x  len=%d  inner magic=%r" % (off, len(pl), magic.decode("latin1")))
        if magic == b"yrp2":
            ver, flag, seed, dsize, stime = struct.unpack_from("<5I", pl, 4)
            print("        version=%d flag=0x%x datasize=%d" % (ver, flag, dsize))
        out = path.rsplit(".", 1)[0] + "_embedded.yrp"
        open(out, "wb").write(pl)
        print("        extracted -> %s" % out)

if chats:
    out = path.rsplit(".", 1)[0] + "_chat.txt"
    with open(out, "w", encoding="utf-8") as f:
        for off, ptype, msg in chats:
            f.write("p%d: %s\n" % (ptype, msg))
    print("\nchat log written -> %s" % out)
