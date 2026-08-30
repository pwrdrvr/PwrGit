import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CreateProfileRequest,
  DeleteProfileRequest,
  Profile,
  ProfileList,
  BranchReveal,
  UpdateProfileRequest
} from "@pwrgit/shared";
import { dispatch, subscribe, windowProfileId } from "../lib/pwrgit";
import {
  LOADING_READ_STATE,
  READY_READ_STATE,
  type ReadState
} from "./readState";

export type UseProfiles = ProfileList & {
  loadState: ReadState;
  /** Retry a failed profile-list read. Later reads and pushed changes win. */
  retry: () => Promise<void>;
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
  /** Permanently remove a profile's PwrGit-owned data. */
  deleteProfile: (req: DeleteProfileRequest) => Promise<string | null>;
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
  const [loadState, setLoadState] =
    useState<ReadState>(LOADING_READ_STATE);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);

  const retry = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current;
    setLoadState(LOADING_READ_STATE);
    const r = await dispatch("profile:list", undefined);
    if (!mountedRef.current || request !== requestRef.current) return;
    if (r.ok) {
      setState(r.value);
      setLoadState(READY_READ_STATE);
    } else {
      setLoadState({ status: "error", message: r.error.message });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const off = subscribe("profile:changed", (payload) => {
      // A push is newer than every read already in flight. Invalidate those
      // requests so a late boot read cannot replace the pushed snapshot.
      requestRef.current += 1;
      setState(payload);
      setLoadState(READY_READ_STATE);
    });
    void retry();
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      off();
    };
  }, [retry]);

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

  const deleteProfile = useCallback(
    async (req: DeleteProfileRequest): Promise<string | null> => {
      const r = await dispatch("profile:delete", req);
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
    loadState,
    retry,
    activeProfile,
    openProfile,
    createProfile,
    updateProfile,
    deleteProfile,
    setRoots,
    pickDirectories
  };
}
