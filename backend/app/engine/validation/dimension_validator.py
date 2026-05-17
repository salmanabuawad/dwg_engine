from __future__ import annotations
from dataclasses import dataclass, asdict

@dataclass
class DimensionCandidate:
    id: str
    orientation: str
    p1: tuple[float, float]
    p2: tuple[float, float]
    base: tuple[float, float]
    length: float
    source_type: str
    source_id: str
    priority: int
    def to_dict(self):
        return asdict(self)

def validate_candidate(candidate: DimensionCandidate, local_max: float | None = None) -> tuple[bool, str]:
    if candidate.length <= 0:
        return False, "non_positive_length"
    if candidate.source_type not in {"wall_chain", "overall_bbox", "opening"}:
        return False, "invalid_source_type"
    if local_max is not None and candidate.length > local_max:
        return False, "too_large_for_local_context"
    if candidate.orientation not in {"H", "V"}:
        return False, "invalid_orientation"
    return True, "ok"
