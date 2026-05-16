import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import maplibregl, {
  GeoJSONSource,
  Map as MLMap,
  MapMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  PIER_COLORS,
  STATUS_COLORS,
  SiteMapProps,
  layerVisible,
  rotate90CCW,
} from "./SiteMapProps";

/**
 * MapLibre GL renderer. The site is treated as a small geographic rectangle
 * around (0, 0) so MapLibre's vector renderer can draw every pier in a
 * single GL draw call.
 *
 * Features parity with the legacy canvas SiteMap:
 *   - Blocks (polygon line + optional selection fill)
 *   - Block labels (HTML markers at centroids)
 *   - Trackers (line from first to last pier)
 *   - Piers (circle layer, colored by type)
 *   - Status rings (circle stroke for non-"New" piers)
 *   - Selected pier highlight
 *   - Layer toggles
 *   - Click to select pier / tracker / block
 *   - Pier-code labels when visible count ≤ `pierLabelThreshold`
 *   - Box area selection via an overlay rectangle (mouse + touch)
 */

// PDF points → pseudo lon/lat. Small scale keeps us well inside Mercator.
const DEG_PER_PT = 0.001;
const pt2lng = (pt: number) => pt * DEG_PER_PT;
const pt2lat = (pt: number) => -pt * DEG_PER_PT; // flip y so +y is down
const EMPTY_IMAGE_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const STRING_STATUSES = ["new", "completed", "verified"] as const;
const STRING_STATUS_LABELS: Record<string, string> = {
  new: "New",
  completed: "Completed",
  verified: "Verified",
};
const STRING_STATUS_ICONS: Record<string, string> = {
  new: "○",
  completed: "✓",
  verified: "★",
};
const STRING_STATUS_COLORS: Record<string, string> = {
  new: "#64748b",
  completed: "#16a34a",
  verified: "#2563eb",
};

function normalizeStringStatus(status: any) {
  const s = String(status || "new").toLowerCase();
  return STRING_STATUSES.includes(s as any) ? s : "new";
}

function rotatedToLngLat(
  x: number,
  y: number,
  imageWidth: number,
): [number, number] {
  const [rx, ry] = rotate90CCW(x, y, imageWidth);
  return [pt2lng(rx), pt2lat(ry)];
}

export default function SiteMapMapLibre({
  imageWidth,
  imageHeight,
  mapImageUrl,
  blocks,
  trackers,
  piers,
  dccbs = [],
  inverters = [],
  electricalZones = [],
  electricalRows = [],
  panelBaseRows = [],
  stringDetail = null,
  siteBorder = [],
  securityDevices = [],
  weatherAssets = [],
  pierStatuses,
  stringStatuses = {},
  stringImages = {},
  stringComments = {},
  selectedBlock,
  selectedTracker,
  selectedPier,
  layers,
  onBlockClick,
  onTrackerClick,
  onPierClick,
  onStringStatusChange,
  onStringImageAdd,
  onStringCommentChange,
  onAreaSelect,
  bulkSelectedPierCodes,
  pierLabelThreshold = 25,
  pierDetailThreshold = 4,
  pierStatusDisplay = "icon",
  mapLabelStride = 10,
  mapLabelDenseThreshold = 20,
}: SiteMapProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const blockMarkersRef = useRef<maplibregl.Marker[]>([]);
  const rowLabelMarkersRef = useRef<maplibregl.Marker[]>([]);
  const electricalRowMarkersRef = useRef<maplibregl.Marker[]>([]);
  const pierLabelMarkersRef = useRef<maplibregl.Marker[]>([]);
  const trackerLabelMarkersRef = useRef<maplibregl.Marker[]>([]);
  // Ref raised while the corner zoom-square is actively being dragged,
  // so the map click handlers can skip pier / tracker / block clicks
  // under the pointer during a drag.
  const isBoxDraggingRef = useRef(false);

  // Refs mirroring reactive state, so map-level event handlers (registered
  // once at load) always see the *current* props without needing the
  // enclosing effect to re-subscribe.  Without these the handlers captured
  // the first-render closure: zooming fired refreshRowLabels against the
  // stale `layers` / `rowLabelData` snapshot → labels appeared to vanish
  // despite the checkbox being selected.
  const layersRef = useRef(layers);
  useEffect(() => { layersRef.current = layers; }, [layers]);
  const piersRef = useRef(piers);
  useEffect(() => { piersRef.current = piers; }, [piers]);
  const rowLabelDataRef = useRef<Record<string, { lng: number; lat: number }>>({});
  const electricalRowLabelDataRef = useRef<Record<string, { lng: number; lat: number; zone: string; rowNum?: any; side?: string; strings?: any; stringNumbers?: number[]; stringLabels?: string[]; optimizerPattern?: string; splitStrings?: string[]; optimizers?: any; modules?: any }>>({});
  const trackerLabelDataRef = useRef<Record<string, { lng: number; lat: number }>>({});
  const [selectedString, setSelectedString] = useState<any>(null);
  // Sampling prefs are read from refs by the map's `moveend`/`zoomend`
  // handlers, which are registered once at mount; without the refs
  // those handlers would see the first-render values forever.
  const mapLabelStrideRef = useRef(mapLabelStride);
  const mapLabelDenseThresholdRef = useRef(mapLabelDenseThreshold);
  useEffect(() => { mapLabelStrideRef.current = mapLabelStride; }, [mapLabelStride]);
  useEffect(() => { mapLabelDenseThresholdRef.current = mapLabelDenseThreshold; }, [mapLabelDenseThreshold]);

  // ---- GeoJSON sources (memoized by dataset) ------------------------------

  const mapImageCoordinates = useMemo(() => {
    if (!imageWidth || !imageHeight || imageWidth <= 0 || imageHeight <= 0) {
      return [
        [0, 0],
        [0.001, 0],
        [0.001, -0.001],
        [0, -0.001],
      ] as [number, number][];
    }
    return [
      rotatedToLngLat(0, 0, imageWidth),
      rotatedToLngLat(imageWidth, 0, imageWidth),
      rotatedToLngLat(imageWidth, imageHeight, imageWidth),
      rotatedToLngLat(0, imageHeight, imageWidth),
    ];
  }, [imageWidth, imageHeight]);

  // Two-source strategy:
  // - `piers` (this) carries all 24 k positions but NO status. It only
  //   rebuilds when the pier set itself changes, so position + colour
  //   tiles stay stable across status edits.
  // - `pier-statuses` (below) carries ONE feature per non-"New" pier
  //   with the status property. The symbol icon layer reads from that
  //   smaller source. A status edit only rebuilds this overlay (often
  //   just a few hundred features), not the 24 k-pier base.
  const piersGeoJSON = useMemo(() => {
    const features = piers.map((p: any) => {
      const [lng, lat] = rotatedToLngLat(p.x, p.y, imageWidth);
      return {
        type: "Feature" as const,
        id: p.pier_code,
        geometry: { type: "Point" as const, coordinates: [lng, lat] },
        properties: {
          pier_code: p.pier_code,
          pier_type: p.pier_type || "UNKNOWN",
          color: PIER_COLORS[p.pier_type] || PIER_COLORS.UNKNOWN,
          block_code: p.block_code || "",
          tracker_code: p.tracker_code || "",
          row_num: p.row_num ?? "",
          slope_band: p.slope_band || "",
          structure_code: p.structure_code || "",
        },
      };
    });
    return { type: "FeatureCollection" as const, features };
  }, [piers, imageWidth]);

  // Status overlay — only piers that have a non-"New" status. This
  // is the source the icon symbol layer consumes, and it's the only
  // thing that needs to rebuild on a status edit. With most projects
  // starting all-"New" the overlay is initially empty and grows as
  // work progresses, so a single edit rebuilds at most a few hundred
  // features instead of all 24 k.
  const pierStatusGeoJSON = useMemo(() => {
    const features: any[] = [];
    if (!imageWidth || imageWidth <= 0) {
      return { type: "FeatureCollection" as const, features };
    }
    for (const p of piers) {
      const status = pierStatuses?.[p.pier_code];
      if (!status || status === "New") continue;
      const [lng, lat] = rotatedToLngLat(p.x, p.y, imageWidth);
      features.push({
        type: "Feature" as const,
        id: p.pier_code,
        geometry: { type: "Point" as const, coordinates: [lng, lat] },
        properties: {
          pier_code: p.pier_code,
          status,
          status_color: STATUS_COLORS[status] || "",
        },
      });
    }
    return { type: "FeatureCollection" as const, features };
  }, [piers, pierStatuses, imageWidth]);

  const blocksGeoJSON = useMemo(() => {
    const features = blocks.flatMap((b: any) => {
      const poly = b.polygon;
      if (!poly || poly.length < 3) return [];
      const ring = poly.map((pt: any) =>
        rotatedToLngLat(pt.x, pt.y, imageWidth),
      );
      ring.push(ring[0]);
      return [
        {
          type: "Feature" as const,
          geometry: { type: "Polygon" as const, coordinates: [ring] },
          properties: { block_code: b.block_code, label: b.label },
        },
      ];
    });
    return { type: "FeatureCollection" as const, features };
  }, [blocks, imageWidth]);

  const trackersGeoJSON = useMemo(() => {
    // Build a line per tracker.  We try three sources in order of
    // reliability:
    //   1. All piers on the tracker — draw the line that actually hits
    //      every pier (most accurate and, on Ashalim, always available).
    //   2. The tracker's bbox — span along whichever axis is longer.
    //   3. Skip (no usable geometry).
    //
    // The pier-based path is preferred because the Ashalim bbox values
    // coming out of the vector parser were observed to sometimes be
    // degenerate (zero width on single-pier trackers), which produced
    // point-length "lines" that MapLibre renders as invisible.
    const byTracker: Record<string, any[]> = {};
    for (const p of piers) {
      if (!p.tracker_code) continue;
      (byTracker[p.tracker_code] ??= []).push(p);
    }
    const features: any[] = [];
    let bboxUsed = 0;
    let pierUsed = 0;
    let skipped = 0;
    // Without a real imageWidth the coord transform is meaningless — skip
    // and recompute once the parent's imageWidth prop settles.
    if (!imageWidth || imageWidth <= 0) {
      return { type: "FeatureCollection" as const, features };
    }
    for (const t of trackers) {
      let a: [number, number] | null = null;
      let b: [number, number] | null = null;

      // Preferred: first-pier → last-pier along the tracker axis.
      const tPiers = byTracker[t.tracker_code];
      if (tPiers && tPiers.length >= 2) {
        const sorted = [...tPiers].sort((p, q) =>
          String(p.pier_code || "").localeCompare(String(q.pier_code || ""), undefined, { numeric: true }),
        );
        a = rotatedToLngLat(sorted[0].x, sorted[0].y, imageWidth);
        b = rotatedToLngLat(sorted[sorted.length - 1].x, sorted[sorted.length - 1].y, imageWidth);
        pierUsed++;
      } else {
        // Fallback: span the bbox along whichever side is longer.
        const box = t.bbox as { x: number; y: number; w: number; h: number } | undefined;
        if (
          box &&
          typeof box.x === "number" && typeof box.y === "number" &&
          typeof box.w === "number" && typeof box.h === "number" &&
          (box.w > 0 || box.h > 0)
        ) {
          if (box.w >= box.h) {
            const midY = box.y + box.h / 2;
            a = rotatedToLngLat(box.x,         midY, imageWidth);
            b = rotatedToLngLat(box.x + box.w, midY, imageWidth);
          } else {
            const midX = box.x + box.w / 2;
            a = rotatedToLngLat(midX, box.y,          imageWidth);
            b = rotatedToLngLat(midX, box.y + box.h,  imageWidth);
          }
          bboxUsed++;
        } else {
          skipped++;
        }
      }
      if (!a || !b) continue;
      features.push({
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: [a, b] },
        properties: {
          tracker_code: t.tracker_code,
          row: String(t.row || ""),
        },
      });
    }
    // One-off diagnostic so it's obvious from the devtools console if
    // the tracker dataset never produced drawable features (the root
    // cause of the "Trackers checkbox does nothing" complaint).  Also
    // logs a sample so bad coordinates are easy to spot.
    try {
      const sample = features[0];
      console.debug(
        `[SiteMap] trackersGeoJSON: ${features.length} lines ` +
        `(pier=${pierUsed}, bbox=${bboxUsed}, skipped=${skipped}) ` +
        `from ${trackers.length} trackers, ${piers.length} piers, imageWidth=${imageWidth}`,
        sample ? sample.geometry.coordinates : "(no features)",
      );
    } catch { /* noop */ }
    return { type: "FeatureCollection" as const, features };
  }, [trackers, piers, imageWidth]);

  const structuralRowGuideGeoJSON = useMemo(() => {
    const features: any[] = [];
    if (!imageWidth || imageWidth <= 0) {
      return { type: "FeatureCollection" as const, features };
    }
    const byRow: Record<string, any[]> = {};
    for (const p of piers || []) {
      const row = String(p?.row_num || "");
      if (!row || typeof p?.x !== "number" || typeof p?.y !== "number") continue;
      (byRow[row] ??= []).push(p);
    }
    for (const [row, pts] of Object.entries(byRow)) {
      if (pts.length < 2) continue;
      const xs = pts.map((p) => Number(p.x));
      const ys = pts.map((p) => Number(p.y));
      const xRange = Math.max(...xs) - Math.min(...xs);
      const yRange = Math.max(...ys) - Math.min(...ys);
      const sorted = [...pts].sort((a, b) =>
        xRange >= yRange ? Number(a.x) - Number(b.x) : Number(a.y) - Number(b.y),
      );
      features.push({
        type: "Feature" as const,
        geometry: {
          type: "LineString" as const,
          coordinates: [
            rotatedToLngLat(sorted[0].x, sorted[0].y, imageWidth),
            rotatedToLngLat(sorted[sorted.length - 1].x, sorted[sorted.length - 1].y, imageWidth),
          ],
        },
        properties: { row },
      });
    }
    return { type: "FeatureCollection" as const, features };
  }, [piers, imageWidth]);

  // Row labels: compute the topmost pier position per row number so we can
  // place a label above each row on the map.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rowLabelData = useMemo(() => {
    const rowEdges: Record<string, { lng: number; lat: number }> = {};
    for (const p of piers) {
      const row = String(p.row_num || "");
      if (!row) continue;
      const [rx, ry] = rotate90CCW(p.x, p.y, imageWidth);
      const lng = pt2lng(rx);
      const lat = pt2lat(ry);
      const existing = rowEdges[row];
      // "Topmost" = largest lat (least negative) in the rotated space.
      if (!existing || lat > existing.lat) {
        rowEdges[row] = { lng, lat };
      }
    }
    return rowEdges;
  }, [piers, imageWidth]);

  const electricalRowLabelData = useMemo(() => {
    const out: Record<string, { lng: number; lat: number; zone: string; rowNum?: any; side?: string; strings?: any; stringNumbers?: number[]; stringLabels?: string[]; optimizerPattern?: string; splitStrings?: string[]; optimizers?: any; modules?: any }> = {};
    if (!imageWidth || imageWidth <= 0) return out;
    for (const row of electricalRows || []) {
      if (typeof row?.x !== "number" || typeof row?.y !== "number") continue;
      const basePayload = {
        rowNum: row.row_num,
        zone: String(row.zone ?? ""),
        strings: row.string_count,
        stringNumbers: Array.isArray(row.string_numbers) ? row.string_numbers : [],
        stringLabels: Array.isArray(row.string_labels) ? row.string_labels : [],
        optimizerPattern: row.optimizer_pattern || "",
        splitStrings: Array.isArray(row.split_strings) ? row.split_strings : [],
        optimizers: row.optimizer_count,
        modules: row.module_count,
      };
      const [lng, lat] = rotatedToLngLat(row.x, row.y, imageWidth);
      out[`${String(row.id || `${row.zone}-${row.row_num}`)}-north`] = {
        lng,
        lat,
        side: "north",
        ...basePayload,
      };
      if (typeof row?.south_x === "number" && typeof row?.south_y === "number") {
        const [southLng, southLat] = rotatedToLngLat(row.south_x, row.south_y, imageWidth);
        out[`${String(row.id || `${row.zone}-${row.row_num}`)}-south`] = {
          lng: southLng,
          lat: southLat,
          side: "south",
          ...basePayload,
        };
      }
    }
    return out;
  }, [electricalRows, imageWidth]);

  const panelBaseRowsGeoJSON = useMemo(() => {
    const features: any[] = [];
    if (!imageWidth || imageWidth <= 0) return { type: "FeatureCollection" as const, features };
    for (const row of panelBaseRows || []) {
      if (!["x0", "y0", "x1", "y1"].every((key) => Number.isFinite(Number(row?.[key])))) continue;
      features.push({
        type: "Feature" as const,
        id: row.id || `panel-row-${features.length + 1}`,
        geometry: {
          type: "LineString" as const,
          coordinates: [
            rotatedToLngLat(Number(row.x0), Number(row.y0), imageWidth),
            rotatedToLngLat(Number(row.x1), Number(row.y1), imageWidth),
          ],
        },
        properties: { id: row.id || "", source_file: row.source_file || "" },
      });
    }
    return { type: "FeatureCollection" as const, features };
  }, [panelBaseRows, imageWidth]);

  const electricalStringLabelLinesGeoJSON = useMemo(() => {
    const features: any[] = [];
    if (!imageWidth || imageWidth <= 0) return { type: "FeatureCollection" as const, features };
    const panelRowsSorted = [...(panelBaseRows || [])]
      .filter((row: any) => ["x0", "y0", "x1", "y1"].every((key) => Number.isFinite(Number(row?.[key]))))
      .sort((a: any, b: any) => Number(a.north_y ?? a.y0) - Number(b.north_y ?? b.y0));
    const projectToRow = (panelRow: any, x: number, y: number) => {
      if (!panelRow) return { x, y };
      const x0 = Number(panelRow.x0);
      const y0 = Number(panelRow.y0);
      const x1 = Number(panelRow.x1);
      const y1 = Number(panelRow.y1);
      const dx = x1 - x0;
      const dy = y1 - y0;
      const denom = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / denom));
      return { x: x0 + dx * t, y: y0 + dy * t };
    };
    for (const row of electricalRows || []) {
      const rowNo = Number(row?.row_num);
      const panelRow = Number.isFinite(rowNo) ? panelRowsSorted[Math.min(Math.max(rowNo - 1, 0), panelRowsSorted.length - 1)] : null;
      const dx = panelRow ? Number(panelRow.x1) - Number(panelRow.x0) : 1;
      const dy = panelRow ? Number(panelRow.y1) - Number(panelRow.y0) : 0;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      for (const stringPoint of row?.string_points || []) {
        const id = String(stringPoint?.id || "").trim();
        const xValues = [Number(stringPoint?.x), Number(stringPoint?.x1)].filter(Number.isFinite);
        const yValues = [Number(stringPoint?.y), Number(stringPoint?.y1)].filter(Number.isFinite);
        if (!id || !xValues.length || !yValues.length) continue;
        const cx = xValues.reduce((sum, v) => sum + v, 0) / xValues.length;
        const cy = yValues.reduce((sum, v) => sum + v, 0) / yValues.length;
        const projected = projectToRow(panelRow, cx, cy);
        const halfLen = Math.max(22, Math.min(58, id.length * 3.8));
        features.push({
          type: "Feature" as const,
          id,
          geometry: {
            type: "LineString" as const,
            coordinates: [
              rotatedToLngLat(projected.x - ux * halfLen, projected.y - uy * halfLen, imageWidth),
              rotatedToLngLat(projected.x + ux * halfLen, projected.y + uy * halfLen, imageWidth),
            ],
          },
          properties: { id, row: String(rowNo || "") },
        });
      }
    }
    return { type: "FeatureCollection" as const, features };
  }, [electricalRows, panelBaseRows, imageWidth]);

  const electricalStringSegmentsGeoJSON = useMemo(() => {
    const features: any[] = [];
    if (!imageWidth || imageWidth <= 0) return { type: "FeatureCollection" as const, features };
    const detailPanelCount = Number(stringDetail?.panel_count);
    const panelsPerString = Math.max(2, Number.isFinite(detailPanelCount) && detailPanelCount > 0
      ? detailPanelCount
      : Number(stringDetail?.panel_pair_count || 22) * 2);
    const panelRowsSorted = [...(panelBaseRows || [])]
      .filter((row: any) => ["x0", "y0", "x1", "y1"].every((key) => Number.isFinite(Number(row?.[key]))))
      .sort((a: any, b: any) => Number(a.north_y ?? a.y0) - Number(b.north_y ?? b.y0));
    const pointAt = (panelRow: any, t: number) => {
      const x0 = Number.isFinite(Number(panelRow?.south_x)) ? Number(panelRow.south_x) : Number(panelRow?.x0);
      const y0 = Number.isFinite(Number(panelRow?.south_y)) ? Number(panelRow.south_y) : Number(panelRow?.y0);
      const x1 = Number.isFinite(Number(panelRow?.north_x)) ? Number(panelRow.north_x) : Number(panelRow?.x1);
      const y1 = Number.isFinite(Number(panelRow?.north_y)) ? Number(panelRow.north_y) : Number(panelRow?.y1);
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    };
    const projectT = (panelRow: any, x: number, y: number) => {
      const x0 = Number.isFinite(Number(panelRow?.south_x)) ? Number(panelRow.south_x) : Number(panelRow?.x0);
      const y0 = Number.isFinite(Number(panelRow?.south_y)) ? Number(panelRow.south_y) : Number(panelRow?.y0);
      const x1 = Number.isFinite(Number(panelRow?.north_x)) ? Number(panelRow.north_x) : Number(panelRow?.x1);
      const y1 = Number.isFinite(Number(panelRow?.north_y)) ? Number(panelRow.north_y) : Number(panelRow?.y1);
      const dx = x1 - x0;
      const dy = y1 - y0;
      const denom = dx * dx + dy * dy || 1;
      return Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / denom));
    };
    const rowPanels = (panelRow: any) => Array.isArray(panelRow?.panels)
      ? panelRow.panels
          .map((panel: any) => ({
            panel: Number(panel?.panel),
            t: Number(panel?.t),
            cx: Number(panel?.cx),
            cy: Number(panel?.cy),
          }))
          .filter((panel: any) => Number.isFinite(panel.panel) && Number.isFinite(panel.t) && Number.isFinite(panel.cx) && Number.isFinite(panel.cy))
          .sort((a: any, b: any) => a.panel - b.panel)
      : [];
    const pointForPanel = (panelRow: any, panel: any) => {
      if (panel && Number.isFinite(panel.cx) && Number.isFinite(panel.cy)) return [panel.cx, panel.cy];
      return pointAt(panelRow, Number(panel?.t) || 0);
    };
    const pointForStringStart = (panelRow: any, panels: any[], panelNo: number) => {
      if (panelNo <= 1) return pointAt(panelRow, 0);
      return pointForPanel(panelRow, panels[panelNo - 1] || { t: 0 });
    };
    const shiftedPointAt = (panelRow: any, t: number, delta: number) => pointAt(panelRow, Math.max(0, Math.min(1, t + delta)));
    const labelAngleFromMapLine = (start: number[], end: number[]) => {
      const [lng0, lat0] = rotatedToLngLat(start[0], start[1], imageWidth);
      const [lng1, lat1] = rotatedToLngLat(end[0], end[1], imageWidth);
      let angle = Math.atan2(-(lat1 - lat0), lng1 - lng0) * 180 / Math.PI;
      while (angle > 90) angle -= 180;
      while (angle < -90) angle += 180;
      return angle;
    };
    for (const row of electricalRows || []) {
      const rowNo = Number(row?.row_num);
      const panelRow = Number.isFinite(rowNo) ? panelRowsSorted[Math.min(Math.max(rowNo - 1, 0), panelRowsSorted.length - 1)] : null;
      if (!panelRow) continue;
      const panels = rowPanels(panelRow);
      const panelCount = panels.length || Number(panelRow?.panel_count) || panelsPerString;
      const stringPoints = [...(row?.string_points || [])]
        .map((stringPoint: any) => {
          const xValues = [Number(stringPoint?.x), Number(stringPoint?.x1)].filter(Number.isFinite);
          const yValues = [Number(stringPoint?.y), Number(stringPoint?.y1)].filter(Number.isFinite);
          const cx = xValues.length ? xValues.reduce((sum, v) => sum + v, 0) / xValues.length : NaN;
          const cy = yValues.length ? yValues.reduce((sum, v) => sum + v, 0) / yValues.length : NaN;
          return {
            stringPoint,
            xValues,
            yValues,
            cx,
            cy,
            labelT: Number.isFinite(cx) && Number.isFinite(cy) ? projectT(panelRow, cx, cy) : 0,
          };
        })
        .sort((a: any, b: any) => a.labelT - b.labelT);
      for (const [stringIndex, positioned] of stringPoints.entries()) {
        const stringPoint = positioned.stringPoint;
        const id = String(stringPoint?.id || "").trim();
        const xValues = positioned.xValues;
        const yValues = positioned.yValues;
        if (!id || !xValues.length || !yValues.length) continue;
        const labelT = positioned.labelT;
        const segmentPanelCount = Math.min(panelsPerString, Math.max(2, panelCount));
        const startPanelNo = Math.min(panelCount, stringIndex * segmentPanelCount + 1);
        const endPanelNo = Math.min(panelCount, startPanelNo + segmentPanelCount - 1);
        const startPanel = panels[startPanelNo - 1];
        const endPanel = panels[endPanelNo - 1];
        const startT = startPanelNo <= 1 ? 0 : Number(startPanel?.t ?? 0);
        const endT = Number(endPanel?.t ?? 1);
        const boundaryGapT = Math.min(0.012, Math.max(0.004, 7 / Math.max(1, Number(panelRow?.length) || 1)));
        const visualStartT = startPanelNo <= 1 ? startT : startT + boundaryGapT;
        const visualEndT = endPanelNo >= panelCount ? endT : endT - boundaryGapT;
        const start = startPanelNo <= 1 ? pointForStringStart(panelRow, panels, startPanelNo) : shiftedPointAt(panelRow, startT, boundaryGapT);
        const end = shiftedPointAt(panelRow, endT, endPanelNo >= panelCount ? 0 : -boundaryGapT);
        const dx = end[0] - start[0];
        const dy = end[1] - start[1];
        const len = Math.hypot(dx, dy) || 1;
        const gapT = Math.min(0.04, Math.max(0.008, 16 / len));
        const clampedLabelT = (visualStartT + visualEndT) / 2;
        const gapLow = pointAt(panelRow, Math.max(Math.min(visualStartT, visualEndT), clampedLabelT - gapT));
        const gapHigh = pointAt(panelRow, Math.min(Math.max(visualStartT, visualEndT), clampedLabelT + gapT));
        const statusT = Math.max(Math.min(visualStartT, visualEndT), clampedLabelT - gapT * 1.9);
        const statusPoint = pointAt(panelRow, statusT);
        const startPanelLabel = `${startPanelNo}/${Math.min(endPanelNo, startPanelNo + 1)}`;
        const endPanelLabel = `${Math.max(startPanelNo, endPanelNo - 1)}/${endPanelNo}`;
        const labelPoint = pointAt(panelRow, clampedLabelT);
        const mapAngle = labelAngleFromMapLine(start, end);
        const status = normalizeStringStatus(stringStatuses[id]);
        const statusLabel = STRING_STATUS_LABELS[status];
        const statusIcon = STRING_STATUS_ICONS[status];
        const statusColor = STRING_STATUS_COLORS[status];
        features.push({
          type: "Feature" as const,
          id: `${id}-line-a`,
          geometry: { type: "LineString" as const, coordinates: [rotatedToLngLat(start[0], start[1], imageWidth), rotatedToLngLat(gapLow[0], gapLow[1], imageWidth)] },
          properties: { id, row: String(rowNo || ""), kind: "line", status, status_color: statusColor },
        });
        features.push({
          type: "Feature" as const,
          id: `${id}-line-b`,
          geometry: { type: "LineString" as const, coordinates: [rotatedToLngLat(gapHigh[0], gapHigh[1], imageWidth), rotatedToLngLat(end[0], end[1], imageWidth)] },
          properties: { id, row: String(rowNo || ""), kind: "line", status, status_color: statusColor },
        });
        features.push({
          type: "Feature" as const,
          id: `${id}-label`,
          geometry: { type: "Point" as const, coordinates: rotatedToLngLat(labelPoint[0], labelPoint[1], imageWidth) },
          properties: { id, row: String(rowNo || ""), kind: "label", angle: mapAngle, status, status_label: statusLabel, status_icon: statusIcon, status_color: statusColor, start_panel_label: startPanelLabel, end_panel_label: endPanelLabel },
        });
        features.push({
          type: "Feature" as const,
          id: `${id}-status`,
          geometry: { type: "Point" as const, coordinates: rotatedToLngLat(statusPoint[0], statusPoint[1], imageWidth) },
          properties: { id, row: String(rowNo || ""), kind: "status-icon", angle: mapAngle, status, status_label: statusLabel, status_icon: statusIcon, status_color: statusColor, start_panel_label: startPanelLabel, end_panel_label: endPanelLabel },
        });
        features.push({
          type: "Feature" as const,
          id: `${id}-start`,
          geometry: { type: "Point" as const, coordinates: rotatedToLngLat(start[0], start[1], imageWidth) },
          properties: { id, row: String(rowNo || ""), kind: "start", panel_label: startPanelLabel },
        });
        features.push({
          type: "Feature" as const,
          id: `${id}-end`,
          geometry: { type: "Point" as const, coordinates: rotatedToLngLat(end[0], end[1], imageWidth) },
          properties: { id, row: String(rowNo || ""), kind: "end", panel_label: endPanelLabel },
        });
      }
    }
    return { type: "FeatureCollection" as const, features };
  }, [electricalRows, panelBaseRows, imageWidth, stringDetail, stringStatuses]);

  const electricalRowGuideGeoJSON = useMemo(() => {
    const features: any[] = [];
    if (!imageWidth || imageWidth <= 0) {
      return { type: "FeatureCollection" as const, features };
    }
    const xs = [
      ...(electricalZones || [])
        .map((zone: any) => zone?.source?.x)
        .filter((x: any) => typeof x === "number"),
      ...(electricalRows || [])
        .map((row: any) => row?.x)
        .filter((x: any) => typeof x === "number"),
    ];
    if (!xs.length) return { type: "FeatureCollection" as const, features };
    const maxModulesInRow = Math.max(
      1,
      ...(electricalRows || []).map((row: any) => Number(row?.module_count || 0)).filter(Number.isFinite),
    );
    const modulePitch = (imageWidth * 0.56) / maxModulesInRow;
    for (const row of electricalRows || []) {
      if (typeof row?.x !== "number" || typeof row?.y !== "number") continue;
      const rowNo = row.row_num ?? "";
      const stringCount = Number(row.string_count || 0);
      const moduleCount = Number(row.module_count || 0);
      const rowLength = Math.max(260, modulePitch * Math.max(1, moduleCount || stringCount * 44 || 88));
      const halfLength = rowLength / 2;
      const centerX = Number(row.x);
      const x0 = Math.max(20, centerX - halfLength);
      const x1 = Math.min(imageWidth - 20, centerX + halfLength);
      features.push({
        type: "Feature" as const,
        geometry: {
          type: "LineString" as const,
          coordinates: [
            rotatedToLngLat(x0, Number(row.y), imageWidth),
            rotatedToLngLat(x1, Number(row.y), imageWidth),
          ],
        },
        properties: {
          row: String(rowNo),
          zone: String(row.zone ?? ""),
          strings: stringCount || null,
        },
      });
    }
    return { type: "FeatureCollection" as const, features };
  }, [electricalRows, electricalZones, imageWidth]);

  const electricalZoneBandGeoJSON = useMemo(() => {
    const features: any[] = [];
    if (!imageWidth || imageWidth <= 0) {
      return { type: "FeatureCollection" as const, features };
    }
    const rowsByZone: Record<string, any[]> = {};
    for (const row of electricalRows || []) {
      const zone = String(row?.zone ?? "");
      if (!zone || typeof row?.x !== "number" || typeof row?.y !== "number") continue;
      (rowsByZone[zone] ??= []).push(row);
    }
    const maxModulesInRow = Math.max(
      1,
      ...(electricalRows || []).map((row: any) => Number(row?.module_count || 0)).filter(Number.isFinite),
    );
    const modulePitch = (imageWidth * 0.56) / maxModulesInRow;
    for (const zone of electricalZones || []) {
      const src = zone?.source || {};
      const zoneKey = String(zone?.zone ?? "");
      const rows = rowsByZone[zoneKey] || [];
      if (!zoneKey || typeof src.x !== "number" || !rows.length) continue;
      const ys = rows.map((row) => Number(row.y)).filter(Number.isFinite);
      if (!ys.length) continue;
      const maxZoneModules = Math.max(
        1,
        ...rows.map((row) => Number(row.module_count || 0)).filter(Number.isFinite),
      );
      const rowLength = Math.max(260, modulePitch * maxZoneModules);
      const halfLength = rowLength / 2;
      const centerX = Number(src.x);
      const x0 = Math.max(20, centerX - halfLength);
      const x1 = Math.min(imageWidth - 20, centerX + halfLength);
      const y0 = Math.min(...ys) - 12;
      const y1 = Math.max(...ys) + 12;
      const ring = [
        rotatedToLngLat(x0, y0, imageWidth),
        rotatedToLngLat(x1, y0, imageWidth),
        rotatedToLngLat(x1, y1, imageWidth),
        rotatedToLngLat(x0, y1, imageWidth),
        rotatedToLngLat(x0, y0, imageWidth),
      ];
      features.push({
        type: "Feature" as const,
        id: `zone-band-${zoneKey}`,
        geometry: { type: "Polygon" as const, coordinates: [ring] },
        properties: {
          zone: zoneKey,
          string_count: Number(zone.string_count || 0) || null,
        },
      });
    }
    return { type: "FeatureCollection" as const, features };
  }, [electricalRows, electricalZones, imageWidth]);

  // Tracker labels: compute one position per tracker_code, anchored at
  // the centre of the tracker bbox so the label sits over its row.
  // Only rendered when the user is zoomed in enough (see
  // refreshTrackerLabels below) — otherwise 1 533 labels would clobber
  // the map.
  const trackerLabelData = useMemo(() => {
    const out: Record<string, { lng: number; lat: number }> = {};
    if (!imageWidth || imageWidth <= 0) return out;
    for (const t of trackers) {
      if (!t?.tracker_code) continue;
      const box = t.bbox as { x: number; y: number; w: number; h: number } | undefined;
      let cx: number, cy: number;
      if (box && typeof box.x === "number" && typeof box.w === "number") {
        cx = box.x + box.w / 2;
        cy = box.y + box.h / 2;
      } else if (typeof t.center_x === "number" && typeof t.center_y === "number") {
        cx = t.center_x; cy = t.center_y;
      } else {
        continue;
      }
      const [lng, lat] = rotatedToLngLat(cx, cy, imageWidth);
      out[t.tracker_code] = { lng, lat };
    }
    return out;
  }, [trackers, imageWidth]);

  // DCCB + Inverter sources — both come from the electrical parser as
  // `{type, name, x, y}` in PDF-point coordinates, so the same 90° CCW
  // rotation the piers use puts them on the right spot on the map.
  const dccbGeoJSON = useMemo(() => {
    if (!imageWidth || imageWidth <= 0) {
      return { type: "FeatureCollection" as const, features: [] };
    }
    const features = (dccbs || [])
      .filter((d: any) => typeof d?.x === "number" && typeof d?.y === "number")
      .map((d: any) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: rotatedToLngLat(d.x, d.y, imageWidth),
        },
        properties: { name: d.name || "", type: "dccb" },
      }));
    return { type: "FeatureCollection" as const, features };
  }, [dccbs, imageWidth]);

  const inverterGeoJSON = useMemo(() => {
    if (!imageWidth || imageWidth <= 0) {
      return { type: "FeatureCollection" as const, features: [] };
    }
    const features = (inverters || [])
      .filter((d: any) => typeof d?.x === "number" && typeof d?.y === "number")
      .map((d: any) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: rotatedToLngLat(d.x, d.y, imageWidth),
        },
        properties: { name: d.name || "", type: "inverter" },
      }));
    return { type: "FeatureCollection" as const, features };
  }, [inverters, imageWidth]);

  const electricalZonesGeoJSON = useMemo(() => {
    if (!imageWidth || imageWidth <= 0) {
      return { type: "FeatureCollection" as const, features: [] };
    }
    const features = (electricalZones || [])
      .filter((z: any) => {
        const src = z?.source || {};
        return typeof src.x === "number" && typeof src.y === "number";
      })
      .map((z: any) => {
        const src = z.source || {};
        const rows = Array.isArray(z.physical_rows) ? z.physical_rows : [];
        const firstRow = rows[0];
        const lastRow = rows[rows.length - 1];
        return {
          type: "Feature" as const,
          id: `zone-${z.zone}`,
          geometry: {
            type: "Point" as const,
            coordinates: rotatedToLngLat(src.x, src.y, imageWidth),
          },
          properties: {
            zone: z.zone,
            string_count: Number(z.string_count || 0),
            physical_rows: rows.length ? `${firstRow}-${lastRow}` : "",
            source_file: src.source_file || "",
            page: src.page ?? "",
          },
        };
      });
    return { type: "FeatureCollection" as const, features };
  }, [electricalZones, imageWidth]);

  const securityDevicesGeoJSON = useMemo(() => {
    if (!imageWidth || imageWidth <= 0) {
      return { type: "FeatureCollection" as const, features: [] };
    }
    const features = (securityDevices || [])
      .filter((asset: any) => typeof asset?.x === "number" && typeof asset?.y === "number")
      .map((asset: any) => ({
        type: "Feature" as const,
        id: asset.id,
        geometry: {
          type: "Point" as const,
          coordinates: rotatedToLngLat(asset.x, asset.y, imageWidth),
        },
        properties: {
          id: asset.id || "",
          type: asset.type || "security_camera",
          raw_label: asset.raw_label || asset.id || "",
          confidence: asset.confidence || "",
          color: asset.type === "ptz_camera"
            ? "#7c3aed"
            : asset.type === "fixed_camera"
              ? "#0891b2"
              : asset.type === "radar_camera"
                ? "#ea580c"
                : "#475569",
        },
      }));
    return { type: "FeatureCollection" as const, features };
  }, [securityDevices, imageWidth]);

  const weatherStationsGeoJSON = useMemo(() => {
    if (!imageWidth || imageWidth <= 0) {
      return { type: "FeatureCollection" as const, features: [] };
    }
    const features = (weatherAssets || [])
      .filter((asset: any) => asset?.type === "weather_station" && typeof asset?.x === "number" && typeof asset?.y === "number")
      .map((asset: any) => ({
        type: "Feature" as const,
        id: asset.id,
        geometry: {
          type: "Point" as const,
          coordinates: rotatedToLngLat(asset.x, asset.y, imageWidth),
        },
        properties: {
          id: asset.id || "",
          type: asset.type || "weather_station",
          raw_label: asset.raw_label || asset.id || "",
          confidence: asset.confidence || "",
          sensors: Array.isArray(asset.sensors) ? asset.sensors.join(", ") : "",
        },
      }));
    return { type: "FeatureCollection" as const, features };
  }, [weatherAssets, imageWidth]);

  const weatherSensorsGeoJSON = useMemo(() => {
    if (!imageWidth || imageWidth <= 0) {
      return { type: "FeatureCollection" as const, features: [] };
    }
    const features = (weatherAssets || [])
      .filter((asset: any) => asset?.type !== "weather_station" && typeof asset?.x === "number" && typeof asset?.y === "number")
      .map((asset: any) => ({
        type: "Feature" as const,
        id: asset.id,
        geometry: {
          type: "Point" as const,
          coordinates: rotatedToLngLat(asset.x, asset.y, imageWidth),
        },
        properties: {
          id: asset.id || "",
          type: asset.type || "",
          raw_label: asset.raw_label || asset.id || "",
          confidence: asset.confidence || "",
          color: asset.type === "pyranometer"
            ? "#eab308"
            : asset.type === "wind_sensor"
              ? "#22c55e"
              : asset.type === "ambient_temperature_sensor"
                ? "#06b6d4"
                : "#f97316",
        },
      }));
    return { type: "FeatureCollection" as const, features };
  }, [weatherAssets, imageWidth]);

  const bounds = useMemo(() => {
    const points: Array<{ x: number; y: number }> = [];
    if (mapImageUrl && imageWidth > 0 && imageHeight > 0) {
      points.push(
        { x: 0, y: 0 },
        { x: imageWidth, y: 0 },
        { x: imageWidth, y: imageHeight },
        { x: 0, y: imageHeight },
      );
    }
    for (const p of piers) {
      if (typeof p?.x === "number" && typeof p?.y === "number") points.push({ x: p.x, y: p.y });
    }
    for (const z of electricalZones || []) {
      const src = z?.source || {};
      if (typeof src.x === "number" && typeof src.y === "number") points.push({ x: src.x, y: src.y });
    }
    for (const row of electricalRows || []) {
      if (typeof row?.x === "number" && typeof row?.y === "number") points.push({ x: row.x, y: row.y });
      if (typeof row?.south_x === "number" && typeof row?.south_y === "number") points.push({ x: row.south_x, y: row.south_y });
    }
    for (const row of panelBaseRows || []) {
      if (typeof row?.x0 === "number" && typeof row?.y0 === "number") points.push({ x: row.x0, y: row.y0 });
      if (typeof row?.x1 === "number" && typeof row?.y1 === "number") points.push({ x: row.x1, y: row.y1 });
    }
    for (const d of [...(dccbs || []), ...(inverters || [])]) {
      if (typeof d?.x === "number" && typeof d?.y === "number") points.push({ x: d.x, y: d.y });
    }
    for (const asset of [...(securityDevices || []), ...(weatherAssets || [])]) {
      if (typeof asset?.x === "number" && typeof asset?.y === "number") points.push({ x: asset.x, y: asset.y });
    }
    if (!points.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      const [rx, ry] = rotate90CCW(p.x, p.y, imageWidth);
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry;
      if (ry > maxY) maxY = ry;
    }
    return new maplibregl.LngLatBounds(
      [pt2lng(minX), pt2lat(maxY)],
      [pt2lng(maxX), pt2lat(minY)],
    );
  }, [piers, electricalZones, electricalRows, panelBaseRows, dccbs, inverters, securityDevices, weatherAssets, imageWidth, imageHeight, mapImageUrl]);

  // ---- Map lifecycle ------------------------------------------------------

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: "bg",
            type: "background",
            paint: { "background-color": "#f8fafc" },
          },
        ],
      },
      center: [0, 0],
      zoom: 2,
      minZoom: -2,
      maxZoom: 22,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    mapRef.current = map;
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right",
    );

    map.on("load", () => {
      // --- Sources -------------------------------------------------------
      map.addSource("map-background", {
        type: "image",
        url: mapImageUrl || EMPTY_IMAGE_URL,
        coordinates: mapImageCoordinates as any,
      });
      map.addSource("blocks", { type: "geojson", data: blocksGeoJSON });
      map.addSource("structural-row-guides", { type: "geojson", data: structuralRowGuideGeoJSON });
      map.addSource("trackers", { type: "geojson", data: trackersGeoJSON });
      map.addSource("piers", { type: "geojson", data: piersGeoJSON });
      map.addSource("pier-statuses", { type: "geojson", data: pierStatusGeoJSON });
      map.addSource("electrical-zones", { type: "geojson", data: electricalZonesGeoJSON });
      map.addSource("electrical-row-guides", { type: "geojson", data: electricalRowGuideGeoJSON });
      map.addSource("panel-base-rows", { type: "geojson", data: panelBaseRowsGeoJSON });
      map.addSource("electrical-string-label-lines", { type: "geojson", data: electricalStringLabelLinesGeoJSON });
      map.addSource("electrical-string-segments", { type: "geojson", data: electricalStringSegmentsGeoJSON });
      map.addSource("electrical-zone-bands", { type: "geojson", data: electricalZoneBandGeoJSON });
      map.addSource("dccb", { type: "geojson", data: dccbGeoJSON });
      map.addSource("inverters", { type: "geojson", data: inverterGeoJSON });
      map.addSource("security-devices", { type: "geojson", data: securityDevicesGeoJSON });
      map.addSource("weather-stations", { type: "geojson", data: weatherStationsGeoJSON });
      map.addSource("weather-sensors", { type: "geojson", data: weatherSensorsGeoJSON });

      map.addLayer({
        id: "map-background-layer",
        type: "raster",
        source: "map-background",
        paint: {
          "raster-opacity": mapImageUrl ? 0.92 : 0,
          "raster-fade-duration": 0,
        },
      });

      // --- Block fill + outline -----------------------------------------
      //
      // Default-hidden (visibility: "none") so the Blocks checkbox drives
      // everything. Previously these added with implicit `visible` and
      // the first-run visibility effect could silently bail on the
      // `isStyleLoaded()` race, leaving the blocks briefly shown even
      // when the checkbox was off.
      map.addLayer({
        id: "blocks-fill",
        type: "fill",
        source: "blocks",
        layout: { visibility: "none" },
        paint: {
          "fill-color": "#3b82f6",
          "fill-opacity": 0.04,
        },
      });
      map.addLayer({
        id: "blocks-outline",
        type: "line",
        source: "blocks",
        layout: { visibility: "none" },
        paint: {
          "line-color": "#3b82f6",
          "line-width": 1.2,
        },
      });
      map.addLayer({
        id: "blocks-selected",
        type: "line",
        source: "blocks",
        layout: { visibility: "none" },
        filter: ["==", ["get", "block_code"], ""],
        paint: {
          "line-color": "#f97316",
          "line-width": 2.5,
        },
      });

      // --- Always-on row guides -----------------------------------------
      //
      // Rows are the operator's main spatial reference. Keep their guide
      // lines visible even when labels / piers / trackers are toggled.
      map.addLayer({
        id: "structural-row-guides-layer",
        type: "line",
        source: "structural-row-guides",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#94a3b8",
          "line-opacity": 0.42,
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            0, 0.6,
            8, 0.9,
            14, 1.4,
            18, 2,
          ],
        },
      });
      map.addLayer({
        id: "electrical-zone-bands-fill",
        type: "fill",
        source: "electrical-zone-bands",
        paint: {
          "fill-color": [
            "case",
            ["==", ["get", "string_count"], 11],
            "#0ea5e9",
            "#f59e0b",
          ],
          "fill-opacity": 0.055,
        },
      });
      map.addLayer({
        id: "electrical-zone-bands-outline",
        type: "line",
        source: "electrical-zone-bands",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": [
            "case",
            ["==", ["get", "string_count"], 11],
            "#0284c7",
            "#d97706",
          ],
          "line-opacity": 0.28,
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            0, 0.7,
            8, 1,
            14, 1.6,
            18, 2.2,
          ],
        },
      });
      map.addLayer({
        id: "panel-base-rows-layer",
        type: "line",
        source: "panel-base-rows",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#cbd5e1",
          "line-opacity": 0.64,
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            0, 0.7,
            8, 1,
            14, 1.5,
            18, 2,
          ],
        },
      });
      map.addLayer({
        id: "electrical-row-guides-layer",
        type: "line",
        source: "electrical-row-guides",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#cbd5e1",
          "line-opacity": 0.88,
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            0, 1,
            8, 1.4,
            14, 2.2,
            18, 3,
          ],
        },
      });

      // --- Tracker lines -------------------------------------------------
      //
      // Drawn as a two-layer stack so the line reads on *any* base-map
      // colour and even when it crosses the 24 k pier dots:
      //   • `trackers-casing`  — wide white halo underneath
      //   • `trackers-line`    — emerald core on top
      // Both widths scale with zoom so the lines are legible from fully
      // zoomed-out (site overview) to fully zoomed-in (single row).
      map.addLayer({
        id: "trackers-casing",
        type: "line",
        source: "trackers",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-opacity": 0.8,
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            0, 1.5,
            6, 2,
            10, 2.5,
            14, 3.5,
            18, 5,
          ],
        },
      });
      map.addLayer({
        id: "trackers-line",
        type: "line",
        source: "trackers",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#16a34a",
          "line-opacity": 1,
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            0, 0.6,
            6, 1,
            10, 1.4,
            14, 2,
            18, 3,
          ],
        },
      });
      map.addLayer({
        id: "trackers-selected",
        type: "line",
        source: "trackers",
        filter: ["==", ["get", "tracker_code"], ""],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#f97316",
          "line-width": 4,
        },
      });

      // --- Pier circles + selection ------------------------------------
      //
      // Pier dot colour follows the user preference `pierStatusDisplay`:
      //   • "icon"  → dot is always the pier_type colour, status comes
      //               from the icon symbol layer (default)
      //   • "color" → dot fill = status colour for non-New piers, no
      //               icon overlay
      //   • "both"  → status-coloured dot AND status icon
      // Both expressions are added at construction time; the visibility
      // effect below toggles the icon symbol layer based on the pref.
      const wantStatusColor = pierStatusDisplay !== "icon";
      map.addLayer({
        id: "piers-layer",
        type: "circle",
        source: "piers",
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            0, 1.5,
            6, 2.5,
            10, 4,
            14, 6,
            18, 10,
          ],
          // Pier circle uses feature-state for the status colour so a
          // single status edit doesn't rebuild this 24 k-feature
          // source.  The state is pushed in the effect below via
          // setFeatureState.  feature-state is allowed in PAINT
          // expressions (which this is); layout properties cannot
          // read feature-state.
          "circle-color": wantStatusColor
            ? ["case",
                ["!=", ["coalesce", ["feature-state", "status"], "New"], "New"],
                ["coalesce", ["feature-state", "status_color"], ["get", "color"]],
                ["get", "color"],
              ]
            : ["get", "color"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": wantStatusColor
            ? ["case",
                ["!=", ["coalesce", ["feature-state", "status"], "New"], "New"],
                1.5,
                0,
              ]
            : 0,
        },
      });

      // --- Status icons (symbol layer) ----------------------------------
      //
      // Each non-"New" pier gets a small icon matching its status: clock,
      // wrench, check, X, or shield.  Icons are white-filled circles with
      // a coloured stroke + glyph so they're legible on any base-layer.
      // Loaded as data-URI SVGs into the map's image store; cheap (< 1 KB
      // each) and renders with the usual collision-aware symbol layer.
      const SIZE = 24;
      const statusIcons: Array<{ id: string; svg: string }> = [
        {
          id: "status-in-progress",
          svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.5" fill="#fff" stroke="#eab308" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="#a16207" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        },
        {
          id: "status-implemented",
          svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.5" fill="#fff" stroke="#10b981" stroke-width="2"/><path d="M7 12l3.2 3.2L17 8" fill="none" stroke="#047857" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        },
        {
          id: "status-approved",
          svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.5" fill="#16a34a" stroke="#166534" stroke-width="1.5"/><path d="M7 12l3.2 3.2L17 8" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        },
        {
          id: "status-rejected",
          svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.5" fill="#fff" stroke="#ef4444" stroke-width="2"/><path d="M8 8l8 8M16 8l-8 8" fill="none" stroke="#b91c1c" stroke-width="2.4" stroke-linecap="round"/></svg>`,
        },
        {
          id: "status-fixed",
          svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.5" fill="#fff" stroke="#2563eb" stroke-width="2"/><path d="M12 5l6 2.2v4.4c0 3.5-2.5 6.4-6 7.4-3.5-1-6-3.9-6-7.4V7.2z" fill="#dbeafe"/><path d="M9 12l2.2 2.2L15 10" fill="none" stroke="#1e40af" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        },
      ];
      for (const it of statusIcons) {
        const img = new Image(SIZE, SIZE);
        img.onload = () => { if (!map.hasImage(it.id)) map.addImage(it.id, img); };
        img.src = "data:image/svg+xml;utf8," + encodeURIComponent(it.svg);
      }
      const stringStart = new Image(24, 18);
      stringStart.onload = () => { if (!map.hasImage("string-start-rect")) map.addImage("string-start-rect", stringStart); };
      stringStart.src = "data:image/svg+xml;utf8," + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="22" viewBox="0 0 24 22"><path d="M12 3L22 19H2Z" fill="#22c55e" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/></svg>`,
      );

      map.addLayer({
        id: "pier-status-icons",
        type: "symbol",
        // Use the lightweight overlay source so the layer only
        // tessellates the piers that actually have a status. The icon
        // image is selected from a feature *property* (allowed in
        // layout expressions); status changes rebuild only this
        // smaller source via setData on the dedicated useEffect.
        source: "pier-statuses",
        layout: {
          "icon-image": [
            "case",
            ["==", ["get", "status"], "In Progress"], "status-in-progress",
            ["==", ["get", "status"], "Implemented"], "status-implemented",
            ["==", ["get", "status"], "Approved"],    "status-approved",
            ["==", ["get", "status"], "Rejected"],    "status-rejected",
            ["==", ["get", "status"], "Fixed"],       "status-fixed",
            "status-approved",
          ],
          "icon-size": [
            "interpolate", ["linear"], ["zoom"],
            0,  0.20,
            8,  0.35,
            12, 0.55,
            15, 0.80,
            18, 1.10,
          ],
          "icon-allow-overlap": false,
          "icon-ignore-placement": false,
          "symbol-sort-key": 1,
        },
      });
      // Bulk-selection highlight — any pier whose code is in the shared
      // selection set. Drawn as a filled ring larger than the base circle.
      map.addLayer({
        id: "piers-bulk-selected",
        type: "circle",
        source: "piers",
        filter: ["in", ["get", "pier_code"], ["literal", []]],
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            0, 3,
            6, 5,
            10, 7,
            14, 10,
            18, 14,
          ],
          "circle-color": "rgba(59, 130, 246, 0.25)",
          "circle-stroke-color": "#2563eb",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "piers-selected",
        type: "circle",
        source: "piers",
        filter: ["==", ["get", "pier_code"], ""],
        paint: {
          "circle-radius": 10,
          "circle-color": "#ef4444",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fff",
        },
      });

      // --- Electrical string zones --------------------------------------
      //
      // Used for electrical-only BHK/EPL uploads before the structural
      // ramming/pier package exists. These are positioned at the source
      // "10/11 STRINGS" labels in the electrical cable plan.
      map.addLayer({
        id: "electrical-zones-layer",
        type: "circle",
        source: "electrical-zones",
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            0, 4,
            8, 7,
            14, 11,
            18, 15,
          ],
          "circle-color": [
            "case",
            ["==", ["get", "string_count"], 11],
            "#0ea5e9",
            "#f59e0b",
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "electrical-zones-labels",
        type: "symbol",
        source: "electrical-zones",
        layout: {
          "text-field": [
            "concat",
            "Z",
            ["to-string", ["get", "zone"]],
            "\n",
            ["to-string", ["get", "string_count"]],
            " strings",
          ],
          "text-size": [
            "interpolate", ["linear"], ["zoom"],
            0, 9,
            8, 10,
            14, 12,
            18, 14,
          ],
          "text-anchor": "top",
          "text-offset": [0, 1.15],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": "#0f172a",
          "text-halo-color": "#ffffff",
          "text-halo-width": 2,
          "text-halo-blur": 0.5,
        },
      });
      map.addLayer({
        id: "electrical-string-labels",
        type: "symbol",
        source: "electrical-string-label-lines",
        layout: {
          visibility: "none",
          "symbol-placement": "line",
          "text-field": ["get", "id"],
          "text-size": [
            "interpolate", ["linear"], ["zoom"],
            0, 8,
            8, 10,
            12, 13,
            16, 17,
            20, 22,
          ],
          "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
          "text-offset": [0, -0.9],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
          "text-keep-upright": true,
          "symbol-sort-key": 2,
        },
        paint: {
          "text-color": "#1e3a8a",
          "text-halo-color": "rgba(255,255,255,0.92)",
          "text-halo-width": 1.4,
        },
      });
      map.addLayer({
        id: "electrical-string-lines",
        type: "line",
        source: "electrical-string-segments",
        filter: ["==", ["get", "kind"], "line"],
        layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "status_color"],
          "line-opacity": 0.74,
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            0, 1.1,
            8, 1.6,
            14, 2.4,
            18, 3.2,
          ],
        },
      });
      map.addLayer({
        id: "electrical-string-point-labels",
        type: "symbol",
        source: "electrical-string-segments",
        filter: ["==", ["get", "kind"], "label"],
        layout: {
          visibility: "none",
          "text-field": ["get", "id"],
          "text-size": [
            "interpolate", ["linear"], ["zoom"],
            0, 7,
            6, 8,
            10, 12,
            14, 18,
            18, 28,
            20, 34,
          ],
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-rotate": ["get", "angle"],
          "text-rotation-alignment": "viewport",
          "text-allow-overlap": true,
          "text-ignore-placement": true,
          "text-anchor": "center",
          "symbol-sort-key": 3,
        },
        paint: {
          "text-color": ["get", "status_color"],
          "text-halo-color": "rgba(255,255,255,0.94)",
          "text-halo-width": 1.2,
        },
      });
      map.addLayer({
        id: "electrical-string-status-icons",
        type: "symbol",
        source: "electrical-string-segments",
        filter: ["==", ["get", "kind"], "status-icon"],
        layout: {
          visibility: "none",
          "text-field": ["get", "status_icon"],
          "text-size": [
            "interpolate", ["linear"], ["zoom"],
            0, 8,
            6, 9,
            10, 12,
            14, 17,
            18, 25,
            20, 31,
          ],
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-rotate": ["get", "angle"],
          "text-rotation-alignment": "viewport",
          "text-offset": [0, 0],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
          "text-anchor": "center",
          "symbol-sort-key": 4,
        },
        paint: {
          "text-color": ["get", "status_color"],
          "text-halo-color": "rgba(255,255,255,0.96)",
          "text-halo-width": 1.4,
        },
      });
      map.addLayer({
        id: "electrical-string-starts",
        type: "symbol",
        source: "electrical-string-segments",
        filter: ["==", ["get", "kind"], "start"],
        layout: {
          visibility: "none",
          "icon-image": "string-start-rect",
          "icon-size": [
            "interpolate", ["linear"], ["zoom"],
            0, 0.38,
            8, 0.5,
            14, 0.75,
            18, 1,
          ],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
      map.addLayer({
        id: "electrical-string-start-panel-labels",
        type: "symbol",
        source: "electrical-string-segments",
        filter: ["==", ["get", "kind"], "start"],
        layout: {
          visibility: "none",
          "text-field": ["get", "panel_label"],
          "text-size": [
            "interpolate", ["linear"], ["zoom"],
            0, 7,
            8, 9,
            14, 12,
            18, 15,
          ],
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-anchor": "top",
          "text-offset": [0, 0.55],
          "text-allow-overlap": false,
          "text-ignore-placement": false,
        },
        paint: {
          "text-color": "#111827",
          "text-halo-color": "rgba(255,255,255,0.95)",
          "text-halo-width": 1.4,
        },
      });
      map.addLayer({
        id: "electrical-string-ends",
        type: "circle",
        source: "electrical-string-segments",
        filter: ["==", ["get", "kind"], "end"],
        layout: { visibility: "none" },
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            0, 2.4,
            8, 3.2,
            14, 4.8,
            18, 6.5,
          ],
          "circle-color": "#ef4444",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.2,
        },
      });
      map.addLayer({
        id: "electrical-string-end-panel-labels",
        type: "symbol",
        source: "electrical-string-segments",
        filter: ["==", ["get", "kind"], "end"],
        layout: {
          visibility: "none",
          "text-field": ["get", "panel_label"],
          "text-size": [
            "interpolate", ["linear"], ["zoom"],
            0, 7,
            8, 9,
            14, 12,
            18, 15,
          ],
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-anchor": "top",
          "text-offset": [0, 1.25],
          "text-allow-overlap": false,
          "text-ignore-placement": false,
        },
        paint: {
          "text-color": "#111827",
          "text-halo-color": "rgba(255,255,255,0.95)",
          "text-halo-width": 1.4,
        },
      });

      // --- Electrical devices -------------------------------------------
      //
      // DCCB  = small red dots with a white stroke (~ one per combiner).
      // Inverter = slightly larger blue dots with a white stroke (one
      //            per inverter station). Both start hidden; the user
      //            toggles them via the side-panel checkboxes.
      map.addLayer({
        id: "dccb-layer",
        type: "circle",
        source: "dccb",
        layout: { visibility: "none" },
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            0, 2.5, 8, 4, 14, 6, 18, 9,
          ],
          "circle-color": "#dc2626",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        },
      });
      map.addLayer({
        id: "inverters-layer",
        type: "circle",
        source: "inverters",
        layout: { visibility: "none" },
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            0, 3.5, 8, 6, 14, 9, 18, 13,
          ],
          "circle-color": "#2563eb",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });

      // --- Optional EPL assets -----------------------------------------
      //
      // Cameras, weather stations, and weather sensors are optional EPL
      // detections. They start hidden and are only exposed in the checkbox
      // list when the EPL feature flags are enabled and assets exist.
      map.addLayer({
        id: "security-devices-layer",
        type: "circle",
        source: "security-devices",
        layout: { visibility: "none" },
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            0, 3, 8, 5, 14, 8, 18, 12,
          ],
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "security-devices-labels",
        type: "symbol",
        source: "security-devices",
        layout: {
          visibility: "none",
          "text-field": ["get", "raw_label"],
          "text-size": [
            "interpolate", ["linear"], ["zoom"],
            0, 8, 10, 10, 16, 12,
          ],
          "text-anchor": "top",
          "text-offset": [0, 1.1],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": "#111827",
          "text-halo-color": "#ffffff",
          "text-halo-width": 2,
        },
      });
      map.addLayer({
        id: "weather-stations-layer",
        type: "circle",
        source: "weather-stations",
        layout: { visibility: "none" },
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            0, 4, 8, 7, 14, 11, 18, 15,
          ],
          "circle-color": "#16a34a",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "weather-stations-labels",
        type: "symbol",
        source: "weather-stations",
        layout: {
          visibility: "none",
          "text-field": ["get", "raw_label"],
          "text-size": [
            "interpolate", ["linear"], ["zoom"],
            0, 8, 10, 10, 16, 12,
          ],
          "text-anchor": "top",
          "text-offset": [0, 1.15],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": "#14532d",
          "text-halo-color": "#ffffff",
          "text-halo-width": 2,
        },
      });
      map.addLayer({
        id: "weather-sensors-layer",
        type: "circle",
        source: "weather-sensors",
        layout: { visibility: "none" },
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            0, 2.5, 8, 4.5, 14, 7, 18, 10,
          ],
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        },
      });
      map.addLayer({
        id: "weather-sensors-labels",
        type: "symbol",
        source: "weather-sensors",
        layout: {
          visibility: "none",
          "text-field": ["get", "raw_label"],
          "text-size": [
            "interpolate", ["linear"], ["zoom"],
            0, 8, 10, 10, 16, 12,
          ],
          "text-anchor": "top",
          "text-offset": [0, 1.05],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": "#713f12",
          "text-halo-color": "#ffffff",
          "text-halo-width": 2,
        },
      });

      // Generous internal padding so the site layout doesn't kiss the map's
      // edges — especially on narrow mobile viewports where 40 px was too tight.
      if (bounds) map.fitBounds(bounds, { padding: 56, duration: 0 });

      // Promote tracker lines above the 24 k-pier layer so they're
      // actually readable.  With piers rendered on top the tracker line
      // was getting obscured.  Casing first (below) → core (on top).
      try {
        map.moveLayer("trackers-casing");
        map.moveLayer("trackers-line");
        map.moveLayer("trackers-selected");
      } catch { /* layers might not exist mid-swap; ignore */ }

      // --- Interaction handlers -----------------------------------------
      map.on("click", "piers-layer", (e: MapMouseEvent & { features?: any[] }) => {
        if (isBoxDraggingRef.current) return; // box-select owns clicks
        const f = e.features?.[0];
        if (!f) return;
        const code = f.properties?.pier_code;
        const match = piers.find((p: any) => p.pier_code === code);
        if (match) onPierClick(match);
      });
      map.on("click", "trackers-line", (e: MapMouseEvent & { features?: any[] }) => {
        if (isBoxDraggingRef.current) return;
        const f = e.features?.[0];
        if (!f) return;
        const code = f.properties?.tracker_code;
        const match = trackers.find((t: any) => t.tracker_code === code);
        if (match) onTrackerClick(match);
      });
      map.on("click", "blocks-fill", (e: MapMouseEvent & { features?: any[] }) => {
        if (isBoxDraggingRef.current) return;
        const f = e.features?.[0];
        if (!f) return;
        const code = f.properties?.block_code;
        const match = blocks.find((b: any) => b.block_code === code);
        if (match) onBlockClick(match);
      });
      const openStringStatus = (e: MapMouseEvent & { features?: any[] }) => {
        if (isBoxDraggingRef.current) return;
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties || {};
        setSelectedString({
          id: p.id,
          row: p.row,
          status: normalizeStringStatus(p.status),
          statusLabel: p.status_label,
          startPanelLabel: p.start_panel_label,
          endPanelLabel: p.end_panel_label,
        });
      };
      map.on("click", "electrical-string-point-labels", openStringStatus);
      map.on("click", "electrical-string-status-icons", openStringStatus);
      map.on("click", "electrical-zones-layer", (e: MapMouseEvent & { features?: any[] }) => {
        if (isBoxDraggingRef.current) return;
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties || {};
        new maplibregl.Popup({ closeButton: true, closeOnClick: true })
          .setLngLat(e.lngLat)
          .setHTML(
            `<div style="font: 12px Arial, sans-serif; min-width: 150px;">` +
            `<div style="font-weight:700;margin-bottom:4px;">Zone ${p.zone}</div>` +
            `<div>${p.string_count || "-"} strings</div>` +
            `<div>Rows ${p.physical_rows || "-"}</div>` +
            `<div style="color:#64748b;margin-top:4px;">${p.source_file || ""}</div>` +
            `</div>`,
          )
          .addTo(map);
      });
      map.on("mouseenter", "piers-layer", () => {
        if (!isBoxDraggingRef.current) map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "piers-layer", () => {
        if (!isBoxDraggingRef.current) map.getCanvas().style.cursor = "";
      });
      map.on("mouseenter", "electrical-zones-layer", () => {
        if (!isBoxDraggingRef.current) map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "electrical-zones-layer", () => {
        if (!isBoxDraggingRef.current) map.getCanvas().style.cursor = "";
      });
      map.on("mouseenter", "electrical-string-point-labels", () => {
        if (!isBoxDraggingRef.current) map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "electrical-string-point-labels", () => {
        if (!isBoxDraggingRef.current) map.getCanvas().style.cursor = "";
      });
      map.on("mouseenter", "electrical-string-status-icons", () => {
        if (!isBoxDraggingRef.current) map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "electrical-string-status-icons", () => {
        if (!isBoxDraggingRef.current) map.getCanvas().style.cursor = "";
      });

      // Pier number labels + viewport change: recompute on any
      // movement end. The initial refresh is owned by dedicated
      // useEffects (`refreshPierLabels` / `refreshRowLabels` /
      // `refreshBlockLabels`), so we don't fire them again here —
      // doing so caused a double-render flicker on first paint.
      const refresh = () => {
        refreshPierLabels();
        refreshRowLabels();
        refreshElectricalRowLabels();
        refreshTrackerLabels();
      };
      map.on("moveend", refresh);
      map.on("zoomend", refresh);
    });

    return () => {
      clearMarkers();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resize the GL canvas when the container transitions from hidden to visible
  // (e.g. accordion toggling). Without this the canvas stays at 0x0 after a
  // display:none→block cycle. Also re-fit the camera to the current bounds
  // whenever the container's pixel size changes substantially — otherwise
  // the first fitBounds (which fires before the lazy parent has finished
  // laying out) leaves the trackers as a tiny dot in the middle of the map.
  const boundsRef = useRef<maplibregl.LngLatBounds | null>(null);
  useEffect(() => { boundsRef.current = bounds; }, [bounds]);
  useEffect(() => {
    const el = containerRef.current;
    const map = mapRef.current;
    if (!el || !map) return;
    // First-time auto-fit only.  Once we successfully fit the map to
    // its bounds against a real, non-zero canvas, we stop auto-fitting
    // on resize — otherwise window-resizes and side-panel toggles
    // would fight against any zoom/pan the user has done since.
    let firstFitDone = false;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w <= 0 || h <= 0) return;
      map.resize();
      if (!firstFitDone) {
        const b = boundsRef.current;
        if (b) {
          map.fitBounds(b, { padding: 56, duration: 0 });
          firstFitDone = true;
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The zoom square is always visible in the top-right; there is no
  // "box select mode" any more. dragPan stays enabled — the square's
  // own pointer events stop propagation, so panning the map past the
  // square still works exactly as before.

  // ---- Source updates when data changes ----------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("map-background") as any;
      if (!src) { setTimeout(apply, 50); return; }
      const url = mapImageUrl || EMPTY_IMAGE_URL;
      if (typeof src.updateImage === "function") {
        src.updateImage({ url, coordinates: mapImageCoordinates });
      }
      if (map.getLayer("map-background-layer")) {
        map.setPaintProperty("map-background-layer", "raster-opacity", mapImageUrl ? 0.92 : 0);
      }
    };
    apply();
  }, [mapImageUrl, mapImageCoordinates]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("piers") as GeoJSONSource | undefined;
      if (!src) { setTimeout(apply, 50); return; }
      src.setData(piersGeoJSON as any);
      // Note: pier-label markers are NOT rebuilt here.  They only
      // show `pier_code` (which doesn't change when pierStatuses
      // updates), so destroying + recreating them on every status
      // edit was a major source of visible flicker.  A dedicated
      // effect below refreshes them only when the pier *set* or the
      // label-threshold prefs actually change.
    };
    apply();
  }, [piersGeoJSON]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("structural-row-guides") as GeoJSONSource | undefined;
      if (!src) { setTimeout(apply, 50); return; }
      src.setData(structuralRowGuideGeoJSON as any);
    };
    apply();
  }, [structuralRowGuideGeoJSON]);

  // Status updates touch two map structures:
  //   1. feature-state on the `piers` source — drives the circle
  //      layer's colour expression (paint property; allowed to read
  //      feature-state). Updated via setFeatureState/removeFeatureState
  //      so a single edit costs microseconds, no re-tile.
  //   2. the `pier-statuses` source — drives the icon symbol layer
  //      (icon-image is layout, can't read feature-state). Rebuilt via
  //      setData but only contains non-"New" piers, so the dataset is
  //      a fraction of the 24 k base.
  const lastStatusesRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      if (!map.getSource("piers")) { setTimeout(apply, 50); return; }
      const prev = lastStatusesRef.current;
      const next = pierStatuses || {};
      for (const p of piers) {
        const code = p.pier_code;
        if (!code) continue;
        const v = next[code];
        if (prev[code] === v) continue;
        if (!v || v === "New") {
          map.removeFeatureState({ source: "piers", id: code });
        } else {
          map.setFeatureState(
            { source: "piers", id: code },
            { status: v, status_color: STATUS_COLORS[v] || "" },
          );
        }
      }
      lastStatusesRef.current = { ...next };
    };
    apply();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pierStatuses, piers]);

  // Push the pier-statuses overlay to its source whenever the
  // (smaller) overlay GeoJSON changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("pier-statuses") as GeoJSONSource | undefined;
      if (!src) { setTimeout(apply, 50); return; }
      src.setData(pierStatusGeoJSON as any);
    };
    apply();
  }, [pierStatusGeoJSON]);

  // Pier labels only depend on the pier set + threshold prefs, not on
  // statuses. Splitting this out kills the blink that used to fire on
  // every status update.
  useEffect(() => {
    refreshPierLabels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [piers.length, imageWidth, pierLabelThreshold, pierDetailThreshold]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("blocks") as GeoJSONSource | undefined;
      if (!src) { setTimeout(apply, 50); return; }
      src.setData(blocksGeoJSON as any);
      // refreshBlockLabels is owned by its dedicated effect below —
      // calling it here too caused the labels to blink on every
      // blocks-data tick.
    };
    apply();
  }, [blocksGeoJSON]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("trackers") as GeoJSONSource | undefined;
      if (!src) {
        // Source hasn't been created yet (map hasn't fired load).  Retry
        // on the next paint — cheap and avoids losing data on the race.
        setTimeout(apply, 50);
        return;
      }
      src.setData(trackersGeoJSON as any);
      // Re-promote tracker lines above the 24 k pier layer every time
      // the data changes — otherwise a late-arriving pier source pushes
      // piers back on top and the lines silently disappear underneath.
      // Also *force* visibility to match the user's checkbox state: the
      // visibility effect can silently bail on first run if the style
      // isn't loaded yet, leaving the layer in whatever state the
      // addLayer call set it to. Doing it here guarantees the layer
      // follows the Trackers checkbox even across race-conditions.
      const trackersOn = layerVisible(layersRef.current, "trackers", true);
      try {
        if (map.getLayer("trackers-casing")) {
          map.moveLayer("trackers-casing");
          map.setLayoutProperty("trackers-casing", "visibility", trackersOn ? "visible" : "none");
        }
        if (map.getLayer("trackers-line")) {
          map.moveLayer("trackers-line");
          map.setLayoutProperty("trackers-line", "visibility", trackersOn ? "visible" : "none");
        }
        if (map.getLayer("trackers-selected")) {
          map.moveLayer("trackers-selected");
          map.setLayoutProperty("trackers-selected", "visibility", trackersOn ? "visible" : "none");
        }
      } catch { /* noop */ }
      // Row labels live on their own effect (deps: rowLabelsOn +
      // rowLabelData) so they don't re-render every time the tracker
      // line data ticks — used to be a major flicker source.
    };
    apply();
  }, [trackersGeoJSON]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
      const apply = () => {
      (map.getSource("electrical-zones") as GeoJSONSource | undefined)?.setData(electricalZonesGeoJSON as any);
      (map.getSource("electrical-row-guides") as GeoJSONSource | undefined)?.setData(electricalRowGuideGeoJSON as any);
      (map.getSource("panel-base-rows") as GeoJSONSource | undefined)?.setData(panelBaseRowsGeoJSON as any);
      (map.getSource("electrical-string-label-lines") as GeoJSONSource | undefined)?.setData(electricalStringLabelLinesGeoJSON as any);
      (map.getSource("electrical-string-segments") as GeoJSONSource | undefined)?.setData(electricalStringSegmentsGeoJSON as any);
      (map.getSource("electrical-zone-bands") as GeoJSONSource | undefined)?.setData(electricalZoneBandGeoJSON as any);
      (map.getSource("dccb") as GeoJSONSource | undefined)?.setData(dccbGeoJSON as any);
      (map.getSource("inverters") as GeoJSONSource | undefined)?.setData(inverterGeoJSON as any);
      (map.getSource("security-devices") as GeoJSONSource | undefined)?.setData(securityDevicesGeoJSON as any);
      (map.getSource("weather-stations") as GeoJSONSource | undefined)?.setData(weatherStationsGeoJSON as any);
      (map.getSource("weather-sensors") as GeoJSONSource | undefined)?.setData(weatherSensorsGeoJSON as any);
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [electricalZonesGeoJSON, electricalRowGuideGeoJSON, panelBaseRowsGeoJSON, electricalStringLabelLinesGeoJSON, electricalStringSegmentsGeoJSON, electricalZoneBandGeoJSON, dccbGeoJSON, inverterGeoJSON, securityDevicesGeoJSON, weatherStationsGeoJSON, weatherSensorsGeoJSON]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !bounds) return;
    // Fit only when the pier set itself changes (cheap heuristic: first load
    // or project swap).
    map.fitBounds(bounds, { padding: 40, duration: 300 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [piers.length, imageWidth]);

  // ---- Selection filters -------------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    map.setFilter("piers-selected", [
      "==", ["get", "pier_code"], selectedPier?.pier_code || "",
    ]);
  }, [selectedPier]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    map.setFilter("trackers-selected", [
      "==", ["get", "tracker_code"], selectedTracker?.tracker_code || "",
    ]);
  }, [selectedTracker]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    map.setFilter("blocks-selected", [
      "==", ["get", "block_code"], selectedBlock?.block_code || "",
    ]);
  }, [selectedBlock]);

  // Bulk-selection filter — this can be a very large list so we pass it as
  // a literal expression directly into MapLibre.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const codes = bulkSelectedPierCodes
      ? Array.from(bulkSelectedPierCodes)
      : [];
    if (map.getLayer("piers-bulk-selected")) {
      map.setFilter("piers-bulk-selected", [
        "in",
        ["get", "pier_code"],
        ["literal", codes],
      ]);
    }
  }, [bulkSelectedPierCodes]);

  // ---- Layer visibility --------------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const show = (id: string, visible: boolean) => {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
        } else {
          // Layer not created yet (style still loading) — retry briefly.
          setTimeout(() => apply(), 50);
        }
      };
      const piersOn = layerVisible(layers, "piers");
      const blocksOn = layerVisible(layers, "blocks");
      const blockLabelsOn = layerVisible(layers, "blockLabels");
      const trackersOn = layerVisible(layers, "trackers");
      const rowLabelsOn = layerVisible(layers, "row_labels");
      // Icon overlay only renders when the user wants the icon variant
      // (default) or both. When set to "color" the dot's fill colour
      // alone communicates status — no icon.
      const wantIcon = pierStatusDisplay !== "color";
      show("piers-layer", piersOn);
      show("piers-selected", piersOn);
      show("pier-status-icons", piersOn && wantIcon);
      // Live-update the pier dot's colour expression when the user
      // flips the "Show status as" preference. Without this the
      // expression stays whatever was set inside on("load") and the
      // dropdown change has no visible effect on the map.
      if (map.getLayer("piers-layer")) {
        const wantStatusColor = pierStatusDisplay !== "icon";
        map.setPaintProperty("piers-layer", "circle-color",
          wantStatusColor
            ? ["case", ["!=", ["get", "status"], "New"], ["get", "status_color"], ["get", "color"]]
            : ["get", "color"],
        );
        map.setPaintProperty("piers-layer", "circle-stroke-width",
          wantStatusColor
            ? ["case", ["!=", ["get", "status"], "New"], 1.5, 0]
            : 0,
        );
      }
      show("blocks-fill", blocksOn);
      show("blocks-outline", blocksOn);
      show("blocks-selected", blocksOn);
      show("trackers-casing", trackersOn);
      show("trackers-line", trackersOn);
      show("trackers-selected", trackersOn);
      const stringsOn = layerVisible(layers, "string_zones", true);
        const zonesOn = layerVisible(layers, "zones", false);
        show("electrical-zone-bands-fill", zonesOn);
        show("electrical-zone-bands-outline", zonesOn);
      show("electrical-string-lines", stringsOn);
      show("electrical-string-starts", stringsOn);
      show("electrical-string-ends", stringsOn);
      show("electrical-string-labels", false);
      show("electrical-string-point-labels", stringsOn);
      show("electrical-string-status-icons", stringsOn);
      show("electrical-string-start-panel-labels", stringsOn);
      show("electrical-string-end-panel-labels", stringsOn);
      const hasPanelBase = (panelBaseRows || []).length > 0;
      show("panel-base-rows-layer", hasPanelBase);
      show("electrical-row-guides-layer", !hasPanelBase);
      show("electrical-zones-layer", layerVisible(layers, "zones", false));
      show("electrical-zones-labels", layerVisible(layers, "zones", false));
      show("dccb-layer", layerVisible(layers, "dccb", false));
      show("inverters-layer", layerVisible(layers, "inverters", false));
      show("security-devices-layer", layerVisible(layers, "security_cameras", false));
      show("security-devices-labels", layerVisible(layers, "security_cameras", false));
      show("weather-stations-layer", layerVisible(layers, "weather_station", false));
      show("weather-stations-labels", layerVisible(layers, "weather_station", false));
      show("weather-sensors-layer", layerVisible(layers, "weather_sensors", false));
      show("weather-sensors-labels", layerVisible(layers, "weather_sensors", false));
      // Block labels: cheap toggle on existing markers (display:
      // none/""), no destroy-and-rebuild.  A separate effect below
      // owns the actual marker creation when the checkbox flips on
      // for the first time. This stops the visible flicker that used
      // to fire whenever ANY layer checkbox changed.
      for (const m of blockMarkersRef.current) {
        m.getElement().style.display = blockLabelsOn ? "" : "none";
      }
    };
    apply();
    // Row-label rendering lives in its OWN effect below so that toggling
    // Blocks / Block labels / Trackers doesn't destroy and rebuild the row
    // markers each time (previously this loop ran on every layer change
    // and visually wiped the row labels mid-toggle).
  }, [layers, pierLabelThreshold, pierDetailThreshold, pierStatusDisplay]);

  // ---- Row labels — dedicated effect ------------------------------------
  //
  // Only re-runs when Row-numbers visibility changes or when the underlying
  // pier data changes. Prevents Blocks / Block-labels toggles from
  // destroying and rebuilding the row-number markers.
  const rowLabelsOn = layerVisible(layers, "row_labels");
  useEffect(() => {
    refreshRowLabels();
    refreshElectricalRowLabels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowLabelsOn, rowLabelData, electricalRowLabelData, mapLabelStride, mapLabelDenseThreshold]);

  // ---- Tracker labels — dedicated effect --------------------------------
  //
  // Tracker codes (T0001…T1533) appear as small chips when the Trackers
  // checkbox is on AND the user is zoomed in enough to read them
  // (1 533 labels at site overview would be unreadable). The actual
  // rendering happens in refreshTrackerLabels which checks the zoom
  // level and the viewport — this effect just resets the label set
  // when the toggle or data changes.
  const trackersOnForLabels = layerVisible(layers, "trackers");
  useEffect(() => {
    refreshTrackerLabels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackersOnForLabels, trackerLabelData, mapLabelStride, mapLabelDenseThreshold]);

  // ---- Block labels — dedicated effect ----------------------------------
  //
  // Block-label HTML markers are expensive to recreate (DOM + style +
  // map.addMarker per block). Rebuild only when the block set changes
  // or the BlockLabels checkbox actually flips. The visibility effect
  // above just toggles `display` on already-built markers, which is
  // cheap and doesn't blink.
  const blockLabelsOn = layerVisible(layers, "blockLabels");
  useEffect(() => {
    refreshBlockLabels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockLabelsOn, blocks, imageWidth]);

  // ---- HTML marker helpers ----------------------------------------------

  function clearMarkers() {
    for (const m of pierLabelMarkersRef.current) m.remove();
    pierLabelMarkersRef.current = [];
    for (const m of rowLabelMarkersRef.current) m.remove();
    rowLabelMarkersRef.current = [];
    for (const m of electricalRowMarkersRef.current) m.remove();
    electricalRowMarkersRef.current = [];
    for (const m of trackerLabelMarkersRef.current) m.remove();
    trackerLabelMarkersRef.current = [];
    for (const m of blockMarkersRef.current) m.remove();
    blockMarkersRef.current = [];
  }

  function refreshBlockLabels() {
    const map = mapRef.current;
    if (!map) return;
    for (const m of blockMarkersRef.current) m.remove();
    blockMarkersRef.current = [];
    if (!layerVisible(layers, "blockLabels")) return;
    for (const b of blocks) {
      if (!b.centroid) continue;
      const el = document.createElement("div");
      el.textContent = b.block_code;
      el.style.cssText =
        "font: 700 12px Arial, sans-serif; color: #1e3a5f; pointer-events: none; " +
        "text-shadow: 0 0 3px #fff, 0 0 3px #fff, 0 0 3px #fff; white-space: nowrap;";
      const [lng, lat] = rotatedToLngLat(b.centroid.x, b.centroid.y, imageWidth);
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([lng, lat])
        .addTo(map);
      blockMarkersRef.current.push(marker);
    }
  }

  // Keep the data ref in sync so the zoom/move handlers always see fresh data.
  useEffect(() => { rowLabelDataRef.current = rowLabelData; }, [rowLabelData]);
  useEffect(() => { electricalRowLabelDataRef.current = electricalRowLabelData; }, [electricalRowLabelData]);
  useEffect(() => { trackerLabelDataRef.current = trackerLabelData; }, [trackerLabelData]);

  function refreshRowLabels() {
    const map = mapRef.current;
    if (!map) return;
    for (const m of rowLabelMarkersRef.current) m.remove();
    rowLabelMarkersRef.current = [];
    // Read layers + row positions through refs so zoom/move events
    // (registered once at map-load time) always see the latest state.
    if (!layerVisible(layersRef.current, "row_labels")) return;

    const bounds = map.getBounds();
    // Two-pass sampling so the chips spread evenly across the
    // viewport: first collect every row whose marker position lies
    // in-bounds, then either render them all (if the count fits the
    // dense-threshold) or keep every Nth.
    const visible: [string, { lng: number; lat: number }][] = [];
    for (const e of Object.entries(rowLabelDataRef.current)) {
      if (bounds.contains([e[1].lng, e[1].lat])) visible.push(e);
    }
    const stride = visible.length <= mapLabelDenseThresholdRef.current
      ? 1
      : Math.max(1, mapLabelStrideRef.current);
    for (let i = 0; i < visible.length; i += stride) {
      const [row, pos] = visible[i];
      // Keep the S prefix verbatim so an S-row chip ("R-S19") is
      // visibly distinct from the regular numeric row of the same
      // index ("R-19"). Earlier we stripped the S to "normalise" the
      // pill, but that hid the S-row labels entirely behind the
      // numeric ones.
      const el = document.createElement("div");
      el.textContent = `R-${row}`;
      // Clickable pill so row numbers behave like piers/trackers: hover
      // feedback, pointer cursor, click filters the grid + highlights on map.
      el.style.cssText =
        "font: 700 11px Arial, sans-serif; color: #0f172a; cursor: pointer; " +
        "background: rgba(255,255,255,0.88); border: 1px solid #cbd5e1; " +
        "border-radius: 999px; padding: 1px 7px; white-space: nowrap; " +
        "box-shadow: 0 1px 2px rgba(0,0,0,0.08); user-select: none;";
      el.addEventListener("mouseenter", () => { el.style.background = "#dbeafe"; el.style.borderColor = "#93c5fd"; });
      el.addEventListener("mouseleave", () => { el.style.background = "rgba(255,255,255,0.88)"; el.style.borderColor = "#cbd5e1"; });
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        // Re-use the tracker-click flow — the App treats it as a row
        // filter by setting gridFilterBy to "row" and gridFilterValue
        // to the row id. Passing a synthetic object with the row info
        // so the caller can distinguish.
        onTrackerClick({ __row: true, row: row, tracker_code: "", row_num: row });
      });
      const marker = new maplibregl.Marker({ element: el, anchor: "bottom" })
        .setLngLat([pos.lng, pos.lat + 0.003])
        .addTo(map);
      rowLabelMarkersRef.current.push(marker);
    }
  }

  // Tracker labels — small "T0001" pills centred on each tracker. With
  // 1 533 trackers we only render labels above a zoom threshold (the
  // map text would be unreadable below it) and clip to the viewport so
  // the marker count stays bounded as the user pans around.
  function refreshElectricalRowLabels() {
    const map = mapRef.current;
    if (!map) return;
    for (const m of electricalRowMarkersRef.current) m.remove();
    electricalRowMarkersRef.current = [];
    if (!layerVisible(layersRef.current, "row_labels")) return;

    const bounds = map.getBounds();
    const visible: [string, { lng: number; lat: number; zone: string; rowNum?: any; side?: string; strings?: any; stringNumbers?: number[]; stringLabels?: string[]; optimizerPattern?: string; splitStrings?: string[]; optimizers?: any; modules?: any }][] = [];
    for (const e of Object.entries(electricalRowLabelDataRef.current)) {
      if (bounds.contains([e[1].lng, e[1].lat])) visible.push(e);
    }
    const stride = 1;
    for (let i = 0; i < visible.length; i += stride) {
      const [id, pos] = visible[i];
      const row = String(pos.rowNum ?? id.split("-row-").pop()?.replace(/^row-/, "").replace(/-(north|south)$/, "") ?? id.replace(/^row-/, "").replace(/-(north|south)$/, ""));
      const stringLabel = (pos.stringLabels || []).join(", ") || formatStringNumbers(pos.stringNumbers || []);
      const splitLabel = (pos.splitStrings || []).join(", ");
      const el = document.createElement("div");
      el.textContent = `R-${row}`;
      el.title = stringLabel ? `Row ${row} ${pos.side || ""}: ${stringLabel}` : `Row ${row} ${pos.side || ""}`;
      el.style.cssText =
        "font: 700 10px Arial, sans-serif; color: #075985; cursor: pointer; " +
        "background: rgba(224,242,254,0.94); border: 1px solid #38bdf8; " +
        "border-radius: 999px; padding: 1px 6px; white-space: nowrap; " +
        "box-shadow: 0 1px 2px rgba(14,165,233,0.18); user-select: none;";
      el.addEventListener("mouseenter", () => { el.style.background = "#bae6fd"; });
      el.addEventListener("mouseleave", () => { el.style.background = "rgba(224,242,254,0.94)"; });
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        new maplibregl.Popup({ closeButton: true, closeOnClick: true })
          .setLngLat([pos.lng, pos.lat])
          .setHTML(
            `<div style="font: 12px Arial, sans-serif; min-width: 150px;">` +
            `<div style="font-weight:700;margin-bottom:4px;">Physical row ${row}</div>` +
            `<div>Zone ${pos.zone || "-"}</div>` +
            `<div>Strings ${stringLabel || "-"}</div>` +
            `<div>String count ${pos.strings ?? "-"}</div>` +
            `<div>Optimizers ${pos.optimizers ?? "-"}</div>` +
            `<div>Optimizer pattern ${pos.optimizerPattern || "-"}</div>` +
            `<div>Split strings ${splitLabel || "-"}</div>` +
            `<div>Modules ${pos.modules ?? "-"}</div>` +
            `</div>`,
          )
          .addTo(map);
      });
      const isSouthLabel = pos.side === "south";
      const marker = new maplibregl.Marker({
        element: el,
        anchor: isSouthLabel ? "top" : "center",
        offset: isSouthLabel ? [0, 18] : [0, 0],
      })
        .setLngLat([pos.lng, pos.lat])
        .addTo(map);
      electricalRowMarkersRef.current.push(marker);
    }
  }

  function formatStringNumbers(values: number[]) {
    const nums = [...new Set(values)]
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    if (!nums.length) return "";
    return `S.${nums.join(".")}`;
  }

  function refreshTrackerLabels() {
    const map = mapRef.current;
    if (!map) return;
    for (const m of trackerLabelMarkersRef.current) m.remove();
    trackerLabelMarkersRef.current = [];
    if (!layerVisible(layersRef.current, "trackers")) return;

    // Same sampling policy as refreshRowLabels: render every tracker
    // when the visible count fits, otherwise stride every Nth so
    // chips don't pile on top of each other.
    const bounds = map.getBounds();
    const visible: [string, { lng: number; lat: number }][] = [];
    for (const e of Object.entries(trackerLabelDataRef.current)) {
      if (bounds.contains([e[1].lng, e[1].lat])) visible.push(e);
    }
    const stride = visible.length <= mapLabelDenseThresholdRef.current
      ? 1
      : Math.max(1, mapLabelStrideRef.current);
    for (let i = 0; i < visible.length; i += stride) {
      const [code, pos] = visible[i];
      const el = document.createElement("div");
      el.textContent = code;
      el.style.cssText =
        "font: 700 10px Arial, sans-serif; color: #15803d; cursor: pointer; " +
        "background: rgba(255,255,255,0.92); border: 1px solid #86efac; " +
        "border-radius: 999px; padding: 0 6px; white-space: nowrap; " +
        "box-shadow: 0 1px 2px rgba(0,0,0,0.06); user-select: none;";
      el.addEventListener("mouseenter", () => { el.style.background = "#dcfce7"; });
      el.addEventListener("mouseleave", () => { el.style.background = "rgba(255,255,255,0.92)"; });
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onTrackerClick({ tracker_code: code });
      });
      const marker = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([pos.lng, pos.lat])
        .addTo(map);
      trackerLabelMarkersRef.current.push(marker);
    }
  }

  function refreshPierLabels() {
    const map = mapRef.current;
    if (!map) return;
    // Remove existing labels.
    for (const m of pierLabelMarkersRef.current) m.remove();
    pierLabelMarkersRef.current = [];
    // Read through layersRef so the handler reflects the latest toggle state
    // even when triggered by map-level zoom / move events.
    if (!layerVisible(layersRef.current, "piers")) return;

    // `piers-layer` may not be in the style yet if the map fired a
    // zoom/move event before its on("load") handler ran (seen on slow
    // first-paint — MapLibre throws a synchronous error if any layer in
    // the filter list is missing).  Skip until it exists.
    if (!map.getLayer("piers-layer")) return;

    // Query only the features currently rendered in the viewport.
    const visible = map.queryRenderedFeatures(undefined, {
      layers: ["piers-layer"],
    });
    // Deduplicate by pier_code (MapLibre can return duplicates across tiles).
    const seen = new Set<string>();
    const unique: typeof visible = [];
    for (const f of visible) {
      const code = (f.properties as any)?.pier_code;
      if (!code || seen.has(code)) continue;
      seen.add(code);
      unique.push(f);
    }
    if (unique.length > pierLabelThreshold) return;

    // Pick the detail level: full card vs thin code-only label. The full
    // card only kicks in when the user is zoomed right onto a handful of
    // piers (default ≤ 4) so it does not flood the screen.
    const showDetails = unique.length <= pierDetailThreshold;

    for (const f of unique) {
      const props = f.properties as any;
      const geom = f.geometry as any;
      if (!geom || geom.type !== "Point") continue;
      const [lng, lat] = geom.coordinates as [number, number];
      const el = document.createElement("div");

      if (showDetails) {
        // Rich detail card — one row per meaningful field.
        const statusColor = STATUS_COLORS[props.status] || "#94a3b8";
        const rows: string[] = [];
        const add = (label: string, value: any) => {
          if (value == null || value === "") return;
          rows.push(
            `<div style="display:flex;gap:6px;"><span style="color:#64748b;min-width:52px;">${label}</span><span style="color:#0f172a;font-weight:600;">${String(value)}</span></div>`,
          );
        };
        add("Type", props.pier_type);
        add("Tracker", props.tracker_code);
        add("Block", props.block_code);
        add("Row", props.row_num);
        add("Structure", props.structure_code);
        add("Slope", props.slope_band);
        el.innerHTML = `
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
            <span style="width:8px;height:8px;border-radius:50%;background:${props.color};display:inline-block;box-shadow:0 0 0 1px #cbd5e1;"></span>
            <span style="font:700 12px Arial,sans-serif;color:#0f172a;">${props.pier_code}</span>
            <span style="font:600 10px Arial,sans-serif;color:${statusColor};text-transform:uppercase;letter-spacing:.3px;">${props.status}</span>
          </div>
          <div style="font:500 11px Arial,sans-serif;display:grid;gap:1px;">
            ${rows.join("")}
          </div>`;
        el.style.cssText =
          "background: rgba(255,255,255,0.97); padding: 6px 8px; border-radius: 8px; " +
          "box-shadow: 0 2px 8px rgba(15,23,42,0.18); border: 1px solid #e2e8f0; " +
          "pointer-events: none; transform: translate(12px, -50%); " +
          "white-space: nowrap; min-width: 140px;";
      } else {
        // Thin code-only label.
        el.textContent = String(props.pier_code || "");
        el.style.cssText =
          "font: 600 10px Arial, sans-serif; color: #0f172a; pointer-events: none; " +
          "background: rgba(255,255,255,0.85); padding: 1px 4px; border-radius: 4px; " +
          "transform: translate(10px, -6px); white-space: nowrap;";
      }

      const marker = new maplibregl.Marker({
        element: el,
        anchor: showDetails ? "left" : "top-left",
      })
        .setLngLat([lng, lat])
        .addTo(map);
      pierLabelMarkersRef.current.push(marker);
    }
  }

  // ---- Always-visible zoom selector --------------------------------------
  //
  // A fixed square sits parked in the map's bottom-left corner (right
  // next to the side panel) at all times; the user drags it over an
  // area of interest and presses ✓ to zoom+select. No toolbar button
  // needed. +/- buttons on the square resize it in 20 px steps
  // (60 px min → 90 % of shorter side max).
  useEffect(() => {
    const map = mapRef.current;
    const container = containerRef.current;
    if (!map || !container) return;

    // The map container can still be reporting 0×0 right after lazy
    // loading. Pick a sensible default and let the ResizeObserver below
    // upgrade everything once the real container size is known.
    const minSide = 60;
    let side = 110;          // initial size used until container measures
    let maxSide = 600;       // recalculated once container has size
    const margin = 10;

    const box = document.createElement("div");
    // Anchor with `bottom`+`left` so the square is always parked at the
    // bottom-left even if the container hasn't laid out yet (useEffect
    // can fire before the lazy-Suspense parent has its real height).
    // The drag handler swaps `bottom` → `top` on first interaction.
    box.style.cssText =
      `position: absolute; left: ${margin}px; bottom: ${margin}px; ` +
      `width: ${side}px; height: ${side}px; ` +
      // Soft-dashed outline + a subtle tinted fill so the drag area is
      // discoverable without screaming for attention, and a crisp drop
      // shadow so it visibly sits above the map.
      `border: 1.5px dashed #334155; background: rgba(248,250,252,0.35); ` +
      `border-radius: 8px; cursor: grab; z-index: 20; touch-action: none; ` +
      `box-shadow: 0 2px 8px rgba(15,23,42,0.08);`;

    // Once the container actually has size, scale `side` to ~14 % of
    // the shorter edge and clamp to the new max. Box stays anchored
    // bottom-left via CSS `bottom` until the user interacts with it.
    const ro = new ResizeObserver(() => {
      const c = container.getBoundingClientRect();
      if (!c.width || !c.height) return;
      maxSide = Math.round(Math.min(c.width, c.height) * 0.9);
      const target = Math.round(Math.min(c.width, c.height) * 0.14);
      const next = Math.max(minSide, Math.min(maxSide, target));
      if (next !== side) {
        side = next;
        box.style.width = `${side}px`;
        box.style.height = `${side}px`;
      }
    });
    ro.observe(container);

    // Convert from CSS `bottom` to absolute `top` lazily, the first
    // time the user grabs the box. Without this, every mouse move
    // would have to recompute against `bottom`, and resizing wouldn't
    // keep the box pinned to the bottom-left until the user moves it.
    function pinToTop() {
      if (box.style.top) return;
      const c = container.getBoundingClientRect();
      const offsetTop = c.height - side - margin;
      box.style.top = `${Math.max(margin, offsetTop)}px`;
      box.style.bottom = "";
    }

    // Small pill-style toolbar parked at the top of the square with
    // icon-only buttons: ✓ apply, + grow, − shrink. Each button is a
    // rounded ghost that fills on hover, so the trio reads as a real
    // control set instead of three loose characters.
    const ctrl = document.createElement("div");
    ctrl.style.cssText =
      "position: absolute; top: -14px; left: 50%; transform: translateX(-50%); " +
      "display: flex; gap: 4px; padding: 3px; z-index: 3; " +
      "background: #ffffff; border: 1px solid #e2e8f0; border-radius: 999px; " +
      "box-shadow: 0 2px 10px rgba(15,23,42,0.12);";
    const ICON_CHECK =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 10 18 20 6"/></svg>';
    const ICON_PLUS =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    const ICON_MINUS =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>';

    const mkBtn = (
      icon: string,
      title: string,
      variant: "primary" | "ghost",
      onClick: () => void,
    ) => {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = icon;
      b.title = title;
      b.setAttribute("aria-label", title);
      const isPrimary = variant === "primary";
      const baseBg   = isPrimary ? "#16a34a" : "transparent";
      const baseFg   = isPrimary ? "#ffffff" : "#0f172a";
      const hoverBg  = isPrimary ? "#15803d" : "#f1f5f9";
      b.style.cssText =
        `display: inline-flex; align-items: center; justify-content: center; ` +
        `width: 22px; height: 22px; padding: 0; border: none; ` +
        `background: ${baseBg}; color: ${baseFg}; border-radius: 999px; ` +
        `cursor: pointer; touch-action: manipulation; ` +
        `transition: background-color 120ms ease;`;
      b.addEventListener("mouseenter", () => { b.style.background = hoverBg; });
      b.addEventListener("mouseleave", () => { b.style.background = baseBg; });
      b.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(); });
      b.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); });
      return b;
    };
    ctrl.appendChild(mkBtn(ICON_CHECK, t("details.zoomHere", "Zoom & select this area"), "primary", () => applyZoom()));
    ctrl.appendChild(mkBtn(ICON_PLUS,  t("details.grow",     "Grow"),   "ghost", () => resize(+20)));
    ctrl.appendChild(mkBtn(ICON_MINUS, t("details.shrink",   "Shrink"), "ghost", () => resize(-20)));
    box.appendChild(ctrl);
    container.appendChild(box);

    // Resize no-op that used to manage the hint; kept as a stub so
    // resize() can call it without a conditional.
    function updateHintVisibility() { /* no-op */ }

    function resize(delta: number) {
      // First +/- click pins the box to top/left coords so we can
      // recompute its centre from `style.left/top`.
      pinToTop();
      const c = container.getBoundingClientRect();
      const newSide = Math.max(minSide, Math.min(maxSide, side + delta));
      const prevCX = parseFloat(box.style.left) + side / 2;
      const prevCY = parseFloat(box.style.top || "0") + side / 2;
      side = newSide;
      box.style.width = `${side}px`;
      box.style.height = `${side}px`;
      box.style.left = `${Math.max(0, Math.min(c.width - side, Math.round(prevCX - side / 2)))}px`;
      box.style.top  = `${Math.max(0, Math.min(c.height - side, Math.round(prevCY - side / 2)))}px`;
      updateHintVisibility();
    }

    let dragging = false;
    let offset = { x: 0, y: 0 };

    function onDown(ev: PointerEvent) {
      ev.preventDefault();
      ev.stopPropagation();
      // Convert from CSS bottom→top so the move handler can use top.
      pinToTop();
      dragging = true;
      isBoxDraggingRef.current = true;
      box.style.cursor = "grabbing";
      const rect = box.getBoundingClientRect();
      offset = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      box.setPointerCapture(ev.pointerId);
    }
    function onMove(ev: PointerEvent) {
      if (!dragging) return;
      ev.preventDefault();
      const c = container.getBoundingClientRect();
      const x = Math.max(0, Math.min(c.width - side, ev.clientX - c.left - offset.x));
      const y = Math.max(0, Math.min(c.height - side, ev.clientY - c.top - offset.y));
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
    }
    function onUp(ev: PointerEvent) {
      if (!dragging) return;
      dragging = false;
      // Defer clearing the drag flag to the next tick — the same pointer-up
      // may still bubble into a MapLibre click handler, and we don't want
      // that click to be treated as a pier click.
      setTimeout(() => { isBoxDraggingRef.current = false; }, 0);
      box.style.cursor = "grab";
      try { box.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
      // Note: no zoom on drag-end any more — the user must press ✓.
    }

    function applyZoom() {
      pinToTop();   // ensure style.top is populated for the math below
      // Compute world bounds under the box and zoom-fit them.
      const c = container.getBoundingClientRect();
      const x0 = parseFloat(box.style.left);
      const y0 = parseFloat(box.style.top);
      const x1 = x0 + side;
      const y1 = y0 + side;

      const canvas = map.getCanvas();
      const cr = canvas.getBoundingClientRect();
      const dx = c.left - cr.left;
      const dy = c.top - cr.top;
      const A = map.unproject([x0 + dx, y0 + dy]);
      const B = map.unproject([x1 + dx, y0 + dy]);
      const C = map.unproject([x0 + dx, y1 + dy]);
      const D = map.unproject([x1 + dx, y1 + dy]);
      const b = new maplibregl.LngLatBounds(A, B); b.extend(C); b.extend(D);

      // Report pier codes inside the square so the grid selection stays
      // in sync. Guard against the layer-not-ready race: MapLibre throws
      // synchronously when any layer in the filter list is missing.
      const features = map.getLayer("piers-layer")
        ? map.queryRenderedFeatures(
            [[x0 + dx, y0 + dy], [x1 + dx, y1 + dy]],
            { layers: ["piers-layer"] },
          )
        : [];
      const codes = new Set<string>();
      for (const f of features) {
        const c0 = (f.properties as any)?.pier_code;
        if (c0) codes.add(c0);
      }
      const picked = piersRef.current.filter((p: any) => codes.has(p.pier_code));
      onAreaSelect?.(picked);

      map.fitBounds(b, { padding: 32, duration: 450 });
      // Re-park in the (new) bottom-LEFT corner so the box stays reachable
      // after a zoom-in that shrinks the viewport in canvas pixels. Also
      // clamp `side` to the new container — otherwise the box overflows
      // a narrow viewport after an aggressive zoom-in and looks chopped
      // off.
      requestAnimationFrame(() => {
        const cc = container.getBoundingClientRect();
        const fit = Math.max(minSide, Math.min(side, Math.round(Math.min(cc.width, cc.height) * 0.5)));
        if (fit !== side) {
          side = fit;
          box.style.width = `${side}px`;
          box.style.height = `${side}px`;
          updateHintVisibility();
        }
        // Re-park to the bottom-left using CSS `bottom` (not `top`) so
        // the position survives any subsequent container resize.
        box.style.left = `${margin}px`;
        box.style.top = "";
        box.style.bottom = `${margin}px`;
      });
    }

    box.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      ro.disconnect();
      box.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (box.parentNode) box.parentNode.removeChild(box);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 300,
      }}
    >
      {selectedString && (
        <StringStatusModal
          stringInfo={{
            ...selectedString,
            status: normalizeStringStatus(stringStatuses[selectedString.id] || selectedString.status),
            images: stringImages[selectedString.id] || [],
            comment: stringComments[selectedString.id] || "",
          }}
          onStatusChange={(status) => {
            onStringStatusChange?.(selectedString.id, status);
            setSelectedString((prev: any) => prev ? { ...prev, status } : prev);
          }}
          onImageAdd={(file) => onStringImageAdd?.(selectedString.id, file)}
          onCommentChange={(comment) => onStringCommentChange?.(selectedString.id, comment)}
          onClose={() => setSelectedString(null)}
        />
      )}
    </div>
  );
}

function StringStatusModal({
  stringInfo,
  onStatusChange,
  onImageAdd,
  onCommentChange,
  onClose,
}: {
  stringInfo: any;
  onStatusChange: (status: string) => void;
  onImageAdd: (file: File) => void;
  onCommentChange: (comment: string) => void;
  onClose: () => void;
}) {
  const currentStatus = normalizeStringStatus(stringInfo?.status);
  const images = Array.isArray(stringInfo?.images) ? stringInfo.images : [];
  const [comment, setComment] = useState(String(stringInfo?.comment || ""));
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  useEffect(() => {
    setComment(String(stringInfo?.comment || ""));
  }, [stringInfo?.id, stringInfo?.comment]);
  const handleImageFile = async (file?: File) => {
    if (!file) return;
    onImageAdd(file);
  };
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.46)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2500,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          borderRadius: 12,
          padding: "18px 20px",
          width: "min(420px, 94vw)",
          boxShadow: "0 16px 42px rgba(15,23,42,0.26)",
          position: "relative",
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute",
            top: 8,
            right: 10,
            width: 34,
            height: 34,
            border: "none",
            background: "transparent",
            color: "#64748b",
            fontSize: 22,
            cursor: "pointer",
          }}
        >
          x
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 10, paddingRight: 32, marginBottom: 12 }}>
          <span style={{ color: STRING_STATUS_COLORS[currentStatus], fontSize: 22, lineHeight: 1 }}>
            {STRING_STATUS_ICONS[currentStatus]}
          </span>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a" }}>{stringInfo.id}</div>
            <div style={{ fontSize: 12, color: "#64748b" }}>
              Row {stringInfo.row || "-"} · Panels {stringInfo.startPanelLabel || "-"} to {stringInfo.endPanelLabel || "-"}
            </div>
          </div>
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {STRING_STATUSES.map((status) => {
            const active = status === currentStatus;
            return (
              <button
                key={status}
                onClick={() => onStatusChange(status)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: active ? `2px solid ${STRING_STATUS_COLORS[status]}` : "1px solid #dbe4ee",
                  background: active ? "#f8fafc" : "#fff",
                  color: active ? "#0f172a" : "#334155",
                  fontWeight: active ? 800 : 600,
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span style={{ color: STRING_STATUS_COLORS[status], fontSize: 17, width: 20 }}>
                  {STRING_STATUS_ICONS[status]}
                </span>
                <span>{STRING_STATUS_LABELS[status]}</span>
              </button>
            );
          })}
        </div>
        <div style={{ marginTop: 14, borderTop: "1px solid #e2e8f0", paddingTop: 12 }}>
          <label style={{ display: "block", fontSize: 12, fontWeight: 800, color: "#334155", marginBottom: 6 }}>
            Comment
          </label>
          <textarea
            value={comment}
            placeholder="Add comment..."
            onChange={(e) => {
              setComment(e.target.value);
              onCommentChange(e.target.value);
            }}
            style={{
              width: "100%",
              minHeight: 84,
              resize: "vertical",
              boxSizing: "border-box",
              borderRadius: 8,
              border: "1px solid #cbd5e1",
              padding: "9px 10px",
              font: "13px Arial, sans-serif",
              color: "#0f172a",
              outline: "none",
            }}
          />
        </div>
        <div style={{ marginTop: 14, borderTop: "1px solid #e2e8f0", paddingTop: 12 }}>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "9px 12px",
              borderRadius: 8,
              border: "1px solid #cbd5e1",
              background: "#f8fafc",
              color: "#0f172a",
              fontWeight: 700,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            <span aria-hidden>▣</span>
            Add image
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => handleImageFile(e.target.files?.[0])}
              style={{ display: "none" }}
            />
          </label>
          {images.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
              {images.map((src: string, idx: number) => (
                <img
                  key={`${idx}-${src.slice(0, 24)}`}
                  src={src}
                  alt={`String ${stringInfo.id} attachment ${idx + 1}`}
                  onClick={() => setPreviewImage(src)}
                  style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: "1px solid #cbd5e1", cursor: "zoom-in" }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {previewImage && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            setPreviewImage(null);
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2600,
            background: "rgba(2,6,23,0.86)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 14,
          }}
        >
          <button
            onClick={() => setPreviewImage(null)}
            aria-label="Close image"
            style={{
              position: "fixed",
              top: 12,
              right: 12,
              width: 42,
              height: 42,
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.32)",
              background: "rgba(15,23,42,0.72)",
              color: "#fff",
              fontSize: 24,
              cursor: "pointer",
              zIndex: 2601,
            }}
          >
            x
          </button>
          <img
            src={previewImage}
            alt={`String ${stringInfo.id} attachment preview`}
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: "96vw",
              maxHeight: "92vh",
              objectFit: "contain",
              borderRadius: 10,
              boxShadow: "0 18px 60px rgba(0,0,0,0.45)",
            }}
          />
        </div>
      )}
    </div>
  );
}
