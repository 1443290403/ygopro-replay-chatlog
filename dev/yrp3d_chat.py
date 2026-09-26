#!/usr/bin/env python3
"""
yrp3d_chat.py -- extract chat logs from MDPro3 / YGOPro-Unity .yrp3d replays.

Usage:
    python yrp3d_chat.py *.yrp3d              # writes <name>_chat.txt into out/
    python yrp3d_chat.py -c *.yrp3d           # also write one combined log
    python yrp3d_chat.py --json f.yrp3d       # machine-readable output
    python yrp3d_chat.py -o D:\\logs *.yrp3d   # write somewhere else
    python yrp3d_chat.py --here *.yrp3d       # write next to each input file

Per-file logs default to the tool's own out/ directory, so running this against
replays that live in the workspace root does not scatter _chat.txt through it.

Container format (verified against real files, packet chain must hit EOF exactly):
    uint8  packet type
    uint32 payload length   (little-endian)
    uint8[length] payload
...repeated until EOF. No magic, no version, no checksum.

Packet types used here:
    230  sibyl_chat    -> uint32 player_type + utf16le NUL-terminated message
    231  sibyl_replay  -> a complete standard .yrp/.yrp2 byte stream (optional)
    235  sibyl_name    -> name slots, 100 bytes each, followed by uint32 count
"""
import glob
import io
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUTDIR = os.path.join(HERE, "out")

# Windows consoles default to GBK; force UTF-8 so CJK chat text survives printing.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SIBYL_CHAT = 230
SIBYL_REPLAY = 231
SIBYL_NAME = 235

# chat "player_type" semantics, from srvpro's data/constants.json COLORS
COLORS = {8: "LIGHTBLUE", 11: "RED", 12: "GREEN", 13: "BLUE", 14: "BABYBLUE",
          15: "PINK", 16: "YELLOW", 17: "WHITE", 18: "GRAY", 19: "DARKGRAY"}
SEAT_LIMIT = 4


def u16z(b):
    """decode a NUL-terminated UTF-16LE string"""
    out = []
    for i in range(0, len(b) - 1, 2):
        c = b[i] | (b[i + 1] << 8)
        if c == 0:
            break
        out.append(chr(c))
    return "".join(out)


def parse_packets(d):
    """walk the packet stream; raises ValueError if it doesn't chain to EOF"""
    packets, o = [], 0
    while o < len(d):
        if o + 5 > len(d):
            raise ValueError("truncated packet header at 0x%x" % o)
        ptype = d[o]
        length = struct.unpack_from("<I", d, o + 1)[0]
        if o + 5 + length > len(d):
            raise ValueError("packet @0x%x type=%d claims %d bytes, only %d left"
                             % (o, ptype, length, len(d) - o - 5))
        packets.append((o, ptype, d[o + 5:o + 5 + length]))
        o += 5 + length
    return packets


def read_names(packets):
    """name slots from the type-235 packet.

    Layout observed across files: [p0, '---', p0, p1, '---', p1] -- the last
    4 bytes hold the slot count. Both empty ('---') slots are placeholders.
    """
    slots = []
    for _, t, pl in packets:
        if t == SIBYL_NAME:
            for i in range(0, len(pl) - 99, 100):
                slots.append(u16z(pl[i:i + 100]))
    return slots


def seat_names(slots):
    """map seat index -> name, using the observed [p0,-,p0,p1,-,p1] layout"""
    real = [s for s in slots if s and s != "---"]
    p0 = slots[0] if len(slots) > 0 and slots[0] != "---" else (real[0] if real else "P0")
    p1 = slots[3] if len(slots) > 3 and slots[3] != "---" else (
        real[1] if len(real) > 1 else p0)
    return {0: p0, 1: p1}


def label(ptype, seats):
    if ptype in seats:
        # seats can share a display name (both slots literally "RLX"), so always
        # carry the seat index -- otherwise two speakers are indistinguishable.
        return "%s(%d)" % (seats[ptype], ptype)
    if ptype < SEAT_LIMIT:
        return "seat%d" % ptype
    if ptype >= 10:
        return "SERVER"
    return COLORS.get(ptype, "sys%d" % ptype)


def sniff(d):
    """standard .yrp carries an ASCII magic; .yrp3d has none and starts with a packet"""
    return "yrp" if d[:4] in (b"yrp1", b"yrp2", b"yrp3") else "yrp3d"


def extract(path):
    d = open(path, "rb").read()

    # A standard .yrp is not a packet stream at all -- walking it would produce a
    # bogus packet error instead of the honest "this format has no chat".
    if sniff(d) == "yrp":
        return {
            "file": path, "size": len(d), "kind": "yrp", "packets": 0,
            "name_slots": [], "seats": None, "chats": [],
            "has_embedded_replay": False, "embedded_replay_size": 0,
            "warning": "标准 .yrp 录像不含对话记录",
        }

    packets = parse_packets(d)
    slots = read_names(packets)
    seats = seat_names(slots)
    chats = []
    for off, t, pl in packets:
        if t == SIBYL_CHAT and len(pl) >= 6:
            chats.append({
                "offset": off,
                "player_type": struct.unpack_from("<I", pl, 0)[0],
                "msg": u16z(pl[4:]),
            })
    for c in chats:
        c["who"] = label(c["player_type"], seats)
    inner = next((pl for _, t, pl in packets if t == SIBYL_REPLAY), None)
    return {
        "file": path,
        "size": len(d),
        "kind": "yrp3d",
        "packets": len(packets),
        "name_slots": slots,
        "seats": seats,
        "chats": chats,
        "has_embedded_replay": inner is not None,
        "embedded_replay_size": len(inner) if inner else 0,
    }


def main(argv):
    as_json = "--json" in argv
    combined = "-c" in argv or "--combined" in argv

    # --here keeps the old behaviour of dropping <name>_chat.txt beside each input
    here = "--here" in argv
    outdir = DEFAULT_OUTDIR
    if "-o" in argv:
        outdir = argv[argv.index("-o") + 1]
    elif "--outdir" in argv:
        outdir = argv[argv.index("--outdir") + 1]
    if not here:
        os.makedirs(outdir, exist_ok=True)

    args = [a for a in argv if not a.startswith("-")]
    # drop the argument that belonged to -o/--outdir
    if "-o" in argv or "--outdir" in argv:
        flag = "-o" if "-o" in argv else "--outdir"
        i = argv.index(flag)
        if i + 1 < len(argv) and argv[i + 1] in args:
            args.remove(argv[i + 1])

    paths = []
    for a in args:
        paths.extend(sorted(glob.glob(a)))
    if not paths:
        print(__doc__)
        return 1

    def dest(src):
        if here:
            return src.rsplit(".", 1)[0] + "_chat.txt"
        base = os.path.basename(src).rsplit(".", 1)[0]
        return os.path.join(outdir, base + "_chat.txt")

    def show(path):
        # relpath raises when cwd and target sit on different Windows drives
        try:
            return os.path.relpath(path, os.getcwd())
        except ValueError:
            return path

    all_rows = []
    for p in paths:
        try:
            r = extract(p)
        except Exception as e:
            print("!! %s: %s" % (p, e))
            continue
        all_rows.append(r)
        if as_json:
            continue

        print("=" * 68)
        print(r["file"])
        if r["kind"] == "yrp":
            print("  %d bytes — %s" % (r["size"], r["warning"]))
            continue
        print("  %d bytes, %d packets%s" % (
            r["size"], r["packets"],
            ", embedded yrp2: %d bytes" % r["embedded_replay_size"]
            if r["has_embedded_replay"] else ", no embedded yrp2"))
        print("  seats: 0=%s  1=%s" % (r["seats"][0], r["seats"][1]))
        if not r["chats"]:
            print("  (no chat)")
            continue
        print("  %d chat message(s):" % len(r["chats"]))
        for c in r["chats"]:
            print("    %-9s %s" % (c["who"] + ":", c["msg"]))

        out = dest(p)
        with open(out, "w", encoding="utf-8") as f:
            for c in r["chats"]:
                f.write("%s: %s\n" % (c["who"], c["msg"]))
        print("  -> %s" % show(out))

    if as_json:
        print(json.dumps(all_rows, ensure_ascii=False, indent=2))
    elif combined:
        out = os.path.join(os.path.dirname(dest(paths[0])), "_all_chat.txt")
        with open(out, "w", encoding="utf-8") as f:
            for r in all_rows:
                f.write("### %s\n" % r["file"])
                for c in r["chats"]:
                    f.write("%s: %s\n" % (c["who"], c["msg"]))
                f.write("\n")
        print("\ncombined log -> %s" % show(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
