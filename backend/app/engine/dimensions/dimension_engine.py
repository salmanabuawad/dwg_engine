"""
Semantic dimension engine.

CLAUDE-GUARD:
Do not dimension every raw line.
Do not dimension full-sheet geometry.
Do not use page frames/title borders as bbox source.
Use architectural isolation first, then perimeter-first semantic spans.

IMPORTANT SMALL-DRAWING RULE:
If a split drawing is a small room/storage/block, it still must receive local
width and height dimensions. Never skip a valid architectural cluster only
because it is small.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import ezdxf
import numpy as np

from app.engine.geometry.line_registry import extract_lines_from_doc, LineSegment
from app.engine.isolation.main_plan_isolation import isolate_architectural_lines

def setup_dimstyle(doc: Any, style: str = "ISO-25") -> str:
    if style not in doc.dimstyles:
        doc.dimstyles.new(style)

    ds = doc.dimstyles.get(style)
    settings = {
        "dimtxt": 18.0,
        "dimasz": 18.0,
        "dimgap": 7.0,
        "dimtad": 1,
        "dimjust": 0,
        "dimtih": 0,
        "dimtoh": 0,
        "dimexe": 1.25,
        "dimexo": 0.625,
    }
    for k, v in settings.items():
        try:
            setattr(ds.dxf, k, v)
        except Exception:
            pass

    for k, v in [("dimtix", 0), ("dimtofl", 1), ("dimtmove", 1), ("dimatfit", 3)]:
        try:
            setattr(ds.dxf, k, v)
        except Exception:
            pass

    return style


def _line_to_edge(line: LineSegment) -> dict | None:
    if line.orientation == "H":
        a, b = sorted([line.x1, line.x2])
        c = (line.y1 + line.y2) / 2.0
        return {"ori": "H", "a": a, "b": b, "c": c, "len": b - a, "source": line.id}
    if line.orientation == "V":
        a, b = sorted([line.y1, line.y2])
        c = (line.x1 + line.x2) / 2.0
        return {"ori": "V", "a": a, "b": b, "c": c, "len": b - a, "source": line.id}
    return None


def semantic_edges(doc: Any) -> tuple[list[dict], tuple[float, float, float, float], float, dict]:
    all_lines = [
        l for l in extract_lines_from_doc(doc)
        if l.orientation in ("H", "V") and l.length >= 12
    ]

    architectural_lines, isolation = isolate_architectural_lines(all_lines)

    # Fallback: if isolation is too aggressive for tiny split drawings, keep all non-frame lines.
    if not architectural_lines and all_lines:
        architectural_lines = all_lines
        isolation["fallback_used"] = "all_lines_for_small_split"

    if not architectural_lines:
        return [], (0, 0, 1, 1), 1, isolation

    xs, ys = [], []
    raw = []

    for l in architectural_lines:
        edge = _line_to_edge(l)
        if edge is None:
            continue
        raw.append(edge)
        if edge["ori"] == "H":
            xs += [edge["a"], edge["b"]]
            ys.append(edge["c"])
        else:
            xs.append(edge["c"])
            ys += [edge["a"], edge["b"]]

    if not raw:
        return [], (0, 0, 1, 1), 1, isolation

    xlo, xhi = np.percentile(xs, [1, 99])
    ylo, yhi = np.percentile(ys, [1, 99])
    width, height = max(1.0, xhi - xlo), max(1.0, yhi - ylo)
    base = max(1.0, min(width, height))

    snap = max(4.0, base * 0.0025)

    def sv(v: float) -> float:
        return round(v / snap) * snap

    dedup = {}

    # For small split drawings, thresholds must be relaxed.
    min_len = max(20.0, base * 0.012)

    for e in raw:
        if e["len"] < min_len:
            continue

        key = (e["ori"], sv(e["c"]), sv(e["a"]), sv(e["b"]))
        if key not in dedup or e["len"] > dedup[key]["len"]:
            dedup[key] = {
                "ori": e["ori"],
                "a": sv(e["a"]),
                "b": sv(e["b"]),
                "c": sv(e["c"]),
                "len": abs(sv(e["b"]) - sv(e["a"])),
            }

    edges = list(dedup.values())

    # Keep local meaningful spans. Do not require large percentages only.
    per_band = max(35.0, base * 0.080)
    selected = []

    for e in edges:
        if e["ori"] == "H":
            near_perimeter = abs(e["c"] - yhi) <= per_band or abs(e["c"] - ylo) <= per_band
            local_span = e["len"] > width * 0.18 or e["len"] > base * 0.22
            if near_perimeter or local_span:
                selected.append(e)
        else:
            near_perimeter = abs(e["c"] - xhi) <= per_band or abs(e["c"] - xlo) <= per_band
            local_span = e["len"] > height * 0.18 or e["len"] > base * 0.22
            if near_perimeter or local_span:
                selected.append(e)

    selected = sorted(selected, key=lambda e: e["len"], reverse=True)[:32]

    isolation["raw_edges"] = len(raw)
    isolation["dedup_edges"] = len(dedup)
    isolation["selected_edges"] = len(selected)
    isolation["small_drawing_rule"] = True

    return selected, (float(xlo), float(ylo), float(xhi), float(yhi)), float(base), isolation


def _add_dim(msp, style, layer, base, p1, p2, angle) -> bool:
    try:
        dim = msp.add_linear_dim(
            base=base,
            p1=p1,
            p2=p2,
            angle=angle,
            dimstyle=style,
            dxfattribs={"layer": layer},
        )
        dim.render()
        return True
    except Exception:
        return False


def _perimeter_breaks(edges: list[dict], orientation: str, lo: float, hi: float, snap: float) -> list[float]:
    """Collect unique positions of edges in the given orientation, snapped and
    bounded to [lo, hi]. Used to build the inner chain breakpoints: every wall
    position along the chain axis becomes a segment boundary.

    For 'V' edges the position is the edge's X centerline (each vertical wall
    contributes one X break to the horizontal chain on top/bottom). For 'H'
    edges the position is the Y centerline.
    """
    positions = set()
    for e in edges:
        if e["ori"] != orientation:
            continue
        pos = round(e["c"] / snap) * snap
        if lo - snap <= pos <= hi + snap:
            positions.add(pos)
    # Always anchor the chain at the bbox endpoints so the chain spans the full
    # façade even when no interior wall sits at the corner.
    positions.add(lo)
    positions.add(hi)
    return sorted(positions)


def _emit_chain(msp, style, layer, breaks: list[float], base_perp: float, attach_perp: float,
                axis: str, min_len: float) -> int:
    """Emit one chain row. `breaks` is the sorted list of positions along the
    chain's main axis. `base_perp` is the perpendicular coordinate where the
    chain's dimension line sits. `attach_perp` is the building-edge coordinate
    where extension lines start.

    axis='H' → horizontal chain (top/bottom), breaks are X, base_perp/attach_perp are Y.
    axis='V' → vertical chain (left/right),  breaks are Y, base_perp/attach_perp are X.
    """
    n = 0
    for i in range(len(breaks) - 1):
        a, b = breaks[i], breaks[i + 1]
        if b - a < min_len:
            continue
        if axis == "H":
            ok = _add_dim(
                msp, style, layer,
                base=((a + b) / 2.0, base_perp),
                p1=(a, attach_perp),
                p2=(b, attach_perp),
                angle=0,
            )
        else:
            ok = _add_dim(
                msp, style, layer,
                base=(base_perp, (a + b) / 2.0),
                p1=(attach_perp, a),
                p2=(attach_perp, b),
                angle=90,
            )
        if ok:
            n += 1
    return n


def dimension_dxf(input_dxf: Path, output_dxf: Path) -> dict:
    doc = ezdxf.readfile(str(input_dxf))
    msp = doc.modelspace()

    for e in list(msp):
        if e.dxftype() == "DIMENSION":
            try:
                msp.delete_entity(e)
            except Exception:
                pass

    style = setup_dimstyle(doc)
    layer = "NAVVIX_DIMENSIONS"
    if layer not in doc.layers:
        doc.layers.new(layer, dxfattribs={"color": 7})

    edges, bbox, base, isolation = semantic_edges(doc)
    xlo, ylo, xhi, yhi = bbox

    width = xhi - xlo
    height = yhi - ylo
    created = 0
    off1 = max(28.0, base * 0.045)   # inner chain offset from building edge
    off2 = max(48.0, base * 0.075)   # outer span offset (one row beyond inner chain)
    snap = max(4.0, base * 0.0025)
    min_chain_len = max(20.0, base * 0.008)

    has_architecture = isolation.get("architectural_lines", 0) > 0 or isolation.get("input_lines", 0) > 0

    chain_segments = 0
    if has_architecture and width > 1 and height > 1:
        # === Outer spans on all four sides ============================
        # Mirrors the reference dimensioning style: outer-span (full façade
        # width/height) sits OUTSIDE the inner chain, on every side.
        if _add_dim(msp, style, layer, base=((xlo + xhi) / 2, yhi + off2),
                    p1=(xlo, yhi), p2=(xhi, yhi), angle=0):
            created += 1
        if _add_dim(msp, style, layer, base=((xlo + xhi) / 2, ylo - off2),
                    p1=(xlo, ylo), p2=(xhi, ylo), angle=0):
            created += 1
        if _add_dim(msp, style, layer, base=(xlo - off2, (ylo + yhi) / 2),
                    p1=(xlo, ylo), p2=(xlo, yhi), angle=90):
            created += 1
        if _add_dim(msp, style, layer, base=(xhi + off2, (ylo + yhi) / 2),
                    p1=(xhi, ylo), p2=(xhi, yhi), angle=90):
            created += 1

        # === Inner chains (segment-by-segment) on all four sides =======
        # Each chain's segments share one base coordinate so they read as a
        # row of ticked dimensions, matching the reference style.
        x_breaks = _perimeter_breaks(edges, "V", xlo, xhi, snap)
        y_breaks = _perimeter_breaks(edges, "H", ylo, yhi, snap)

        if len(x_breaks) >= 3:
            chain_segments += _emit_chain(msp, style, layer, x_breaks,
                                          base_perp=yhi + off1, attach_perp=yhi,
                                          axis="H", min_len=min_chain_len)
            chain_segments += _emit_chain(msp, style, layer, x_breaks,
                                          base_perp=ylo - off1, attach_perp=ylo,
                                          axis="H", min_len=min_chain_len)
        if len(y_breaks) >= 3:
            chain_segments += _emit_chain(msp, style, layer, y_breaks,
                                          base_perp=xlo - off1, attach_perp=xlo,
                                          axis="V", min_len=min_chain_len)
            chain_segments += _emit_chain(msp, style, layer, y_breaks,
                                          base_perp=xhi + off1, attach_perp=xhi,
                                          axis="V", min_len=min_chain_len)
        created += chain_segments

    isolation["chain_segments"] = chain_segments

    output_dxf.parent.mkdir(parents=True, exist_ok=True)
    doc.saveas(str(output_dxf))

    return {
        "input": str(input_dxf),
        "output": str(output_dxf),
        "dimensions_created": created,
        "selected_spans": len(edges),
        "bbox": bbox,
        "isolation": isolation,
        "note": "Small valid split drawings now receive local width/height dimensions.",
    }
