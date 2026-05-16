/**
 * Read-only details modal for a tracker, mirroring the PierModal
 * layout. Surfaces the fields the parser stores on each tracker row:
 *   • Tracker code, row, block
 *   • Pier count, tracker type, orientation
 *   • Source sheet + assignment metadata (parser provenance)
 *   • Bbox extent in PDF points
 *
 * The tracker object passed in is whatever shape /api/projects/:id/trackers
 * returns — see `app/parser.py::extract_trackers_from_pdf_vector` for the
 * authoritative field list.
 */
import { useResponsive } from "../hooks/useResponsive";
import { useTranslation } from "react-i18next";

interface Props {
  tracker: any;
  pierStatuses?: Record<string, string>;
  piers?: any[];
  onClose: () => void;
  onShowInGrid?: (trackerCode: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  "New": "#94a3b8",
  "In Progress": "#eab308",
  "Implemented": "#10b981",
  "Approved": "#16a34a",
  "Rejected": "#ef4444",
  "Fixed": "#2563eb",
};

export default function TrackerModal({ tracker, pierStatuses, piers, onClose, onShowInGrid }: Props) {
  const { isMobile } = useResponsive();
  const { t } = useTranslation();
  if (!tracker?.tracker_code) return null;

  // Compute per-status pier counts for THIS tracker so the modal
  // doubles as a mini-status snapshot of the row.
  const trackerCode = tracker.tracker_code;
  const trackerPiers = (piers || []).filter((p: any) => p.tracker_code === trackerCode);
  const counts: Record<string, number> = { "New": 0, "In Progress": 0, "Implemented": 0, "Approved": 0, "Rejected": 0, "Fixed": 0 };
  for (const p of trackerPiers) {
    const s = (p.pier_code && pierStatuses?.[p.pier_code]) || "New";
    if (s in counts) counts[s] += 1;
  }

  const rows: Array<[string, any]> = [
    [t("tracker.code", "Tracker"),       tracker.tracker_code],
    [t("tracker.row", "Row"),            tracker.row || tracker.row_num],
    [t("tracker.block", "Block"),        tracker.block_code],
    [t("tracker.pierCount", "Piers"),    tracker.pier_count ?? trackerPiers.length],
    [t("tracker.type", "Type"),          tracker.tracker_type_code],
    [t("tracker.sheet", "Sheet"),        tracker.tracker_sheet],
    [t("tracker.orientation", "Orientation"), tracker.orientation],
    [t("tracker.assignment", "Assignment"),
      tracker.assignment_method
        ? `${tracker.assignment_method} (${tracker.assignment_confidence || "—"})`
        : null],
  ];
  if (tracker.bbox && typeof tracker.bbox.x === "number") {
    const bx = Math.round(tracker.bbox.x);
    const by = Math.round(tracker.bbox.y);
    const bw = Math.round(tracker.bbox.w);
    const bh = Math.round(tracker.bbox.h);
    rows.push([t("tracker.bbox", "Bbox"), `x=${bx}, y=${by}, w=${bw}, h=${bh}`]);
  }

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
          minWidth: isMobile ? "auto" : 360,
          maxWidth: isMobile ? "95vw" : 480,
          width: isMobile ? "95vw" : undefined,
          boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
          position: "relative",
          maxHeight: "90vh",
          overflow: "auto",
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
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
            lineHeight: 1,
          }}
        >×</button>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#16a34a", boxShadow: "0 0 0 2px #fff, 0 0 0 3px #cbd5e1" }} />
          <h3 style={{ margin: 0, fontSize: isMobile ? 18 : 16, fontWeight: 800, color: "#0f172a" }}>
            {trackerCode}
          </h3>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 14, rowGap: 6, fontSize: 13, marginBottom: 14 }}>
          {rows.map(([label, value], i) => {
            if (value == null || value === "") return null;
            return (
              <div key={i} style={{ display: "contents" }}>
                <div style={{ color: "#64748b", whiteSpace: "nowrap" }}>{label}</div>
                <div style={{ color: "#0f172a", fontWeight: 600 }}>{String(value)}</div>
              </div>
            );
          })}
        </div>

        {trackerPiers.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: "#64748b", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
              {t("tracker.statusBreakdown", "Status breakdown")}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {Object.entries(counts).map(([st, n]) => (
                <span
                  key={st}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "2px 8px",
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 600,
                    color: STATUS_COLORS[st],
                    background: `${STATUS_COLORS[st]}1a`,
                    border: `1px solid ${STATUS_COLORS[st]}40`,
                  }}
                >
                  {st}: {n}
                </span>
              ))}
            </div>
          </div>
        )}

        {onShowInGrid && (
          <button
            onClick={() => { onShowInGrid(trackerCode); onClose(); }}
            style={{
              width: "100%",
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid #2563eb",
              background: "#2563eb",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t("tracker.showInGrid", "Show in grid")}
          </button>
        )}
      </div>
    </div>
  );
}
