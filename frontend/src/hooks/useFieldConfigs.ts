import { useEffect, useState } from "react";
import { FieldConfig, listFieldConfigs } from "../api";

/** Per-grid column preferences, keyed by field_name. */
export type FieldConfigMap = Record<string, FieldConfig>;

/**
 * Fetch the field configuration for a single grid and expose a lookup map
 * keyed by field_name.  Returns `null` while loading so grids can render
 * their fallback column defs instead of flashing an unconfigured layout.
 */
export function useFieldConfigs(gridName: string | null | undefined): FieldConfigMap | null {
  const [map, setMap] = useState<FieldConfigMap | null>(null);

  useEffect(() => {
    if (!gridName) { setMap({}); return; }
    let cancelled = false;
    listFieldConfigs(gridName)
      .then((rows) => {
        if (cancelled) return;
        const m: FieldConfigMap = {};
        for (const r of rows) m[r.field_name] = r;
        setMap(m);
      })
      .catch(() => {
        if (cancelled) return;
        // Non-fatal — grids fall back to their hardcoded defaults.
        setMap({});
      });
    return () => { cancelled = true; };
  }, [gridName]);

  return map;
}

/**
 * Apply a FieldConfigMap to a flat array of ag-grid column defs.
 *  - Drops columns whose config says visible = false.
 *  - Rewrites headerName if a display_name was set.
 *  - Applies pin_side → pinned ("left" | "right" | null).
 *  - Applies width.
 *  - Sorts by column_order (columns with no explicit order keep their
 *    relative position at the end).
 *
 * Accepts ColGroupDef trees (with `children`) and applies per-leaf.
 */
export function applyFieldConfigs(
  cols: any[],
  configs: FieldConfigMap | null,
  widthMultiplier: number = 1,
): any[] {
  if (!configs || Object.keys(configs).length === 0) return cols;

  const transform = (col: any): any | null => {
    if (col.children) {
      const kids = col.children.map(transform).filter(Boolean);
      if (kids.length === 0) return null;
      return { ...col, children: kids };
    }
    const cfg = configs[col.field];
    if (!cfg) return col;
    if (cfg.visible === false) return null;
    const merged: any = { ...col };
    if (cfg.display_name) merged.headerName = cfg.display_name;
    if (cfg.pin_side) merged.pinned = cfg.pin_side;
    else if (cfg.pin_side === null && col.pinned) merged.pinned = undefined;
    if (cfg.width != null) {
      // Scale the configured width by the multiplier (used on mobile
      // to render columns at e.g. 70 % of the desktop width). Floored
      // at 30 px so a small multiplier can't collapse a column.
      const scaled = Math.max(30, Math.round(cfg.width * widthMultiplier));
      merged.width = scaled;
      merged.minWidth = Math.min(col.minWidth ?? 60, scaled);
    }
    // ag-grid rejects custom top-level props; stash our order in `context`.
    merged.context = { ...(col.context || {}), fc_order: cfg.column_order ?? Number.POSITIVE_INFINITY };
    return merged;
  };

  const processed = cols.map(transform).filter(Boolean);

  // Sort leaves & group children by fc_order. Groups sort by the min
  // fc_order of their children so you can reorder whole bands too.
  const minOrder = (node: any): number => {
    if (node.children) {
      const v = node.children.map(minOrder);
      return Math.min(...v);
    }
    return (node.context?.fc_order) ?? Number.POSITIVE_INFINITY;
  };
  const sortTree = (node: any): any => {
    if (!node.children) return node;
    const kids = node.children.slice().sort((a: any, b: any) => minOrder(a) - minOrder(b)).map(sortTree);
    return { ...node, children: kids };
  };
  return processed.slice().sort((a: any, b: any) => minOrder(a) - minOrder(b)).map(sortTree);
}
