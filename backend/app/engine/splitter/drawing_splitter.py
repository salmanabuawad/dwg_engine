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

def detect_drawing_clusters(records: list[dict], global_bbox: BBox) -> list[dict]:
    gx1, gy1, gx2, gy2 = global_bbox
    gw, gh = gx2 - gx1, gy2 - gy1

    seeds = []
    for i, r in enumerate(records):
        # Hard reject huge sheet/page/frame entities during clustering.
        if r["w"] > gw * 0.60 or r["h"] > gh * 0.60:
            continue
        if r["type"] in ("LINE", "LWPOLYLINE", "POLYLINE", "DIMENSION", "TEXT", "MTEXT", "INSERT"):
            seeds.append((i, r["center"]))

    if not seeds:
        return []

    centers = np.array([c for _, c in seeds], dtype=float)
    eps = max(250.0, min(gw, gh) * 0.035)

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

    infos = []
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
            infos.append({
                "id": cid,
                "indices": comp,
                "bbox": b,
                "area": float(area),
                "entity_count": len(comp),
                "types": types,
            })

    return sorted(infos, key=lambda c: (c["area"], c["entity_count"]), reverse=True)

def split_dxf(input_dxf: Path, output_dir: Path) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)

    doc = ezdxf.readfile(str(input_dxf))
    records, global_bbox = collect_entities(doc)
    clusters = detect_drawing_clusters(records, global_bbox)

    gx1, gy1, gx2, gy2 = global_bbox
    gw, gh = gx2 - gx1, gy2 - gy1

    drawings = []

    for n, cluster in enumerate(clusters, start=1):
        b = cluster["bbox"]
        pad = max(b[2] - b[0], b[3] - b[1]) * 0.08
        expanded = (b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad)

        ndoc = ezdxf.new(dxfversion=doc.dxfversion)
        ndoc.units = doc.units
        copy_layers(doc, ndoc)
        nmsp = ndoc.modelspace()
        copied = 0

        for r in records:
            if intersects(r["bbox"], expanded):
                # Avoid carrying full-page/title-frame entities into individual drawings.
                if r["w"] > gw * 0.60 or r["h"] > gh * 0.60:
                    continue
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
