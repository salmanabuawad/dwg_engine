export default function LayerTogglePanel({ layers, onChange, inline }: any) {
  if (inline) {
    return (
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {layers.map((l: any) => (
          <label key={l.key} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={l.visible} onChange={(e) => onChange(l.key, e.target.checked)} />
            {l.label}
          </label>
        ))}
      </div>
    );
  }
  return (
    <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 12, background: "#fff" }}>
      <h4 style={{ marginTop: 0 }}>Layers</h4>
      {layers.map((l: any) => (
        <label key={l.key} style={{ display: "block", marginBottom: 8 }}>
          <input type="checkbox" checked={l.visible} onChange={(e) => onChange(l.key, e.target.checked)} style={{ marginRight: 8 }} />
          {l.label}
        </label>
      ))}
    </div>
  );
}
