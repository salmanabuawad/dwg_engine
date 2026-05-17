from __future__ import annotations

from pathlib import Path
import math

import ezdxf
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Polygon

from app.engine.geometry.line_registry import extract_lines_from_doc
from app.engine.isolation.main_plan_isolation import isolate_architectural_lines, bbox_from_lines


# Dimension annotations sit ON the architectural plan. Building walls
# stay solid black at 0.75 line weight so the structure reads first;
# dimensions render in a per-job-configurable colour (defaults to a
# mid-grey) at thinner line weights so they annotate without competing
# for visual hierarchy.
DEFAULT_DIM_COLOR = "#7a7a7a"


def _valid_hex_color(value: str | None) -> str:
    """Return value if it looks like a 7-char hex colour, else the default.
    Defensive — the API validates too, but the renderer accepts anything
    a caller passes and falls back gracefully."""
    if not isinstance(value, str):
        return DEFAULT_DIM_COLOR
    s = value.strip()
    if len(s) != 7 or not s.startswith("#"):
        return DEFAULT_DIM_COLOR
    hexpart = s[1:]
    if all(c in "0123456789abcdefABCDEF" for c in hexpart):
        return s
    return DEFAULT_DIM_COLOR


def _mtext_plain(text: str) -> str:
    if not text:
        return ""
    out = text.replace("\\P", "\n").replace("\\~", " ")
    while "\\f" in out:
        i = out.find("\\f")
        j = out.find(";", i)
        if j < 0:
            break
        out = out[:i] + out[j + 1 :]
    return out


def _architectural_preview_bbox(doc):
    lines = [l for l in extract_lines_from_doc(doc) if l.orientation in ("H", "V") and l.length >= 30]
    arch, _ = isolate_architectural_lines(lines)
    if arch:
        return bbox_from_lines(arch), arch
    if lines:
        return bbox_from_lines(lines), lines
    return (0, 0, 1, 1), []


DEFAULT_ARROW_DIRECTION = "in"


def _valid_arrow_direction(value: str | None) -> str:
    if isinstance(value, str) and value.strip().lower() in ("in", "out"):
        return value.strip().lower()
    return DEFAULT_ARROW_DIRECTION


def render_dxf_preview(dxf_path: Path, output_png: Path, output_pdf: Path | None = None,
                       *, dim_color: str | None = None,
                       arrow_direction: str | None = None) -> bool:
    dim_color = _valid_hex_color(dim_color)
    arrow_direction = _valid_arrow_direction(arrow_direction)
    # "in":  arrowheads point toward each other across the dimension line
    # "out": arrowheads flip and point outward (architectural tick style)
    arrow_flip = -1 if arrow_direction == "out" else 1
    doc = ezdxf.readfile(str(dxf_path))
    msp = doc.modelspace()
    segs = []
    dims = []
    texts = []

    arch_bbox, arch_lines = _architectural_preview_bbox(doc)
    axlo, aylo, axhi, ayhi = arch_bbox
    aw, ah = max(1.0, axhi - axlo), max(1.0, ayhi - aylo)

    def in_arch_area(x, y, pad_factor=0.25):
        pad = max(aw, ah) * pad_factor
        return axlo - pad <= x <= axhi + pad and aylo - pad <= y <= ayhi + pad

    def add_seg(x1, y1, x2, y2, layer):
        if math.hypot(x2 - x1, y2 - y1) > 1e-6:
            # Suppress page-frame lines far outside architectural cluster.
            if in_arch_area((x1 + x2) / 2.0, (y1 + y2) / 2.0):
                segs.append((float(x1), float(y1), float(x2), float(y2), layer))

    for e in msp:
        t = e.dxftype()
        layer = getattr(e.dxf, "layer", "")

        try:
            if t == "LINE":
                a, b = e.dxf.start, e.dxf.end
                add_seg(a.x, a.y, b.x, b.y, layer)
            elif t == "LWPOLYLINE":
                pts = [(p[0], p[1]) for p in e.get_points()]
                if e.closed and pts:
                    pts.append(pts[0])
                for a, b in zip(pts, pts[1:]):
                    add_seg(a[0], a[1], b[0], b[1], layer)
            elif t == "POLYLINE":
                pts = [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
                if e.is_closed and pts:
                    pts.append(pts[0])
                for a, b in zip(pts, pts[1:]):
                    add_seg(a[0], a[1], b[0], b[1], layer)
            elif t == "DIMENSION":
                p1 = e.dxf.defpoint2
                p2 = e.dxf.defpoint3
                bp = e.dxf.defpoint
                if not in_arch_area(bp.x, bp.y, pad_factor=0.45):
                    continue
                angle = float(getattr(e.dxf, "angle", 0) or 0)
                is_h = abs(angle) < 45 or abs(angle - 180) < 45
                length = abs(p2.x - p1.x) if is_h else abs(p2.y - p1.y)
                dims.append({
                    "p1": (float(p1.x), float(p1.y)),
                    "p2": (float(p2.x), float(p2.y)),
                    "base": (float(bp.x), float(bp.y)),
                    "ori": "H" if is_h else "V",
                    "length": float(length),
                })
            elif t == "TEXT":
                p = e.dxf.insert
                content = (e.dxf.text or "").strip()
                if content and in_arch_area(p.x, p.y, pad_factor=0.15):
                    texts.append({"x": float(p.x), "y": float(p.y), "text": content})
            elif t == "MTEXT":
                p = e.dxf.insert
                content = _mtext_plain((e.text if hasattr(e, "text") else "") or "").strip()
                if content and in_arch_area(p.x, p.y, pad_factor=0.15):
                    texts.append({"x": float(p.x), "y": float(p.y), "text": content})
        except Exception:
            pass

    xs, ys = [], []
    for x1, y1, x2, y2, layer in segs:
        if "DIM" not in layer.upper():
            xs += [x1, x2]
            ys += [y1, y2]
    for d in dims:
        xs += [d["p1"][0], d["p2"][0], d["base"][0]]
        ys += [d["p1"][1], d["p2"][1], d["base"][1]]
    for t in texts:
        xs.append(t["x"])
        ys.append(t["y"])

    if not xs:
        fig, ax = plt.subplots(figsize=(14, 10), facecolor="white")
        ax.text(0.5, 0.5, "(empty drawing)", fontsize=14, ha="center", va="center", transform=ax.transAxes, color="#94a3b8")
        ax.axis("off")
        output_png.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(output_png, dpi=200, bbox_inches="tight", facecolor="white")
        if output_pdf:
            fig.savefig(output_pdf, dpi=200, bbox_inches="tight", facecolor="white")
        plt.close(fig)
        return True

    xlo, xhi = (np.percentile(xs, [1, 99]) if len(xs) >= 4 else (min(xs), max(xs)))
    ylo, yhi = (np.percentile(ys, [1, 99]) if len(ys) >= 4 else (min(ys), max(ys)))
    if xhi - xlo < 1e-6:
        xhi = xlo + 1.0
    if yhi - ylo < 1e-6:
        yhi = ylo + 1.0

    width, height = xhi - xlo, yhi - ylo
    base = max(1.0, min(width, height))
    pad = max(width, height) * 0.18

    fig, ax = plt.subplots(figsize=(14, 10), facecolor="white")

    for x1, y1, x2, y2, layer in segs:
        if "DIM" not in layer.upper() and "NAVVIX" not in layer.upper():
            ax.plot([x1, x2], [y1, y2], color="black", linewidth=0.75)

    def draw_arrow(tip, direction, size):
        x, y = tip
        dx, dy = direction
        n = math.hypot(dx, dy)
        if n == 0:
            return
        dx, dy = dx / n, dy / n
        px, py = -dy, dx
        pts = np.array([
            [x, y],
            [x - dx * size + px * size * 0.35, y - dy * size + py * size * 0.35],
            [x - dx * size - px * size * 0.35, y - dy * size - py * size * 0.35],
        ])
        ax.add_patch(Polygon(pts, closed=True, facecolor=dim_color, edgecolor=dim_color, linewidth=0.15))

    arrow_size = max(8, base * 0.004)
    text_offset = max(12, base * 0.007)

    for d in dims:
        p1, p2, bp = d["p1"], d["p2"], d["base"]
        if d["ori"] == "H":
            ax.plot([p1[0], p2[0]], [bp[1], bp[1]], color=dim_color, linewidth=0.30)
            ax.plot([p1[0], p1[0]], [p1[1], bp[1]], color=dim_color, linewidth=0.18)
            ax.plot([p2[0], p2[0]], [p2[1], bp[1]], color=dim_color, linewidth=0.18)
            draw_arrow((p1[0], bp[1]), (arrow_flip * 1, 0), arrow_size)
            draw_arrow((p2[0], bp[1]), (arrow_flip * -1, 0), arrow_size)
            side = 1 if bp[1] >= (ylo + yhi) / 2 else -1
            ax.text((p1[0] + p2[0]) / 2, bp[1] + side * text_offset, str(int(round(d["length"]))), fontsize=4.5, ha="center", va="center", color=dim_color)
        else:
            ax.plot([bp[0], bp[0]], [p1[1], p2[1]], color=dim_color, linewidth=0.30)
            ax.plot([p1[0], bp[0]], [p1[1], p1[1]], color=dim_color, linewidth=0.18)
            ax.plot([p2[0], bp[0]], [p2[1], p2[1]], color=dim_color, linewidth=0.18)
            draw_arrow((bp[0], p1[1]), (0, arrow_flip * 1), arrow_size)
            draw_arrow((bp[0], p2[1]), (0, arrow_flip * -1), arrow_size)
            side = 1 if bp[0] >= (xlo + xhi) / 2 else -1
            ax.text(bp[0] + side * text_offset, (p1[1] + p2[1]) / 2, str(int(round(d["length"]))), fontsize=4.5, rotation=90, ha="center", va="center", color=dim_color)

    text_fontsize = max(5.0, min(10.0, base * 0.010))
    for t in texts:
        ax.text(t["x"], t["y"], t["text"], fontsize=text_fontsize, ha="left", va="bottom", color="#0f172a")

    ax.set_xlim(xlo - pad, xhi + pad)
    ax.set_ylim(ylo - pad, yhi + pad)
    ax.set_aspect("equal")
    ax.axis("off")

    output_png.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_png, dpi=260, bbox_inches="tight", facecolor="white")
    if output_pdf:
        fig.savefig(output_pdf, dpi=300, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return True
