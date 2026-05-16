import { useResponsive } from "../hooks/useResponsive";

const PIER_COLORS: Record<string, string> = {
  HAP: "#ff0000",
  HMP: "#ff0000",
  SAP: "#00ffff",
  SAPE: "#0000ff",
  SAPEND: "#ff8c00",
  SMP: "#00ff00",
};

const STATUSES = ["New", "In Progress", "Implemented", "Approved", "Rejected", "Fixed"] as const;

const STATUS_COLORS: Record<string, string> = {
  "New": "#94a3b8",          // gray text
  "In Progress": "#eab308",  // yellow
  "Implemented": "#10b981",  // light green
  "Approved": "#16a34a",     // green
  "Rejected": "#ef4444",     // red
  "Fixed": "#2563eb",        // blue
};

const STATUS_ICONS: Record<string, string> = {
  "New": "\u25cb",           // ○
  "In Progress": "\u25d0",   // ◐
  "Implemented": "\u25cf",   // ●
  "Approved": "\u2714",      // ✔
  "Rejected": "\u2718",      // ✘
  "Fixed": "\u2692",         // ⚒
};

interface Props {
  selected: any;
  status: string;
  onStatusChange: (pierId: string, status: string) => void;
  onClose: () => void;
}

export default function PierModal({ selected, status, onStatusChange, onClose }: Props) {
  const { isMobile } = useResponsive();
  if (!selected?.pier) return null;
  const { pier } = selected;
  const color = PIER_COLORS[pier.pier_type] || "#888";
  const currentStatus = status || "New";
  const statusColor = STATUS_COLORS[currentStatus] || "#94a3b8";

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          borderRadius: 16,
          padding: isMobile ? "16px 16px" : "20px 24px",
          minWidth: isMobile ? "auto" : 320,
          maxWidth: isMobile ? "95vw" : 460,
          width: isMobile ? "95vw" : undefined,
          boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
          position: "relative",
          maxHeight: "90vh",
          overflow: "auto",
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: isMobile ? 8 : 12,
            right: isMobile ? 8 : 14,
            background: "none",
            border: "none",
            fontSize: isMobile ? 28 : 20,
            width: isMobile ? 44 : undefined,
            height: isMobile ? 44 : undefined,
            cursor: "pointer",
            color: "#64748b",
          }}
        >
          x
        </button>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <span style={{ width: 14, height: 14, borderRadius: "50%", background: color, display: "inline-block", border: "2px solid #fff", boxShadow: "0 0 0 1px #ccc" }} />
          <h3 style={{ margin: 0, fontSize: 18 }}>{pier.pier_code}</h3>
          <span style={{ fontSize: 12, color: "#64748b", background: "#f1f5f9", padding: "2px 8px", borderRadius: 6 }}>{pier.pier_type}</span>
        </div>

        {/* Status */}
        <div style={{ marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 16, color: statusColor }}>{STATUS_ICONS[currentStatus]}</span>
          <select
            value={currentStatus}
            onChange={(e) => onStatusChange(pier.pier_code, e.target.value)}
            style={{
              padding: isMobile ? "10px 14px" : "6px 12px",
              borderRadius: 8,
              border: `2px solid ${statusColor}`,
              fontSize: isMobile ? 15 : 13,
              fontWeight: 600,
              background: "#fff",
              cursor: "pointer",
              color: statusColor,
            }}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>{STATUS_ICONS[s]} {s}</option>
            ))}
          </select>
        </div>

        {/* Pier details */}
        <Section title="Pier">
          <Field label="Pier code" value={pier.pier_code} />
          <Field label="Pier type" value={pier.pier_type} />
          <Field label="Structure" value={pier.structure_code} />
          <Field label="Row" value={pier.row_num} />
          <Field label="Slope band" value={pier.slope_band} />
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#334155", marginBottom: 4, borderBottom: "1px solid #e2e8f0", paddingBottom: 3 }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px", fontSize: 13 }}>
        {children}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: any }) {
  if (value == null || value === "") return null;
  return (
    <div>
      <span style={{ color: "#64748b" }}>{label}: </span>
      <span style={{ fontWeight: 500 }}>{value}</span>
    </div>
  );
}
