import { useCallback, useEffect, useState } from "react";
import {
  OfflineError,
  ignorePendingMutation,
  listPending,
  syncOneMutation,
  syncPending,
} from "../api";
import { PendingMutation } from "../offlineStore";
import { ConfirmModal } from "./Modals";

interface Props {
  online: boolean;
  onClose: () => void;
  /** Called after any change to the queue so the caller can refresh
   *  its own pending counter / statuses map. */
  onChanged?: () => void;
}

/**
 * Full-screen modal that shows every pending offline mutation. The user
 * can retry or ignore each one individually, or batch-retry / clear the
 * whole queue.
 *
 * A mutation is "failed" if its `attempts > 0` AND `lastError` is set —
 * that means we already tried to sync it while online and the server
 * rejected it. Entries without errors are simply waiting.
 */
export default function SyncQueuePanel({ online, onClose, onChanged }: Props) {
  const [rows, setRows] = useState<PendingMutation[]>([]);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [confirmClearAll, setConfirmClearAll] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const all = await listPending();
      // Newest first, but failed rows pinned to the top.
      all.sort((a, b) => {
        const af = (a.attempts || 0) > 0 ? 1 : 0;
        const bf = (b.attempts || 0) > 0 ? 1 : 0;
        if (af !== bf) return bf - af;
        return b.createdAt - a.createdAt;
      });
      setRows(all);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleRetryOne(id?: number) {
    if (id == null) return;
    setBusy(true);
    setError("");
    try {
      const ok = await syncOneMutation(id);
      if (!ok) {
        setError("Retry failed. Check the error message in the row and try again.");
      }
      await refresh();
      onChanged?.();
    } catch (e: any) {
      if (e instanceof OfflineError) setError("You are offline. Reconnect and try again.");
      else setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function handleIgnoreOne(id?: number) {
    if (id == null) return;
    setBusy(true);
    setError("");
    try {
      await ignorePendingMutation(id);
      await refresh();
      onChanged?.();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRetryAll() {
    setBusy(true);
    setError("");
    try {
      const res = await syncPending();
      if (res.failed > 0) {
        setError(`${res.synced} synced, ${res.failed} still failing.`);
      }
      await refresh();
      onChanged?.();
    } catch (e: any) {
      if (e instanceof OfflineError) setError("You are offline. Reconnect and try again.");
      else setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function handleClearAll() {
    setBusy(true);
    setError("");
    try {
      const toClear = rows.filter((r) => r.id != null).map((r) => r.id as number);
      for (const id of toClear) {
        await ignorePendingMutation(id);
      }
      await refresh();
      onChanged?.();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  const failed = rows.filter((r) => (r.attempts || 0) > 0);
  const waiting = rows.filter((r) => (r.attempts || 0) === 0);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1500,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          borderRadius: 16,
          width: "92vw",
          maxWidth: 760,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "16px 20px",
            borderBottom: "1px solid #e2e8f0",
            gap: 10,
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>
            Sync queue
          </div>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "#64748b",
              background: "#f1f5f9",
              padding: "2px 8px",
              borderRadius: 6,
            }}
          >
            {rows.length} pending
          </span>
          {failed.length > 0 && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "#991b1b",
                background: "#fef2f2",
                padding: "2px 8px",
                borderRadius: 6,
              }}
            >
              {failed.length} failed
            </span>
          )}
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            <button
              onClick={handleRetryAll}
              disabled={busy || !online || rows.length === 0}
              title={online ? "" : "Reconnect to retry"}
              style={{
                padding: "6px 12px",
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 8,
                border: "none",
                background:
                  busy || !online || rows.length === 0 ? "#cbd5e1" : "#0f172a",
                color: "#fff",
                cursor:
                  busy || !online || rows.length === 0 ? "not-allowed" : "pointer",
              }}
            >
              Retry all
            </button>
            <button
              onClick={() => setConfirmClearAll(true)}
              disabled={busy || rows.length === 0}
              style={{
                padding: "6px 12px",
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 8,
                border: "1px solid #fecaca",
                background: "#fff",
                color: "#b91c1c",
                cursor: busy || rows.length === 0 ? "not-allowed" : "pointer",
                opacity: busy || rows.length === 0 ? 0.5 : 1,
              }}
            >
              Clear all
            </button>
            <button
              onClick={onClose}
              style={{
                padding: "6px 10px",
                fontSize: 14,
                border: "1px solid #e2e8f0",
                borderRadius: 8,
                background: "#fff",
                cursor: "pointer",
                color: "#475569",
              }}
            >
              ×
            </button>
          </div>
        </div>

        {/* Connection banner */}
        {!online && (
          <div
            style={{
              padding: "8px 20px",
              fontSize: 12,
              color: "#991b1b",
              background: "#fef2f2",
              borderBottom: "1px solid #fecaca",
            }}
          >
            You are offline. Retry will not work until the connection is back.
          </div>
        )}
        {error && (
          <div
            style={{
              padding: "8px 20px",
              fontSize: 12,
              color: "#991b1b",
              background: "#fef2f2",
              borderBottom: "1px solid #fecaca",
            }}
          >
            {error}
          </div>
        )}

        {/* List */}
        <div style={{ overflow: "auto", flex: 1 }}>
          {rows.length === 0 ? (
            <div
              style={{
                padding: 40,
                textAlign: "center",
                color: "#64748b",
                fontSize: 14,
              }}
            >
              Nothing pending. Every local change has been synced to the server.
            </div>
          ) : (
            <>
              {failed.length > 0 && (
                <SectionHeader label={`Failed (${failed.length})`} tone="danger" />
              )}
              {failed.map((m) => (
                <QueueRow
                  key={m.id}
                  m={m}
                  busy={busy}
                  online={online}
                  onRetry={() => handleRetryOne(m.id)}
                  onIgnore={() => handleIgnoreOne(m.id)}
                />
              ))}
              {waiting.length > 0 && (
                <SectionHeader
                  label={`Waiting (${waiting.length})`}
                  tone="muted"
                />
              )}
              {waiting.map((m) => (
                <QueueRow
                  key={m.id}
                  m={m}
                  busy={busy}
                  online={online}
                  onRetry={() => handleRetryOne(m.id)}
                  onIgnore={() => handleIgnoreOne(m.id)}
                />
              ))}
            </>
          )}
        </div>
      </div>

      {confirmClearAll && (
        <ConfirmModal
          title="Ignore every pending mutation?"
          message={`Discard ${rows.length} pending change${rows.length === 1 ? "" : "s"}? The local cache keeps whatever status you already see on-screen, but the server will not be updated.`}
          confirmLabel="Ignore all"
          danger
          onCancel={() => setConfirmClearAll(false)}
          onConfirm={async () => {
            setConfirmClearAll(false);
            await handleClearAll();
          }}
        />
      )}
    </div>
  );
}

function SectionHeader({ label, tone }: { label: string; tone: "danger" | "muted" }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        color: tone === "danger" ? "#b91c1c" : "#64748b",
        background: "#f8fafc",
        padding: "8px 20px",
        borderTop: "1px solid #e2e8f0",
        borderBottom: "1px solid #e2e8f0",
      }}
    >
      {label}
    </div>
  );
}

function QueueRow({
  m,
  busy,
  online,
  onRetry,
  onIgnore,
}: {
  m: PendingMutation;
  busy: boolean;
  online: boolean;
  onRetry: () => void;
  onIgnore: () => void;
}) {
  const when = new Date(m.createdAt).toLocaleString();
  const hasError = (m.attempts || 0) > 0;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "12px 20px",
        borderBottom: "1px solid #f1f5f9",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: "#0f172a" }}>
            {m.pierCode}
          </span>
          <span style={{ fontSize: 11, color: "#64748b" }}>
            project {m.projectId}
          </span>
          <span style={{ fontSize: 11, color: "#94a3b8" }}>{when}</span>
        </div>
        <div style={{ marginTop: 4, fontSize: 13, color: "#334155" }}>
          Set status to{" "}
          <span
            style={{
              fontWeight: 600,
              color: "#0f172a",
              background: "#eef2ff",
              padding: "1px 6px",
              borderRadius: 4,
            }}
          >
            {m.status}
          </span>
        </div>
        {hasError && (
          <div
            style={{
              marginTop: 6,
              padding: "6px 10px",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 6,
              fontSize: 12,
              color: "#991b1b",
            }}
          >
            <div style={{ fontWeight: 600 }}>
              Failed {m.attempts} attempt{m.attempts === 1 ? "" : "s"}
            </div>
            {m.lastError && (
              <div
                style={{
                  marginTop: 2,
                  fontFamily: "monospace",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {m.lastError}
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        <button
          onClick={onRetry}
          disabled={busy || !online}
          title={online ? "Retry this update" : "Reconnect to retry"}
          style={{
            padding: "6px 12px",
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 6,
            border: "none",
            background: busy || !online ? "#cbd5e1" : "#0f172a",
            color: "#fff",
            cursor: busy || !online ? "not-allowed" : "pointer",
          }}
        >
          Retry
        </button>
        <button
          onClick={onIgnore}
          disabled={busy}
          title="Remove from queue without sending to the server"
          style={{
            padding: "6px 12px",
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 6,
            border: "1px solid #fecaca",
            background: "#fff",
            color: "#b91c1c",
            cursor: busy ? "not-allowed" : "pointer",
            opacity: busy ? 0.5 : 1,
          }}
        >
          Ignore
        </button>
      </div>
    </div>
  );
}
