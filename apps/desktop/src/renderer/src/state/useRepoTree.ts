import { useCallback, useEffect, useRef, useState } from "react";
import { claimWorktreeOwnership, type Repo, type Res } from "@pwrgit/shared";
import { confirmDialog, notifyDialog } from "../features/shell/dialogs";
import { dispatch, subscribe } from "../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../lib/toast";
import {
  LOADING_READ_STATE,
  READY_READ_STATE,
  type ReadState
} from "./readState";

export type RemovalProgress = { done: number; total: number };

/**
 * Swap re-read repositories into the tree by id. Every other repository keeps
 * its object, so nothing keyed on it (memoized rows, each expanded repo's
 * `repo:refs`) re-runs. A named repository missing from the answer is gone or
 * hidden, so it leaves. Ownership runs over the merged list, as main runs it
 * over a full one (`repo-ownership.ts`), so a fossil duplicate stays single.
 */
export function mergeChangedRepos(
  current: Repo[],
  asked: readonly string[],
  fresh: readonly Repo[]
): Repo[] {
  const byId = new Map(fresh.map((repo) => [repo.id, repo]));
  const named = new Set(asked);
  const merged: Repo[] = [];
  for (const repo of current) {
    if (!named.has(repo.id)) merged.push(repo);
    else {
      const next = byId.get(repo.id);
      if (next !== undefined) merged.push(next);
    }
  }
  return claimWorktreeOwnership(merged);
}

export type RemoveWorktreesOptions = {
  /**
   * The caller has already shown a confirm naming the count — skip this one.
   *
   * The pruner does: its confirm names the repos, the reasons and the bytes,
   * which is strictly more than the generic prompt below, and asking twice
   * trains people to click through both.
   */
  confirmed?: boolean;
  /**
   * Remove without the uncommitted-changes check. Only for a retry of
   * worktrees the user already chose to remove, whose earlier attempt stopped
   * partway — Git now reads PwrGit's own half-finished delete as changes.
   */
  force?: boolean;
  /**
   * Show failures in a notice dialog (the default). A caller that renders the
   * outcome itself — the maintenance dialog does, inline — passes false.
   */
  reportFailures?: boolean;
};

/** What became of each worktree asked for; every id lands in exactly one. */
export type RemoveWorktreesOutcome = {
  removed: string[];
  /** Had changes, and the user chose to keep them (or was never asked). */
  keptDirty: string[];
  /** Each with a sentence for people, and Node's or Git's own words. */
  failed: Res<"worktree:removeMany">["failed"];
};

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
  loadState: ReadState;
  /** Retry a failed repository-list read without discarding the last tree. */
  retry: () => Promise<void>;
  /** Non-null while a batch removal is in flight (for a progress indicator). */
  removalProgress: RemovalProgress | null;
  /** Repo ids currently being reconciled with `git worktree list`. */
  refreshingRepoIds: Set<string>;
  setRepoPin: (repoId: string, pinned: boolean) => void;
  setWorktreePin: (worktreeId: string, pinned: boolean) => void;
  /** Pin a local branch, held by a worktree or not. */
  setBranchPin: (repoId: string, branch: string, pinned: boolean) => void;
  createWorktree: (
    repoId: string,
    branch: string,
    newBranch: boolean,
    startPoint?: string
  ) => Promise<CreateWorktreeResult>;
  removeWorktrees: (
    worktreeIds: string[],
    options?: RemoveWorktreesOptions
  ) => Promise<RemoveWorktreesOutcome>;
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
  /** For callbacks that must name a worktree without re-binding per render. */
  const reposRef = useRef(repos);
  reposRef.current = repos;
  const [loadState, setLoadState] =
    useState<ReadState>(LOADING_READ_STATE);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);
  /** Repositories a `repo:changed` named, waiting for their re-read. */
  const changedRef = useRef(new Set<string>());
  const readingChangedRef = useRef(false);
  const [removalProgress, setRemovalProgress] =
    useState<RemovalProgress | null>(null);
  const [refreshingRepoIds, setRefreshingRepoIds] = useState<Set<string>>(
    new Set()
  );
  /**
   * The repositories this window has already asked the forge about, or null
   * until the first `repo:list` of this profile lands.
   *
   * The mount-time `repo:refreshIdentities` covers every repository that
   * existed then, and nothing else ever asked about one that arrived later.
   * Add folders… and a rescan end with `repo:changed` and nothing more, and
   * until `repo:clone` learned to ask from main, PwrGit's own Clone… did too.
   * This is the net under all of them. Such a row stayed
   * without an identity until a relaunch or a fetch of that repo, so every
   * surface that waits on the forge's answer stayed blank. That included the
   * read-only mark, the fork button on `origin`, and Fork…'s seed. So each
   * reload asks, once, about the rows it has not seen before. Main's TTL,
   * backoff and in-flight de-dupe bound the cost as they do for the mount
   * call. Seeded from the first load rather than asked about, because the
   * mount call already is.
   */
  const identityAskedRef = useRef<Set<string> | null>(null);

  // Always scope to THIS window's profile — with one window per profile, the
  // global "active" profile changes whenever any window opens.
  const reload = useCallback(async (showLoading = false): Promise<void> => {
    if (activeProfileId === null) return;
    const request = ++requestRef.current;
    if (showLoading) setLoadState(LOADING_READ_STATE);
    const r = await dispatch("repo:list", { profileId: activeProfileId });
    if (!mountedRef.current || request !== requestRef.current) return;
    if (r.ok) {
      setRepos(r.value);
      setLoadState(READY_READ_STATE);
      const asked = identityAskedRef.current;
      if (asked === null) {
        identityAskedRef.current = new Set(r.value.map((repo) => repo.id));
      } else {
        const arrived = r.value.filter((repo) => !asked.has(repo.id));
        for (const repo of arrived) asked.add(repo.id);
        const unread = arrived
          .filter((repo) => repo.identity === undefined)
          .map((repo) => repo.id);
        if (unread.length > 0) {
          void dispatch("repo:refreshIdentities", {
            profileId: activeProfileId,
            repoIds: unread
          });
        }
      }
    } else {
      // Keep the last good tree. Pinning, ordering, PR refreshes, and removals
      // update that copy optimistically and a transient read must not erase it.
      setLoadState({ status: "error", message: r.error.message });
    }
  }, [activeProfileId]);

  const retry = useCallback(() => reload(true), [reload]);

  /**
   * Re-read only the repositories a `repo:changed` named. A bulk fetch sends
   * one per repository it finishes; re-reading the whole profile each time
   * replaced every Repo object, so every expanded repository re-ran
   * `repo:refs` once per repository fetched — O(n²) git for one Fetch all.
   *
   * One read at a time: ids that arrive meanwhile join the next batch, so a
   * burst costs a few reads and answers cannot land out of order. A full
   * reload started after a read covers it, so that read's answer is dropped.
   */
  const reloadChanged = useCallback(
    async (repoIds: readonly string[]): Promise<void> => {
      if (activeProfileId === null) return;
      for (const id of repoIds) changedRef.current.add(id);
      if (readingChangedRef.current) return;
      readingChangedRef.current = true;
      try {
        while (changedRef.current.size > 0) {
          const asked = [...changedRef.current];
          changedRef.current.clear();
          const request = requestRef.current;
          const r = await dispatch("repo:list", {
            profileId: activeProfileId,
            repoIds: asked
          });
          if (!mountedRef.current || request !== requestRef.current) continue;
          if (!r.ok) {
            // Same as a failed full read: keep the last good tree.
            setLoadState({ status: "error", message: r.error.message });
            continue;
          }
          setRepos((rs) => mergeChangedRepos(rs, asked, r.value));
        }
      } finally {
        readingChangedRef.current = false;
      }
    },
    [activeProfileId]
  );

  useEffect(() => {
    mountedRef.current = true;
    if (activeProfileId === null) {
      requestRef.current += 1;
      setRepos([]);
      setLoadState(READY_READ_STATE);
      return () => {
        mountedRef.current = false;
        requestRef.current += 1;
      };
    }
    identityAskedRef.current = null;
    void reload(true);
    // Identity refresh is fire-and-forget and TTL-throttled in the main
    // process: stored marks paint with the first repo:list, and anything
    // stale arrives as a repo:identityChanged delta a moment later. Rows that
    // arrive after this are asked about by `reload` — see `identityAskedRef`.
    void dispatch("repo:refreshIdentities", { profileId: activeProfileId });
    const off = subscribe("repo:changed", (p) => {
      if (p.profileId !== activeProfileId) return;
      if (p.repoIds === undefined) void reload();
      else if (p.repoIds.length > 0) void reloadChanged(p.repoIds);
    });
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      changedRef.current.clear();
      off();
    };
  }, [activeProfileId, reload, reloadChanged]);

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

  // Same delta shape, same reason: the identity marks sit on every repo row,
  // and a full repo:list reload to repaint a lock icon would collapse every
  // expanded repo in the sidebar.
  useEffect(() => {
    return subscribe("repo:identityChanged", ({ identities }) => {
      if (identities.length === 0) return;
      const byRepo = new Map(
        identities.map(({ repoId, identity }) => [repoId, identity])
      );
      setRepos((rs) =>
        rs.map((r) => {
          const identity = byRepo.get(r.id);
          return identity === undefined ? r : { ...r, identity };
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

  const setBranchPin = useCallback(
    (repoId: string, branch: string, pinned: boolean) => {
      setRepos((rs) =>
        rs.map((r) => {
          if (r.id !== repoId) return r;
          // Mirror RepoIndexer.setBranchPinned: a holding worktree is pinned
          // directly; with none, the branch joins (or leaves) the list.
          const held = r.worktrees.some((w) => w.branch === branch);
          const worktrees = r.worktrees.map((w) =>
            w.branch === branch ? { ...w, pinned } : w
          );
          const rest = (r.pinnedBranches ?? []).filter((b) => b !== branch);
          const pinnedBranches =
            pinned && !held ? [...rest, branch].sort() : rest;
          const { pinnedBranches: _old, ...without } = r;
          return {
            ...without,
            worktrees,
            ...(pinnedBranches.length > 0 ? { pinnedBranches } : {})
          };
        })
      );
      void dispatch("branch:setPin", { repoId, branch, pinned });
    },
    []
  );

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

  const removeWorktrees = useCallback(async (
    worktreeIds: string[],
    options: RemoveWorktreesOptions = {}
  ): Promise<RemoveWorktreesOutcome> => {
    const outcome: RemoveWorktreesOutcome = { removed: [], keptDirty: [], failed: [] };
    if (worktreeIds.length === 0) return outcome;
    // Removing >1 is a bulk destructive action → confirm up front. A single
    // removal (trash icon / context menu) goes straight to the attempt and
    // only prompts if that worktree is dirty, matching the prior behaviour.
    if (worktreeIds.length > 1 && options.confirmed !== true) {
      const go = await confirmDialog({
        title: `Remove ${worktreeIds.length} worktrees?`,
        message:
          "Their working directories will be deleted. Branches and commits are kept.",
        confirmLabel: `Remove ${worktreeIds.length}`,
        danger: true
      });
      if (!go) return outcome;
    }
    const report = options.reportFailures !== false;

    // Show the progress indicator for the whole flow (both passes); each
    // worktree:removed event ticks `done` forward.
    setRemovalProgress({ done: 0, total: worktreeIds.length });
    try {
      const first = await dispatch("worktree:removeMany", {
        worktreeIds,
        force: options.force === true
      });
      if (!first.ok) {
        outcome.failed = worktreeIds.map((id) => ({ id, message: first.error.message }));
        if (report) {
          await notifyDialog({
            title: "Couldn't remove",
            message: first.error.message
          });
        }
        return outcome;
      }
      const { dirty } = first.value;
      outcome.removed.push(...first.value.removed);
      outcome.failed.push(...first.value.failed);

      if (dirty.length > 0) {
        const have = dirty.length === 1 ? "worktree has" : "worktrees have";
        const them = dirty.length === 1 ? "it" : "them";
        const force = await confirmDialog({
          title: "Uncommitted changes",
          message: `${dirty.length} ${have} uncommitted changes. Remove ${them} anyway?`,
          confirmLabel: "Remove anyway",
          danger: true
        });
        if (!force) {
          outcome.keptDirty.push(...dirty);
        } else {
          const forced = await dispatch("worktree:removeMany", {
            worktreeIds: dirty,
            force: true
          });
          if (forced.ok) {
            outcome.removed.push(...forced.value.removed);
            outcome.failed.push(...forced.value.failed);
            // A forced pass never reports dirty; keep the count honest anyway.
            outcome.keptDirty.push(...forced.value.dirty);
          } else {
            outcome.failed.push(
              ...dirty.map((id) => ({ id, message: forced.error.message }))
            );
            if (report) {
              await notifyDialog({
                title: "Couldn't remove",
                message: forced.error.message
              });
            }
          }
        }
      }

      if (report && outcome.failed.length > 0) {
        const failures = outcome.failed;
        // Messages no longer carry the path (the maintenance card shows it
        // beside them), so this notice names each worktree itself.
        const names = new Map(
          reposRef.current.flatMap((repo) =>
            repo.worktrees.map((w) => [w.id, `${repo.name} · ${w.branch || w.path}`] as const)
          )
        );
        const shown = failures
          .slice(0, 6)
          .map((f) => {
            const name = names.get(f.id);
            return name === undefined ? `• ${f.message}` : `• ${name}: ${f.message}`;
          })
          .join("\n");
        const more =
          failures.length > 6 ? `\n…and ${failures.length - 6} more` : "";
        await notifyDialog({
          title: "Some worktrees couldn't be removed",
          message: `${shown}${more}`
        });
      }
      return outcome;
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
        // The repo is named by its chip now, so the title says only what
        // happened — the name in both read as a stutter.
        showErrorToast({
          title: "Couldn't refresh worktrees",
          message: result.error.message,
          subject: { repoId: repo.id }
        });
        return;
      }

      // The row's path turned out to be a linked worktree, so it's gone from
      // the sidebar. Name the repo that owns it rather than claiming that repo
      // is already listed — it only gets indexed if a scan root reaches it.
      // No chip: the repo it would go to is the one just removed.
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
        title: "Worktrees refreshed",
        subject: { repoId: repo.id },
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
    loadState,
    retry,
    removalProgress,
    refreshingRepoIds,
    setRepoPin,
    setWorktreePin,
    setBranchPin,
    createWorktree,
    removeWorktrees,
    persistWorktreeOrder,
    persistRepoOrder,
    computeRepoState,
    refreshPullRequest,
    refreshRepoWorktrees
  };
}
