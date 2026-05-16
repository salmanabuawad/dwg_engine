import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { apiBase, getAuthToken } from "../api";

interface Props {
  projectId: string;
  pierCode: string;
  newStatus: string;
  /** Called with the created event when the server accepts the submission. */
  onSubmitted: () => void;
  onCancel: () => void;
}

/**
 * Shown when an inspector flips a pier to a status that requires a reason
 * — currently `Rejected`.  Captures a description + one or more photos or
 * a short video.  The backend route stores the event (who / when / what)
 * AND updates the pier's current status atomically, so the grid's
 * optimistic update still lines up.
 */
export default function StatusChangeModal({
  projectId, pierCode, newStatus, onSubmitted, onCancel,
}: Props) {
  const { t } = useTranslation();
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const required = newStatus === "Rejected";

  function pickFiles(ev: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(ev.target.files || []);
    setFiles((prev) => [...prev, ...list]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }
  function removeFile(i: number) {
    setFiles((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function submit() {
    if (required && !description.trim()) {
      setErr(t("statusEvent.descRequired"));
      return;
    }
    setErr(null); setBusy(true);
    try {
      const fd = new FormData();
      fd.append("status", newStatus);
      fd.append("description", description);
      for (const f of files) fd.append("files", f);
      const token = getAuthToken();
      const r = await fetch(
        `${apiBase()}/api/projects/${projectId}/pier/${encodeURIComponent(pierCode)}/status-event`,
        {
          method: "POST",
          body: fd,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
      );
      if (!r.ok) {
        const text = await r.text();
        throw new Error(text || `HTTP ${r.status}`);
      }
      onSubmitted();
    } catch (ex: any) {
      setErr(ex?.message || String(ex));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onCancel}
      style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(15,23,42,0.55)",
               display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(560px, 100%)", background: "#fff", borderRadius: 14,
                 padding: "20px 22px", boxShadow: "0 24px 56px rgba(0,0,0,0.35)" }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", marginBottom: 4 }}>
          {t("statusEvent.title", { status: t(`status.${newStatus.replace(/\s+/g, "")}`, newStatus) })}
        </div>
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 14 }}>
          {t("column.pier")}: <span style={{ fontFamily: "monospace" }}>{pierCode}</span>
        </div>

        <label className="label-base">
          {t("statusEvent.description")}{required && <span style={{ color: "#dc2626" }}> *</span>}
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("statusEvent.descriptionPH")}
          rows={4}
          autoFocus
          style={{ width: "100%", padding: "8px 10px", fontSize: 13, borderRadius: 8,
                   border: "1px solid #cbd5e1", outline: "none", marginBottom: 12, resize: "vertical" }}
        />

        <label className="label-base">{t("statusEvent.attachments")}</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,video/*"
            onChange={pickFiles}
            style={{ fontSize: 12 }}
          />
          {files.length > 0 && (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 3 }}>
              {files.map((f, i) => (
                <li key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#334155" }}>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {f.type.startsWith("video/") ? "🎬" : "🖼"} {f.name} <span style={{ color: "#94a3b8" }}>({(f.size / (1024 * 1024)).toFixed(1)} MB)</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removeFile(i)}
                    style={{ background: "transparent", border: "none", color: "#dc2626", cursor: "pointer", fontSize: 12 }}
                  >{t("app.delete")}</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {err && (
          <div style={{ background: "#fee2e2", color: "#b91c1c", border: "1px solid #fecaca",
                        padding: "8px 12px", borderRadius: 8, fontSize: 13, marginBottom: 10 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button onClick={onCancel} className="btn btn-cancel btn-sm">{t("app.cancel")}</button>
          <button onClick={submit} disabled={busy || (required && !description.trim())} className="btn btn-primary btn-sm">
            {busy ? t("app.saving") : t("app.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
