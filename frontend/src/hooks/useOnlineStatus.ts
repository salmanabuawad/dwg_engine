import { useCallback, useEffect, useState } from "react";
import { pendingCount, syncPending } from "../api";

/**
 * React hook that tracks `navigator.onLine` + the pending-mutation count.
 *
 * The pending count is polled on an interval and also refreshed after
 * each successful sync. We also listen for the browser's `online` /
 * `offline` events and auto-fire a sync the moment connectivity returns.
 */
export function useOnlineStatus() {
  const [online, setOnline] = useState<boolean>(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [pending, setPending] = useState<number>(0);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);

  const refreshPending = useCallback(async () => {
    try {
      const n = await pendingCount();
      setPending(n);
    } catch {
      // ignore IDB errors
    }
  }, []);

  const syncNow = useCallback(async () => {
    if (syncing) return { synced: 0, failed: 0 };
    setSyncing(true);
    try {
      const res = await syncPending();
      setLastSyncAt(Date.now());
      await refreshPending();
      return res;
    } finally {
      setSyncing(false);
    }
  }, [refreshPending, syncing]);

  useEffect(() => {
    function onOnline() {
      setOnline(true);
      // Auto-sync the moment we come back online.
      syncNow().catch(() => {});
    }
    function onOffline() {
      setOnline(false);
    }
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [syncNow]);

  // Poll the pending count, but only every 15 seconds instead of 3 — the
  // count only changes after a write or a sync, and both of those call
  // refreshPending explicitly anyway.
  useEffect(() => {
    refreshPending();
    const id = window.setInterval(refreshPending, 15000);
    return () => window.clearInterval(id);
  }, [refreshPending]);

  return { online, pending, syncing, lastSyncAt, syncNow, refreshPending };
}
