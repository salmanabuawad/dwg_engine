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
from app.engine.semantic.wall_graph import build_wall_chains, WallChain
from app.engine.semantic.perimeter import (
    classify_wall_exposure,
    build_perimeter_polygon,
    WallExposure,
    PerimeterEdge,
)

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


def semantic_edges(doc: Any) -> tuple[list[dict], tuple[float, float, float, float], float, dict, list[WallChain]]:
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
        return [], (0, 0, 1, 1), 1, isolation, []

    # Build the wall topology graph: collinear connected line segments
    # become WallChains, with small axial gaps bridged as openings. This
    # is the foundation of dimension ownership — the inner chain's
    # breakpoints come from wall topology, not raw line endpoints.
    wall_chains = build_wall_chains(architectural_lines)
    isolation["wall_chains"] = len(wall_chains)
    isolation["chains_with_openings"] = sum(1 for c in wall_chains if c.has_openings)

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
        return [], (0, 0, 1, 1), 1, isolation, wall_chains

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

    return selected, (float(xlo), float(ylo), float(xhi), float(yhi)), float(base), isolation, wall_chains


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


def _perimeter_chain_breaks(
    chains: list[WallChain],
    bbox: tuple[float, float, float, float],
    side: str,
    snap: float,
    touch_tol: float,
) -> list[float]:
    """Breakpoints for the inner dimension chain on `side` of the bbox.

    `side` ∈ {"top", "bottom", "left", "right"}.

    The architectural-drafting convention (verified against the reference
    samples) is that an inner chain on the top edge breaks at every
    vertical wall that REACHES the top edge — not at every vertical wall
    in the building. Interior partitions that don't touch the top
    perimeter belong to interior cross-dimensions, not to the top chain.

    A vertical wall (orientation='V') with along-axis range [a..b] in Y
    "reaches the top" iff b >= yhi - touch_tol. Symmetric for bottom.

    A horizontal wall (orientation='H') with along-axis range [a..b] in X
    "reaches the left" iff a <= xlo + touch_tol. Symmetric for right.

    The bbox endpoints always anchor the chain so the chain spans the
    full façade even at the corners.
    """
    xlo, ylo, xhi, yhi = bbox
    positions: set[float] = set()

    if side in ("top", "bottom"):
        chain_orientation = "V"
        chain_lo, chain_hi = xlo, xhi
        # Y threshold a vertical wall must reach to be a top/bottom
        # perimeter wall.
        if side == "top":
            def touches(ch: WallChain) -> bool:
                return ch.b >= yhi - touch_tol
        else:
            def touches(ch: WallChain) -> bool:
                return ch.a <= ylo + touch_tol
    else:  # "left" / "right"
        chain_orientation = "H"
        chain_lo, chain_hi = ylo, yhi
        if side == "left":
            def touches(ch: WallChain) -> bool:
                return ch.a <= xlo + touch_tol
        else:
            def touches(ch: WallChain) -> bool:
                return ch.b >= xhi - touch_tol

    for ch in chains:
        if ch.orientation != chain_orientation:
            continue
        if not touches(ch):
            continue
        pos = round(ch.c / snap) * snap
        if chain_lo - snap <= pos <= chain_hi + snap:
            positions.add(pos)

    positions.add(chain_lo)
    positions.add(chain_hi)
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

    edges, bbox, base, isolation, wall_chains = semantic_edges(doc)
    xlo, ylo, xhi, yhi = bbox

    width = xhi - xlo
    height = yhi - ylo
    created = 0
    off1 = max(28.0, base * 0.045)   # inner chain offset from building edge
    off2 = max(48.0, base * 0.075)   # outer span offset (one row beyond inner chain)
    snap = max(4.0, base * 0.0025)
    min_chain_len = max(20.0, base * 0.008)

    has_architecture = isolation.get("architectural_lines", 0) > 0 or isolation.get("input_lines", 0) > 0

    # === Dimensions come ONLY from the perimeter polygon ===============
    # Walls are classified by topology (semantic/perimeter.py): a wall is
    # "exposed top" iff no parallel wall sits between it and the outside,
    # etc. This generalises perimeter detection beyond rectangular
    # buildings — L-shapes, U-shapes, courtyards, step-backs all classify
    # correctly because exposure is a function of nearby walls, not bbox.
    perimeter_walls = 0
    interior_skipped = 0
    rejected_spans = 0
    perimeter_stats: dict = {}

    h_chains = [c for c in wall_chains if c.orientation == "H"]
    v_chains = [c for c in wall_chains if c.orientation == "V"]
    if h_chains and v_chains and has_architecture:
        exposures = classify_wall_exposure(wall_chains)
        perimeter_edges, perimeter_stats = build_perimeter_polygon(wall_chains, exposures)
        chains_by_id = {c.id: c for c in wall_chains}

        # Sanity ceiling: 1.5× the longest wall chain in each orientation.
        # No emitted dimension may exceed it — defensive validation per
        # the roadmap so an over-merge can't ship phantom spans.
        max_h_len = max((c.length for c in h_chains), default=0.0)
        max_v_len = max((c.length for c in v_chains), default=0.0)
        h_ceiling = max_h_len * 1.5 if max_h_len else float("inf")
        v_ceiling = max_v_len * 1.5 if max_v_len else float("inf")

        def _emit_wall_chain(ch: WallChain, side: str) -> int:
            """Emit dimensions along ONE wall chain. The full chain
            length is one dim on the side-appropriate offset. If the
            chain has bridged openings (sub-door-width gaps), each
            non-opening sub-segment AND each opening also become their
            own dimensions on a slightly more-outer row so the chain
            reads as: wall | opening | wall.
            """
            n = 0
            ceiling = h_ceiling if ch.orientation == "H" else v_ceiling
            if ch.length > ceiling:
                # Defensive: a chain longer than 1.5× the longest wall
                # in its orientation cannot be a real wall.
                return 0

            if side == "top":
                base_total = (ch.a + ch.b) / 2.0, ch.c + off2
                base_seg = ch.c + off1
                p1_attach, p2_attach = ch.c, ch.c
                angle = 0
            elif side == "bottom":
                base_total = (ch.a + ch.b) / 2.0, ch.c - off2
                base_seg = ch.c - off1
                p1_attach, p2_attach = ch.c, ch.c
                angle = 0
            elif side == "left":
                base_total = ch.c - off2, (ch.a + ch.b) / 2.0
                base_seg = ch.c - off1
                angle = 90
            else:  # "right"
                base_total = ch.c + off2, (ch.a + ch.b) / 2.0
                base_seg = ch.c + off1
                angle = 90

            # Overall chain dimension (the chain's own length — never
            # larger than the real wall it represents).
            if angle == 0:
                ok_total = _add_dim(msp, style, layer, base=base_total,
                                    p1=(ch.a, ch.c), p2=(ch.b, ch.c), angle=0)
            else:
                ok_total = _add_dim(msp, style, layer, base=base_total,
                                    p1=(ch.c, ch.a), p2=(ch.c, ch.b), angle=90)
            if ok_total:
                n += 1

            # Sub-segments split by any openings within the chain.
            if ch.openings:
                breaks = sorted({ch.a, ch.b}.union(
                    pt for (oa, ob) in ch.openings for pt in (oa, ob)
                ))
                for i in range(len(breaks) - 1):
                    a, b = breaks[i], breaks[i + 1]
                    if b - a < min_chain_len:
                        continue
                    if angle == 0:
                        ok = _add_dim(msp, style, layer,
                                      base=((a + b) / 2.0, base_seg),
                                      p1=(a, ch.c), p2=(b, ch.c), angle=0)
                    else:
                        ok = _add_dim(msp, style, layer,
                                      base=(base_seg, (a + b) / 2.0),
                                      p1=(ch.c, a), p2=(ch.c, b), angle=90)
                    if ok:
                        n += 1
            return n

        # Walk the perimeter polygon edges (already ordered top→right→
        # bottom→left). Each edge is one exposed wall on one side — a
        # chain exposed on top AND bottom contributes two perimeter edges.
        seen: set[tuple[int, str]] = set()
        for edge in perimeter_edges:
            key = (edge.chain_id, edge.side)
            if key in seen:
                continue
            seen.add(key)
            ch = chains_by_id.get(edge.chain_id)
            if ch is None:
                continue
            emitted = _emit_wall_chain(ch, edge.side)
            if emitted:
                perimeter_walls += 1
                created += emitted
            else:
                rejected_spans += 1

        # Walls that were not classified as exposed on ANY side are
        # interior partitions — reserved for cross-dimensions (next).
        exposed_chain_ids = {e.chain_id for e in perimeter_edges}
        for ch in wall_chains:
            if ch.id in exposed_chain_ids:
                continue
            interior_skipped += 1

    isolation["perimeter_walls_dimensioned"] = perimeter_walls
    isolation["interior_walls_skipped"] = interior_skipped
    isolation["dimensions_rejected_over_ceiling"] = rejected_spans
    isolation["perimeter_polygon"] = perimeter_stats

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
