from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import Dict, List
from app.engine.geometry.line_registry import LineSegment
from app.engine.topology.snap import SnapIndex, default_snap_tolerance

@dataclass
class TopologyEdge:
    id: str
    line_id: str
    start_node: str
    end_node: str
    x1: float
    y1: float
    x2: float
    y2: float
    length: float
    orientation: str
    layer: str

    @property
    def axis(self) -> float:
        return (self.y1 + self.y2) / 2.0 if self.orientation == "H" else (self.x1 + self.x2) / 2.0

    @property
    def start_axis(self) -> float:
        return min(self.x1, self.x2) if self.orientation == "H" else min(self.y1, self.y2)

    @property
    def end_axis(self) -> float:
        return max(self.x1, self.x2) if self.orientation == "H" else max(self.y1, self.y2)

    def to_dict(self):
        return asdict(self)

@dataclass
class TopologyGraph:
    nodes: Dict[str, dict] = field(default_factory=dict)
    edges: Dict[str, TopologyEdge] = field(default_factory=dict)
    adjacency: Dict[str, List[str]] = field(default_factory=dict)
    snap_tolerance: float = 5.0

    def add_node(self, node_id: str, x: float, y: float):
        self.nodes[node_id] = {"id": node_id, "x": float(x), "y": float(y)}
        self.adjacency.setdefault(node_id, [])

    def add_edge(self, edge: TopologyEdge):
        self.edges[edge.id] = edge
        self.adjacency.setdefault(edge.start_node, []).append(edge.id)
        self.adjacency.setdefault(edge.end_node, []).append(edge.id)

    def to_debug_dict(self):
        return {
            "snap_tolerance": self.snap_tolerance,
            "nodes": list(self.nodes.values()),
            "edges": [edge.to_dict() for edge in self.edges.values()],
            "adjacency": self.adjacency,
        }

def build_topology_graph(lines: list[LineSegment], snap_tolerance: float | None = None) -> TopologyGraph:
    wall_lines = [l for l in lines if l.orientation in ("H", "V") and l.length > 1e-6]
    tol = snap_tolerance or default_snap_tolerance([l.length for l in wall_lines])
    snap = SnapIndex(tol)
    graph = TopologyGraph(snap_tolerance=tol)
    eid = 1
    for line in wall_lines:
        n1 = snap.snap((line.x1, line.y1))
        n2 = snap.snap((line.x2, line.y2))
        if n1.id == n2.id:
            continue
        graph.add_node(n1.id, n1.x, n1.y)
        graph.add_node(n2.id, n2.x, n2.y)
        edge = TopologyEdge(
            id=f"E{eid:06d}",
            line_id=line.id,
            start_node=n1.id,
            end_node=n2.id,
            x1=float(line.x1), y1=float(line.y1), x2=float(line.x2), y2=float(line.y2),
            length=float(line.length),
            orientation=line.orientation,
            layer=line.layer,
        )
        graph.add_edge(edge)
        eid += 1
    return graph
