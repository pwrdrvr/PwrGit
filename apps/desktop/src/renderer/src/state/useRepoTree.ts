import { useCallback, useEffect, useState } from "react";
import type { Repo } from "@pwrgit/shared";
import { dispatch, subscribe } from "../lib/pwrgit";

export type RemovalProgress = { done: number; total: number };

export type UseRepoTree = {
  repos: Repo[];
  loading: boolean;
  /** Non-null while a batch removal is in flight (for a progress indicator). */
  removalProgress: RemovalProgress | null;
  setRepoPin: (repoId: string, pinned: boolean) => void;
  setWorktreePin: (worktreeId: string, pinned: boolean) => void;
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
  const [removalProgress, setRemovalProgress] =
    useState<RemovalProgress | null>(null);

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

  // Prune each worktree from the tree as its removal completes — live feedback
  // during a long batch delete, and it advances the progress counter.
  useEffect(() => {
    return subscribe("worktree:removed", ({ worktreeId }) => {
      setRepos((rs) =>
        rs.map((r) => {
          if (!r.worktrees.some((w) => w.id === worktreeId)) return r;
          return {
            ...r,
            worktrees: r.worktrees.filter((w) => w.id !== worktreeId)
          };
        })
      );
      setRemovalProgress((p) =>
        p === null ? p : { ...p, done: p.done + 1 }
      );
    });
  }, []);

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

    // Show the progress indicator for the whole flow (both passes); each
    // worktree:removed event ticks `done` forward.
    setRemovalProgress({ done: 0, total: worktreeIds.length });
    try {
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
    } finally {
      setRemovalProgress(null);
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
    removalProgress,
    setRepoPin,
    setWorktreePin,
    createWorktree,
    removeWorktrees,
    persistWorktreeOrder,
    computeRepoState
  };
}

