import { useCallback, useEffect, useState } from "react";
import type { AppSettingsPatch, AppSettingsSnapshot } from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";

export type AppSettingsState = {
  snapshot: AppSettingsSnapshot | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  update: (patch: AppSettingsPatch) => Promise<void>;
};

/** Load the app settings snapshot, stay in sync with `settings:changed`
 *  (writes from any window), expose a patch writer. */
export function useAppSettings(): AppSettingsState {
  const [snapshot, setSnapshot] = useState<AppSettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    const r = await dispatch("settings:read", undefined);
    setLoading(false);
    if (r.ok) setSnapshot(r.value);
    else setError(r.error.message);
  }, []);

  useEffect(() => {
    void refresh();
    const off = subscribe("settings:changed", (payload) => {
      setSnapshot(payload);
    });
    return off;
  }, [refresh]);

  const update = useCallback(
    async (patch: AppSettingsPatch): Promise<void> => {
      setSaving(true);
      setError(null);
      const r = await dispatch("settings:update", { patch });
      setSaving(false);
      if (r.ok) setSnapshot(r.value);
      else setError(r.error.message);
    },
    []
  );

  return { snapshot, loading, saving, error, refresh, update };
}
