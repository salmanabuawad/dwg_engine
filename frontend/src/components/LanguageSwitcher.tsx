import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGS } from "../i18n/i18n";

/** Compact language menu — renders a <select> so it works on every
 * platform (including the iPad / Android keyboards) without extra deps. */
export default function LanguageSwitcher({ dark = false }: { dark?: boolean }) {
  const { i18n } = useTranslation();
  return (
    <select
      value={i18n.language}
      onChange={(e) => i18n.changeLanguage(e.target.value)}
      aria-label="Language"
      style={{
        width: "100%",
        padding: "6px 8px",
        borderRadius: 8,
        fontSize: 12,
        background: dark ? "rgba(255,255,255,0.08)" : "#fff",
        color: dark ? "#f1f5f9" : "#0f172a",
        border: dark ? "1px solid rgba(255,255,255,0.12)" : "1px solid #cbd5e1",
        cursor: "pointer",
      }}
    >
      {SUPPORTED_LANGS.map((l) => (
        <option key={l.code} value={l.code} style={{ color: "#0f172a", background: "#fff" }}>
          {l.flag} {l.label}
        </option>
      ))}
    </select>
  );
}
