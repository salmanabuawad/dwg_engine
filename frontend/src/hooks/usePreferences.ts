import { useEffect, useState } from "react";

export type ThemeId = "ocean" | "mist";
export type BrightnessId = "light" | "normal" | "dark" | "contrast";
export type FontSizeId = "small" | "normal" | "large";

const KEYS = {
  theme: "solarica.theme",
  brightness: "solarica.brightness",
  fontSize: "solarica.fontSize",
};

function read<T extends string>(key: string, fallback: T, valid: readonly T[]): T {
  try {
    const v = localStorage.getItem(key);
    if (v && (valid as readonly string[]).includes(v)) return v as T;
  } catch { /* ignore */ }
  return fallback;
}

function applyAttributes(theme: ThemeId, brightness: BrightnessId, fontSize: FontSizeId) {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  el.setAttribute("data-theme", theme);
  el.setAttribute("data-brightness", brightness);
  el.setAttribute("data-font-size", fontSize);
}

/**
 * Shared visual preferences: theme (ocean/mist), brightness level, font
 * size. Persists to localStorage and reflects as `data-*` attributes on
 * <html> so CSS variables can swap at runtime.
 */
export function usePreferences() {
  const [theme, setThemeState] = useState<ThemeId>(() =>
    read<ThemeId>(KEYS.theme, "ocean", ["ocean", "mist"]),
  );
  const [brightness, setBrightnessState] = useState<BrightnessId>(() =>
    read<BrightnessId>(KEYS.brightness, "normal", ["light", "normal", "dark", "contrast"]),
  );
  const [fontSize, setFontSizeState] = useState<FontSizeId>(() =>
    read<FontSizeId>(KEYS.fontSize, "normal", ["small", "normal", "large"]),
  );

  useEffect(() => { applyAttributes(theme, brightness, fontSize); }, [theme, brightness, fontSize]);

  const setTheme = (t: ThemeId) => {
    setThemeState(t);
    try { localStorage.setItem(KEYS.theme, t); } catch { /* ignore */ }
  };
  const setBrightness = (b: BrightnessId) => {
    setBrightnessState(b);
    try { localStorage.setItem(KEYS.brightness, b); } catch { /* ignore */ }
  };
  const setFontSize = (f: FontSizeId) => {
    setFontSizeState(f);
    try { localStorage.setItem(KEYS.fontSize, f); } catch { /* ignore */ }
  };

  return { theme, brightness, fontSize, setTheme, setBrightness, setFontSize };
}
