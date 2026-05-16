/**
 * Offline-aware API layer.
 *
 * - GET endpoints used during normal field work (projects list, project,
 *   blocks, trackers, piers, pier-statuses, plant-info) are network-first
 *   with a transparent fall-back to the IndexedDB cache.
 * - `updatePierStatus` writes optimistically to the local cache and queues
 *   a pending mutation. If we're online the mutation is flushed
 *   immediately, otherwise it sits in the queue until `syncPending()`
 *   fires (on window 'online' event or from the manual Sync button).
 * - Writes that require the server (create project, upload file, parse,
 *   update plant-info) throw an `OfflineError` when there is no network so
 *   the UI can show a friendly message.
 */
import {
  PendingMutation,
  applyPendingToStatuses,
  countPendingMutations,
  enqueueStatusMutation,
  listPendingMutations,
  loadProjectBundle,
  loadProjectsList,
  markPendingFailure,
  patchPierStatus,
  patchProjectBundle,
  removePendingMutation,
  saveProjectsList,
} from "./offlineStore";

const API = (import.meta as any).env?.VITE_API_URL ?? "";

// ── Auth (admin/admin123 by default; token lives in localStorage) ──────

const AUTH_TOKEN_KEY = "solarica.auth_token";
const AUTH_USER_KEY = "solarica.auth_user";

export interface AuthUser { username: string; role: string; }

export function getAuthToken(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

export function getCurrentUser(): AuthUser | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY);
    return raw ? JSON.parse(raw) as AuthUser : null;
  } catch { return null; }
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) {
    const msg = r.status === 401 ? "Invalid username or password" : await r.text();
    throw new Error(msg);
  }
  const data = await r.json();
  localStorage.setItem(AUTH_TOKEN_KEY, data.access_token);
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(data.user));
  return data.user;
}

export function logout(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
  location.reload();
}

function authHeaders(extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  const tok = getAuthToken();
  if (tok) h.set("Authorization", `Bearer ${tok}`);
  return h;
}

export class OfflineError extends Error {
  constructor(message = "This action requires an internet connection.") {
    super(message);
    this.name = "OfflineError";
  }
}

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

async function j<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: authHeaders(init?.headers) });
  if (r.status === 401) {
    // Token invalid / expired — purge and force login next render.
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(AUTH_USER_KEY);
    }
    throw new Error("Not authenticated");
  }
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

/**
 * Deduplicates concurrent GET requests to the same URL. If a fetch for
 * `/api/projects/TEST` is already in flight, a second caller gets the
 * same promise instead of firing another HTTP request.
 */
const inflightGets = new Map<string, Promise<any>>();
function jDeduped<T = any>(url: string): Promise<T> {
  let pending = inflightGets.get(url);
  if (!pending) {
    pending = j<T>(url).finally(() => { inflightGets.delete(url); });
    inflightGets.set(url, pending);
  }
  return pending;
}

/**
 * Try to fetch from the network; if that fails for any reason (offline,
 * DNS, 5xx, etc) fall back to the provided loader. If both fail, rethrow
 * the network error so the caller can surface it.
 */
async function networkFirst<T>(
  fetcher: () => Promise<T>,
  fallback: () => Promise<T | null>,
  onFetched?: (value: T) => Promise<void> | void,
): Promise<T> {
  if (isOnline()) {
    try {
      const value = await fetcher();
      try {
        await onFetched?.(value);
      } catch {
        // cache write failures are non-fatal
      }
      return value;
    } catch (e) {
      const cached = await fallback();
      if (cached != null) return cached;
      throw e;
    }
  }
  const cached = await fallback();
  if (cached != null) return cached;
  throw new OfflineError("No offline copy available for this request.");
}

/* ---------------- Projects list ---------------- */

export const getProjects = () =>
  networkFirst<any[]>(
    () => jDeduped<any[]>(`${API}/api/projects`),
    () => loadProjectsList(),
    async (items) => { await saveProjectsList(items); },
  );

/* ---------------- Per-project data (individual endpoints) ---------------- */

/**
 * Lightweight project metadata — only fetches the summary endpoint, not the
 * full pier/block/tracker data. Used by the Project Info tab.
 */
export const getProject = async (id: string) =>
  networkFirst<any>(
    () => jDeduped<any>(`${API}/api/projects/${id}`),
    async () => (await loadProjectBundle(id))?.project ?? null,
    async (v) => { await patchProjectBundle(id, { project: v }); },
  );

/**
 * Heavy data endpoints — each fetches only its own slice, cached individually.
 * These are called by the Details tab (Grid/Map), NOT by Project Info.
 */
export const getBlocks = async (id: string) =>
  networkFirst<any[]>(
    () => jDeduped<any[]>(`${API}/api/projects/${id}/blocks`),
    async () => (await loadProjectBundle(id))?.blocks ?? [],
    async (v) => { await patchProjectBundle(id, { blocks: v }); },
  );

export const getTrackers = async (id: string) =>
  networkFirst<any[]>(
    () => jDeduped<any[]>(`${API}/api/projects/${id}/trackers`),
    async () => (await loadProjectBundle(id))?.trackers ?? [],
    async (v) => { await patchProjectBundle(id, { trackers: v }); },
  );

export const getPiers = async (id: string) =>
  networkFirst<any[]>(
    () => jDeduped<any[]>(`${API}/api/projects/${id}/piers`),
    async () => (await loadProjectBundle(id))?.piers ?? [],
    async (v) => { await patchProjectBundle(id, { piers: v }); },
  );

/**
 * Electrical-device (DCCB + inverter) positions extracted from the
 * project's construction PDF. Mounted under the `security` phase module
 * — see backend/app/modules/security/routes.py.
 *
 * Falls back to the offline bundle's `electricalDevices` slice when the
 * network is unavailable. Returns `{dccb, inverters}` — each a list of
 * `{type, name, x, y}`.
 */
export const getElectricalDevices = async (id: string) =>
  networkFirst<{ dccb: any[]; inverters: any[] }>(
    () => jDeduped<{ dccb: any[]; inverters: any[] }>(
      `${API}/api/security/projects/${id}/electrical-devices`,
    ),
    async () =>
      (await loadProjectBundle(id))?.electricalDevices ?? { dccb: [], inverters: [] },
    async (v) => { await patchProjectBundle(id, { electricalDevices: v }); },
  );


/**
 * EPL string/optimizer model for BHK/SolarEdge/agro-PV style projects.
 *
 * Returns the physical-row reconstruction:
 *   physical rows → electrical zones → strings → optimizers → modules
 *
 * By default the backend omits the full optimizer list to keep the response
 * light. Pass includeOptimizers=true when you need all optimizer records.
 */
export const getStringOptimizerModel = async (id: string, includeOptimizers = false) =>
  networkFirst<any>(
    () => jDeduped<any>(
      `${API}/api/epl/projects/${id}/string-optimizer-model?include_optimizers=${includeOptimizers ? "true" : "false"}`,
    ),
    async () => (await loadProjectBundle(id))?.stringOptimizerModel ?? null,
    async (v) => { await patchProjectBundle(id, { stringOptimizerModel: v }); },
  );

export const getStringOptimizerExportUrl = (id: string) =>
  `${API}/api/epl/projects/${id}/string-optimizer-export`;

export const getProjectFeatures = async (id: string) =>
  networkFirst<any>(
    () => jDeduped<any>(`${API}/api/projects/${id}/features`),
    async () => (await loadProjectBundle(id))?.eplFeatures ?? null,
    async (v) => { await patchProjectBundle(id, { eplFeatures: v }); },
  );

export const getEplModel = async (id: string, includeRawText = false) =>
  networkFirst<any>(
    () => jDeduped<any>(
      `${API}/api/projects/${id}/epl/model?include_raw_text=${includeRawText ? "true" : "false"}`,
    ),
    async () => (await loadProjectBundle(id))?.eplModel ?? null,
    async (v) => {
      if (!includeRawText) await patchProjectBundle(id, { eplModel: v });
    },
  );

export const getEplMapData = async (id: string, projectFolder?: string) => {
  const qs = projectFolder ? `?project_folder=${encodeURIComponent(projectFolder)}` : "";
  return networkFirst<any>(
    () => jDeduped<any>(`${API}/api/projects/${id}/epl/map-data${qs}`),
    async () => (await loadProjectBundle(id))?.eplMapData ?? null,
    async (v) => { await patchProjectBundle(id, { eplMapData: v }); },
  );
};

export const getEplExportUrl = (id: string) =>
  `${API}/api/projects/${id}/epl/export`;

export async function downloadEplExport(id: string): Promise<void> {
  if (!isOnline()) throw new OfflineError("Export download needs a connection.");
  const r = await fetch(getEplExportUrl(id), { headers: authHeaders() });
  if (!r.ok) throw new Error(await r.text());
  const blob = await r.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = `${id}_epl_deepsearch.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

/**
 * getPierStatuses merges server statuses with any locally-queued mutations
 * so the UI never loses in-flight edits.
 */
export const getPierStatuses = async (id: string) => {
  const base = await networkFirst<Record<string, string>>(
    () => jDeduped<Record<string, string>>(`${API}/api/projects/${id}/pier-statuses`),
    async () => (await loadProjectBundle(id))?.pierStatuses ?? {},
    async (v) => { await patchProjectBundle(id, { pierStatuses: v }); },
  );
  return applyPendingToStatuses(id, base);
};

export const getPier = async (pid: string, pier: string) => {
  // Individual-pier endpoint: try network when online, otherwise
  // reconstruct from the cached piers/blocks/trackers.
  if (isOnline()) {
    try {
      return await jDeduped<any>(`${API}/api/projects/${pid}/pier/${pier}`);
    } catch {
      // fall through to cached lookup
    }
  }
  const bundle = await loadProjectBundle(pid);
  if (!bundle) throw new OfflineError(`No offline copy of project ${pid}.`);
  const match = bundle.piers.find((p: any) => p.pier_code === pier);
  if (!match) throw new OfflineError(`Pier ${pier} not found in cached project.`);
  // Shape the object the way the backend returns it so PierModal keeps working.
  return { pier: match };
};


/* ---------------- Plant info ---------------- */

export const getPlantInfo = async (pid: string) => {
  if (isOnline()) {
    try {
      const v = await jDeduped<any>(`${API}/api/projects/${pid}/plant-info`);
      await patchProjectBundle(pid, { plantInfo: v });
      return v;
    } catch {
      // fall through
    }
  }
  const bundle = await loadProjectBundle(pid);
  if (!bundle) throw new OfflineError();
  return bundle.plantInfo || {};
};

export const updatePlantInfo = async (pid: string, data: Record<string, any>) => {
  if (!isOnline()) throw new OfflineError("Plant info updates need a connection.");
  const v = await j<any>(`${API}/api/projects/${pid}/plant-info`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  await patchProjectBundle(pid, { plantInfo: v });
  return v;
};

/* ---------------- Pier status writes (offline-capable) ---------------- */

/**
 * Update a single pier's status. Always updates the local cache and (if
 * appropriate) enqueues a pending sync. When online we attempt the server
 * write inline; on failure the mutation stays in the queue and will be
 * retried by `syncPending()`.
 */
export const updatePierStatus = async (pid: string, pierId: string, status: string) => {
  // 1) optimistic local write
  await patchPierStatus(pid, pierId, status);
  // 2) enqueue (or coalesce) the mutation
  await enqueueStatusMutation(pid, pierId, status);
  // 3) fire-and-forget online flush
  if (isOnline()) {
    // don't await — caller wants instant feedback
    syncPending().catch(() => {});
  }
  return { ok: true, offline: !isOnline() };
};

/**
 * Bulk-update many piers to the same status in ONE HTTP request
 * (and one DB round-trip on the server). For N piers this is O(1)
 * requests instead of O(N), turning 24 k-pier bulk changes from
 * minutes into well under a second.
 *
 * Falls back to the per-pier `updatePierStatus` path when offline so
 * the local cache and mutation queue stay consistent.
 */
export async function bulkUpdatePierStatus(
  pid: string,
  pierCodes: string[],
  status: string,
): Promise<{ ok: true; updated: number; offline: boolean }> {
  // Optimistic local writes first (same pattern as single-pier update).
  for (const code of pierCodes) {
    await patchPierStatus(pid, code, status);
  }

  if (!isOnline()) {
    // Queue individually so the sync-queue panel can retry per-pier.
    for (const code of pierCodes) await enqueueStatusMutation(pid, code, status);
    return { ok: true, updated: pierCodes.length, offline: true };
  }

  const res = await j<{ updated: number }>(
    `${API}/api/projects/${pid}/pier-statuses/bulk`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pier_codes: pierCodes, status }),
    },
  );
  return { ok: true, updated: res?.updated ?? pierCodes.length, offline: false };
}

/**
 * Flush every pending mutation to the server. Called on window 'online'
 * events, from the manual Sync button, and after each local write while
 * online. Returns the number of successfully flushed mutations.
 *
 * Optional `ids` restricts the sync to a specific subset — used by the
 * sync-queue panel when the user clicks "Retry" on a single row.
 */
export async function syncPending(ids?: number[]): Promise<{ synced: number; failed: number }> {
  if (!isOnline()) return { synced: 0, failed: 0 };
  const all = await listPendingMutations();
  const filter = ids ? new Set(ids) : null;
  const pending = filter ? all.filter((m) => m.id != null && filter.has(m.id)) : all;
  let synced = 0;
  let failed = 0;
  for (const m of pending) {
    try {
      await j<any>(`${API}/api/projects/${m.projectId}/pier/${m.pierCode}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: m.status }),
      });
      if (m.id != null) await removePendingMutation(m.id);
      synced++;
    } catch (e: any) {
      if (m.id != null) await markPendingFailure(m.id, String(e?.message || e));
      failed++;
    }
  }
  return { synced, failed };
}

/**
 * Retry a single mutation by id. Returns `true` on success.
 */
export async function syncOneMutation(id: number): Promise<boolean> {
  const res = await syncPending([id]);
  return res.synced === 1;
}

/**
 * Drop a pending mutation without sending it to the server. Used by the
 * sync-queue panel when the user decides to ignore a failing update.
 * Note: the optimistic local change already applied to the cache is left
 * in place — you can undo it manually via a fresh status edit if needed.
 */
export async function ignorePendingMutation(id: number): Promise<void> {
  await removePendingMutation(id);
}

/* ---------------- Electrical string records (server-backed) ------------ */

export async function getStringRecords(pid: string): Promise<any> {
  return j<any>(`${API}/api/projects/${pid}/strings/records`);
}

export async function updateStringStatus(pid: string, stringId: string, status: string): Promise<any> {
  if (!isOnline()) throw new OfflineError("String status updates need a connection.");
  return j<any>(`${API}/api/projects/${pid}/strings/${encodeURIComponent(stringId)}/status`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

export async function updateStringComment(pid: string, stringId: string, comment: string): Promise<any> {
  if (!isOnline()) throw new OfflineError("String comments need a connection.");
  return j<any>(`${API}/api/projects/${pid}/strings/${encodeURIComponent(stringId)}/comment`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ comment }),
  });
}

export async function addStringImage(pid: string, stringId: string, file: File): Promise<any> {
  if (!isOnline()) throw new OfflineError("String images need a connection.");
  const body = new FormData();
  body.append("file", file);
  const r = await fetch(`${API}/api/projects/${pid}/strings/${encodeURIComponent(stringId)}/images`, {
    method: "POST",
    headers: authHeaders(),
    body,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function pendingCount(): Promise<number> {
  return countPendingMutations();
}

export async function listPending(projectId?: string): Promise<PendingMutation[]> {
  return listPendingMutations(projectId);
}

/* ---------------- Files (all online-only) ---------------- */

export const listProjectFiles = async (pid: string) => {
  if (isOnline()) {
    try {
      const v = await jDeduped<any[]>(`${API}/api/projects/${pid}/files`);
      await patchProjectBundle(pid, { files: v });
      return v;
    } catch {
      // fall through
    }
  }
  const bundle = await loadProjectBundle(pid);
  if (!bundle) return [];
  return bundle.files || [];
};

export const uploadProjectFile = async (pid: string, kind: string, file: File) => {
  if (!isOnline()) throw new OfflineError("File uploads need a connection.");
  const fd = new FormData();
  fd.append("kind", kind);
  fd.append("file", file);
  const r = await fetch(`${API}/api/projects/${pid}/files`, {
    method: "POST",
    body: fd,
    headers: authHeaders(),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
};

export const clearProjectFiles = async (pid: string) => {
  if (!isOnline()) throw new OfflineError("Clearing files needs a connection.");
  return j<any>(`${API}/api/projects/${pid}/files`, { method: "DELETE" });
};

export const parseProject = async (pid: string) => {
  if (!isOnline()) throw new OfflineError("Parsing needs a connection.");
  return j<any>(`${API}/api/projects/${pid}/parse`, { method: "POST" });
};

export const createProject = async (body: { project_id: string; name?: string; site_profile?: string; project_type?: string; enabled_features?: Record<string, string> }) => {
  if (!isOnline()) throw new OfflineError("Creating a project needs a connection.");
  return j<any>(`${API}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
};

export function apiBase() {
  return API;
}

// ── Field configurations (per-grid column prefs) ──────────────────────

export interface FieldConfig {
  grid_name: string;
  field_name: string;
  display_name?: string | null;
  visible: boolean;
  pin_side?: "left" | "right" | null;
  column_order?: number | null;
  width?: number | null;
}

export async function listFieldConfigs(gridName?: string): Promise<FieldConfig[]> {
  const qs = gridName ? `?grid_name=${encodeURIComponent(gridName)}` : "";
  // jDeduped collapses concurrent identical fetches into a single
  // HTTP request — useful here because both App and FieldConfigManager
  // can spin up the same query within the same tick.
  return jDeduped<FieldConfig[]>(`${API}/api/field-configs${qs}`);
}

export async function upsertFieldConfigs(rows: FieldConfig[]): Promise<{ updated: number }> {
  return j(`${API}/api/field-configs`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rows),
  });
}

// ── Users (admin CRUD) ────────────────────────────────────────────────

export interface UserRow {
  id: number;
  username: string;
  display_name?: string | null;
  role: "admin" | "editor" | "viewer";
  is_active: boolean;
  created_at?: string;
}

export async function listUsers(): Promise<UserRow[]> {
  return j<UserRow[]>(`${API}/api/users`);
}

export async function createUser(body: {
  username: string;
  password: string;
  display_name?: string;
  role?: "admin" | "editor" | "viewer";
}): Promise<UserRow> {
  return j<UserRow>(`${API}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function updateUser(
  id: number,
  body: Partial<{ display_name: string | null; role: "admin" | "editor" | "viewer"; is_active: boolean; password: string }>,
): Promise<{ updated: number }> {
  return j(`${API}/api/users/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function deleteUser(id: number): Promise<{ deleted: number }> {
  return j(`${API}/api/users/${id}`, { method: "DELETE" });
}


export async function downloadStringOptimizerExport(id: string): Promise<Blob> {
  if (!isOnline()) throw new OfflineError("Export requires a connection.");
  const r = await fetch(`${API}/api/epl/projects/${id}/string-optimizer-export`, {
    headers: authHeaders(),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.blob();
}
