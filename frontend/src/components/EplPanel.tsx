import { CSSProperties, ReactNode, useMemo, useState } from "react";
import { featureLabel } from "../eplFeatures";

interface Props {
  projectId: string;
  model: any;
  features: any;
  mapData: any;
  loading?: boolean;
  onRefresh: () => void;
  onDownload: () => void;
}

const layerColors: Record<string, string> = {
  physical_rows: "#475569",
  string_zones: "#06b6d4",
  strings: "#2563eb",
  optimizers: "#8b5cf6",
  modules: "#64748b",
  inverters: "#f59e0b",
  icb: "#ea580c",
  dccb: "#dc2626",
  bess: "#16a34a",
  pcs: "#0f766e",
  cable_trenches: "#7c2d12",
  communication_assets: "#9333ea",
  grounding_assets: "#78716c",
  tracker_assets: "#334155",
  floating_assets: "#0284c7",
  security_devices: "#e11d48",
  weather_assets: "#65a30d",
};

export default function EplPanel({ projectId, model, features, mapData, loading, onRefresh, onDownload }: Props) {
  const [visibleLayers, setVisibleLayers] = useState<Record<string, boolean>>({});
  const documents = Array.isArray(model?.documents) ? model.documents : [];
  const assets = Array.isArray(model?.assets) ? model.assets : [];
  const validations = Array.isArray(model?.validations) ? model.validations : [];
  const globalCounts = model?.global_counts || {};
  const countsByFolder = model?.counts_by_project_folder || {};
  const projectFolders = model?.project_folders || {};
  const layers = mapData?.layers || {};
  const optionalWarnings = validations.filter((v: any) =>
    v?.severity === "warning" && ["cameras", "security_devices", "weather_station", "weather_sensors"].includes(v?.feature),
  );

  const layerNames = Object.keys(layers).sort();
  const enabledFeatures = features?.enabled_features || {};
  const required = Object.entries(enabledFeatures).filter(([, state]) => state === "required").map(([feature]) => feature);
  const optional = Object.entries(enabledFeatures).filter(([, state]) => state === "optional").map(([feature]) => feature);

  const visible = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const layer of layerNames) out[layer] = visibleLayers[layer] ?? true;
    return out;
  }, [layerNames, visibleLayers]);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a" }}>EPL Deepsearch</div>
          <div style={{ fontSize: 12, color: "#64748b" }}>{projectId} design package extraction, validations, and exports</div>
        </div>
        <span style={{ flex: 1 }} />
        <button onClick={onRefresh} disabled={loading} style={buttonStyle("#fff", "#0f172a", "#cbd5e1")}>Refresh</button>
        <button onClick={onDownload} disabled={loading || !model} style={buttonStyle("#0f172a", "#fff", "#0f172a")}>Download exports</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <Metric label="Documents" value={model?.documents_processed} />
        <Metric label="Text blocks" value={model?.blocks_scanned} />
        <Metric label="Assets" value={assets.length} />
        <Metric label="Issues" value={validations.length} tone={validations.some((v: any) => v?.severity === "error") ? "bad" : validations.length ? "warn" : "ok"} />
      </div>

      {!model && (
        <Panel>
          <div style={{ color: "#64748b", fontSize: 13 }}>{loading ? "Loading EPL model..." : "No EPL model loaded yet."}</div>
        </Panel>
      )}

      {model && (
        <>
          {(model.parse_stopped || model.epl_blocked) && (
            <Panel>
              <div style={{ color: model.parse_stopped ? "#991b1b" : "#92400e", background: model.parse_stopped ? "#fef2f2" : "#fffbeb", border: `1px solid ${model.parse_stopped ? "#fecaca" : "#fde68a"}`, borderRadius: 8, padding: "9px 10px", fontSize: 13, fontWeight: 700 }}>
                {model.stop_message || `${(model.blocking_errors || []).length} blocking EPL validation issue${(model.blocking_errors || []).length === 1 ? "" : "s"} found.`}
              </div>
            </Panel>
          )}

          <Panel title="Feature Preset">
            <FeatureLine title="Required" items={required} tone="#0f172a" />
            <FeatureLine title="Optional" items={optional} tone="#0369a1" />
          </Panel>

          <Panel title="Project Candidates">
            <Table
              columns={["Folder", "Type guess", "Confidence", "Documents", "Notes"]}
              rows={Object.entries(projectFolders).map(([folder, info]: [string, any]) => [
                folder,
                info?.project_type_guess,
                badge(info?.confidence),
                info?.document_count,
                info?.site_metadata?.notes || "",
              ])}
            />
          </Panel>

          <Panel title="EPL Map">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              {layerNames.length === 0 && <span style={{ fontSize: 12, color: "#64748b" }}>No coordinate-backed enabled EPL layers.</span>}
              {layerNames.map((layer) => (
                <label key={layer} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "#334155" }}>
                  <input
                    type="checkbox"
                    checked={visible[layer]}
                    onChange={(e) => setVisibleLayers((prev) => ({ ...prev, [layer]: e.target.checked }))}
                  />
                  <span style={{ width: 9, height: 9, borderRadius: 9, background: layerColors[layer] || "#64748b" }} />
                  {layer.replace(/_/g, " ")} ({(layers[layer] || []).length})
                </label>
              ))}
            </div>
            <EplMapPreview layers={layers} visible={visible} />
          </Panel>

          <Panel title="Asset Counts">
            <CountGrid counts={globalCounts} />
          </Panel>

          <Panel title="Counts By Project Folder">
            <Table
              columns={["Folder", "Asset type", "Count"]}
              rows={Object.entries(countsByFolder).flatMap(([folder, counts]: [string, any]) =>
                Object.entries(counts || {}).sort().map(([type, count]) => [folder, type, count]),
              )}
              maxRows={120}
            />
          </Panel>

          {optionalWarnings.length > 0 && (
            <Panel title="Optional Asset Warnings">
              <IssueList issues={optionalWarnings} />
            </Panel>
          )}

          <Panel title="Validation Issues">
            {validations.length ? <IssueList issues={validations} /> : <div style={{ fontSize: 13, color: "#15803d", fontWeight: 700 }}>No EPL validation issues.</div>}
          </Panel>

          <Panel title="Documents">
            <Table
              columns={["Source file", "Folder", "Type", "Document", "Counts"]}
              rows={documents.map((doc: any) => [
                doc.source_file,
                doc.project_folder,
                doc.project_type_guess,
                doc.document_type_guess,
                shortCounts(doc.counts),
              ])}
              maxRows={80}
            />
          </Panel>
        </>
      )}
    </div>
  );
}

function EplMapPreview({ layers, visible }: { layers: Record<string, any[]>; visible: Record<string, boolean> }) {
  const points = Object.entries(layers).flatMap(([layer, items]) =>
    visible[layer] ? (items || []).map((asset: any) => ({ layer, x: Number(asset.x), y: Number(asset.y), label: asset.raw_label })) : [],
  ).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!points.length) {
    return <div style={{ height: 280, border: "1px solid #e2e8f0", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", fontSize: 13 }}>No visible EPL coordinates.</div>;
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const sample = points.length > 1600 ? points.filter((_, i) => i % Math.ceil(points.length / 1600) === 0) : points;
  return (
    <svg viewBox="0 0 1000 420" role="img" aria-label="EPL map preview" style={{ display: "block", width: "100%", height: 360, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8 }}>
      <rect x="0" y="0" width="1000" height="420" fill="#f8fafc" />
      {sample.map((p, i) => {
        const x = 24 + ((p.x - minX) / w) * 952;
        const y = 24 + ((p.y - minY) / h) * 372;
        return <circle key={`${p.layer}-${i}`} cx={x} cy={y} r={p.layer === "string_zones" ? 3.2 : 2.4} fill={layerColors[p.layer] || "#64748b"} opacity={0.82} />;
      })}
    </svg>
  );
}

function Metric({ label, value, tone }: { label: string; value: any; tone?: "ok" | "warn" | "bad" }) {
  const color = tone === "bad" ? "#dc2626" : tone === "warn" ? "#b45309" : tone === "ok" ? "#15803d" : "#0f172a";
  return (
    <div style={{ border: "1px solid #e2e8f0", background: "#fff", borderRadius: 8, padding: "10px 12px" }}>
      <div style={{ fontSize: 11, color: "#64748b", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 20, color, fontWeight: 800, marginTop: 4 }}>{formatValue(value)}</div>
    </div>
  );
}

function Panel({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section style={{ border: "1px solid #e2e8f0", borderRadius: 8, background: "#fff", padding: 12 }}>
      {title && <div style={{ fontSize: 12, fontWeight: 800, color: "#475569", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>{title}</div>}
      {children}
    </section>
  );
}

function CountGrid({ counts }: { counts: Record<string, any> }) {
  const entries = Object.entries(counts || {}).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
      {entries.map(([key, value]) => (
        <div key={key} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 10px", background: "#f8fafc" }}>
          <div style={{ fontSize: 11, color: "#64748b" }}>{key}</div>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#0f172a" }}>{formatValue(value)}</div>
        </div>
      ))}
    </div>
  );
}

function Table({ columns, rows, maxRows = 60 }: { columns: string[]; rows: any[][]; maxRows?: number }) {
  const visibleRows = rows.slice(0, maxRows);
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>{columns.map((col) => <th key={col} style={thStyle}>{col}</th>)}</tr>
        </thead>
        <tbody>
          {visibleRows.map((row, i) => (
            <tr key={i}>{row.map((cell, ci) => <td key={ci} style={tdStyle}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {rows.length > maxRows && <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>Showing {maxRows.toLocaleString()} of {rows.length.toLocaleString()} rows.</div>}
    </div>
  );
}

function IssueList({ issues }: { issues: any[] }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {issues.slice(0, 120).map((issue, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "90px 140px 1fr", gap: 8, alignItems: "start", fontSize: 12, borderBottom: "1px solid #f1f5f9", paddingBottom: 6 }}>
          <span>{badge(issue.severity)}</span>
          <span style={{ color: "#475569", fontWeight: 700 }}>{featureLabel(issue.feature || "")}</span>
          <span style={{ color: "#334155" }}>{issue.project_folder ? `${issue.project_folder}: ` : ""}{issue.message}</span>
        </div>
      ))}
      {issues.length > 120 && <div style={{ fontSize: 11, color: "#64748b" }}>Showing 120 of {issues.length.toLocaleString()} issues.</div>}
    </div>
  );
}

function FeatureLine({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
      <span style={{ minWidth: 70, fontSize: 12, fontWeight: 800, color: tone }}>{title}</span>
      {items.length ? items.map((item) => <span key={item} style={{ fontSize: 12, border: "1px solid #e2e8f0", borderRadius: 999, padding: "3px 8px", background: "#f8fafc" }}>{featureLabel(item)}</span>) : <span style={{ fontSize: 12, color: "#64748b" }}>None</span>}
    </div>
  );
}

function badge(value: any) {
  const text = String(value || "-");
  const color = text === "error" || text === "low" ? "#991b1b" : text === "warning" || text === "medium" ? "#92400e" : "#166534";
  const bg = text === "error" || text === "low" ? "#fef2f2" : text === "warning" || text === "medium" ? "#fffbeb" : "#f0fdf4";
  return <span style={{ display: "inline-flex", borderRadius: 999, padding: "2px 7px", background: bg, color, fontSize: 11, fontWeight: 800 }}>{text}</span>;
}

function shortCounts(counts: Record<string, any>) {
  return Object.entries(counts || {}).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(", ");
}

function formatValue(value: any) {
  return typeof value === "number" ? value.toLocaleString() : value ?? "-";
}

function buttonStyle(background: string, color: string, border: string): CSSProperties {
  return { border: `1px solid ${border}`, background, color, borderRadius: 8, padding: "8px 12px", fontWeight: 700, cursor: "pointer" };
}

const thStyle: CSSProperties = { textAlign: "left", color: "#475569", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", padding: "7px 8px", whiteSpace: "nowrap" };
const tdStyle: CSSProperties = { borderBottom: "1px solid #f1f5f9", padding: "7px 8px", color: "#334155", verticalAlign: "top" };
