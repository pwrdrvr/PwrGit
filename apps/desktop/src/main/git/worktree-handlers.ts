import { ok, type WorktreeState } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { DB } from "../persistence/db";
import type { WorktreeWatchers } from "./watchers";
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
      if (before === null || stateChanged(before, fresh)) {
        emitEvent("worktree:changed", { worktreeId });
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
  watchers: WorktreeWatchers,
  db: DB,
  refresher: WorktreeRefresher
): void {
  bus.register("worktree:getState", (req) => {
    const cached = state.getCached(req.worktreeId);
    refresher.refreshWorktree(req.worktreeId);
    return ok(cached);
  });

  bus.register("worktree:activate", (req) => {
    const row = db
      .prepare(
        `SELECT w.id AS id, w.path AS path, r.id AS repo_id, r.path AS repo_path
         FROM worktrees w JOIN repos r ON r.id = w.repo_id
         WHERE w.id = ?`
      )
      .get(req.worktreeId) as
      | { id: string; path: string; repo_id: string; repo_path: string }
      | undefined;
    if (row !== undefined) {
      // Watch only what's being looked at now (single active repo + worktree).
      watchers.watchActiveRepo(row.repo_id, row.repo_path);
      watchers.watchActiveWorktree(row.id, row.path);
      refresher.refreshWorktree(row.id);
    }
    return ok(null);
  });
}
