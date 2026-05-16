import { useState } from "react";
import { useTranslation } from "react-i18next";
import { login, type AuthUser } from "../api";
import LanguageSwitcher from "./LanguageSwitcher";

interface Props {
  onLoggedIn: (user: AuthUser) => void;
}

/**
 * Admin-only login screen. Defaults on a fresh install are `admin / admin123`;
 * override with `ADMIN_USER` / `ADMIN_PASS` env vars on the backend.
 */
export default function Login({ onLoggedIn }: Props) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const user = await login(username.trim(), password);
      onLoggedIn(user);
    } catch (ex: any) {
      setErr(ex?.message || t("login.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #0f172a 0%, rgb(var(--theme-header)) 100%)",
        padding: 16,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: "100%",
          maxWidth: 360,
          background: "#fff",
          borderRadius: 16,
          padding: 32,
          boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
        }}
      >
        <img
          src="/logo.png"
          alt={t("app.name")}
          style={{ display: "block", width: "100%", maxWidth: 300, height: "auto", marginBottom: 10 }}
        />
        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 20 }}>
          {t("login.subtitle")}
        </div>

        <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
          {t("login.username")}
        </label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          autoComplete="username"
          required
          style={{
            width: "100%", padding: "10px 12px", marginBottom: 14,
            border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14, outline: "none",
          }}
        />

        <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
          {t("login.password")}
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          style={{
            width: "100%", padding: "10px 12px", marginBottom: 16,
            border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14, outline: "none",
          }}
        />

        {/* Language chooser sits under the credentials so the eye goes
            username → password → language → submit. */}
        <div style={{ marginBottom: 18 }}>
          <LanguageSwitcher />
        </div>

        {err && (
          <div
            style={{
              background: "#fee2e2", color: "#b91c1c", border: "1px solid #fecaca",
              borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 14,
            }}
          >
            {err}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="btn btn-primary"
          style={{ width: "100%" }}
        >
          {busy ? t("app.signingIn") : t("app.signIn")}
        </button>

        <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 16, textAlign: "center" }}>
          © {new Date().getFullYear()} {t("login.copyright")}
        </div>
      </form>
    </div>
  );
}
