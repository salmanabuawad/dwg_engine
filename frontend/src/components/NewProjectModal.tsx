import { useMemo, useState } from "react";
import { CREATE_PROJECT_TYPES, defaultFeatureState, featureLabel, FEATURES, type CreateProjectType, type FeatureConfig } from "../eplFeatures";

interface Props {
  online: boolean;
  onCancel: () => void;
  onCreate: (payload: { project_id: string; project_type: CreateProjectType; enabled_features: FeatureConfig }) => Promise<void> | void;
}

const projectTypeLabels: Record<CreateProjectType, string> = {
  fixed_ground: "Fixed ground",
  tracker: "Tracker",
  floating: "Floating / FPV",
  hybrid: "Hybrid",
};

export default function NewProjectModal({ online, onCancel, onCreate }: Props) {
  const [projectId, setProjectId] = useState("");
  const [projectType, setProjectType] = useState<CreateProjectType>("fixed_ground");
  const [features, setFeatures] = useState<FeatureConfig>(() => defaultFeatureState("fixed_ground"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const required = useMemo(() => FEATURES.filter((f) => features[f] === "required"), [features]);
  const optional = useMemo(() => FEATURES.filter((f) => features[f] === "optional"), [features]);
  const disabled = useMemo(() => FEATURES.filter((f) => features[f] === "disabled"), [features]);

  const changeType = (next: CreateProjectType) => {
    setProjectType(next);
    setFeatures(defaultFeatureState(next));
  };

  const setFeature = (feature: string, enabled: boolean) => {
    setFeatures((prev) => {
      if (prev[feature] === "required") return prev;
      return { ...prev, [feature]: enabled ? "optional" : "disabled" };
    });
  };

  const submit = async () => {
    const id = projectId.trim();
    if (!id) {
      setError("Project id is required.");
      return;
    }
    if (!online) {
      setError("Creating a project requires an internet connection.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onCreate({ project_id: id, project_type: projectType, enabled_features: features });
    } catch (e: any) {
      setError(String(e?.message || e));
      setBusy(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.42)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ width: "min(760px, 100%)", maxHeight: "90vh", overflowY: "auto", background: "#fff", borderRadius: 12, border: "1px solid #e2e8f0", boxShadow: "0 20px 50px rgba(15,23,42,0.25)" }}>
        <div style={{ padding: "16px 18px", borderBottom: "1px solid #e2e8f0", display: "flex", alignItems: "center", gap: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>New EPL Project</div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>Choose the site type so required and optional EPL features start in the right state.</div>
          </div>
          <span style={{ flex: 1 }} />
          <button onClick={onCancel} style={{ border: "1px solid #cbd5e1", background: "#fff", borderRadius: 8, padding: "6px 10px", cursor: "pointer" }}>Close</button>
        </div>

        <div style={{ padding: 18, display: "grid", gap: 14 }}>
          {error && <div style={{ color: "#991b1b", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "8px 10px", fontSize: 12 }}>{error}</div>}

          <div style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1fr) minmax(160px, 1fr)", gap: 12 }}>
            <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
              Project ID
              <input value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="BHK" autoFocus style={{ padding: "9px 10px", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: 14 }} />
            </label>
            <label style={{ display: "grid", gap: 5, fontSize: 12, color: "#475569", fontWeight: 700 }}>
              Project type
              <select value={projectType} required onChange={(e) => changeType(e.target.value as CreateProjectType)} style={{ padding: "9px 10px", borderRadius: 8, border: "1px solid #cbd5e1", background: "#fff", fontSize: 14 }}>
                {CREATE_PROJECT_TYPES.map((type) => <option key={type} value={type}>{projectTypeLabels[type]}</option>)}
              </select>
            </label>
          </div>

          <FeatureSection title="Required" tone="#0f172a" features={required} readonly checked />
          <FeatureToggleSection title="Optional" tone="#0369a1" features={optional} values={features} onChange={setFeature} />
          <FeatureToggleSection title="Disabled" tone="#64748b" features={disabled} values={features} onChange={setFeature} />
        </div>

        <div style={{ padding: "14px 18px", borderTop: "1px solid #e2e8f0", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onCancel} style={{ border: "1px solid #cbd5e1", background: "#fff", borderRadius: 8, padding: "8px 14px", cursor: "pointer" }}>Cancel</button>
          <button onClick={submit} disabled={busy || !online} style={{ border: "none", background: online ? "#0f172a" : "#94a3b8", color: "#fff", borderRadius: 8, padding: "8px 16px", fontWeight: 700, cursor: online ? "pointer" : "not-allowed" }}>
            {busy ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FeatureSection({ title, tone, features, readonly, checked }: { title: string; tone: string; features: string[]; readonly?: boolean; checked?: boolean }) {
  if (!features.length) return null;
  return (
    <section>
      <div style={{ fontSize: 11, fontWeight: 800, color: tone, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{title}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {features.map((feature) => (
          <label key={feature} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid #e2e8f0", borderRadius: 8, padding: "6px 8px", fontSize: 12, background: "#f8fafc", color: "#334155" }}>
            <input type="checkbox" checked={checked} readOnly={readonly} />
            {featureLabel(feature)}
          </label>
        ))}
      </div>
    </section>
  );
}

function FeatureToggleSection({ title, tone, features, values, onChange }: { title: string; tone: string; features: string[]; values: FeatureConfig; onChange: (feature: string, enabled: boolean) => void }) {
  if (!features.length) return null;
  return (
    <section>
      <div style={{ fontSize: 11, fontWeight: 800, color: tone, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{title}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {features.map((feature) => (
          <label key={feature} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid #e2e8f0", borderRadius: 8, padding: "6px 8px", fontSize: 12, background: values[feature] === "optional" ? "#eff6ff" : "#fff", color: "#334155" }}>
            <input type="checkbox" checked={values[feature] === "optional"} onChange={(e) => onChange(feature, e.target.checked)} />
            {featureLabel(feature)}
          </label>
        ))}
      </div>
    </section>
  );
}
