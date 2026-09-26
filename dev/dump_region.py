import struct, sys, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

path = sys.argv[1]
lo = int(sys.argv[2], 0)
hi = int(sys.argv[3], 0)
d = open(path, "rb").read()
print("size:", len(d), " dumping 0x%x..0x%x" % (lo, hi))

print("\n--- hex (16 per row, ascii right) ---")
for base in range(lo, min(hi, len(d)), 16):
    row = d[base:base + 16]
    hx = " ".join("%02x" % b for b in row)
    asc = "".join(chr(b) if 0x20 <= b <= 0x7e else "." for b in row)
    print("  %04x  %-47s  %s" % (base, hx, asc))

print("\n--- as uint32/uint16 at each offset from lo ---")
for off in range(lo, min(hi, len(d)) - 4, 2):
    u16 = struct.unpack_from("<H", d, off)[0]
    u32 = struct.unpack_from("<I", d, off)[0]
    txt = d[off:off + 24].decode("utf-16-le", "replace")
    txt = "".join(c if c.isprintable() else "." for c in txt)
    print("  +0x%04x  u16=%-6d u32=%-11d  utf16=%r" % (off, u16, u32, txt))
