/**
 * Tiny wrapper around localStorage for per-user preferences. Every getter
 * is safe to call during SSR / before the DOM is ready (returns the default
 * if window is undefined).
 */

const KEYS = {
  pierLabelThreshold: "solarica.pierLabelThreshold",
  pierDetailThreshold: "solarica.pierDetailThreshold",
  pierStatusDisplay: "solarica.pierStatusDisplay",
  // When the map shows row + tracker labels, only render every Nth
  // when there are too many in the viewport — otherwise the chips
  // overlap into a single illegible blur.
  mapLabelStride: "solarica.mapLabelStride",
  // ...unless the visible count is small enough to fit comfortably.
  mapLabelDenseThreshold: "solarica.mapLabelDenseThreshold",
  // Per-layer visibility — persists the on/off state of each layer
  // checkbox across sessions so toggles aren't lost on refresh.
  layerVisibility: "solarica.layerVisibility",
} as const;

export type PierStatusDisplay = "color" | "icon" | "both";

const DEFAULTS = {
  pierLabelThreshold: 25,
  pierDetailThreshold: 4,
  pierStatusDisplay: "icon" as PierStatusDisplay,
  mapLabelStride: 10,
  mapLabelDenseThreshold: 20,
};

function readNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function writeNumber(key: string, value: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // ignore quota errors
  }
}

function readEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (raw && (allowed as readonly string[]).includes(raw)) return raw as T;
  return fallback;
}

function writeString(key: string, value: string) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(key, value); } catch { /* ignore quota */ }
}

const PIER_STATUS_DISPLAY_VALUES = ["color", "icon", "both"] as const;

export const userPrefs = {
  getPierLabelThreshold: () => readNumber(KEYS.pierLabelThreshold, DEFAULTS.pierLabelThreshold),
  setPierLabelThreshold: (v: number) => writeNumber(KEYS.pierLabelThreshold, v),
  getPierDetailThreshold: () => readNumber(KEYS.pierDetailThreshold, DEFAULTS.pierDetailThreshold),
  setPierDetailThreshold: (v: number) => writeNumber(KEYS.pierDetailThreshold, v),
  getPierStatusDisplay: (): PierStatusDisplay =>
    readEnum<PierStatusDisplay>(KEYS.pierStatusDisplay, PIER_STATUS_DISPLAY_VALUES, DEFAULTS.pierStatusDisplay),
  setPierStatusDisplay: (v: PierStatusDisplay) => writeString(KEYS.pierStatusDisplay, v),
  getMapLabelStride: () => readNumber(KEYS.mapLabelStride, DEFAULTS.mapLabelStride),
  setMapLabelStride: (v: number) => writeNumber(KEYS.mapLabelStride, v),
  getMapLabelDenseThreshold: () => readNumber(KEYS.mapLabelDenseThreshold, DEFAULTS.mapLabelDenseThreshold),
  setMapLabelDenseThreshold: (v: number) => writeNumber(KEYS.mapLabelDenseThreshold, v),
  getLayerVisibility: (): Record<string, boolean> => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(KEYS.layerVisibility);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch { return {}; }
  },
  setLayerVisibility: (m: Record<string, boolean>) => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(KEYS.layerVisibility, JSON.stringify(m)); } catch { /* quota */ }
  },
};
