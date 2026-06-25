"""
Line registry.

CLAUDE-GUARD:
Do not create dimensions directly from raw DXF entities.
Always extract normalized lines first, then group locally and semantically.

Handled entity types:
  LINE           — direct segment.
  LWPOLYLINE     — flattened to line segments via ezdxf, so bulge-encoded
                   arcs (rounded corners, curved walls) become a series
                   of short chords. Without this rounded-corner buildings
                   (10-apt residential floors etc.) lose their straight
                   outer walls because the polyline's corner arcs would
                   read as a single OTHER-oriented chord and break wall
                   continuity at every corner.
  POLYLINE       — same flattening for the old-style polyline.
  ARC            — subdivided into short chords (≤ARC_MAX_CHORD units).
  CIRCLE         — subdivided into 64-segment polygon. Rare on walls but
                   shows up on round columns / shafts.

Caps:
  MAX_EXTRACTED_LINES limits the total registry size. A 1.7M-line site
  plan in the deep_v2 dataset would otherwise OOM the topology graph and
  matplotlib renderer. We truncate with a flag instead so processing
  always completes (partial geometry is still useful upstream).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import math
from typing import Any, List, Tuple

# Hard cap. Anything beyond this is either a site plan that's too dense
# for the topology pipeline (which is O(n²) in the worst case for
# adjacency checks) or pathological. Truncate rather than fail.
MAX_EXTRACTED_LINES = 80_000

# Curve subdivision tolerance. Chord length below which we stop
# subdividing an arc. In drawing units — DXFs use mm/cm/inches, so 50
# is a reasonable mid-range. With a typical wall arc radius 200–500
# this gives 4–8 chords per quarter-arc.
ARC_MAX_CHORD = 50.0


@dataclass
class LineSegment:
    id: str
    x1: float
    y1: float
    x2: float
    y2: float
    length: float
    orientation: str
    layer: str
    entity_type: str

    def to_dict(self):
        return asdict(self)


def normalize_orientation(x1: float, y1: float, x2: float, y2: float) -> str:
    dx = x2 - x1
    dy = y2 - y1
    if abs(dx) >= abs(dy) * 8:
        return "H"
    if abs(dy) >= abs(dx) * 8:
        return "V"
    return "OTHER"


def make_segment(idx: int, x1: float, y1: float, x2: float, y2: float, layer: str, entity_type: str) -> LineSegment | None:
    length = math.hypot(x2 - x1, y2 - y1)
    if length < 1e-6:
        return None

    return LineSegment(
        id=f"L{idx:06d}",
        x1=float(x1),
        y1=float(y1),
        x2=float(x2),
        y2=float(y2),
        length=float(length),
        orientation=normalize_orientation(x1, y1, x2, y2),
        layer=layer,
        entity_type=entity_type,
    )


def _arc_chords(cx: float, cy: float, radius: float,
                start_angle_rad: float, end_angle_rad: float,
                max_chord: float = ARC_MAX_CHORD) -> List[Tuple[float, float, float, float]]:
    """Subdivide an arc into ≤max_chord-length chords. Returns a list
    of (x1, y1, x2, y2). Used by the ARC / CIRCLE / bulge handlers."""
    if radius <= 0:
        return []
    # Sweep can be negative if end < start in raw DXF; normalise to a
    # positive walk so subdivision is well defined.
    sweep = end_angle_rad - start_angle_rad
    if sweep <= 0:
        sweep += 2 * math.pi
    arc_length = radius * sweep
    n = max(2, int(math.ceil(arc_length / max_chord)))
    out: List[Tuple[float, float, float, float]] = []
    last_x = cx + radius * math.cos(start_angle_rad)
    last_y = cy + radius * math.sin(start_angle_rad)
    for i in range(1, n + 1):
        t = start_angle_rad + sweep * i / n
        x = cx + radius * math.cos(t)
        y = cy + radius * math.sin(t)
        out.append((last_x, last_y, x, y))
        last_x, last_y = x, y
    return out


def _bulge_to_chords(x1: float, y1: float, x2: float, y2: float, bulge: float
                    ) -> List[Tuple[float, float, float, float]]:
    """Turn a bulged LWPOLYLINE segment into a list of chord segments.
    bulge = tan(swept_angle / 4); sign encodes CCW/CW. With bulge=0 the
    segment is a straight line and we just return the chord itself.

    Derivation (standard DXF): with chord length C and bulge b,
        swept_angle = 4 * atan(b)
        sagitta s   = (C/2) * b  (signed)
        radius      = ((C/2)**2 + s**2) / (2 * |s|)
    """
    if abs(bulge) < 1e-9:
        return [(x1, y1, x2, y2)]
    dx, dy = x2 - x1, y2 - y1
    chord = math.hypot(dx, dy)
    if chord < 1e-9:
        return []
    swept = 4.0 * math.atan(bulge)
    radius = chord / (2.0 * math.sin(swept / 2.0))
    # Midpoint of chord
    mx, my = (x1 + x2) * 0.5, (y1 + y2) * 0.5
    # Perpendicular direction (CCW if bulge > 0)
    ux, uy = -dy / chord, dx / chord
    # Distance from midpoint to centre is radius * cos(swept/2)
    d = radius * math.cos(swept / 2.0)
    sign = 1.0 if bulge > 0 else -1.0
    cx = mx - sign * ux * d
    cy = my - sign * uy * d
    start_angle = math.atan2(y1 - cy, x1 - cx)
    end_angle = math.atan2(y2 - cy, x2 - cx)
    # Walk in the bulge's direction
    if bulge > 0 and end_angle < start_angle:
        end_angle += 2 * math.pi
    if bulge < 0 and end_angle > start_angle:
        end_angle -= 2 * math.pi
    return _arc_chords(cx, cy, abs(radius),
                       min(start_angle, end_angle),
                       max(start_angle, end_angle))


def _lwpoly_segments(e: Any) -> List[Tuple[float, float, float, float]]:
    """Flatten an LWPOLYLINE to chord segments, honouring bulge."""
    try:
        pts = list(e.get_points("xyb"))
    except Exception:
        pts = [(p[0], p[1], 0.0) for p in e.get_points()]
    if e.closed and pts:
        pts.append(pts[0])
    out: List[Tuple[float, float, float, float]] = []
    for a, b in zip(pts, pts[1:]):
        x1, y1, bulge = a[0], a[1], (a[2] if len(a) > 2 else 0.0)
        x2, y2 = b[0], b[1]
        out.extend(_bulge_to_chords(x1, y1, x2, y2, bulge))
    return out


def extract_lines_from_doc(doc: Any) -> List[LineSegment]:
    lines: List[LineSegment] = []
    idx = 1
    truncated = False

    def _push(x1, y1, x2, y2, layer, etype) -> bool:
        nonlocal idx, truncated
        if len(lines) >= MAX_EXTRACTED_LINES:
            truncated = True
            return False
        seg = make_segment(idx, x1, y1, x2, y2, layer, etype)
        if seg:
            lines.append(seg)
            idx += 1
        return True

    for e in doc.modelspace():
        if len(lines) >= MAX_EXTRACTED_LINES:
            truncated = True
            break

        entity_type = e.dxftype()
        layer = getattr(e.dxf, "layer", "")

        if "DIM" in layer.upper() or "NAVVIX" in layer.upper():
            continue

        try:
            if entity_type == "LINE":
                a, b = e.dxf.start, e.dxf.end
                _push(a.x, a.y, b.x, b.y, layer, entity_type)

            elif entity_type == "LWPOLYLINE":
                for (x1, y1, x2, y2) in _lwpoly_segments(e):
                    if not _push(x1, y1, x2, y2, layer, entity_type):
                        break

            elif entity_type == "POLYLINE":
                pts = [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
                if e.is_closed and pts:
                    pts.append(pts[0])
                for a, b in zip(pts, pts[1:]):
                    if not _push(a[0], a[1], b[0], b[1], layer, entity_type):
                        break

            elif entity_type == "ARC":
                cx = e.dxf.center.x
                cy = e.dxf.center.y
                r = float(e.dxf.radius)
                sa = math.radians(float(e.dxf.start_angle))
                ea = math.radians(float(e.dxf.end_angle))
                for (x1, y1, x2, y2) in _arc_chords(cx, cy, r, sa, ea):
                    if not _push(x1, y1, x2, y2, layer, entity_type):
                        break

            elif entity_type == "CIRCLE":
                cx = e.dxf.center.x
                cy = e.dxf.center.y
                r = float(e.dxf.radius)
                # Full circle: 0 → 2π.
                for (x1, y1, x2, y2) in _arc_chords(cx, cy, r, 0.0, 2 * math.pi):
                    if not _push(x1, y1, x2, y2, layer, entity_type):
                        break
        except Exception:
            continue

    # Stash truncation info on the function via a module-level flag so
    # callers can surface it in their report without changing the
    # function signature (used by isolate_architectural_lines etc.).
    extract_lines_from_doc.last_truncated = truncated  # type: ignore[attr-defined]
    return lines


# Initial state for the truncation flag (set by the function above).
extract_lines_from_doc.last_truncated = False  # type: ignore[attr-defined]
