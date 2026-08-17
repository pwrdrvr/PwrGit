import { useCallback, useEffect, useState } from "react";
import type {
  CreateProfileRequest,
  Profile,
  ProfileList,
  BranchReveal,
  UpdateProfileRequest
} from "@pwrgit/shared";
import { dispatch, subscribe, windowProfileId } from "../lib/pwrgit";

export type UseProfiles = ProfileList & {
  /** The profile THIS WINDOW is bound to (one window per profile). */
  activeProfile: Profile | null;
  /** Open (or focus) another profile's window; this window is unaffected. */
  openProfile: (
    profileId: string,
    revealRepoId?: string,
    revealWorktreeId?: string,
    revealBranch?: BranchReveal
  ) => Promise<void>;
  /** Create a profile and open its window. Returns an error message or null. */
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

  const openProfile = useCallback(
    async (
      profileId: string,
      revealRepoId?: string,
      revealWorktreeId?: string,
      revealBranch?: BranchReveal
    ) => {
      await dispatch("profile:openWindow", {
        profileId,
        ...(revealRepoId !== undefined ? { revealRepoId } : {}),
        ...(revealWorktreeId !== undefined ? { revealWorktreeId } : {}),
        ...(revealBranch !== undefined ? { revealBranch } : {})
      });
    },
    []
  );

  const createProfile = useCallback(
    async (req: CreateProfileRequest): Promise<string | null> => {
      const r = await dispatch("profile:create", req);
      if (!r.ok) return r.error.message;
      await openProfile(r.value.id);
      return null;
    },
    [openProfile]
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

  // This window's profile is fixed at creation (preload argv); the global
  // "active" id is only a fallback for windows created without a binding.
  const boundId = windowProfileId() ?? state.activeProfileId;
  const activeProfile = state.profiles.find((p) => p.id === boundId) ?? null;

  return {
    ...state,
    activeProfile,
    openProfile,
    createProfile,
    updateProfile,
    setRoots,
    pickDirectories
  };
}
