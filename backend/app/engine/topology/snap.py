from __future__ import annotations
from dataclasses import dataclass
from typing import Iterable, Tuple
import math

Point = Tuple[float, float]

@dataclass(frozen=True)
class SnapNode:
    id: str
    x: float
    y: float

def distance(a: Point, b: Point) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])

def default_snap_tolerance(lengths: Iterable[float]) -> float:
    vals = sorted(float(v) for v in lengths if v and v > 0)
    if not vals:
        return 5.0
    median = vals[len(vals) // 2]
    return max(3.0, min(35.0, median * 0.015))

class SnapIndex:
    """Endpoint snap index.

    CLAUDE-GUARD:
    Do not replace topology snapping with bbox heuristics.
    """

    def __init__(self, tolerance: float):
        self.tolerance = float(max(0.001, tolerance))
        self.cell = self.tolerance
        self.nodes: list[SnapNode] = []
        self.grid: dict[tuple[int, int], list[int]] = {}

    def _cell_key(self, p: Point) -> tuple[int, int]:
        return (int(round(p[0] / self.cell)), int(round(p[1] / self.cell)))

    def _neighbor_keys(self, key: tuple[int, int]):
        x, y = key
        for dx in [-1, 0, 1]:
            for dy in [-1, 0, 1]:
                yield (x + dx, y + dy)

    def snap(self, p: Point) -> SnapNode:
        key = self._cell_key(p)
        best_idx = None
        best_dist = None
        for nk in self._neighbor_keys(key):
            for idx in self.grid.get(nk, []):
                node = self.nodes[idx]
                d = distance((node.x, node.y), p)
                if d <= self.tolerance and (best_dist is None or d < best_dist):
                    best_idx = idx
                    best_dist = d
        if best_idx is not None:
            return self.nodes[best_idx]
        node = SnapNode(id=f"N{len(self.nodes)+1:06d}", x=float(p[0]), y=float(p[1]))
        self.nodes.append(node)
        self.grid.setdefault(key, []).append(len(self.nodes) - 1)
        return node
