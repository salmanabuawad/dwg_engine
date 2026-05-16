import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import LanguageSwitcher from "./LanguageSwitcher";
import PreferencesPanel from "./PreferencesPanel";
import { getCurrentUser, logout } from "../api";

/**
 * App settings popup. Groups the Language picker + the theme / brightness
 * / font-size controls. Rendered from the gear icon in the top bar so
 * the settings are reachable on mobile where the sidebar is collapsed.
 */
export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 100,
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "80px 16px 16px",
        background: "rgba(15,23,42,0.55)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(420px, 100%)",
          background: "#0f172a",
          color: "#e2e8f0",
          borderRadius: 16,
          padding: "18px 20px 22px",
          boxShadow: "0 24px 56px rgba(0,0,0,0.45)",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#f1f5f9" }}>
            {t("settings.title", "Settings")}
          </div>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            aria-label={t("app.cancel")}
            style={{ background: "transparent", border: "none", color: "#94a3b8", fontSize: 22, cursor: "pointer", lineHeight: 1, padding: "0 4px" }}
          >×</button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {(() => {
            const me = getCurrentUser();
            return me ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 10, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                <span style={{ width: 32, height: 32, borderRadius: "50%", background: "#0f2942", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700, textTransform: "uppercase" }}>
                  {me.username.charAt(0)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: "#f1f5f9", fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{me.username}</div>
                  <div style={{ color: "#64748b", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>{me.role}</div>
                </div>
                <button
                  onClick={logout}
                  style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.14)", color: "#cbd5e1", padding: "4px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer" }}
                >{t("app.signOut")}</button>
              </div>
            ) : null;
          })()}
          <div>
            <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 4 }}>
              {t("settings.language", "Language")}
            </div>
            <LanguageSwitcher dark />
          </div>
          <PreferencesPanel />
        </div>
      </div>
    </div>
  );
}
