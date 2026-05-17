"""
Wall topology graph.

CLAUDE-GUARD:
This module is the topology foundation of the engine. Every line in the
architectural cluster must end up either inside a WallChain or explicitly
rejected — never floating without ownership. Downstream dimensioning
consumes WallChain endpoints, not raw lines.

NEVER:
- merge across different orientations
- merge lines with significantly different perpendicular coordinates
- treat OTHER-orientation lines as walls
- bridge gaps wider than a typical door opening (configurable)

ALWAYS:
- group lines by snapped perpendicular coordinate first
- bridge tiny axial gaps (door openings) so a wall stays one chain
- record bridged openings so later steps can surface them as their
  own dimensions if needed
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable, List, Tuple

from app.engine.geometry.line_registry import LineSegment


@dataclass
class WallChain:
    id: int
    orientation: str  # "H" or "V"
    c: float          # perpendicular coord (y for H, x for V), snapped
    a: float          # along-axis min
    b: float          # along-axis max
    length: float
    segments: List[str] = field(default_factory=list)   # source LineSegment.id values
    openings: List[Tuple[float, float]] = field(default_factory=list)  # bridged gaps (a, b)

    @property
    def has_openings(self) -> bool:
        return bool(self.openings)


def _axis_proj(L: LineSegment) -> tuple[float, float, float]:
    """Return (a, b, c) for a wall-oriented line: a..b along the wall axis,
    c the perpendicular coordinate."""
    if L.orientation == "H":
        a, b = sorted((L.x1, L.x2))
        c = (L.y1 + L.y2) / 2.0
    else:  # "V"
        a, b = sorted((L.y1, L.y2))
        c = (L.x1 + L.x2) / 2.0
    return a, b, c


def build_wall_chains(
    lines: Iterable[LineSegment],
    *,
    perp_tol: float = 2.0,
    gap_bridge: float = 120.0,
    min_seg_len: float = 6.0,
) -> List[WallChain]:
    """Topology pass: merge collinear+near-collinear line segments into
    wall chains.

    Parameters
    ----------
    perp_tol : float
        Maximum perpendicular separation for two segments to be considered
        on the same wall line (snapped grid). Tight by default — typical
        CAD drawings keep walls colinear to within a millimetre.
    gap_bridge : float
        Maximum axial gap between two collinear segments that we bridge,
        recording the bridged span as an "opening". Default 120 (cm) covers
        most door widths; tighten via env or call-site if dimensions show
        false continuity.
    min_seg_len : float
        Drop segments shorter than this before chaining. Below ~6 the
        segments are usually CAD noise (hatch ticks, arrow heads).

    Returns
    -------
    list[WallChain] — never None. Each chain knows its sources and any
    bridged openings so dimension placement can surface them.
    """
    by_perp: dict[tuple[str, float], list[tuple[float, float, str]]] = defaultdict(list)

    for L in lines:
        if L.orientation not in ("H", "V"):
            continue
        if L.length < min_seg_len:
            continue
        a, b, c = _axis_proj(L)
        # Snap perp to perp_tol so jitter doesn't fragment a wall.
        key_c = round(c / perp_tol) * perp_tol
        by_perp[(L.orientation, key_c)].append((a, b, L.id))

    chains: List[WallChain] = []
    next_id = 0

    for (ori, c), segs in by_perp.items():
        segs.sort()
        cur_a, cur_b, ids, openings = segs[0][0], segs[0][1], [segs[0][2]], []
        for (a, b, lid) in segs[1:]:
            gap = a - cur_b
            if gap <= gap_bridge:
                # Connected enough — extend the current chain.
                if gap > perp_tol:
                    # Real gap, but small enough to bridge — record as
                    # opening so the dimensioner can show it later.
                    openings.append((cur_b, a))
                if b > cur_b:
                    cur_b = b
                ids.append(lid)
            else:
                # Too far — close out the current chain, start a new one.
                length = cur_b - cur_a
                if length > 0:
                    chains.append(WallChain(
                        id=next_id, orientation=ori, c=c,
                        a=cur_a, b=cur_b, length=length,
                        segments=ids, openings=openings,
                    ))
                    next_id += 1
                cur_a, cur_b, ids, openings = a, b, [lid], []

        length = cur_b - cur_a
        if length > 0:
            chains.append(WallChain(
                id=next_id, orientation=ori, c=c,
                a=cur_a, b=cur_b, length=length,
                segments=ids, openings=openings,
            ))
            next_id += 1

    return chains


def chain_endpoints(chains: List[WallChain], orientation: str) -> List[float]:
    """Return the along-axis endpoints of every chain in `orientation`.
    Used by the dimensioner to build the breakpoint set for chain rows.

    For orientation='V', each vertical wall contributes its X (=c) once —
    plus the X positions of any bridged openings within the chain. That
    way a wall with a door at X=500-600 gives breaks at the wall's
    perpendicular X (one value) AND the dimensioner can also see the
    opening edges through chain.openings if it wants finer detail.

    The function intentionally returns only the wall's perp-coordinate,
    not endpoints of the wall along its own axis; callers wanting the
    along-axis ends of an H wall (its x-positions) should iterate the
    chains themselves.
    """
    out: List[float] = []
    for ch in chains:
        if ch.orientation != orientation:
            continue
        out.append(ch.c)
    return sorted(set(out))


def chain_along_axis_breaks(chains: List[WallChain], orientation: str) -> List[float]:
    """Break positions ALONG the chain axis for chains in `orientation`.

    For orientation='V' (vertical walls), this returns the X positions
    of those walls. Used as inner-chain breakpoints for a horizontal
    dimension chain on top/bottom.

    For orientation='H' (horizontal walls), returns Y positions of those
    walls — feeding the left/right vertical dimension chain.

    Equivalent to chain_endpoints today; kept distinct so its semantic
    role (breakpoints for a perpendicular dimension chain) stays explicit.
    """
    return chain_endpoints(chains, orientation)
