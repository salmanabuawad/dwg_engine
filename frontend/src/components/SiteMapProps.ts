export interface SiteMapProps {
  imageWidth: number;
  imageHeight: number;
  /** Public PNG render of the source drawing page, used as map substrate. */
  mapImageUrl?: string;
  blocks: any[];
  trackers: any[];
  piers: any[];
  /** DCCB devices extracted by the security module (`{type, name, x, y}`). */
  dccbs?: any[];
  /** Inverter devices extracted by the security module (`{type, name, x, y}`). */
  inverters?: any[];
  /** Electrical string-zone labels from the EPL parser. */
  electricalZones?: any[];
  /** Physical row-number markers derived from electrical zones. */
  electricalRows?: any[];
  /** Panel-plan vector base rows extracted from BHK E_41 gray linework. */
  panelBaseRows?: any[];
  /** Canonical string endpoint/panel-pair detail from the electrical PDF. */
  stringDetail?: any;
  /** Site border sketched from panel row endpoints. */
  siteBorder?: any[];
  /** Optional EPL camera/security assets, already filtered by enabled features. */
  securityDevices?: any[];
  /** Optional EPL weather stations and sensor assets, already filtered by enabled features. */
  weatherAssets?: any[];
  pierStatuses?: Record<string, string>;
  /** Per-electrical-string status keyed by full string id. */
  stringStatuses?: Record<string, string>;
  /** Per-electrical-string image attachments as data URLs. */
  stringImages?: Record<string, string[]>;
  /** Per-electrical-string inspector comment. */
  stringComments?: Record<string, string>;
  selectedBlock: any;
  selectedTracker: any;
  selectedPier: any;
  layers: { key: string; visible: boolean }[];
  onBlockClick: (b: any) => void;
  onTrackerClick: (t: any) => void;
  onPierClick: (p: any) => void;
  onStringStatusChange?: (stringId: string, status: string) => void;
  onStringImageAdd?: (stringId: string, file: File) => void;
  onStringCommentChange?: (stringId: string, comment: string) => void;
  /** Called when the user finishes a box/touch area selection. */
  onAreaSelect?: (piers: any[]) => void;
  /** Shared bulk selection — pier codes currently selected in either view. */
  bulkSelectedPierCodes?: Set<string>;
  /** Pier-code labels show only when the number of visible piers is ≤ this. */
  pierLabelThreshold?: number;
  /** Full detail cards show only when the number of visible piers is ≤ this. */
  pierDetailThreshold?: number;
  /**
   * How to encode pier *status* on the map dot:
   *   - "icon" : dot stays pier_type-coloured, status shown as icon (default)
   *   - "color": dot fills with the status colour, no icon
   *   - "both" : both — coloured dot AND icon overlay
   */
  pierStatusDisplay?: "icon" | "color" | "both";
  /** Show every Nth row/tracker label when more than denseThreshold are in view. */
  mapLabelStride?: number;
  /** When ≤ this many row/tracker labels are visible, render them all. */
  mapLabelDenseThreshold?: number;
}

/** Fill colours for the five pier types. */
export const PIER_COLORS: Record<string, string> = {
  HAP: "#ff0000",
  HMP: "#ff0000",
  SAP: "#00ffff",
  SAPE: "#0000ff",
  SAPEND: "#ff8c00",
  SMP: "#00ff00",
  UNKNOWN: "#64748b",
};

/** Status ring colors, matching PierModal and SimpleGrid. */
export const STATUS_COLORS: Record<string, string> = {
  "New": "",                      // no ring
  "In Progress": "#eab308",       // yellow
  "Implemented": "#10b981",       // light green
  "Approved": "#16a34a",          // green
  "Rejected": "#ef4444",          // red
  "Fixed": "#2563eb",             // blue
};

/**
 * Rotate the PDF-space point 90° counter-clockwise so the rendered map reads
 * the same way as the construction drawings.
 *   raw (x, y)  →  rotated (y, imageWidth - x)
 */
export function rotate90CCW(x: number, y: number, imageWidth: number): [number, number] {
  return [y, imageWidth - x];
}

export function layerVisible(
  layers: { key: string; visible: boolean }[],
  key: string,
  fallback = true,
): boolean {
  return layers.find((l) => l.key === key)?.visible ?? fallback;
}
