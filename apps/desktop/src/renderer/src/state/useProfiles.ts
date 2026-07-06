import { useCallback, useEffect, useState } from "react";
import type {
  CreateProfileRequest,
  Profile,
  ProfileList,
  UpdateProfileRequest
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../lib/pwrgit";

export type UseProfiles = ProfileList & {
  activeProfile: Profile | null;
  switchProfile: (profileId: string) => Promise<void>;
  /** Create a profile and make it active. Returns an error message or null. */
  createProfile: (req: CreateProfileRequest) => Promise<string | null>;
  /** Patch an existing profile. Returns an error message or null. */
  updateProfile: (req: UpdateProfileRequest) => Promise<string | null>;
  /** Replace a profile's scan roots (triggers a rescan). */
  setRoots: (profileId: string, roots: string[]) => Promise<void>;
  /** Native multi-select folder picker; [] if cancelled. */
  pickDirectories: () => Promise<string[]>;
};

/** Load the profile list, stay in sync with `profile:changed`, expose CRUD. */
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

  const createProfile = useCallback(
    async (req: CreateProfileRequest): Promise<string | null> => {
      const r = await dispatch("profile:create", req);
      if (!r.ok) return r.error.message;
      await switchProfile(r.value.id);
      return null;
    },
    [switchProfile]
  );

  const updateProfile = useCallback(
    async (req: UpdateProfileRequest): Promise<string | null> => {
      const r = await dispatch("profile:update", req);
      return r.ok ? null : r.error.message;
    },
    []
  );

  const setRoots = useCallback(async (profileId: string, roots: string[]) => {
    await dispatch("profile:setRoots", { profileId, roots });
  }, []);

  const pickDirectories = useCallback(async (): Promise<string[]> => {
    const r = await dispatch("dialog:pickDirectories", undefined);
    return r.ok ? r.value : [];
  }, []);

  const activeProfile =
    state.profiles.find((p) => p.id === state.activeProfileId) ?? null;

  return {
    ...state,
    activeProfile,
    switchProfile,
    createProfile,
    updateProfile,
    setRoots,
    pickDirectories
  };
}
