import { useCallback, useEffect, useState } from "react";
import type { HiddenRepo } from "@pwrgit/shared";
import { dispatch, subscribe } from "../lib/pwrgit";

const HIDDEN_RELOAD_DEBOUNCE_MS = 150;

/**
 * A profile's hidden repositories, kept current. Every hide and unhide in
 * main emits `repo:changed` for its profile, which is also what reloads the
 * tree, so the two cannot disagree for longer than a debounce and a round trip.
 * `profileId` null means every profile (Settings → Profiles).
 */
export function useHiddenRepos(profileId: string | null | undefined): {
  hidden: HiddenRepo[];
  reload: () => void;
} {
  const [hidden, setHidden] = useState<HiddenRepo[]>([]);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (profileId === undefined) {
      setHidden([]);
      return;
    }
    let live = true;
    void dispatch("repo:hiddenList", profileId === null ? {} : { profileId }).then(
      (result) => {
        if (live && result.ok) setHidden(result.value);
      }
    );
    return () => {
      live = false;
    };
  }, [profileId, tick]);

  // `repo:changed` also fires for every fetch, branch and worktree change, in
  // bursts during Fetch all; the list only moves on a hide, unhide, removal
  // or scan, so a burst asks once.
  useEffect(() => {
    if (profileId === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe("repo:changed", (p) => {
      if (profileId !== null && p.profileId !== profileId) return;
      clearTimeout(timer);
      timer = setTimeout(reload, HIDDEN_RELOAD_DEBOUNCE_MS);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [profileId, reload]);

  return { hidden, reload };
}

type Listener = () => void;
const showListeners = new Set<Listener>();

/** Ask the sidebar to open its Hidden list — the palette's "Show hidden
 *  repositories" command. The palette and the sidebar share no parent that
 *  owns this, and the request carries nothing but "now". */
export function requestShowHiddenRepos(): void {
  for (const listener of showListeners) listener();
}

export function onShowHiddenRepos(listener: Listener): () => void {
  showListeners.add(listener);
  return () => {
    showListeners.delete(listener);
  };
}

/** Unhide, reporting a failure the way the caller wants it shown. */
export async function unhideRepo(
  entry: Pick<HiddenRepo, "profileId" | "path">
): Promise<string | null> {
  const result = await dispatch("repo:unhide", {
    profileId: entry.profileId,
    path: entry.path
  });
  return result.ok ? null : result.error.message;
}
