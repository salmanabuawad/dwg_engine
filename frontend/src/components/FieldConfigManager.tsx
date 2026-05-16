import { useEffect, useMemo, useState } from "react";
import { FieldConfig, listFieldConfigs, upsertFieldConfigs } from "../api";

/**
 * Admin UI for editing column preferences per grid. Mirrors the
 * buildingsmanager `field_configurations` pattern: one row per
 * (grid_name, field_name) with visibility, pinning, and order.
 *
 * Grids rendered elsewhere call `useFieldConfigs(gridName)` to read and
 * apply these values on load.
 */
export default function FieldConfigManager() {
  const [rows, setRows] = useState<FieldConfig[]>([]);
  const [dirty, setDirty] = useState<Record<string, FieldConfig>>({});
  const [selectedGrid, setSelectedGrid] = useState<string>("all");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try {
      setRows(await listFieldConfigs());
    } catch (ex: any) {
      setErr(ex?.message || String(ex));
    }
  }

  useEffect(() => { load(); }, []);

  const gridNames = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => s.add(r.grid_name));
    return Array.from(s).sort();
  }, [rows]);

  const visibleRows = useMemo(() => {
    const base = selectedGrid === "all" ? rows : rows.filter((r) => r.grid_name === selectedGrid);
    // Apply any unsaved edits on top of the server state.
    return base.map((r) => {
      const key = `${r.grid_name}|${r.field_name}`;
      return dirty[key] ? { ...r, ...dirty[key] } : r;
    });
  }, [rows, selectedGrid, dirty]);

  function patch(row: FieldConfig, changes: Partial<FieldConfig>) {
    const key = `${row.grid_name}|${row.field_name}`;
    setDirty((prev) => ({
      ...prev,
      [key]: { ...row, ...(prev[key] ?? {}), ...changes },
    }));
  }

  async function saveAll() {
    const payload = Object.values(dirty);
    if (payload.length === 0) return;
    setBusy(true); setErr(null); setSaved(null);
    try {
      const res = await upsertFieldConfigs(payload);
      setDirty({});
      await load();
      setSaved(`Saved ${res.updated} field${res.updated === 1 ? "" : "s"}.`);
      setTimeout(() => setSaved(null), 2500);
    } catch (ex: any) {
      setErr(ex?.message || String(ex));
    } finally {
      setBusy(false);
    }
  }

  const dirtyCount = Object.keys(dirty).length;

  return (
    <div style={{ padding: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a" }}>Field Configuration</div>
        <select
          value={selectedGrid}
          onChange={(e) => setSelectedGrid(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: 13 }}
        >
          <option value="all">All grids</option>
          {gridNames.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <span style={{ fontSize: 12, color: "#64748b" }}>
          {visibleRows.length} field{visibleRows.length === 1 ? "" : "s"}
          {dirtyCount > 0 && <> · <span style={{ color: "#b91c1c", fontWeight: 600 }}>{dirtyCount} unsaved</span></>}
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={saveAll}
          disabled={busy || dirtyCount === 0}
          style={{
            padding: "6px 14px", fontSize: 13, fontWeight: 600, borderRadius: 8,
            background: dirtyCount > 0 && !busy ? "#2563eb" : "#94a3b8",
            color: "#fff", border: "none",
            cursor: dirtyCount > 0 && !busy ? "pointer" : "default",
          }}
        >
          {busy ? "Saving…" : `Save${dirtyCount > 0 ? ` (${dirtyCount})` : ""}`}
        </button>
      </div>

      {err && (
        <div style={{ background: "#fee2e2", color: "#b91c1c", border: "1px solid #fecaca", padding: "8px 12px", borderRadius: 8, fontSize: 13, marginBottom: 10 }}>
          {err}
        </div>
      )}
      {saved && (
        <div style={{ background: "#dcfce7", color: "#166534", border: "1px solid #86efac", padding: "8px 12px", borderRadius: 8, fontSize: 13, marginBottom: 10 }}>
          {saved}
        </div>
      )}

      <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden", background: "#fff" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f1f5f9", color: "#334155", textAlign: "left" }}>
              <th style={th}>Grid</th>
              <th style={th}>Field</th>
              <th style={th}>Display name</th>
              <th style={{ ...th, textAlign: "center" }}>Visible</th>
              <th style={th}>Pin</th>
              <th style={{ ...th, textAlign: "right" }}>Order</th>
              <th style={{ ...th, textAlign: "right" }}>Width (px)</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => {
              const key = `${r.grid_name}|${r.field_name}`;
              const isDirty = key in dirty;
              return (
                <tr key={key} style={{ borderTop: "1px solid #f1f5f9", background: isDirty ? "#fef9c3" : undefined }}>
                  <td style={{ ...td, color: "#64748b" }}>{r.grid_name}</td>
                  <td style={{ ...td, fontFamily: "monospace" }}>{r.field_name}</td>
                  <td style={td}>
                    <input
                      type="text"
                      value={r.display_name ?? ""}
                      placeholder={r.field_name}
                      onChange={(e) => patch(r, { display_name: e.target.value || null })}
                      style={inp}
                    />
                  </td>
                  <td style={{ ...td, textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={!!r.visible}
                      onChange={(e) => patch(r, { visible: e.target.checked })}
                    />
                  </td>
                  <td style={td}>
                    <select
                      value={r.pin_side ?? ""}
                      onChange={(e) => patch(r, { pin_side: (e.target.value || null) as any })}
                      style={{ ...inp, width: 110 }}
                    >
                      <option value="">—</option>
                      <option value="left">Left</option>
                      <option value="right">Right</option>
                    </select>
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <input
                      type="number"
                      value={r.column_order ?? ""}
                      onChange={(e) => patch(r, { column_order: e.target.value === "" ? null : Number(e.target.value) })}
                      style={{ ...inp, width: 70, textAlign: "right" }}
                    />
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <input
                      type="number"
                      min={30}
                      max={600}
                      step={4}
                      value={r.width ?? ""}
                      placeholder="auto"
                      title="Column width in pixels (30–600). Leave blank for auto."
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw === "") { patch(r, { width: null }); return; }
                        // Clamp to [30, 600] so an accidental keypress
                        // (e.g. typing 2 → 20) can't collapse a column
                        // to a sliver. Empty stays as null = auto.
                        const n = Number(raw);
                        if (!Number.isFinite(n)) return;
                        patch(r, { width: Math.max(30, Math.min(600, Math.round(n))) });
                      }}
                      style={{ ...inp, width: 80, textAlign: "right" }}
                    />
                  </td>
                </tr>
              );
            })}
            {visibleRows.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: 24, textAlign: "center", color: "#64748b" }}>
                  No field configurations found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: "10px 12px", fontWeight: 700, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.05 };
const td: React.CSSProperties = { padding: "8px 12px", verticalAlign: "middle" };
const inp: React.CSSProperties = { width: "100%", padding: "5px 8px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 13, outline: "none" };
