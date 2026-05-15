import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Upload } from "lucide-react";
import "./style.css";

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!file) return;
    setLoading(true);
    setResult(null);

    const form = new FormData();
    form.append("file", file);

    const response = await fetch("/api/process", {
      method: "POST",
      body: form,
    });

    const data = await response.json();
    setResult(data);
    setLoading(false);
  }

  return (
    <main className="page">
      <section className="card">
        <div className="title">
          <Upload size={28} />
          <div>
            <h1>Navvix CAD Processor</h1>
            <p>Upload PDF or DXF. Multi-drawing DXFs are split and processed independently.</p>
          </div>
        </div>

        <input type="file" accept=".pdf,.dxf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />

        <button disabled={!file || loading} onClick={submit}>
          {loading ? "Processing..." : "Process file"}
        </button>

        {result && <pre className="result">{JSON.stringify(result, null, 2)}</pre>}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
