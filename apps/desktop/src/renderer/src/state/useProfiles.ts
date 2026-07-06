import { useCallback, useEffect, useState } from "react";
import type { Profile, ProfileList } from "@pwrgit/shared";
import { dispatch, subscribe } from "../lib/pwrgit";

export type UseProfiles = ProfileList & {
  activeProfile: Profile | null;
  switchProfile: (profileId: string) => Promise<void>;
};

/** Load the profile list, stay in sync with `profile:changed`, expose switch. */
export function useProfiles(): UseProfiles {
  const [state, setState] = useState<ProfileList>({
    activeProfileId: null,
    profiles: []
  });

  useEffect(() => {
    let active = true;
    void dispatch("profile:list", undefined).then((r) => {
      if (active && r.ok) setState(r.value);
    });
    const off = subscribe("profile:changed", (payload) => setState(payload));
    return () => {
      active = false;
      off();
    };
  }, []);

  const switchProfile = useCallback(async (profileId: string) => {
    const r = await dispatch("profile:switch", { profileId });
    if (r.ok) setState(r.value);
  }, []);

  const activeProfile =
    state.profiles.find((p) => p.id === state.activeProfileId) ?? null;

  return { ...state, activeProfile, switchProfile };
}
