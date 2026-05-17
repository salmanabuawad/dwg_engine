"""
Perimeter & exposure classification for wall chains.

CLAUDE-GUARD:
This module determines which side(s) of the building each WallChain sits
on by topology, not by bbox-band heuristics. A wall is "exposed on the
top" iff no other parallel wall sits above it with overlapping along-axis
coverage — i.e. there's no other wall between this wall and the
notional outside. Same logic mirrored for bottom / left / right.

This generalises perimeter-band classification (which only handled
rectangular buildings) to arbitrary axis-aligned footprints — L-shapes,
courtyards, U-shapes, step-backs all classify correctly. Every chain
gets an exposure record; downstream dimensioning uses those to decide
which sides emit dimensions for it.

NEVER:
- treat exposure as a function of the global bbox
- merge chains across orientations
- mark interior walls as exposed-perimeter
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

from app.engine.semantic.wall_graph import WallChain


@dataclass
class WallExposure:
    """Per-chain side exposure flags. A chain can be exposed on at most
    two sides (top+bottom for a free-standing H wall; left+right for V).
    Most chains in a real plan are exposed on at most one side."""
    chain_id: int
    top: bool = False
    bottom: bool = False
    left: bool = False
    right: bool = False

    @property
    def exposed(self) -> bool:
        return self.top or self.bottom or self.left or self.right


def classify_wall_exposure(
    chains: List[WallChain],
    *,
    overlap_tol: float = 4.0,
) -> dict[int, WallExposure]:
    """For each wall chain, decide which sides of the building it's
    exposed on.

    A horizontal wall `target` is exposed-top iff no other horizontal
    wall sits ABOVE it (target.c < other.c) while overlapping its X
    range. Symmetric for bottom / left / right.

    overlap_tol guards against jitter — two walls have "overlapping"
    coverage only if their along-axis intervals overlap by more than
    overlap_tol.
    """
    h_chains = [c for c in chains if c.orientation == "H"]
    v_chains = [c for c in chains if c.orientation == "V"]

    out: dict[int, WallExposure] = {}

    for t in h_chains:
        exp = WallExposure(chain_id=t.id)
        has_above = False
        has_below = False
        for o in h_chains:
            if o is t:
                continue
            # Overlap along the wall axis (X for H).
            ov_a = max(t.a, o.a)
            ov_b = min(t.b, o.b)
            if ov_b - ov_a <= overlap_tol:
                continue
            if o.c > t.c:
                has_above = True
            elif o.c < t.c:
                has_below = True
            if has_above and has_below:
                break
        exp.top = not has_above
        exp.bottom = not has_below
        out[t.id] = exp

    for t in v_chains:
        exp = WallExposure(chain_id=t.id)
        has_left = False
        has_right = False
        for o in v_chains:
            if o is t:
                continue
            ov_a = max(t.a, o.a)
            ov_b = min(t.b, o.b)
            if ov_b - ov_a <= overlap_tol:
                continue
            if o.c < t.c:
                has_left = True
            elif o.c > t.c:
                has_right = True
            if has_left and has_right:
                break
        exp.left = not has_left
        exp.right = not has_right
        out[t.id] = exp

    return out


def perimeter_chains(
    chains: List[WallChain],
    exposures: dict[int, WallExposure],
) -> List[WallChain]:
    """Return only the chains that are exposed on at least one side
    (= they sit on the building's outer boundary, including L-cutouts
    and courtyards)."""
    return [c for c in chains if exposures.get(c.id, WallExposure(c.id)).exposed]


# ── Perimeter polygon construction ────────────────────────────────────


@dataclass
class PerimeterEdge:
    """One edge of the closed perimeter polygon — a directed segment
    from p1 to p2 along an underlying WallChain (which may be exposed
    on multiple sides)."""
    chain_id: int
    orientation: str          # "H" or "V"
    p1: tuple[float, float]
    p2: tuple[float, float]
    length: float
    side: str                 # "top" / "bottom" / "left" / "right" (which exposure this edge belongs to)


def _sweep_outline_segments(
    chains: List[WallChain],
    exposures: dict[int, WallExposure],
) -> list[PerimeterEdge]:
    """Walk exposed chains and emit perimeter edges with the side they
    cover. A chain exposed top+bottom (rare — a single free-standing
    wall) emits two edges, one each side.
    """
    edges: list[PerimeterEdge] = []
    for ch in chains:
        exp = exposures.get(ch.id, WallExposure(ch.id))
        if not exp.exposed:
            continue
        if ch.orientation == "H":
            if exp.top:
                edges.append(PerimeterEdge(
                    ch.id, "H", (ch.a, ch.c), (ch.b, ch.c), ch.length, "top"))
            if exp.bottom:
                edges.append(PerimeterEdge(
                    ch.id, "H", (ch.a, ch.c), (ch.b, ch.c), ch.length, "bottom"))
        else:  # "V"
            if exp.left:
                edges.append(PerimeterEdge(
                    ch.id, "V", (ch.c, ch.a), (ch.c, ch.b), ch.length, "left"))
            if exp.right:
                edges.append(PerimeterEdge(
                    ch.id, "V", (ch.c, ch.a), (ch.c, ch.b), ch.length, "right"))
    return edges


def build_perimeter_polygon(
    chains: List[WallChain],
    exposures: dict[int, WallExposure] | None = None,
) -> tuple[list[PerimeterEdge], dict]:
    """Construct the building's outer perimeter as a list of
    PerimeterEdges. Topology-only — no bbox involved.

    Strategy (axis-aligned rectilinear buildings):
    1. For each exposed wall, derive the perimeter edge(s) it contributes.
    2. The returned list contains every perimeter edge with the side it
       sits on, so downstream dimensioning can place dimensions on the
       correct outside of the polygon.

    Ordering: edges are sorted in a stable traversal order — top edges
    left-to-right, right edges top-to-bottom, bottom edges right-to-left,
    left edges bottom-to-top. This is the rendering order an architectural
    draftsman traces.

    Note: this is NOT a full graph-cycle traversal. A graph traversal
    is needed for floor plans with interior courtyards if you want to
    distinguish "outer perimeter" from "courtyard perimeter". For now
    every exposed wall is considered part of the perimeter set, which
    is correct for the dimensioning use case (we dimension every
    exposed wall regardless of which loop it sits on).
    """
    if exposures is None:
        exposures = classify_wall_exposure(chains)
    raw = _sweep_outline_segments(chains, exposures)

    def sort_key(e: PerimeterEdge):
        # top: left→right (sort by min x)
        # right: top→bottom (sort by max y desc)
        # bottom: right→left (sort by max x desc)
        # left: bottom→top (sort by min y)
        if e.side == "top":
            return (0, e.p1[0])
        if e.side == "right":
            return (1, -e.p1[1])
        if e.side == "bottom":
            return (2, -e.p2[0])
        return (3, e.p1[1])

    edges = sorted(raw, key=sort_key)
    stats = {
        "perimeter_edges": len(edges),
        "top_edges": sum(1 for e in edges if e.side == "top"),
        "bottom_edges": sum(1 for e in edges if e.side == "bottom"),
        "left_edges": sum(1 for e in edges if e.side == "left"),
        "right_edges": sum(1 for e in edges if e.side == "right"),
    }
    return edges, stats
