"""Trace logo silhouette from PNG reference into SVG (vector trace, not hand-drawn)."""
from __future__ import annotations

import os
import re
import xml.etree.ElementTree as ET

import cv2
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "icons", "icon-source.png")
OUT_LIGHT = os.path.join(ROOT, "icons", "logo.svg")
OUT_DARK = os.path.join(ROOT, "icons", "logo-dark.svg")
OUT_FAVICON = os.path.join(ROOT, "icons", "favicon.svg")
REF_LIGHT = os.path.join(ROOT, "icons", "icon-reference-light.png")
DEBUG_OVERLAY = os.path.join(ROOT, "icons", "trace-overlay-light.png")
VIEW = 1024
CORNER_R = 228


def _squircle_path(size: int, radius: float) -> str:
    r = radius
    s = size
    return (
        f"M {r} 0 H {s - r} "
        f"C {s} 0 {s} 0 {s} {r} "
        f"V {s - r} "
        f"C {s} {s} {s} {s} {s - r} {s} "
        f"H {r} "
        f"C 0 {s} 0 {s} 0 {s - r} "
        f"V {r} "
        f"C 0 0 0 0 {r} 0 Z"
    )


def _square_reference_from_half(rgb: np.ndarray, dark_logo: bool) -> np.ndarray:
    h, w = rgb.shape[:2]
    half = w // 2
    crop_rgb = rgb[:, half:w] if dark_logo else rgb[:, 0:half]
    gray = cv2.cvtColor(crop_rgb, cv2.COLOR_RGB2GRAY)
    if dark_logo:
        mask = ((gray < 235) & (gray > 15)).astype(np.uint8) * 255
    else:
        mask = ((gray < 245) & (gray > 10)).astype(np.uint8) * 255
    coords = cv2.findNonZero(mask)
    if coords is None:
        return cv2.resize(gray, (VIEW, VIEW), interpolation=cv2.INTER_AREA)
    x, y, bw, bh = cv2.boundingRect(coords)
    pad = 6
    x0 = max(0, x - pad)
    y0 = max(0, y - pad)
    x1 = min(gray.shape[1], x + bw + pad)
    y1 = min(gray.shape[0], y + bh + pad)
    cropped = gray[y0:y1, x0:x1]
    side = max(cropped.shape[0], cropped.shape[1])
    canvas = np.full((side, side), 255 if not dark_logo else 0, dtype=np.uint8)
    cy = (side - cropped.shape[0]) // 2
    cx = (side - cropped.shape[1]) // 2
    canvas[cy : cy + cropped.shape[0], cx : cx + cropped.shape[1]] = cropped
    return cv2.resize(canvas, (VIEW, VIEW), interpolation=cv2.INTER_AREA)


def _build_reference_png(gray: np.ndarray, dark_logo: bool) -> np.ndarray:
    if dark_logo:
        rgb = cv2.cvtColor(gray, cv2.COLOR_GRAY2RGB)
    else:
        rgb = cv2.cvtColor(gray, cv2.COLOR_GRAY2RGB)
    return rgb


def _logo_mask(gray: np.ndarray, dark_logo: bool) -> np.ndarray:
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    if dark_logo:
        _, logo = cv2.threshold(blur, 190, 255, cv2.THRESH_BINARY)
        logo = cv2.medianBlur(logo, 3)
    else:
        _, logo = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        logo = cv2.medianBlur(logo, 3)

    num, labels, stats, _ = cv2.connectedComponentsWithStats(logo, connectivity=8)
    if num <= 1:
        return logo
    best = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    cleaned = np.zeros_like(logo)
    cleaned[labels == best] = 255
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, kernel, iterations=1)
    return cleaned


def _contour_to_path(contour: np.ndarray, epsilon: float) -> str:
    approx = cv2.approxPolyDP(contour, epsilon, True)
    pts = approx.reshape(-1, 2)
    if len(pts) < 4:
        raise RuntimeError("contour simplify failed")
    parts = [f"M {pts[0][0]:.2f} {pts[0][1]:.2f}"]
    for x, y in pts[1:]:
        parts.append(f"L {x:.2f} {y:.2f}")
    parts.append("Z")
    return " ".join(parts)


def _trace_logo_path(gray: np.ndarray, dark_logo: bool) -> tuple[str, np.ndarray, float, np.ndarray]:
    logo = _logo_mask(gray, dark_logo)
    contours, _ = cv2.findContours(logo, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        raise SystemExit("no logo contour found")
    contour = max(contours, key=cv2.contourArea)

    best_path = ""
    best_iou = 0.0
    best_fill = None
    for eps in (0.45, 0.65, 0.85, 1.05, 1.35):
        path = _contour_to_path(contour, eps)
        fill = _rasterize_ml_path(path)
        iou = _iou(fill, logo)
        if iou > best_iou:
            best_iou = iou
            best_path = path
            best_fill = fill
    if best_fill is None:
        raise SystemExit("trace failed")
    return best_path, best_fill, best_iou, logo


def _parse_ml_numbers(d: str) -> list[tuple[str, float, float]]:
    tokens = re.findall(r"[MLZ]|[-+]?(?:\d*\.\d+|\d+)", d)
    pts: list[tuple[str, float, float]] = []
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
        pts.append((cmd, x, y))
        cmd = "L"
        i += 2
    return pts


def _rasterize_ml_path(d: str, size: int = VIEW) -> np.ndarray:
    canvas = np.zeros((size, size), dtype=np.uint8)
    parsed = _parse_ml_numbers(d)
    if not parsed:
        return canvas
    poly = np.array([[x, y] for _c, x, y in parsed], dtype=np.int32)
    cv2.fillPoly(canvas, [poly], 255)
    return canvas


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    inter = np.logical_and(a > 0, b > 0).sum()
    union = np.logical_or(a > 0, b > 0).sum()
    return float(inter) / float(union) if union else 0.0


def _write_svg(path: str, bg: str, fg: str, logo_path: str) -> None:
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VIEW} {VIEW}" role="img" aria-label="WorshipApp logo">',
        "  <title>WorshipApp logo</title>",
        f'  <path fill="{bg}" d="{_squircle_path(VIEW, CORNER_R)}"/>',
        f'  <path fill="{fg}" d="{logo_path}"/>',
        "</svg>",
    ]
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")


def main() -> None:
    src = np.array(Image.open(SOURCE).convert("RGB"))
    light_gray = _square_reference_from_half(src, dark_logo=False)
    dark_gray = _square_reference_from_half(src, dark_logo=True)

    Image.fromarray(_build_reference_png(light_gray, False)).save(REF_LIGHT)

    light_path, light_fill, light_iou, light_mask = _trace_logo_path(light_gray, False)
    dark_path, dark_fill, dark_iou, dark_mask = _trace_logo_path(dark_gray, True)

    _write_svg(OUT_LIGHT, "#FFFFFF", "#000000", light_path)
    _write_svg(OUT_FAVICON, "#FFFFFF", "#000000", light_path)
    _write_svg(OUT_DARK, "#000000", "#FFFFFF", dark_path)

    overlay = np.zeros((VIEW, VIEW, 3), dtype=np.uint8)
    overlay[..., 1] = light_mask
    overlay[..., 2] = light_fill
    cv2.imwrite(DEBUG_OVERLAY, overlay)

    print(f"light IoU={light_iou:.4f}")
    print(f"dark IoU={dark_iou:.4f}")
    print("wrote:", OUT_LIGHT, OUT_FAVICON, OUT_DARK, REF_LIGHT, DEBUG_OVERLAY)


if __name__ == "__main__":
    main()
