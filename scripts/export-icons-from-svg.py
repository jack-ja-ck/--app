"""Export favicon / PWA PNG / ICO assets from icons/logo.svg."""
from __future__ import annotations

import os
import re
import struct
import xml.etree.ElementTree as ET
import zlib

import cv2
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, "icons")
SOURCE_SVG = os.path.join(ICONS, "logo.svg")
VIEW = 1024

EXPORTS: list[tuple[str, int]] = [
    ("favicon-16x16.png", 16),
    ("favicon-32x32.png", 32),
    ("favicon-48x48.png", 48),
    ("apple-touch-icon.png", 180),
    ("android-chrome-192x192.png", 192),
    ("android-chrome-512x512.png", 512),
]


def _parse_ml_path(d: str) -> np.ndarray:
    tokens = re.findall(r"[MLZ]|[-+]?(?:\d*\.\d+|\d+)", d)
    points: list[list[float]] = []
    i = 0
    cmd = "M"
    while i < len(tokens):
        t = tokens[i]
        if t in ("M", "L", "Z"):
            cmd = t
            i += 1
            if cmd == "Z":
                continue
            continue
        if i + 1 >= len(tokens):
            break
        x = float(tokens[i])
        y = float(tokens[i + 1])
        if cmd == "M" or len(points) == 0:
            points.append([x, y])
        else:
            points.append([x, y])
        cmd = "L"
        i += 2
    return np.array(points, dtype=np.float64)


def _read_logo_path() -> str:
    tree = ET.parse(SOURCE_SVG)
    root = tree.getroot()
    ns = {"svg": "http://www.w3.org/2000/svg"}
    paths = root.findall(".//svg:path", ns)
    if len(paths) < 2:
        paths = root.findall(".//{http://www.w3.org/2000/svg}path")
    if len(paths) < 2:
        raise SystemExit("logo.svg must contain background + logo paths")
    for p in paths:
        if (p.get("fill") or "").lower() == "#000000":
            return p.get("d") or ""
    return paths[1].get("d") or ""


def _render_png(size: int, logo_d: str) -> Image.Image:
    scale = size / VIEW
    pts = _parse_ml_path(logo_d)
    scaled = np.round(pts * scale).astype(np.int32)
    canvas = np.full((size, size, 3), 255, dtype=np.uint8)
    if scaled.shape[0] >= 3:
        cv2.fillPoly(canvas, [scaled], (0, 0, 0))
    return Image.fromarray(canvas, mode="RGB")


def _write_png(path: str, img: Image.Image) -> None:
    img.save(path, format="PNG", optimize=True)


def _write_ico(path: str, sizes: list[int], images: dict[int, Image.Image]) -> None:
    entries = []
    for s in sizes:
        img = images[s].convert("RGBA")
        img.save(os.path.join(ICONS, f"_tmp_{s}.png"))
        with open(os.path.join(ICONS, f"_tmp_{s}.png"), "rb") as f:
            png = f.read()
        entries.append((s, png))
    for s in sizes:
        try:
            os.remove(os.path.join(ICONS, f"_tmp_{s}.png"))
        except OSError:
            pass

    # Build ICO with embedded PNGs (Vista+ format)
    offset = 6 + 16 * len(entries)
    header = struct.pack("<HHH", 0, 1, len(entries))
    dir_entries = b""
    data = b""
    for s, png in entries:
        w = 0 if s >= 256 else s
        h = 0 if s >= 256 else s
        dir_entries += struct.pack(
            "<BBBBHHII",
            w,
            h,
            0,
            0,
            1,
            32,
            len(png),
            offset,
        )
        data += png
        offset += len(png)
    with open(path, "wb") as f:
        f.write(header + dir_entries + data)


def main() -> None:
    if not os.path.isfile(SOURCE_SVG):
        raise SystemExit(f"missing {SOURCE_SVG}")
    logo_d = _read_logo_path()
    rendered: dict[int, Image.Image] = {}

    for filename, size in EXPORTS:
        img = _render_png(size, logo_d)
        out = os.path.join(ICONS, filename)
        _write_png(out, img)
        rendered[size] = img
        print("wrote", out)

    ico_path = os.path.join(ICONS, "favicon.ico")
    ico_sizes = [16, 32, 48]
    _write_ico(ico_path, ico_sizes, rendered)
    print("wrote", ico_path)


if __name__ == "__main__":
    main()
