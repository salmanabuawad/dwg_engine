/**
 * Compact status-rollup strip shown above the Grid/Map view.
 *
 * Shows the total pier count plus a coloured chip per status (matching
 * the same colour scheme the grid status pill and the map status icons
 * already use, so the whole UI tells one story).  Each chip also shows
 * the share-of-total as a percentage.
 *
 * The component is purely presentational — it derives every count from
 * the (piers, pierStatuses) props in a single O(N) pass — so adding it
 * costs almost nothing and updates immediately as the user edits
 * statuses.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { STATUS_COLORS } from "./SiteMapProps";

const STATUS_ORDER = [
  "New",
  "In Progress",
  "Implemented",
  "Approved",
  "Rejected",
  "Fixed",
] as const;
type Status = (typeof STATUS_ORDER)[number];

// "New" piers don't carry a coloured ring on the map; pick a slate
// neutral here so the dashboard chip is still readable.
const FALLBACK_COLOR: Record<Status, string> = {
  New: "#64748b",
  "In Progress": STATUS_COLORS["In Progress"] || "#eab308",
  Implemented: STATUS_COLORS.Implemented || "#10b981",
  Approved: STATUS_COLORS.Approved || "#16a34a",
  Rejected: STATUS_COLORS.Rejected || "#ef4444",
  Fixed: STATUS_COLORS.Fixed || "#2563eb",
};

const STATUS_I18N_KEYS: Record<Status, string> = {
  New: "status.New",
  "In Progress": "status.InProgress",
  Implemented: "status.Implemented",
  Approved: "status.Approved",
  Rejected: "status.Rejected",
  Fixed: "status.Fixed",
};

interface Props {
  piers: any[];
  pierStatuses: Record<string, string>;
}

export default function StatusDashboard({ piers, pierStatuses }: Props) {
  const { t } = useTranslation();

  const counts = useMemo(() => {
    const c: Record<Status, number> = {
      New: 0,
      "In Progress": 0,
      Implemented: 0,
      Approved: 0,
      Rejected: 0,
      Fixed: 0,
    };
    for (const p of piers) {
      const code = p?.pier_code;
      const s = (code && pierStatuses?.[code]) || "New";
      if (s in c) c[s as Status]++;
      else c.New++;
    }
    return c;
  }, [piers, pierStatuses]);

  const total = piers.length;

  // Don't render anything until piers have actually loaded — keeps
  // the dashboard from flashing six "0 0%" zeros on project switch.
  if (total === 0) return null;

  return (
    <div
      // Single-row layout. On narrow viewports the cards squeeze
      // (each shrinks down to its inner padding) and the row scrolls
      // horizontally if absolutely necessary — better than wrapping
      // to two rows and pushing the grid/map out of sight.
      style={{
        display: "flex",
        gap: 6,
        flexWrap: "nowrap",
        alignItems: "stretch",
        marginBottom: 10,
        overflowX: "auto",
        WebkitOverflowScrolling: "touch",
      }}
    >
      {/* Total card */}
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "6px 10px",
          background: "#16335c",
          color: "#fff",
          borderRadius: 8,
          boxShadow: "0 1px 2px rgba(15,23,42,0.08)",
        }}
      >
        <div style={{ fontSize: 9, fontWeight: 600, opacity: 0.85, textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap" }}>
          {t("dashboard.totalPiers", "Total Piers")}
        </div>
        <div style={{ fontSize: 16, fontWeight: 800, lineHeight: 1.1, marginTop: 1 }}>
          {total.toLocaleString()}
        </div>
      </div>

      {/* Per-status cards */}
      {STATUS_ORDER.map((s) => {
        const n = counts[s];
        const pct = total > 0 ? Math.round((n / total) * 100) : 0;
        const color = FALLBACK_COLOR[s];
        return (
          <div
            key={s}
            title={`${n.toLocaleString()} of ${total.toLocaleString()} piers`}
            style={{
              flex: "0 0 auto",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              padding: "6px 10px",
              background: "#fff",
              border: `1px solid ${color}33`,
              borderLeft: `3px solid ${color}`,
              borderRadius: 8,
              boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
            }}
          >
            <div
              style={{
                fontSize: 9,
                fontWeight: 700,
                color,
                textTransform: "uppercase",
                letterSpacing: 0.4,
                whiteSpace: "nowrap",
              }}
            >
              {t(STATUS_I18N_KEYS[s], s)}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 4,
                marginTop: 1,
                color: "#0f172a",
              }}
            >
              <span style={{ fontSize: 16, fontWeight: 800, lineHeight: 1.1 }}>
                {n.toLocaleString()}
              </span>
              <span style={{ fontSize: 10, fontWeight: 600, color: "#64748b" }}>
                {pct}%
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
