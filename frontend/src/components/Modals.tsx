import { useEffect, useState } from "react";

const BACKDROP: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 2000,
};

const PANEL: React.CSSProperties = {
  background: "#fff",
  borderRadius: 14,
  padding: "20px 22px",
  minWidth: 320,
  maxWidth: "92vw",
  boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
};

/**
 * Full-screen blocking overlay with a spinner and a status message.
 * Mount while a long operation (upload, parse) is in-flight. While mounted:
 * - All pointer events are blocked
 * - Document body cursor is forced to "wait"
 */
export function BusyOverlay({ message }: { message: string }) {
  useEffect(() => {
    const prev = document.body.style.cursor;
    document.body.style.cursor = "wait";
    return () => {
      document.body.style.cursor = prev;
    };
  }, []);
  return (
    <div style={{ ...BACKDROP, cursor: "wait" }}>
      <div style={{ ...PANEL, display: "flex", alignItems: "center", gap: 14, minWidth: 280 }}>
        <Spinner />
        <div style={{ fontSize: 14, fontWeight: 600, color: "#0f172a" }}>{message}</div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <>
      <style>{`@keyframes solarica-spin { to { transform: rotate(360deg); } }`}</style>
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: "50%",
          border: "3px solid #e2e8f0",
          borderTopColor: "#0f172a",
          animation: "solarica-spin 0.8s linear infinite",
        }}
      />
    </>
  );
}

interface ConfirmProps {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger, onConfirm, onCancel }: ConfirmProps) {
  return (
    <div style={BACKDROP} onClick={onCancel}>
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        {title && <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 8 }}>{title}</div>}
        <div style={{ fontSize: 14, color: "#334155", marginBottom: 16, whiteSpace: "pre-wrap" }}>{message}</div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onCancel}
            style={{ fontSize: 13, padding: "8px 16px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            style={{
              fontSize: 13,
              padding: "8px 16px",
              borderRadius: 8,
              border: "none",
              background: danger ? "#dc2626" : "#0f172a",
              color: "#fff",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PromptProps {
  title?: string;
  message: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function PromptModal({ title, message, placeholder, initialValue = "", confirmLabel = "OK", cancelLabel = "Cancel", onConfirm, onCancel }: PromptProps) {
  const [value, setValue] = useState(initialValue);
  return (
    <div style={BACKDROP} onClick={onCancel}>
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        {title && <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 8 }}>{title}</div>}
        <div style={{ fontSize: 14, color: "#334155", marginBottom: 10 }}>{message}</div>
        <input
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) onConfirm(value.trim());
            if (e.key === "Escape") onCancel();
          }}
          style={{
            width: "100%",
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #d1d5db",
            fontSize: 14,
            boxSizing: "border-box",
            marginBottom: 16,
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onCancel}
            style={{ fontSize: 13, padding: "8px 16px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={() => value.trim() && onConfirm(value.trim())}
            disabled={!value.trim()}
            style={{
              fontSize: 13,
              padding: "8px 16px",
              borderRadius: 8,
              border: "none",
              background: value.trim() ? "#0f172a" : "#cbd5e1",
              color: "#fff",
              fontWeight: 600,
              cursor: value.trim() ? "pointer" : "not-allowed",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
