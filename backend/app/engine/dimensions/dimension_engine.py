"""
Semantic dimension engine using topology wall chains.

CLAUDE-GUARD:
Dimensions must come from wall chains, not merged room blobs or arbitrary bboxes.
This prevents huge wrong values like 15674 / 13141 / 8412.
"""

from __future__ import annotations
from pathlib import Path
from typing import Any
import json
import ezdxf

from app.engine.geometry.line_registry import extract_lines_from_doc
from app.engine.isolation.main_plan_isolation import isolate_architectural_lines, bbox_from_lines
from app.engine.topology.node_graph import build_topology_graph
from app.engine.topology.wall_chain import build_wall_chains, chains_to_debug
from app.engine.validation.dimension_validator import DimensionCandidate, validate_candidate

def setup_dimstyle(doc: Any, style: str = "ISO-25") -> str:
    if style not in doc.dimstyles:
        doc.dimstyles.new(style)
    ds = doc.dimstyles.get(style)
    settings = {
        "dimtxt": 18.0, "dimasz": 18.0, "dimgap": 7.0, "dimtad": 1,
        "dimjust": 0, "dimtih": 0, "dimtoh": 0, "dimexe": 1.25, "dimexo": 0.625,
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

def _candidate_from_chain(chain, bbox, base_size, index: int) -> DimensionCandidate | None:
    xlo, ylo, xhi, yhi = bbox
    off = max(35.0, base_size * 0.040) * (1 + (index % 3) * 0.55)
    if chain.orientation == "H":
        y = chain.axis
        x1, x2 = chain.start, chain.end
        side = 1 if y >= (ylo + yhi) / 2 else -1
        return DimensionCandidate(
            id=f"DC_CHAIN_{chain.id}", orientation="H", p1=(x1, y), p2=(x2, y),
            base=((x1+x2)/2, y + side*off), length=chain.length,
            source_type="wall_chain", source_id=chain.id, priority=2)
    if chain.orientation == "V":
        x = chain.axis
        y1, y2 = chain.start, chain.end
        side = 1 if x >= (xlo + xhi) / 2 else -1
        return DimensionCandidate(
            id=f"DC_CHAIN_{chain.id}", orientation="V", p1=(x, y1), p2=(x, y2),
            base=(x + side*off, (y1+y2)/2), length=chain.length,
            source_type="wall_chain", source_id=chain.id, priority=2)
    return None


def _opening_and_segment_candidates(chain, bbox, base_size) -> list[DimensionCandidate]:
    """For each WallChain with openings, emit a layered inner chain:

    1) An OPENING dim per opening — placed slightly closer to the wall
       than the chain's overall dim. Surfaces door/window widths
       (the 220/245/280 style numbers in the reference plans).
    2) A SEGMENT dim per wall section BETWEEN openings — labels the
       solid-wall pieces that flank each opening (the 5800/840 style
       breakdowns). The chain's start..end is anchored, openings carve
       it into sub-segments.

    Placed inside (closer to the wall) than the chain's overall dim so
    they read as a stacked layer, matching the reference samples.
    """
    if not chain.openings:
        return []
    xlo, ylo, xhi, yhi = bbox
    seg_off = max(20.0, base_size * 0.022)  # inner layer, close to the wall
    op_off  = max(12.0, base_size * 0.011)  # innermost layer, very close

    breaks = sorted({chain.start, chain.end}.union(
        v for o in chain.openings for v in (o.start, o.end)
    ))
    out: list[DimensionCandidate] = []

    if chain.orientation == "H":
        y = chain.axis
        side = 1 if y >= (ylo + yhi) / 2 else -1
        # Solid-wall segments between break points
        for i in range(len(breaks) - 1):
            a, b = breaks[i], breaks[i + 1]
            if b - a <= 0:
                continue
            # Is this stretch an opening or a solid wall?
            is_opening = any(abs(a - o.start) < 0.5 and abs(b - o.end) < 0.5 for o in chain.openings)
            if is_opening:
                # Surface the opening itself on the innermost layer.
                out.append(DimensionCandidate(
                    id=f"DC_OPEN_{chain.id}_{i}", orientation="H",
                    p1=(a, y), p2=(b, y),
                    base=((a + b) / 2, y + side * op_off),
                    length=b - a,
                    source_type="opening", source_id=f"{chain.id}:{i}", priority=4))
            else:
                out.append(DimensionCandidate(
                    id=f"DC_SEG_{chain.id}_{i}", orientation="H",
                    p1=(a, y), p2=(b, y),
                    base=((a + b) / 2, y + side * seg_off),
                    length=b - a,
                    source_type="wall_chain", source_id=f"{chain.id}:seg{i}", priority=3))
    else:  # "V"
        x = chain.axis
        side = 1 if x >= (xlo + xhi) / 2 else -1
        for i in range(len(breaks) - 1):
            a, b = breaks[i], breaks[i + 1]
            if b - a <= 0:
                continue
            is_opening = any(abs(a - o.start) < 0.5 and abs(b - o.end) < 0.5 for o in chain.openings)
            if is_opening:
                out.append(DimensionCandidate(
                    id=f"DC_OPEN_{chain.id}_{i}", orientation="V",
                    p1=(x, a), p2=(x, b),
                    base=(x + side * op_off, (a + b) / 2),
                    length=b - a,
                    source_type="opening", source_id=f"{chain.id}:{i}", priority=4))
            else:
                out.append(DimensionCandidate(
                    id=f"DC_SEG_{chain.id}_{i}", orientation="V",
                    p1=(x, a), p2=(x, b),
                    base=(x + side * seg_off, (a + b) / 2),
                    length=b - a,
                    source_type="wall_chain", source_id=f"{chain.id}:seg{i}", priority=3))
    return out

def _overall_candidates(bbox, base_size) -> list[DimensionCandidate]:
    xlo, ylo, xhi, yhi = bbox
    off = max(70.0, base_size * 0.075)
    return [
        DimensionCandidate("DC_OVERALL_H", "H", (xlo, yhi), (xhi, yhi), ((xlo+xhi)/2, yhi+off), xhi-xlo, "overall_bbox", "architectural_bbox", 1),
        DimensionCandidate("DC_OVERALL_V", "V", (xlo, ylo), (xlo, yhi), (xlo-off, (ylo+yhi)/2), yhi-ylo, "overall_bbox", "architectural_bbox", 1),
    ]

def build_dimension_candidates(doc: Any) -> tuple[list[DimensionCandidate], dict]:
    raw_lines = extract_lines_from_doc(doc)
    truncated = getattr(extract_lines_from_doc, "last_truncated", False)
    all_lines = [l for l in raw_lines if l.orientation in ("H", "V") and l.length >= 10]

    # Sanity classifier — is this even an architectural drawing? A cover
    # letter / form / receipt has lots of TEXT but very few drawing
    # primitives. Below the floor we skip dimensioning entirely instead
    # of emitting garbage on whatever stray lines exist.
    H_count = sum(1 for l in all_lines if l.orientation == "H")
    V_count = sum(1 for l in all_lines if l.orientation == "V")
    if len(all_lines) < 20 or H_count < 4 or V_count < 4:
        return [], {
            "error": "not_architectural",
            "reason": f"H={H_count} V={V_count} total={len(all_lines)} — below threshold",
            "input_lines": len(raw_lines),
            "extraction_truncated": truncated,
        }

    architectural_lines, isolation = isolate_architectural_lines(all_lines)
    isolation["extraction_truncated"] = truncated
    if not architectural_lines and all_lines:
        architectural_lines = all_lines
        isolation["fallback_used"] = "all_lines_for_small_split"
    if not architectural_lines:
        return [], {"error": "no_architectural_lines", **isolation}

    bbox = bbox_from_lines(architectural_lines)
    xlo, ylo, xhi, yhi = bbox
    base_size = max(1.0, min(xhi-xlo, yhi-ylo))
    max_context = max(xhi-xlo, yhi-ylo)

    graph = build_topology_graph(architectural_lines)
    chains = build_wall_chains(graph)

    # Reject chains that are basically whole merged-area spans.
    usable_chains = [c for c in chains if c.length <= max_context * 0.92]

    candidates = []
    candidates.extend(_overall_candidates(bbox, base_size))
    # Track chains with openings so we can layer extra inner dims.
    opening_chains_count = 0
    opening_dims_added = 0
    segment_dims_added = 0
    for i, chain in enumerate(sorted(usable_chains, key=lambda c: c.length, reverse=True)[:36]):
        cand = _candidate_from_chain(chain, bbox, base_size, i)
        if cand:
            candidates.append(cand)
        # Per-opening + per-segment inner layer. Adds the 220/245 door
        # dims and 5800/840 wall-segment dims seen in reference plans.
        inner = _opening_and_segment_candidates(chain, bbox, base_size)
        if inner:
            opening_chains_count += 1
            for ic in inner:
                if ic.source_type == "opening":
                    opening_dims_added += 1
                else:
                    segment_dims_added += 1
            candidates.extend(inner)

    valid = []
    seen = set()
    local_max = max_context * 1.05
    for c in candidates:
        ok, _ = validate_candidate(c, local_max=local_max)
        if not ok:
            continue
        key = (c.orientation, round(c.p1[0],1), round(c.p1[1],1), round(c.p2[0],1), round(c.p2[1],1))
        if key in seen:
            continue
        seen.add(key)
        valid.append(c)

    debug = {
        "isolation": isolation,
        "architectural_bbox": bbox,
        "topology": {"nodes": len(graph.nodes), "edges": len(graph.edges), "snap_tolerance": graph.snap_tolerance},
        "wall_chains": chains_to_debug(chains),
        "usable_chains": len(usable_chains),
        "opening_chains": opening_chains_count,
        "opening_dims": opening_dims_added,
        "segment_dims": segment_dims_added,
        "dimension_candidates": [c.to_dict() for c in valid],
        "note": "Dimensions: chains + per-opening + per-segment inner layer (reference style).",
    }
    return valid, debug

def _add_dim(msp, style, layer, candidate: DimensionCandidate) -> bool:
    try:
        angle = 0 if candidate.orientation == "H" else 90
        dim = msp.add_linear_dim(base=candidate.base, p1=candidate.p1, p2=candidate.p2, angle=angle, dimstyle=style, dxfattribs={"layer": layer})
        dim.render()
        return True
    except Exception:
        return False

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

    candidates, debug = build_dimension_candidates(doc)
    created = 0
    for candidate in candidates:
        if _add_dim(msp, style, layer, candidate):
            created += 1

    output_dxf.parent.mkdir(parents=True, exist_ok=True)
    doc.saveas(str(output_dxf))
    debug_path = output_dxf.with_suffix(".topology_debug.json")
    debug_path.write_text(json.dumps(debug, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    return {
        "input": str(input_dxf), "output": str(output_dxf), "dimensions_created": created,
        "candidate_count": len(candidates), "topology_debug": str(debug_path),
        "topology": debug.get("topology"), "wall_chain_count": debug.get("wall_chains", {}).get("count"),
        "note": "Topology foundation added: dimensions come from wall chains, not merged area blobs.",
    }
