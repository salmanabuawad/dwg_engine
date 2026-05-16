"""
Main architectural plan isolation.

CLAUDE-GUARD:
Do not delete this module.
This module prevents page frames, title borders, legends, and long sheet rectangles
from becoming architectural wall geometry.

Problem fixed:
The engine previously used the whole split drawing bbox, so long border/page lines
became overall dimensions such as 62827 and 40237. This is wrong.

Rule:
Dimension bbox and semantic edges must be computed from architectural lines only,
not page frames, title blocks, table borders, or sheet rectangles.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Iterable, List, Tuple
import math
import numpy as np

from app.engine.geometry.line_registry import LineSegment

BBox = Tuple[float, float, float, float]


def line_bbox(line: LineSegment) -> BBox:
    return (
        min(line.x1, line.x2),
        min(line.y1, line.y2),
        max(line.x1, line.x2),
        max(line.y1, line.y2),
    )


def bbox_from_lines(lines: Iterable[LineSegment]) -> BBox:
    xs, ys = [], []
    for line in lines:
        xs += [line.x1, line.x2]
        ys += [line.y1, line.y2]
    if not xs:
        return (0.0, 0.0, 1.0, 1.0)
    return (float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys)))


def robust_bbox_from_lines(lines: Iterable[LineSegment]) -> BBox:
    xs, ys = [], []
    for line in lines:
        xs += [line.x1, line.x2]
        ys += [line.y1, line.y2]
    if len(xs) < 4:
        return bbox_from_lines(lines)
    return (
        float(np.percentile(xs, 1)),
        float(np.percentile(ys, 1)),
        float(np.percentile(xs, 99)),
        float(np.percentile(ys, 99)),
    )


def is_frame_like_line(line: LineSegment, global_bbox: BBox) -> bool:
    """Detect page/sheet border lines.

    A page frame usually has:
    - very long horizontal/vertical lines
    - located close to global bbox extremes
    - sparse relationship to the real architectural cluster
    """
    gx1, gy1, gx2, gy2 = global_bbox
    gw = max(1.0, gx2 - gx1)
    gh = max(1.0, gy2 - gy1)

    mx = (line.x1 + line.x2) / 2.0
    my = (line.y1 + line.y2) / 2.0

    # Absolute giant line rejection.
    if line.orientation == "H" and line.length > gw * 0.55:
        near_top_bottom = abs(my - gy1) < gh * 0.12 or abs(my - gy2) < gh * 0.12
        if near_top_bottom:
            return True

    if line.orientation == "V" and line.length > gh * 0.55:
        near_left_right = abs(mx - gx1) < gw * 0.12 or abs(mx - gx2) < gw * 0.12
        if near_left_right:
            return True

    # Very large line close to any sheet edge is not a wall.
    if line.length > max(gw, gh) * 0.65:
        edge_close = (
            abs(mx - gx1) < gw * 0.08
            or abs(mx - gx2) < gw * 0.08
            or abs(my - gy1) < gh * 0.08
            or abs(my - gy2) < gh * 0.08
        )
        if edge_close:
            return True

    return False


def cluster_local_lines(lines: List[LineSegment]) -> List[List[LineSegment]]:
    if not lines:
        return []

    centers = np.array([[(l.x1 + l.x2) / 2.0, (l.y1 + l.y2) / 2.0] for l in lines], dtype=float)
    bbox = bbox_from_lines(lines)
    width = max(1.0, bbox[2] - bbox[0])
    height = max(1.0, bbox[3] - bbox[1])
    eps = max(180.0, min(width, height) * 0.065)

    visited = np.zeros(len(lines), dtype=bool)
    clusters: List[List[LineSegment]] = []

    for i in range(len(lines)):
        if visited[i]:
            continue
        stack = [i]
        visited[i] = True
        comp = []

        while stack:
            j = stack.pop()
            comp.append(lines[j])
            distances = np.sqrt(((centers - centers[j]) ** 2).sum(axis=1))
            for k in np.where(distances <= eps)[0]:
                if not visited[k]:
                    visited[k] = True
                    stack.append(int(k))

        clusters.append(comp)

    return clusters


def select_architectural_clusters(lines: List[LineSegment]) -> List[LineSegment]:
    """Keep dense/local architectural clusters and reject sparse page-frame clusters."""
    if not lines:
        return []

    global_bbox = bbox_from_lines(lines)
    no_frame = [line for line in lines if not is_frame_like_line(line, global_bbox)]

    if not no_frame:
        return []

    clusters = cluster_local_lines(no_frame)
    if not clusters:
        return no_frame

    scored = []
    gx1, gy1, gx2, gy2 = bbox_from_lines(no_frame)
    global_area = max(1.0, (gx2 - gx1) * (gy2 - gy1))

    for cluster in clusters:
        b = bbox_from_lines(cluster)
        width = max(1.0, b[2] - b[0])
        height = max(1.0, b[3] - b[1])
        area = width * height
        count = len(cluster)
        total_len = sum(l.length for l in cluster)
        density = count / area

        # Reject sparse giant rectangular/table-like clusters.
        if area > global_area * 0.70 and density < 1e-6 and count < 80:
            continue

        score = count * 10.0 + total_len * 0.002 + density * 500000.0
        scored.append((score, cluster, b, count, density))

    if not scored:
        return no_frame

    scored.sort(key=lambda x: x[0], reverse=True)
    best_score = scored[0][0]

    # Keep the main architectural cluster and meaningful nearby clusters.
    # Do NOT keep tiny text/table fragments.
    kept: List[LineSegment] = []
    for score, cluster, b, count, density in scored:
        if score >= best_score * 0.18 or count >= 18:
            kept.extend(cluster)

    return kept


def isolate_architectural_lines(lines: List[LineSegment]) -> tuple[List[LineSegment], dict]:
    """Return architectural lines only + debug metadata."""
    global_bbox = bbox_from_lines(lines)
    frame_lines = [l for l in lines if is_frame_like_line(l, global_bbox)]
    non_frame = [l for l in lines if not is_frame_like_line(l, global_bbox)]
    architectural = select_architectural_clusters(non_frame)

    return architectural, {
        "input_lines": len(lines),
        "frame_lines_removed": len(frame_lines),
        "non_frame_lines": len(non_frame),
        "architectural_lines": len(architectural),
        "global_bbox": global_bbox,
        "architectural_bbox": bbox_from_lines(architectural) if architectural else None,
    }
