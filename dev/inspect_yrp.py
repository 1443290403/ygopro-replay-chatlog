import lzma, struct, sys, os

path = sys.argv[1] if len(sys.argv) > 1 else "2026-09-25 13-10-37.yrp"
data = open(path, "rb").read()
print("file          :", path)
print("size          :", len(data))

rid, ver, flag, seed, datasize, start_time = struct.unpack_from("<6I", data, 0)
props = data[24:32]
print("id            : %08x (%s)" % (rid, data[0:4].decode('latin1')))
print("version       :", ver)
print("flag          : 0x%x  compressed=%s tag=%s decoded=%s single=%s uniform=%s" % (
    flag, bool(flag & 0x1), bool(flag & 0x2), bool(flag & 0x4), bool(flag & 0x8), bool(flag & 0x10)))
print("seed          :", seed)
print("datasize      : %d  (uncompressed replay_data)" % datasize)
print("start_time    :", start_time)
print("props         :", props.hex(), "-> lzma props byte 0x%02x, dict_size %d" % (
    props[0], struct.unpack_from("<I", props, 1)[0]))

# props[0] packs lc/lp/pb :  (pb*5 + lp)*9 + lc
p = props[0]
lc = p % 9; rest = p // 9
lp = rest % 5; pb = rest // 5
dict_size = struct.unpack_from("<I", props, 1)[0]
print("  lzma params : lc=%d lp=%d pb=%d dict=0x%x" % (lc, lp, pb, dict_size))

filters = [{"id": lzma.FILTER_LZMA1, "lc": lc, "lp": lp, "pb": pb, "dict_size": dict_size}]

# Raw LZMA1 with ext_flags=0 has NO end-of-stream marker just as the decoder runs
# out of input, and Python's FORMAT_RAW cannot be told the expected size.
# Workaround: wrap it in a legacy .lzma ("alone") container whose header carries
# the uncompressed size -- liblzma then stops exactly there, no end marker needed.
raw = None
for hdr_size in (80, 76, 84, 72, 64):
    if hdr_size >= len(data):
        continue
    alone = bytes([props[0]]) + struct.pack("<I", dict_size) + struct.pack("<Q", datasize) + data[hdr_size:]
    try:
        out = lzma.decompress(alone, format=lzma.FORMAT_ALONE)
        print("\n*** DECOMPRESSED OK: header_size=%d -> %d bytes (header claims %d)" % (
            hdr_size, len(out), datasize))
        raw = out[:datasize]
        break
    except Exception as e:
        print("header_size=%d -> %s" % (hdr_size, e))

if raw is None:
    sys.exit(1)

open("_replay_data.bin", "wb").write(raw)
print("raw replay_data dumped to _replay_data.bin")

# ---- structure ----
def dec_name(b):
    # protocol carries names as 40 bytes of UTF-16LE (20 chars), null padded
    return b.decode("utf-16-le", "replace").split("\x00")[0]

print("\nplayer0 name  : %r" % dec_name(raw[0:40]))
print("player1 name  : %r" % dec_name(raw[40:80]))
o = 80
sl, sh, dc, opt = struct.unpack_from("<4i", raw, o)
print("start_lp=%d start_hand=%d draw_count=%d duel_rule=%d opt=0x%x" % (sl, sh, dc, (opt >> 16), opt))
o += 16

# decks: for each of 4 (main0, extra0, main1, extra1): int32 count + count*int32 codes
for label in ("deck0 main", "deck0 extra", "deck1 main", "deck1 extra"):
    if o + 4 > len(raw):
        break
    n = struct.unpack_from("<i", raw, o)[0]
    o += 4
    if n < 0 or n > 200 or o + 4 * n > len(raw):
        print("%-12s : INVALID count=%d (stop; rest is response stream)" % (label, n))
        break
    codes = struct.unpack_from("<%dI" % n, raw, o) if n else ()
    o += 4 * n
    print("%-12s : %2d cards %s" % (label, n, [hex(c) for c in codes[:8]]))

print("\n---- remaining %d bytes (anchor @0x%x) ----" % (len(raw) - o, o))
rest = raw[o:]

# scan for ascii-ish strings (chat would show up here)
print("\nprintable runs >=3 chars in the WHOLE raw data:")
import re
for m in re.finditer(rb"[\x20-\x7e]{3,}", raw):
    print("  @0x%04x  %r" % (m.start(), m.group().decode()))

print("\nbyte histogram of remaining stream (top tokens):")
from collections import Counter
c = Counter(rest)
print(" ", c.most_common(12))
print("  0x19 (STOC_CHAT) occurrences in whole raw:", raw.count(b"\x19"))
