"""
Line registry.

CLAUDE-GUARD:
Do not create dimensions directly from raw DXF entities.
Always extract normalized lines first, then group locally and semantically.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import math
from typing import Any, List

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

def extract_lines_from_doc(doc: Any) -> List[LineSegment]:
    lines: List[LineSegment] = []
    idx = 1

    for e in doc.modelspace():
        entity_type = e.dxftype()
        layer = getattr(e.dxf, "layer", "")

        if "DIM" in layer.upper() or "NAVVIX" in layer.upper():
            continue

        try:
            if entity_type == "LINE":
                a, b = e.dxf.start, e.dxf.end
                seg = make_segment(idx, a.x, a.y, b.x, b.y, layer, entity_type)
                if seg:
                    lines.append(seg)
                    idx += 1

            elif entity_type == "LWPOLYLINE":
                pts = [(p[0], p[1]) for p in e.get_points()]
                if e.closed and pts:
                    pts.append(pts[0])
                for a, b in zip(pts, pts[1:]):
                    seg = make_segment(idx, a[0], a[1], b[0], b[1], layer, entity_type)
                    if seg:
                        lines.append(seg)
                        idx += 1

            elif entity_type == "POLYLINE":
                pts = [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
                if e.is_closed and pts:
                    pts.append(pts[0])
                for a, b in zip(pts, pts[1:]):
                    seg = make_segment(idx, a[0], a[1], b[0], b[1], layer, entity_type)
                    if seg:
                        lines.append(seg)
                        idx += 1
        except Exception:
            continue

    return lines
