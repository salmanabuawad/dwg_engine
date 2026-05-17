export type JobStatus = 'pending' | 'processing' | 'done' | 'error';

export interface Job {
  id: string;
  filename: string;
  status: JobStatus;
  size_bytes: number;
  error?: string | null;
  report?: Record<string, unknown> | null;
  created_at: string;
  started_at?: string | null;
  done_at?: string | null;
  dim_color?: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface AppSettings {
  dim_color: string;
  arrow_direction: 'in' | 'out';
}

export const api = {
  upload(file: File): Promise<Job> {
    // Per-job overrides are no longer sent from the UI; the backend
    // resolves the current app_settings row at upload time and snapshots
    // the values onto the job. To override per upload, the API still
    // accepts dim_color / arrow_direction form fields.
    const fd = new FormData();
    fd.append('file', file);
    return request<Job>('/jobs', { method: 'POST', body: fd });
  },
  getSettings(): Promise<AppSettings> {
    return request<AppSettings>('/settings');
  },
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return request<AppSettings>('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },
  listJobs(): Promise<Job[]> {
    return request<Job[]>('/jobs');
  },
  deleteJob(id: string): Promise<void> {
    return request<void>(`/jobs/${id}`, { method: 'DELETE' });
  },
  pdfUrl(id: string): string {
    return `/api/jobs/${id}/pdf`;
  },
  pdfDownloadUrl(id: string): string {
    return `/api/jobs/${id}/pdf/download`;
  },
  pngUrl(id: string): string {
    return `/api/jobs/${id}/png`;
  },
  dxfUrl(id: string): string {
    return `/api/jobs/${id}/dxf`;
  },
};
