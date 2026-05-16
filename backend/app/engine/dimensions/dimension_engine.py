"""
Semantic dimension engine.

CLAUDE-GUARD:
Do not dimension every raw line.
Do not dimension full-sheet geometry.
Do not use page frames/title borders as bbox source.
Use architectural isolation first, then perimeter-first semantic spans.
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
        if l.orientation in ("H", "V") and l.length >= 30
    ]

    architectural_lines, isolation = isolate_architectural_lines(all_lines)

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

    # Use architectural bbox only, not sheet/page bbox.
    xlo, xhi = np.percentile(xs, [1, 99])
    ylo, yhi = np.percentile(ys, [1, 99])
    width, height = max(1.0, xhi - xlo), max(1.0, yhi - ylo)
    base = max(1.0, min(width, height))

    snap = max(8.0, base * 0.003)

    def sv(v: float) -> float:
        return round(v / snap) * snap

    dedup = {}

    for e in raw:
        # Remove tiny connector/letter/table lines.
        if e["len"] < max(90.0, base * 0.030):
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

    # Reject extremely dominant frame-like spans inside the architectural bbox.
    # Real overall dimension is generated separately, so raw huge spans do not need duplication.
    edges = [
        e for e in edges
        if not (
            (e["ori"] == "H" and e["len"] > width * 0.92)
            or (e["ori"] == "V" and e["len"] > height * 0.92)
        )
    ]

    per_band = max(100.0, base * 0.055)
    selected = []

    for e in edges:
        if e["ori"] == "H":
            near_perimeter = abs(e["c"] - yhi) <= per_band or abs(e["c"] - ylo) <= per_band
            major_span = e["len"] > width * 0.28
            if near_perimeter or major_span:
                selected.append(e)
        else:
            near_perimeter = abs(e["c"] - xhi) <= per_band or abs(e["c"] - xlo) <= per_band
            major_span = e["len"] > height * 0.28
            if near_perimeter or major_span:
                selected.append(e)

    # Clutter guard.
    selected = sorted(selected, key=lambda e: e["len"], reverse=True)[:28]

    isolation["raw_edges"] = len(raw)
    isolation["dedup_edges"] = len(dedup)
    isolation["selected_edges"] = len(selected)

    return selected, (float(xlo), float(ylo), float(xhi), float(yhi)), float(base), isolation


def dimension_dxf(input_dxf: Path, output_dxf: Path) -> dict:
    doc = ezdxf.readfile(str(input_dxf))
    msp = doc.modelspace()

    # Remove old dimensions from each split. This prevents copied original dimensions
    # and generated dimensions from compounding.
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

    created = 0
    off1 = max(45.0, base * 0.030)
    off2 = max(85.0, base * 0.060)

    # Overall dimensions generated from architectural bbox only.
    if edges or isolation.get("architectural_lines", 0) > 0:
        try:
            dim = msp.add_linear_dim(
                base=((xlo + xhi) / 2, yhi + off2),
                p1=(xlo, yhi),
                p2=(xhi, yhi),
                angle=0,
                dimstyle=style,
                dxfattribs={"layer": layer},
            )
            dim.render()
            created += 1
        except Exception:
            pass

        try:
            dim = msp.add_linear_dim(
                base=(xlo - off2, (ylo + yhi) / 2),
                p1=(xlo, ylo),
                p2=(xlo, yhi),
                angle=90,
                dimstyle=style,
                dxfattribs={"layer": layer},
            )
            dim.render()
            created += 1
        except Exception:
            pass

    for i, e in enumerate(edges):
        try:
            if e["ori"] == "H":
                a, b, c = e["a"], e["b"], e["c"]
                side = 1 if c >= (ylo + yhi) / 2 else -1
                basept = ((a + b) / 2, c + side * off1 * (1 + (i % 2) * 0.55))
                dim = msp.add_linear_dim(
                    base=basept,
                    p1=(a, c),
                    p2=(b, c),
                    angle=0,
                    dimstyle=style,
                    dxfattribs={"layer": layer},
                )
                dim.render()
                created += 1
            else:
                a, b, c = e["a"], e["b"], e["c"]
                side = 1 if c >= (xlo + xhi) / 2 else -1
                basept = (c + side * off1 * (1 + (i % 2) * 0.55), (a + b) / 2)
                dim = msp.add_linear_dim(
                    base=basept,
                    p1=(c, a),
                    p2=(c, b),
                    angle=90,
                    dimstyle=style,
                    dxfattribs={"layer": layer},
                )
                dim.render()
                created += 1
        except Exception:
            pass

    output_dxf.parent.mkdir(parents=True, exist_ok=True)
    doc.saveas(str(output_dxf))

    return {
        "input": str(input_dxf),
        "output": str(output_dxf),
        "dimensions_created": created,
        "selected_spans": len(edges),
        "bbox": bbox,
        "isolation": isolation,
        "note": "Dimensions are generated from isolated architectural geometry only, not page frame/title border.",
    }
