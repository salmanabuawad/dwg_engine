import { IDBPDatabase, openDB } from "idb";

/**
 * IndexedDB-backed offline cache for Solarica.
 *
 * Stores:
 *   meta          — "projects" list + last-fetched timestamps
 *   projects      — per-project bundle (project, blocks, trackers, piers,
 *                   plantInfo, pierStatuses, files)
 *   mutations     — pending writes waiting to be flushed to the server
 *
 * The mutation queue is append-only except for coalescing duplicates: if
 * the user changes the same pier status twice in a row, only the latest
 * entry is kept.
 */

const DB_NAME = "solarica-offline";
const DB_VERSION = 1;

export interface ProjectBundle {
  project_id: string;
  project: any | null;          // /api/projects/{id}
  blocks: any[];
  trackers: any[];
  piers: any[];
  pierStatuses: Record<string, string>;
  plantInfo: any | null;
  files: any[];
  electricalDevices?: { dccb: any[]; inverters: any[] };
  stringOptimizerModel?: any;
  eplModel?: any;
  eplFeatures?: any;
  eplMapData?: any;
  fetchedAt: number;            // ms since epoch
}

export interface PendingMutation {
  id?: number;                  // auto-increment PK
  kind: "status";
  projectId: string;
  pierCode: string;
  status: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("projects")) {
          db.createObjectStore("projects", { keyPath: "project_id" });
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta");
        }
        if (!db.objectStoreNames.contains("mutations")) {
          const store = db.createObjectStore("mutations", {
            keyPath: "id",
            autoIncrement: true,
          });
          store.createIndex("byProject", "projectId");
          store.createIndex("byPier", ["projectId", "pierCode"]);
        }
      },
    });
  }
  return dbPromise;
}

/* ---------- Projects list ---------- */

export async function saveProjectsList(items: any[]) {
  const db = await getDB();
  await db.put("meta", items, "projects_list");
}

export async function loadProjectsList(): Promise<any[] | null> {
  try {
    const db = await getDB();
    const items = await db.get("meta", "projects_list");
    return Array.isArray(items) ? items : null;
  } catch {
    return null;
  }
}

/* ---------- Project bundle ---------- */

export async function saveProjectBundle(bundle: ProjectBundle) {
  const db = await getDB();
  await db.put("projects", bundle);
}

export async function loadProjectBundle(projectId: string): Promise<ProjectBundle | null> {
  try {
    const db = await getDB();
    const bundle = (await db.get("projects", projectId)) as ProjectBundle | undefined;
    return bundle || null;
  } catch {
    return null;
  }
}

export async function patchProjectBundle(
  projectId: string,
  patch: Partial<ProjectBundle>,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("projects", "readwrite");
  const existing = ((await tx.store.get(projectId)) as ProjectBundle | undefined) || {
    project_id: projectId,
    project: null,
    blocks: [],
    trackers: [],
    piers: [],
    pierStatuses: {},
    plantInfo: null,
    files: [],
    fetchedAt: 0,
  };
  const merged: ProjectBundle = { ...existing, ...patch, project_id: projectId };
  await tx.store.put(merged);
  await tx.done;
}

export async function patchPierStatus(
  projectId: string,
  pierCode: string,
  status: string,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("projects", "readwrite");
  const existing = (await tx.store.get(projectId)) as ProjectBundle | undefined;
  if (existing) {
    const next = { ...existing.pierStatuses };
    if (status === "New") delete next[pierCode];
    else next[pierCode] = status;
    await tx.store.put({ ...existing, pierStatuses: next });
  }
  await tx.done;
}

/* ---------- Mutation queue ---------- */

/**
 * Enqueue (or coalesce) a status mutation. If a pending mutation for the
 * same (projectId, pierCode) already exists, we overwrite its status and
 * reset its attempts count — last-write-wins, saving bandwidth.
 */
export async function enqueueStatusMutation(
  projectId: string,
  pierCode: string,
  status: string,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("mutations", "readwrite");
  const idx = tx.store.index("byPier");
  const existing = (await idx.get([projectId, pierCode])) as PendingMutation | undefined;
  if (existing && existing.id != null) {
    existing.status = status;
    existing.createdAt = Date.now();
    existing.attempts = 0;
    existing.lastError = undefined;
    await tx.store.put(existing);
  } else {
    const m: PendingMutation = {
      kind: "status",
      projectId,
      pierCode,
      status,
      createdAt: Date.now(),
      attempts: 0,
    };
    await tx.store.add(m);
  }
  await tx.done;
}

export async function listPendingMutations(projectId?: string): Promise<PendingMutation[]> {
  const db = await getDB();
  const tx = db.transaction("mutations", "readonly");
  if (projectId) {
    const idx = tx.store.index("byProject");
    return (await idx.getAll(projectId)) as PendingMutation[];
  }
  return (await tx.store.getAll()) as PendingMutation[];
}

export async function countPendingMutations(): Promise<number> {
  const db = await getDB();
  return db.count("mutations");
}

export async function removePendingMutation(id: number): Promise<void> {
  const db = await getDB();
  await db.delete("mutations", id);
}

export async function markPendingFailure(id: number, error: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("mutations", "readwrite");
  const m = (await tx.store.get(id)) as PendingMutation | undefined;
  if (m) {
    m.attempts = (m.attempts || 0) + 1;
    m.lastError = error;
    await tx.store.put(m);
  }
  await tx.done;
}

/**
 * Apply pending writes over a server-returned statuses map so the UI
 * always reflects the latest local intent, even when we have just fetched
 * fresh data from the server while mutations are still queued.
 */
export async function applyPendingToStatuses(
  projectId: string,
  base: Record<string, string>,
): Promise<Record<string, string>> {
  const pending = await listPendingMutations(projectId);
  const merged = { ...base };
  for (const m of pending) {
    if (m.kind !== "status") continue;
    if (m.status === "New") delete merged[m.pierCode];
    else merged[m.pierCode] = m.status;
  }
  return merged;
}
