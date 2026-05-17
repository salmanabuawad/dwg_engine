import { useCallback, useEffect, useState } from 'react';
import { Layers, Palette, RefreshCw } from 'lucide-react';
import { api, Job } from './api';
import { UploadZone } from './components/UploadZone';
import { JobList } from './components/JobList';
import { PreviewPanel } from './components/PreviewPanel';

const DIM_COLOR_STORAGE_KEY = 'dwg-engine.dim_color';
const DEFAULT_DIM_COLOR = '#7a7a7a';

function loadDimColor(): string {
  if (typeof localStorage === 'undefined') return DEFAULT_DIM_COLOR;
  const raw = localStorage.getItem(DIM_COLOR_STORAGE_KEY);
  if (!raw) return DEFAULT_DIM_COLOR;
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : DEFAULT_DIM_COLOR;
}

export default function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dimColor, setDimColor] = useState<string>(() => loadDimColor());

  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DIM_COLOR_STORAGE_KEY, dimColor);
    }
  }, [dimColor]);

  const fetchJobs = useCallback(async () => {
    try {
      const data = await api.listJobs();
      setJobs(data);
      setSelected((old) => old ? data.find((j) => j.id === old.id) ?? null : data[0] ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load jobs');
    }
  }, []);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);
  useEffect(() => {
    if (!jobs.some((j) => j.status === 'pending' || j.status === 'processing')) return;
    const id = window.setTimeout(fetchJobs, 2000);
    return () => window.clearTimeout(id);
  }, [jobs, fetchJobs]);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const job = await api.upload(file, { dimColor });
      setJobs((prev) => [job, ...prev]);
      setSelected(job);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await api.deleteJob(id);
    setJobs((prev) => prev.filter((j) => j.id !== id));
    if (selected?.id === id) setSelected(null);
  }

  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-900">
      <header className="flex h-14 items-center justify-between bg-slate-950 px-5 text-white">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-white/15 p-1.5"><Layers className="h-4 w-4" /></div>
          <div>
            <div className="text-sm font-bold tracking-wide">dwg-engine</div>
            <div className="text-[11px] text-white/50">Semantic DXF dimensioning</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label
            className="group flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-2.5 hover:bg-white/10"
            title="Dimension colour applied to every new upload"
          >
            <Palette className="h-3.5 w-3.5 text-white/70 group-hover:text-white" />
            <span className="text-[11px] uppercase tracking-wider text-white/60">Dim</span>
            <input
              type="color"
              value={dimColor}
              onChange={(e) => setDimColor(e.target.value)}
              className="h-5 w-7 cursor-pointer rounded border-0 bg-transparent p-0"
              aria-label="Dimension line colour"
            />
            <span className="font-mono text-[10px] text-white/60">{dimColor.toLowerCase()}</span>
          </label>
          <button onClick={fetchJobs} className="rounded-lg p-2 text-white/70 hover:bg-white/10 hover:text-white" title="Refresh jobs">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-96 flex-col border-r bg-white">
          <div className="border-b p-4"><UploadZone onUpload={upload} disabled={busy} />{error && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</div>}</div>
          <div className="flex items-center justify-between px-4 py-3"><span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Drawings</span><span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{jobs.length}</span></div>
          <div className="min-h-0 flex-1 overflow-auto px-4 pb-4"><JobList jobs={jobs} selectedId={selected?.id ?? null} onSelect={setSelected} onDelete={remove} /></div>
        </aside>
        <main className="min-w-0 flex-1"><PreviewPanel job={selected} /></main>
      </div>
    </div>
  );
}
