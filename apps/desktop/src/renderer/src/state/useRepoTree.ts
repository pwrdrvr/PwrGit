import { useCallback, useEffect, useState } from "react";
import type { Repo } from "@pwrgit/shared";
import { dispatch, subscribe } from "../lib/pwrgit";

export type UseRepoTree = {
  repos: Repo[];
  loading: boolean;
  setRepoPin: (repoId: string, pinned: boolean) => void;
  setWorktreePin: (worktreeId: string, pinned: boolean) => void;
  addFolder: () => Promise<void>;
};

/** Repos for the active profile, kept in sync with `repo:changed`. */
export function useRepoTree(activeProfileId: string | null): UseRepoTree {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const r = await dispatch("repo:list", {});
    if (r.ok) setRepos(r.value);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (activeProfileId === null) {
      setRepos([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    void reload();
    const off = subscribe("repo:changed", () => void reload());
    return off;
  }, [activeProfileId, reload]);

  const setRepoPin = useCallback((repoId: string, pinned: boolean) => {
    setRepos((rs) => rs.map((r) => (r.id === repoId ? { ...r, pinned } : r)));
    void dispatch("repo:setPin", { repoId, pinned });
  }, []);

  const setWorktreePin = useCallback((worktreeId: string, pinned: boolean) => {
    setRepos((rs) =>
      rs.map((r) => ({
        ...r,
        worktrees: r.worktrees.map((w) =>
          w.id === worktreeId ? { ...w, pinned } : w
        )
      }))
    );
    void dispatch("worktree:setPin", { worktreeId, pinned });
  }, []);

  const addFolder = useCallback(async () => {
    if (activeProfileId === null) return;
    const picked = await dispatch("dialog:pickDirectory", undefined);
    if (!picked.ok || picked.value === null) return;
    await dispatch("profile:addRoot", {
      profileId: activeProfileId,
      root: picked.value
    });
    // profile:addRoot rescans and emits repo:changed, which reloads.
  }, [activeProfileId]);

  return { repos, loading, setRepoPin, setWorktreePin, addFolder };
}
