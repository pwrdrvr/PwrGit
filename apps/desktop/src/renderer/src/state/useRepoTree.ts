import { useCallback, useEffect, useState } from "react";
import type { Repo } from "@pwrgit/shared";
import { confirmDialog, notifyDialog } from "../features/shell/dialogs";
import { dispatch, subscribe } from "../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../lib/toast";

export type RemovalProgress = { done: number; total: number };

/**
 * Creating a worktree is only half of what the user asked for — they want to
 * be *in* it. Carry the new worktree's id (null when the post-create refresh
 * didn't list it) so the caller can move the selection there.
 */
export type CreateWorktreeResult =
  | { ok: true; worktreeId: string | null }
  | { ok: false; message: string };

export type UseRepoTree = {
  repos: Repo[];
  loading: boolean;
  /** Non-null while a batch removal is in flight (for a progress indicator). */
  removalProgress: RemovalProgress | null;
  /** Repo ids currently being reconciled with `git worktree list`. */
  refreshingRepoIds: Set<string>;
  setRepoPin: (repoId: string, pinned: boolean) => void;
  setWorktreePin: (worktreeId: string, pinned: boolean) => void;
  createWorktree: (
    repoId: string,
    branch: string,
    newBranch: boolean,
    startPoint?: string
  ) => Promise<CreateWorktreeResult>;
  removeWorktrees: (worktreeIds: string[]) => Promise<void>;
  persistWorktreeOrder: (repoId: string, orderedIds: string[]) => void;
  persistRepoOrder: (orderedRepoIds: string[]) => void;
  computeRepoState: (repoId: string) => void;
  refreshPullRequest: (
    repoId: string,
    branch: string,
    trigger: "scheduled" | "user"
  ) => void;
  refreshRepoWorktrees: (repo: Repo) => Promise<void>;
};

/** Repos for the active profile, kept in sync with `repo:changed`. */
export function useRepoTree(activeProfileId: string | null): UseRepoTree {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [removalProgress, setRemovalProgress] =
    useState<RemovalProgress | null>(null);
  const [refreshingRepoIds, setRefreshingRepoIds] = useState<Set<string>>(
    new Set()
  );

  // Always scope to THIS window's profile — with one window per profile, the
  // global "active" profile changes whenever any window opens.
  const reload = useCallback(async () => {
    if (activeProfileId === null) return;
    const r = await dispatch("repo:list", { profileId: activeProfileId });
    if (r.ok) setRepos(r.value);
    setLoading(false);
  }, [activeProfileId]);

  useEffect(() => {
    if (activeProfileId === null) {
      setRepos([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    void reload();
    const off = subscribe("repo:changed", (p) => {
      if (p.profileId === activeProfileId) void reload();
    });
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

  // Patch PR status onto the tree in place from the targeted delta — every
  // surface reading the tree updates together, no full repo:list reload.
  useEffect(() => {
    return subscribe("pr:changed", ({ repoId, prs }) => {
      const has = (b: string): boolean =>
        Object.prototype.hasOwnProperty.call(prs, b);
      setRepos((rs) =>
        rs.map((r) => {
          if (r.id !== repoId) return r;
          return {
            ...r,
            worktrees: r.worktrees.map((w) => {
              if (!has(w.branch)) return w;
              const pr = prs[w.branch];
              const next = { ...w };
              if (pr) next.pr = pr;
              else delete next.pr;
              return next;
            })
          };
        })
      );
    });
  }, []);

  const setRepoPin = useCallback((repoId: string, pinned: boolean) => {
    setRepos((rs) =>
      rs.map((r) => {
        if (r.id !== repoId) return r;
        // Mirror the main process, which drops custom_order on unpin (see
        // RepoIndexer.setRepoPinned) — otherwise the optimistic row keeps a
        // stale index until the next reload and sorts by it on re-pin.
        if (pinned) return { ...r, pinned };
        const { order: _dropped, ...rest } = r;
        return { ...rest, pinned };
      })
    );
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
    async (
      repoId: string,
      branch: string,
      newBranch: boolean,
      startPoint?: string
    ): Promise<CreateWorktreeResult> => {
      const r = await dispatch("worktree:create", {
        repoId,
        branch,
        newBranch,
        ...(startPoint === undefined ? {} : { startPoint })
      });
      return r.ok
        ? { ok: true, worktreeId: r.value.worktreeId }
        : { ok: false, message: r.error.message };
    },
    []
  );

  const removeWorktrees = useCallback(async (worktreeIds: string[]) => {
    if (worktreeIds.length === 0) return;
    // Removing >1 is a bulk destructive action → confirm up front. A single
    // removal (trash icon / context menu) goes straight to the attempt and
    // only prompts if that worktree is dirty, matching the prior behaviour.
    if (worktreeIds.length > 1) {
      const go = await confirmDialog({
        title: `Remove ${worktreeIds.length} worktrees?`,
        message:
          "Their working directories will be deleted. Branches and commits are kept.",
        confirmLabel: `Remove ${worktreeIds.length}`,
        danger: true
      });
      if (!go) return;
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
        await notifyDialog({
          title: "Couldn't remove",
          message: first.error.message
        });
        return;
      }
      const { dirty } = first.value;
      const failures = [...first.value.failed];

      if (dirty.length > 0) {
        const have = dirty.length === 1 ? "worktree has" : "worktrees have";
        const them = dirty.length === 1 ? "it" : "them";
        const force = await confirmDialog({
          title: "Uncommitted changes",
          message: `${dirty.length} ${have} uncommitted changes. Remove ${them} anyway?`,
          confirmLabel: "Remove anyway",
          danger: true
        });
        if (force) {
          const forced = await dispatch("worktree:removeMany", {
            worktreeIds: dirty,
            force: true
          });
          if (forced.ok) failures.push(...forced.value.failed);
          else
            await notifyDialog({
              title: "Couldn't remove",
              message: forced.error.message
            });
        }
      }

      if (failures.length > 0) {
        const shown = failures
          .slice(0, 6)
          .map((f) => `• ${f.message}`)
          .join("\n");
        const more =
          failures.length > 6 ? `\n…and ${failures.length - 6} more` : "";
        await notifyDialog({
          title: "Some worktrees couldn't be removed",
          message: `${shown}${more}`
        });
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

  // Apply the new order locally before the round-trip: `repo:changed` doesn't
  // fire for an ordering write (nothing about the repos themselves changed), so
  // without this the dropped row would snap back until the next reload.
  const persistRepoOrder = useCallback(
    (orderedRepoIds: string[]) => {
      if (activeProfileId === null) return;
      setRepos((rs) => {
        const rank = new Map(orderedRepoIds.map((id, i) => [id, i]));
        return [...rs].map((r) => {
          const at = rank.get(r.id);
          return at === undefined ? r : { ...r, order: at };
        });
      });
      void dispatch("repo:setOrder", {
        profileId: activeProfileId,
        orderedRepoIds
      });
    },
    [activeProfileId]
  );

  // Compute a repo's worktree badges lazily when its row is expanded, and
  // refresh GitHub PR status (TTL-throttled in the main process).
  const computeRepoState = useCallback((repoId: string) => {
    void dispatch("repo:computeState", { repoId });
    void dispatch("pr:refresh", { repoId });
  }, []);

  const refreshPullRequest = useCallback(
    (repoId: string, branch: string, trigger: "scheduled" | "user") => {
      void dispatch("pr:refresh", { repoId, branches: [branch], trigger });
    },
    []
  );

  const refreshRepoWorktrees = useCallback(async (repo: Repo) => {
    setRefreshingRepoIds((ids) => new Set(ids).add(repo.id));
    try {
      const result = await dispatch("repo:refreshWorktrees", {
        repoId: repo.id
      });
      if (!result.ok) {
        showErrorToast({
          title: `Couldn't refresh ${repo.name}`,
          message: result.error.message
        });
        return;
      }

      // The row's path turned out to be a linked worktree, so it's gone from
      // the sidebar. Name the repo that owns it rather than claiming that repo
      // is already listed — it only gets indexed if a scan root reaches it.
      if (result.value.outcome === "deindexed") {
        showInfoToast({
          title: `Removed ${repo.name} from the list`,
          message: `It's a worktree of ${result.value.ownerPath}, not a repo of its own.`
        });
        return;
      }

      const { added, removed, updated } = result.value;
      const changes = [
        added > 0 ? `${added} discovered` : null,
        updated > 0 ? `${updated} updated` : null,
        removed > 0 ? `${removed} removed` : null
      ].filter((part): part is string => part !== null);
      showInfoToast({
        title: `${repo.name} worktrees refreshed`,
        message:
          changes.length > 0
            ? changes.join(" · ")
            : "Worktree list is up to date."
      });
    } finally {
      setRefreshingRepoIds((ids) => {
        const next = new Set(ids);
        next.delete(repo.id);
        return next;
      });
    }
  }, []);

  return {
    repos,
    loading,
    removalProgress,
    refreshingRepoIds,
    setRepoPin,
    setWorktreePin,
    createWorktree,
    removeWorktrees,
    persistWorktreeOrder,
    persistRepoOrder,
    computeRepoState,
    refreshPullRequest,
    refreshRepoWorktrees
  };
}
