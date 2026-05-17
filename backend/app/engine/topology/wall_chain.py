from __future__ import annotations
from dataclasses import dataclass, asdict, field
from app.engine.topology.node_graph import TopologyEdge, TopologyGraph

@dataclass
class OpeningCandidate:
    start: float
    end: float
    length: float
    def to_dict(self):
        return asdict(self)

@dataclass
class WallChain:
    id: str
    orientation: str
    axis: float
    start: float
    end: float
    length: float
    edge_ids: list[str]
    openings: list[OpeningCandidate] = field(default_factory=list)
    chain_type: str = "wall_chain"
    def to_dict(self):
        return {
            "id": self.id,
            "orientation": self.orientation,
            "axis": self.axis,
            "start": self.start,
            "end": self.end,
            "length": self.length,
            "edge_ids": self.edge_ids,
            "openings": [o.to_dict() for o in self.openings],
            "chain_type": self.chain_type,
        }

def _axis_bucket(value: float, tolerance: float) -> float:
    return round(value / tolerance) * tolerance

def _edge_span(edge: TopologyEdge) -> tuple[float, float]:
    return edge.start_axis, edge.end_axis

def _merge_group_to_chains(edges: list[TopologyEdge], orientation: str, axis: float,
                           gap_tolerance: float, opening_min: float, opening_max: float,
                           chain_id_start: int) -> tuple[list[WallChain], int]:
    if not edges:
        return [], chain_id_start
    ordered = sorted(edges, key=lambda e: e.start_axis)
    chains = []
    current_edges = [ordered[0]]
    cur_start, cur_end = _edge_span(ordered[0])
    openings = []
    cid = chain_id_start

    for edge in ordered[1:]:
        s, e = _edge_span(edge)
        gap = s - cur_end
        if gap <= gap_tolerance:
            current_edges.append(edge)
            cur_end = max(cur_end, e)
            continue
        if opening_min <= gap <= opening_max:
            openings.append(OpeningCandidate(start=cur_end, end=s, length=gap))
            current_edges.append(edge)
            cur_end = max(cur_end, e)
            continue
        if cur_end > cur_start:
            chains.append(WallChain(
                id=f"WC{cid:06d}", orientation=orientation, axis=float(axis),
                start=float(cur_start), end=float(cur_end), length=float(cur_end-cur_start),
                edge_ids=[ed.id for ed in current_edges], openings=openings))
            cid += 1
        current_edges = [edge]
        cur_start, cur_end = s, e
        openings = []

    if cur_end > cur_start:
        chains.append(WallChain(
            id=f"WC{cid:06d}", orientation=orientation, axis=float(axis),
            start=float(cur_start), end=float(cur_end), length=float(cur_end-cur_start),
            edge_ids=[ed.id for ed in current_edges], openings=openings))
        cid += 1
    return chains, cid

def build_wall_chains(graph: TopologyGraph) -> list[WallChain]:
    edges = list(graph.edges.values())
    if not edges:
        return []
    lengths = sorted([e.length for e in edges if e.length > 0])
    median = lengths[len(lengths)//2] if lengths else 100.0
    axis_tolerance = max(4.0, min(35.0, median * 0.018))
    gap_tolerance = max(8.0, min(45.0, median * 0.035))
    opening_min = max(25.0, median * 0.04)
    opening_max = max(60.0, median * 0.35)

    grouped = {}
    for edge in edges:
        if edge.orientation not in ("H", "V"):
            continue
        if edge.length < max(10.0, median * 0.02):
            continue
        key = (edge.orientation, _axis_bucket(edge.axis, axis_tolerance))
        grouped.setdefault(key, []).append(edge)

    chains = []
    cid = 1
    for (orientation, axis), group_edges in grouped.items():
        group_chains, cid = _merge_group_to_chains(
            group_edges, orientation, axis, gap_tolerance, opening_min, opening_max, cid)
        chains.extend(group_chains)

    if chains:
        chain_lengths = sorted(c.length for c in chains)
        med_chain = chain_lengths[len(chain_lengths)//2]
        min_chain = max(20.0, med_chain * 0.08)
        chains = [c for c in chains if c.length >= min_chain]
    return chains

def chains_to_debug(chains: list[WallChain]) -> dict:
    return {"count": len(chains), "chains": [c.to_dict() for c in chains]}
