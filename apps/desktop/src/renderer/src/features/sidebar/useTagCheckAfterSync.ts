import { useCallback, useEffect, useState } from "react";
import { dispatch, subscribe } from "../../lib/pwrgit";

/**
 * Main-owned toggles shown in the sidebar's Sync options menu:
 * - "Check tags after sync" (`general.tagCheckAfterSync`)
 * - "Sync forks with upstream" (`general.syncForksOnBulkPull`)
 *
 * Both stay `null` until the first `settings:read` answers, so the menu never
 * draws a guessed checkmark.
 */
export function useSyncMenuSettings(): {
  tagCheckAfterSync: boolean | null;
  setTagCheckAfterSync: (on: boolean) => void;
  syncForksOnBulkPull: boolean | null;
  setSyncForksOnBulkPull: (on: boolean) => void;
} {
  const [tagCheckAfterSync, setTagCheckState] = useState<boolean | null>(null);
  const [syncForksOnBulkPull, setSyncForksState] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    void dispatch("settings:read", undefined).then((result) => {
      if (!active || !result.ok) return;
      if (typeof result.value.general.tagCheckAfterSync === "boolean") {
        setTagCheckState(result.value.general.tagCheckAfterSync);
      }
      if (typeof result.value.general.syncForksOnBulkPull === "boolean") {
        setSyncForksState(result.value.general.syncForksOnBulkPull);
      }
    });
    const off = subscribe("settings:changed", (snapshot) => {
      if (typeof snapshot.general.tagCheckAfterSync === "boolean") {
        setTagCheckState(snapshot.general.tagCheckAfterSync);
      }
      if (typeof snapshot.general.syncForksOnBulkPull === "boolean") {
        setSyncForksState(snapshot.general.syncForksOnBulkPull);
      }
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  const setTagCheckAfterSync = useCallback((next: boolean) => {
    setTagCheckState(next);
    void dispatch("settings:update", { patch: { general: { tagCheckAfterSync: next } } }).then((result) => {
      if (!result.ok) setTagCheckState(!next);
    });
  }, []);

  const setSyncForksOnBulkPull = useCallback((next: boolean) => {
    setSyncForksState(next);
    void dispatch("settings:update", { patch: { general: { syncForksOnBulkPull: next } } }).then((result) => {
      if (!result.ok) setSyncForksState(!next);
    });
  }, []);

  return {
    tagCheckAfterSync,
    setTagCheckAfterSync,
    syncForksOnBulkPull,
    setSyncForksOnBulkPull
  };
}
