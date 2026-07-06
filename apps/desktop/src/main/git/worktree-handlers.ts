import { ok, type WorktreeState } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { DB } from "../persistence/db";
import type { WorktreeStateService } from "./worktree-state";

function stateChanged(a: WorktreeState, b: WorktreeState): boolean {
  return (
    a.dirty !== b.dirty ||
    a.ahead !== b.ahead ||
    a.behind !== b.behind ||
    a.head !== b.head ||
    a.branch !== b.branch ||
    a.behindDefault !== b.behindDefault ||
    a.mergedIntoDefault !== b.mergedIntoDefault ||
    a.divergedFromDefault !== b.divergedFromDefault ||
    a.lastActivityAt !== b.lastActivityAt
  );
}

export type WorktreeRefresher = {
  /** Recompute one worktree; emit worktree:changed only if it actually moved. */
  refreshWorktree: (worktreeId: string) => void;
  /** Recompute all worktrees of a repo; emit repo:changed once when done. */
  refreshRepoWorktrees: (repoId: string) => void;
};

export function createWorktreeRefresher(
  state: WorktreeStateService,
  db: DB
): WorktreeRefresher {
  const refreshWorktree = (worktreeId: string): void => {
    const before = state.getCached(worktreeId);
    void state.compute(worktreeId).then((fresh) => {
      if (fresh === null) return;
      if (before !== null && !stateChanged(before, fresh)) return;
      // The header reads live worktree state (worktree:changed); the sidebar's
      // badges (behind/ahead/merged/…) come from the repo tree, which reloads on
      // repo:changed — so a single-worktree change (pull/fetch/push/commit) must
      // nudge both, or e.g. the ↓N badge goes stale after a fast-forward.
      emitEvent("worktree:changed", { worktreeId });
      const row = db
        .prepare(
          `SELECT r.profile_id AS profile_id
           FROM worktrees w JOIN repos r ON r.id = w.repo_id
           WHERE w.id = ?`
        )
        .get(worktreeId) as { profile_id: string } | undefined;
      if (row !== undefined) {
        emitEvent("repo:changed", { profileId: row.profile_id });
      }
    });
  };

  const refreshRepoWorktrees = (repoId: string): void => {
    const ids = (
      db
        .prepare("SELECT id FROM worktrees WHERE repo_id = ?")
        .all(repoId) as { id: string }[]
    ).map((r) => r.id);
    if (ids.length === 0) return;
    void state.refreshMany(ids).then(() => {
      const repo = db
        .prepare("SELECT profile_id FROM repos WHERE id = ?")
        .get(repoId) as { profile_id: string } | undefined;
      if (repo !== undefined) {
        emitEvent("repo:changed", { profileId: repo.profile_id });
      }
    });
  };

  return { refreshWorktree, refreshRepoWorktrees };
}

export function registerWorktreeHandlers(
  bus: CommandBus,
  state: WorktreeStateService,
  db: DB,
  refresher: WorktreeRefresher,
  onActivate: (worktreeId: string) => void
): void {
  bus.register("worktree:getState", (req) => {
    const cached = state.getCached(req.worktreeId);
    refresher.refreshWorktree(req.worktreeId);
    return ok(cached);
  });

  bus.register("worktree:activate", (req) => {
    const row = db
      .prepare("SELECT id FROM worktrees WHERE id = ?")
      .get(req.worktreeId) as { id: string } | undefined;
    if (row !== undefined) {
      onActivate(row.id);
      refresher.refreshWorktree(row.id);
    }
    return ok(null);
  });

  // Lazily compute a repo's worktree states when its row is expanded, so a
  // 156-worktree repo only pays for git when the user looks at it.
  bus.register("repo:computeState", (req) => {
    refresher.refreshRepoWorktrees(req.repoId);
    return ok(null);
  });
}
