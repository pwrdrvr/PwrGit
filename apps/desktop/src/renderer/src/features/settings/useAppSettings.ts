import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettingsPatch, AppSettingsSnapshot } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";

type SettingsChange = AppSettingsPatch | ((snapshot: AppSettingsSnapshot) => AppSettingsPatch | undefined);

export type AppSettingsState = {
  snapshot: AppSettingsSnapshot | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  update: (change: SettingsChange) => Promise<void>;
};

/** Load the app settings snapshot, stay in sync with `settings:changed`
 *  (writes from any window), expose a patch writer. */
export function useAppSettings(): AppSettingsState {
  const [snapshot, setSnapshot] = useState<AppSettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<AppSettingsSnapshot | null>(null);
  const writes = useRef(Promise.resolve());
  const acceptSnapshot = useCallback((next: AppSettingsSnapshot): void => {
    latest.current = next;
    setSnapshot(next);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    const r = await dispatch("settings:read", undefined);
    setLoading(false);
    if (r.ok) acceptSnapshot(r.value);
    else setError(r.error.message);
  }, [acceptSnapshot]);

  useEffect(() => {
    void refresh();
    return subscribe("settings:changed", acceptSnapshot);
  }, [acceptSnapshot, refresh]);

  const update = useCallback((change: SettingsChange): Promise<void> => {
    setSaving(true);
    // A rule edit replaces the entire rules object. Resolve each edit after
    // the preceding IPC write so turning on a rule keeps a threshold saved on blur.
    const done: Promise<void> = writes.current.then(async () => {
      const current = latest.current;
      const patch = typeof change === "function" ? current && change(current) : change;
      if (!patch) return;
      setError(null);
      const result = await dispatch("settings:update", { patch });
      if (result.ok) acceptSnapshot(result.value);
      else setError(result.error.message);
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (writes.current === done) setSaving(false);
    });
    writes.current = done;
    return done;
  }, [acceptSnapshot]);

  return { snapshot, loading, saving, error, refresh, update };
}
