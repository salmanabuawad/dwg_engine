import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  getCurrentUser,
  type UserRow,
} from "../api";

type Role = "admin" | "editor" | "viewer" | "electric";

export default function UsersManager() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<{ username: string; password: string; display_name: string; role: Role }>({
    username: "", password: "", display_name: "", role: "viewer",
  });
  const [passwordEdits, setPasswordEdits] = useState<Record<number, string>>({});

  const me = getCurrentUser();

  async function load() {
    setErr(null);
    try { setRows(await listUsers()); } catch (ex: any) { setErr(ex?.message || String(ex)); }
  }
  useEffect(() => { load(); }, []);

  async function onCreate() {
    if (!draft.username.trim() || !draft.password) {
      setErr(t("users.requiredFields", "Username and password are required"));
      return;
    }
    setBusy(true); setErr(null);
    try {
      await createUser({ username: draft.username.trim(), password: draft.password, display_name: draft.display_name || undefined, role: draft.role });
      setDraft({ username: "", password: "", display_name: "", role: "viewer" });
      setCreating(false);
      await load();
      flashMsg(t("users.created", "User created"));
    } catch (ex: any) { setErr(ex?.message || String(ex)); } finally { setBusy(false); }
  }

  async function onToggleActive(u: UserRow) {
    setBusy(true); setErr(null);
    try { await updateUser(u.id, { is_active: !u.is_active }); await load(); }
    catch (ex: any) { setErr(ex?.message || String(ex)); } finally { setBusy(false); }
  }

  async function onChangeRole(u: UserRow, role: Role) {
    setBusy(true); setErr(null);
    try { await updateUser(u.id, { role }); await load(); }
    catch (ex: any) { setErr(ex?.message || String(ex)); } finally { setBusy(false); }
  }

  async function onSavePassword(u: UserRow) {
    const pw = passwordEdits[u.id]?.trim();
    if (!pw) return;
    setBusy(true); setErr(null);
    try {
      await updateUser(u.id, { password: pw });
      setPasswordEdits(({ [u.id]: _drop, ...rest }) => rest);
      flashMsg(t("users.pwUpdated", "Password updated"));
    } catch (ex: any) { setErr(ex?.message || String(ex)); } finally { setBusy(false); }
  }

  async function onDelete(u: UserRow) {
    if (!confirm(t("users.confirmDelete", "Delete user '{{name}}'?", { name: u.username }))) return;
    setBusy(true); setErr(null);
    try { await deleteUser(u.id); await load(); }
    catch (ex: any) { setErr(ex?.message || String(ex)); } finally { setBusy(false); }
  }

  function flashMsg(text: string) { setMsg(text); setTimeout(() => setMsg(null), 2200); }

  return (
    <div style={{ padding: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a" }}>{t("users.title", "Users")}</div>
        <span style={{ fontSize: 12, color: "#64748b" }}>{rows.length} {rows.length === 1 ? t("users.oneUser","user") : t("users.manyUsers","users")}</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setCreating((v) => !v)}
          className="btn btn-primary btn-md"
          style={{ fontSize: 13 }}
        >{creating ? t("app.cancel") : `+ ${t("users.new", "New user")}`}</button>
      </div>

      {err && <div style={errBox}>{err}</div>}
      {msg && <div style={okBox}>{msg}</div>}

      {creating && (
        <div style={cardBox}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t("users.new", "New user")}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
            <Labeled label={t("login.username")}><input style={inp} value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} autoFocus /></Labeled>
            <Labeled label={t("login.password")}><input style={inp} type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} /></Labeled>
            <Labeled label={t("users.displayName", "Display name")}><input style={inp} value={draft.display_name} onChange={(e) => setDraft({ ...draft, display_name: e.target.value })} /></Labeled>
            <Labeled label={t("users.role", "Role")}>
              <select style={inp} value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as Role })}>
                <option value="viewer">viewer</option>
                <option value="electric">electric</option>
                <option value="editor">editor</option>
                <option value="admin">admin</option>
              </select>
            </Labeled>
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <button onClick={onCreate} disabled={busy} className="btn btn-primary btn-sm">{t("app.create")}</button>
            <button onClick={() => setCreating(false)} className="btn btn-cancel btn-sm">{t("app.cancel")}</button>
          </div>
        </div>
      )}

      <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden", background: "#fff" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f1f5f9", color: "#334155", textAlign: "left" }}>
              <th style={th}>{t("login.username")}</th>
              <th style={th}>{t("users.displayName", "Display name")}</th>
              <th style={th}>{t("users.role", "Role")}</th>
              <th style={{ ...th, textAlign: "center" }}>{t("users.active", "Active")}</th>
              <th style={th}>{t("users.setPassword", "Set password")}</th>
              <th style={{ ...th, textAlign: "right" }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => {
              const isMe = me?.username === u.username;
              return (
                <tr key={u.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <td style={td}>
                    <div style={{ fontWeight: 600, color: "#0f172a", fontFamily: "monospace" }}>{u.username}</div>
                    {isMe && <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>{t("users.you", "you")}</div>}
                  </td>
                  <td style={td}>{u.display_name || "—"}</td>
                  <td style={td}>
                    <select style={{ ...inp, width: 110 }} value={u.role} onChange={(e) => onChangeRole(u, e.target.value as Role)} disabled={busy || isMe}>
                      <option value="viewer">viewer</option>
                      <option value="electric">electric</option>
                      <option value="editor">editor</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td style={{ ...td, textAlign: "center" }}>
                    <input type="checkbox" checked={u.is_active} onChange={() => onToggleActive(u)} disabled={busy || isMe} />
                  </td>
                  <td style={td}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        type="password"
                        placeholder="••••••"
                        style={{ ...inp, width: 140 }}
                        value={passwordEdits[u.id] ?? ""}
                        onChange={(e) => setPasswordEdits({ ...passwordEdits, [u.id]: e.target.value })}
                      />
                      <button
                        onClick={() => onSavePassword(u)}
                        disabled={!passwordEdits[u.id] || busy}
                        className="btn btn-secondary btn-sm"
                      >{t("app.save")}</button>
                    </div>
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button
                      onClick={() => onDelete(u)}
                      disabled={busy || isMe}
                      className="btn btn-danger btn-sm"
                      title={isMe ? t("users.noDeleteSelf", "You can't delete your own account") : ""}
                    >{t("app.delete")}</button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 24, textAlign: "center", color: "#64748b" }}>{t("users.none", "No users.")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "#64748b", fontWeight: 600 }}>{label}{children}</label>;
}

const th: React.CSSProperties = { padding: "10px 12px", fontWeight: 700, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.05 };
const td: React.CSSProperties = { padding: "8px 12px", verticalAlign: "middle" };
const inp: React.CSSProperties = { width: "100%", padding: "5px 8px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 13, outline: "none", background: "#fff" };
const errBox: React.CSSProperties = { background: "#fee2e2", color: "#b91c1c", border: "1px solid #fecaca", padding: "8px 12px", borderRadius: 8, fontSize: 13, marginBottom: 10 };
const okBox: React.CSSProperties = { background: "#dcfce7", color: "#166534", border: "1px solid #86efac", padding: "8px 12px", borderRadius: 8, fontSize: 13, marginBottom: 10 };
const cardBox: React.CSSProperties = { border: "1px solid #e2e8f0", borderRadius: 12, padding: 14, marginBottom: 14, background: "#fff" };
