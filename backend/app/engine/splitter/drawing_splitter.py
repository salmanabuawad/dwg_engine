"""
Multi-drawing DXF splitter.

CLAUDE-GUARD:
A DXF may contain one drawing or many drawings.
Never dimension the full sheet. Split first, then process each split independently.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional, Tuple

import ezdxf
import numpy as np

BBox = Tuple[float, float, float, float]

def entity_bbox(e: Any) -> Optional[BBox]:
    pts = []

    try:
        t = e.dxftype()
        if t == "LINE":
            pts = [(e.dxf.start.x, e.dxf.start.y), (e.dxf.end.x, e.dxf.end.y)]
        elif t == "LWPOLYLINE":
            pts = [(p[0], p[1]) for p in e.get_points()]
        elif t == "POLYLINE":
            pts = [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
        elif t == "DIMENSION":
            for attr in ["defpoint", "defpoint2", "defpoint3"]:
                if hasattr(e.dxf, attr):
                    p = getattr(e.dxf, attr)
                    pts.append((p.x, p.y))
        elif t in ("TEXT", "MTEXT", "INSERT"):
            p = e.dxf.insert
            pts = [(p.x, p.y)]
    except Exception:
        return None

    if not pts:
        return None

    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))

def intersects(a: BBox, b: BBox) -> bool:
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])

def copy_layers(src_doc: Any, dst_doc: Any) -> None:
    for layer in src_doc.layers:
        try:
            name = layer.dxf.name
            if name not in dst_doc.layers:
                dst_doc.layers.new(name, dxfattribs={"color": layer.dxf.color})
        except Exception:
            pass

def collect_entities(doc: Any) -> tuple[list[dict], BBox]:
    records = []
    all_x, all_y = [], []

    for e in doc.modelspace():
        b = entity_bbox(e)
        if b is None:
            continue

        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        records.append({
            "entity": e,
            "type": e.dxftype(),
            "layer": getattr(e.dxf, "layer", ""),
            "bbox": b,
            "center": (cx, cy),
            "w": b[2] - b[0],
            "h": b[3] - b[1],
        })

        all_x += [b[0], b[2]]
        all_y += [b[1], b[3]]

    if not records:
        raise RuntimeError("No DXF entities found")

    return records, (min(all_x), min(all_y), max(all_x), max(all_y))

def _explicit_drawing_layers() -> set[str] | None:
    """Read SPLITTER_DRAWING_LAYERS env var. Returns None if unset."""
    import os as _os
    raw = _os.environ.get("SPLITTER_DRAWING_LAYERS", "").strip()
    if not raw:
        return None
    return {layer.strip() for layer in raw.split(",") if layer.strip()}


def _dbscan_count(centers: np.ndarray, eps: float) -> int:
    """Return the number of connected components in `centers` under
    Euclidean-distance threshold eps. Used to score candidate drawing
    layers."""
    n = len(centers)
    if n == 0:
        return 0
    visited = np.zeros(n, dtype=bool)
    count = 0
    for i in range(n):
        if visited[i]:
            continue
        stack = [i]
        visited[i] = True
        while stack:
            j = stack.pop()
            d = np.sqrt(((centers - centers[j]) ** 2).sum(axis=1))
            for k in np.where(d <= eps)[0]:
                if not visited[k]:
                    visited[k] = True
                    stack.append(int(k))
        count += 1
    return count


def _autodetect_drawing_layers(records: list[dict], eps: float, gw: float, gh: float) -> set[str] | None:
    """Pick the geometry-bearing layer(s) most likely to hold the actual
    drawing content. A drawing layer's geometry forms multiple distinct
    clusters (one per building / floor plan). A sheet-decoration layer's
    geometry forms a single sprawling cluster (the title block / frame).
    Returns the layer(s) tied at the top by cluster count, or None to
    skip layer filtering altogether when nothing scores meaningfully.
    """
    from collections import defaultdict
    by_layer_pts: dict[str, list[tuple[int, tuple[float, float]]]] = defaultdict(list)
    for i, r in enumerate(records):
        if r["w"] > gw * 0.60 or r["h"] > gh * 0.60:
            continue
        if r["type"] in ("LINE", "LWPOLYLINE", "POLYLINE"):
            by_layer_pts[r["layer"]].append((i, r["center"]))

    if not by_layer_pts:
        return None

    scores: list[tuple[str, int, int]] = []
    for layer, pts in by_layer_pts.items():
        if len(pts) < 8:
            continue
        centers = np.array([c for _, c in pts], dtype=float)
        n_clusters = _dbscan_count(centers, eps)
        scores.append((layer, n_clusters, len(pts)))

    if not scores:
        return None

    scores.sort(key=lambda s: (-s[1], -s[2]))
    top_n = scores[0][1]
    # Only filter by layer if the winner shows real spatial diversity
    # (more than one cluster). A single-drawing file gives top_n == 1 and
    # layer filtering buys us nothing — leave the whitelist unset.
    if top_n < 2:
        return None
    return {s[0] for s in scores if s[1] == top_n}


def detect_drawing_clusters(records: list[dict], global_bbox: BBox) -> list[dict]:
    gx1, gy1, gx2, gy2 = global_bbox
    gw, gh = gx2 - gx1, gy2 - gy1

    # Compute eps first — auto-layer-detection scores layers by cluster
    # count at the same eps the main pass will use, so they have to agree.
    import os as _os
    eps_env = _os.environ.get("SPLITTER_EPS")
    eps = float(eps_env) if eps_env else max(250.0, ((gw * gh) ** 0.5) * 0.004)

    drawing_layers = _explicit_drawing_layers()
    if drawing_layers is None:
        drawing_layers = _autodetect_drawing_layers(records, eps, gw, gh)

    def _build_seeds(filter_by_layer: bool) -> list:
        out = []
        for i, r in enumerate(records):
            if r["w"] > gw * 0.60 or r["h"] > gh * 0.60:
                continue
            if filter_by_layer and drawing_layers is not None and r["layer"] not in drawing_layers:
                continue
            if r["type"] in ("LINE", "LWPOLYLINE", "POLYLINE", "DIMENSION", "TEXT", "MTEXT", "INSERT"):
                out.append((i, r["center"]))
        return out

    seeds = _build_seeds(filter_by_layer=True)
    if not seeds and drawing_layers is not None:
        # Layer whitelist matched nothing — fall back to no-filter so the
        # file still produces output instead of zero drawings.
        seeds = _build_seeds(filter_by_layer=False)

    if not seeds:
        return []

    centers = np.array([c for _, c in seeds], dtype=float)
    # eps was computed above (auto-layer-detection needs the same value).
    visited = np.zeros(len(seeds), dtype=bool)
    clusters = []

    for i in range(len(seeds)):
        if visited[i]:
            continue

        stack = [i]
        visited[i] = True
        comp = []

        while stack:
            j = stack.pop()
            comp.append(seeds[j][0])

            d = np.sqrt(((centers - centers[j]) ** 2).sum(axis=1))
            for k in np.where(d <= eps)[0]:
                if not visited[k]:
                    visited[k] = True
                    stack.append(int(k))

        clusters.append(comp)

    candidates = []
    for cid, comp in enumerate(clusters, start=1):
        xs, ys = [], []
        types = {}

        for idx in comp:
            r = records[idx]
            b = r["bbox"]
            xs += [b[0], b[2]]
            ys += [b[1], b[3]]
            types[r["type"]] = types.get(r["type"], 0) + 1

        b = (min(xs), min(ys), max(xs), max(ys))
        area = (b[2] - b[0]) * (b[3] - b[1])

        if len(comp) >= 10 or area > 10000:
            candidates.append({
                "id": cid,
                "indices": comp,
                "bbox": b,
                "area": float(area),
                "entity_count": len(comp),
                "types": types,
            })

    # A "real" drawing must have structural geometry (lines / polylines).
    # Pure text/dim clusters are sheet annotations (titles, callouts), not
    # drawings — keeping them creates phantom rows in the UI and steals
    # entities away from the actual drawing they belong to.
    def geom_count(c: dict) -> int:
        t = c["types"]
        return t.get("LINE", 0) + t.get("LWPOLYLINE", 0) + t.get("POLYLINE", 0)

    # A building drawing has substantial geometry — walls, lines, polylines.
    # Threshold tuned high enough that small clusters (dim chains, callouts,
    # title fragments) get filtered out and absorbed via strict partition
    # routing, but low enough that a small floor plan still qualifies.
    # Override via SPLITTER_MIN_GEOM env var.
    import os as _os2
    geom_min = int(_os2.environ.get("SPLITTER_MIN_GEOM", "20"))
    real = [c for c in candidates if geom_count(c) >= geom_min]
    # Safety net: never return zero clusters from a non-empty file — if
    # the geometry filter dropped everything, fall back to the original
    # size/count filter so the engine still has something to dimension.
    infos = real if real else candidates

    return sorted(infos, key=lambda c: (c["area"], c["entity_count"]), reverse=True)

def split_dxf(input_dxf: Path, output_dir: Path) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)

    doc = ezdxf.readfile(str(input_dxf))
    records, global_bbox = collect_entities(doc)
    clusters = detect_drawing_clusters(records, global_bbox)

    gx1, gy1, gx2, gy2 = global_bbox
    gw, gh = gx2 - gx1, gy2 - gy1

    # Strict partition: every (non-frame) entity goes to EXACTLY ONE drawing.
    # Records that are members of a kept cluster go to that cluster. Records
    # that fell out of clustering (or into a rejected micro-cluster) are
    # assigned to the kept cluster whose center is nearest. This stops
    # drawing-1's bbox from sweeping up the entire sheet.
    n_records = len(records)
    n_clusters = len(clusters)
    ownership = [-1] * n_records  # record index -> kept-cluster index (0..n_clusters-1)

    for ki, cluster in enumerate(clusters):
        for idx in cluster["indices"]:
            ownership[idx] = ki

    if n_clusters > 0:
        cluster_centers = np.array([
            ((c["bbox"][0] + c["bbox"][2]) / 2.0, (c["bbox"][1] + c["bbox"][3]) / 2.0)
            for c in clusters
        ], dtype=float)
        # Pre-compute each cluster's expanded bbox so we can decide whether a
        # stray record (e.g. a dimension on the VP layer, a label) is close
        # enough to a drawing to be attached, or is sheet decoration (title
        # block, schedule, frame) that should be dropped.
        cluster_expanded = []
        for c in clusters:
            b = c["bbox"]
            pad = max(b[2] - b[0], b[3] - b[1]) * 0.15
            cluster_expanded.append((b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad))

        def near_any_cluster(rec_bbox) -> int:
            """Return the index of a cluster whose expanded bbox contains
            rec_bbox's center, else -1."""
            cx = (rec_bbox[0] + rec_bbox[2]) / 2.0
            cy = (rec_bbox[1] + rec_bbox[3]) / 2.0
            for ki, eb in enumerate(cluster_expanded):
                if eb[0] <= cx <= eb[2] and eb[1] <= cy <= eb[3]:
                    return ki
            return -1

        for i, r in enumerate(records):
            if ownership[i] != -1:
                continue
            # Frame / title-block sized entities never get assigned.
            if r["w"] > gw * 0.60 or r["h"] > gh * 0.60:
                continue
            # If the entity sits inside some drawing's expanded bbox, attach
            # it to that drawing. Otherwise it's sheet decoration (title
            # block, frame, schedule) — drop it from every output.
            hit = near_any_cluster(r["bbox"])
            if hit >= 0:
                ownership[i] = hit

    buckets: list[list[int]] = [[] for _ in clusters]
    for i, owner in enumerate(ownership):
        if owner >= 0:
            buckets[owner].append(i)

    drawings = []

    for n, (cluster, member_idxs) in enumerate(zip(clusters, buckets), start=1):
        b = cluster["bbox"]
        pad = max(b[2] - b[0], b[3] - b[1]) * 0.08
        expanded = (b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad)

        ndoc = ezdxf.new(dxfversion=doc.dxfversion)
        ndoc.units = doc.units
        copy_layers(doc, ndoc)
        nmsp = ndoc.modelspace()
        copied = 0

        for idx in member_idxs:
            r = records[idx]
            try:
                nmsp.add_entity(r["entity"].copy())
                copied += 1
            except Exception:
                pass

        file_path = output_dir / f"drawing_{n:02d}.dxf"
        ndoc.saveas(str(file_path))

        drawings.append({
            "drawing": n,
            "file": str(file_path),
            "bbox": b,
            "expanded_bbox": expanded,
            "copied_entities": copied,
            "cluster_entity_count": cluster["entity_count"],
            "types": cluster["types"],
        })

    return {
        "input": str(input_dxf),
        "global_bbox": global_bbox,
        "drawings_detected": len(drawings),
        "drawings": drawings,
    }
