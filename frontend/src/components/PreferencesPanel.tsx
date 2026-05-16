import { useTranslation } from "react-i18next";
import {
  usePreferences,
  type ThemeId,
  type BrightnessId,
  type FontSizeId,
} from "../hooks/usePreferences";

/**
 * Sidebar-footer section with Theme / Brightness / Font-size pickers.
 * Tiny segmented controls so the whole panel still fits under the nav.
 */
export default function PreferencesPanel() {
  const { t } = useTranslation();
  const { theme, brightness, fontSize, setTheme, setBrightness, setFontSize } = usePreferences();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Label>{t("prefs.theme")}</Label>
      <Segmented<ThemeId>
        value={theme}
        options={[
          { v: "ocean", label: t("prefs.themeOcean") },
          { v: "mist",  label: t("prefs.themeMist")  },
        ]}
        onChange={setTheme}
      />
      <Label>{t("prefs.brightness")}</Label>
      <Segmented<BrightnessId>
        value={brightness}
        options={[
          { v: "light",    label: t("prefs.brLight")    },
          { v: "normal",   label: t("prefs.brNormal")   },
          { v: "dark",     label: t("prefs.brDark")     },
          { v: "contrast", label: t("prefs.brContrast") },
        ]}
        onChange={setBrightness}
      />
      <Label>{t("prefs.fontSize")}</Label>
      <Segmented<FontSizeId>
        value={fontSize}
        options={[
          { v: "small",  label: "A-" },
          { v: "normal", label: "A"  },
          { v: "large",  label: "A+" },
        ]}
        onChange={setFontSize}
      />
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase" }}>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { v: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${options.length}, 1fr)`, gap: 0, background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: 2, border: "1px solid rgba(255,255,255,0.08)" }}>
      {options.map((o) => {
        const active = o.v === value;
        return (
          <button
            key={o.v}
            onClick={() => onChange(o.v)}
            style={{
              background: active ? "rgba(255,255,255,0.16)" : "transparent",
              color: active ? "#ffffff" : "#cbd5e1",
              border: "none",
              padding: "5px 2px",
              fontSize: 10.5,
              fontWeight: active ? 700 : 500,
              borderRadius: 6,
              cursor: "pointer",
              letterSpacing: 0.2,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
