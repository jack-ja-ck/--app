"""One-off: write minimal solid PNGs for Web App Manifest (theme #0a0f1f)."""
import os
import struct
import zlib


def _chunk(typ: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + typ + data + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)


def write_solid_png(path, w, h, rgb=(10, 15, 31)):
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    r, g, b = rgb
    row = bytes([0, r, g, b] * w)
    raw = row * h
    idat = zlib.compress(raw, 9)
    data = sig + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", idat) + _chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(data)


if __name__ == "__main__":
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    write_solid_png(os.path.join(root, "icon-192.png"), 192, 192)
    write_solid_png(os.path.join(root, "icon-512.png"), 512, 512)
    print("wrote icon-192.png, icon-512.png")
