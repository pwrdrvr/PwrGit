import { useCallback, useEffect, useState } from "react";
import type { Repo } from "@pwrgit/shared";
import { dispatch, subscribe } from "../lib/pwrgit";

export type UseRepoTree = {
  repos: Repo[];
  loading: boolean;
  setRepoPin: (repoId: string, pinned: boolean) => void;
  setWorktreePin: (worktreeId: string, pinned: boolean) => void;
  addFolder: () => Promise<void>;
  createWorktree: (
    repoId: string,
    branch: string,
    newBranch: boolean
  ) => Promise<string | null>;
  removeWorktrees: (worktreeIds: string[]) => Promise<void>;
  persistWorktreeOrder: (repoId: string, orderedIds: string[]) => void;
  computeRepoState: (repoId: string) => void;
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

  const createWorktree = useCallback(
    async (repoId: string, branch: string, newBranch: boolean) => {
      const r = await dispatch("worktree:create", {
        repoId,
        branch,
        newBranch
      });
      return r.ok ? null : r.error.message;
    },
    []
  );

  const removeWorktrees = useCallback(async (worktreeIds: string[]) => {
    if (worktreeIds.length === 0) return;
    // Removing >1 is a bulk destructive action → confirm up front. A single
    // removal (trash icon / context menu) goes straight to the attempt and
    // only prompts if that worktree is dirty, matching the prior behaviour.
    if (
      worktreeIds.length > 1 &&
      !window.confirm(
        `Remove ${worktreeIds.length} worktrees? Their working directories ` +
          `will be deleted. Branches and commits are kept.`
      )
    ) {
      return;
    }

    const first = await dispatch("worktree:removeMany", {
      worktreeIds,
      force: false
    });
    if (!first.ok) {
      window.alert(first.error.message);
      return;
    }
    const { dirty } = first.value;
    const failures = [...first.value.failed];

    if (dirty.length > 0) {
      const have = dirty.length === 1 ? "worktree has" : "worktrees have";
      const them = dirty.length === 1 ? "it" : "them";
      if (
        window.confirm(
          `${dirty.length} ${have} uncommitted changes. Remove ${them} anyway?`
        )
      ) {
        const forced = await dispatch("worktree:removeMany", {
          worktreeIds: dirty,
          force: true
        });
        if (forced.ok) failures.push(...forced.value.failed);
        else window.alert(forced.error.message);
      }
    }

    if (failures.length > 0) {
      const shown = failures
        .slice(0, 6)
        .map((f) => `• ${f.message}`)
        .join("\n");
      const more =
        failures.length > 6 ? `\n…and ${failures.length - 6} more` : "";
      window.alert(`Some worktrees couldn't be removed:\n${shown}${more}`);
    }
  }, []);

  const persistWorktreeOrder = useCallback(
    (repoId: string, orderedIds: string[]) => {
      void dispatch("worktree:setOrder", {
        repoId,
        orderedWorktreeIds: orderedIds
      });
    },
    []
  );

  // Compute a repo's worktree badges lazily when its row is expanded.
  const computeRepoState = useCallback((repoId: string) => {
    void dispatch("repo:computeState", { repoId });
  }, []);

  return {
    repos,
    loading,
    setRepoPin,
    setWorktreePin,
    addFolder,
    createWorktree,
    removeWorktrees,
    persistWorktreeOrder,
    computeRepoState
  };
}

