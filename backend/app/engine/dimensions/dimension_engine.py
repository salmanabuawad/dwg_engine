"""
Semantic dimension engine.

CLAUDE-GUARD:
Do not dimension every raw line.
Do not dimension full-sheet geometry.
Use perimeter-first, local, semantic spans only.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import ezdxf
import numpy as np

from app.engine.geometry.line_registry import extract_lines_from_doc

def setup_dimstyle(doc: Any, style: str = "ISO-25") -> str:
    if style not in doc.dimstyles:
        doc.dimstyles.new(style)

    ds = doc.dimstyles.get(style)

    settings = {
        "dimtxt": 16.0,
        "dimasz": 16.0,
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

def semantic_edges(doc: Any) -> tuple[list[dict], tuple[float, float, float, float], float, int]:
    lines = [l for l in extract_lines_from_doc(doc) if l.orientation in ("H", "V") and l.length >= 30]

    if not lines:
        return [], (0, 0, 1, 1), 1, 0

    xs, ys = [], []
    raw = []

    for l in lines:
        if l.orientation == "H":
            a, b = sorted([l.x1, l.x2])
            c = (l.y1 + l.y2) / 2
            raw.append({"ori": "H", "a": a, "b": b, "c": c, "len": b - a})
            xs += [a, b]
            ys.append(c)
        else:
            a, b = sorted([l.y1, l.y2])
            c = (l.x1 + l.x2) / 2
            raw.append({"ori": "V", "a": a, "b": b, "c": c, "len": b - a})
            xs.append(c)
            ys += [a, b]

    xlo, xhi = np.percentile(xs, [1, 99])
    ylo, yhi = np.percentile(ys, [1, 99])
    width, height = xhi - xlo, yhi - ylo
    base = max(1.0, min(width, height))

    snap = max(8.0, base * 0.003)

    def sv(v: float) -> float:
        return round(v / snap) * snap

    dedup = {}

    for e in raw:
        if e["len"] < max(80.0, base * 0.025):
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

    # Perimeter-first selection. This is not room intelligence yet,
    # but it avoids full raw-line dimensioning and keeps the result architectural.
    per_band = max(120.0, base * 0.040)
    selected = []

    for e in edges:
        if e["ori"] == "H":
            if abs(e["c"] - yhi) <= per_band or abs(e["c"] - ylo) <= per_band or e["len"] > width * 0.45:
                selected.append(e)
        else:
            if abs(e["c"] - xhi) <= per_band or abs(e["c"] - xlo) <= per_band or e["len"] > height * 0.45:
                selected.append(e)

    selected = sorted(selected, key=lambda e: e["len"], reverse=True)[:42]

    return selected, (float(xlo), float(ylo), float(xhi), float(yhi)), float(base), len(raw)

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

    edges, bbox, base, raw_edge_count = semantic_edges(doc)
    xlo, ylo, xhi, yhi = bbox

    created = 0
    off1 = max(55.0, base * 0.028)
    off2 = max(95.0, base * 0.050)

    # Overall dimensions first.
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
                basept = ((a + b) / 2, c + side * off1 * (1 + (i % 2) * 0.45))
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
                basept = (c + side * off1 * (1 + (i % 2) * 0.45), (a + b) / 2)
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
        "raw_edges": raw_edge_count,
        "selected_spans": len(edges),
        "bbox": bbox,
    }
