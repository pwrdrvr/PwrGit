import { err, ok, type WorktreeState } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { DB } from "../persistence/db";
import type { GitExec } from "./dugite";
import { inspectGitLfs } from "./git-lfs";
import { recordLfsOutcome } from "./git-lfs-notice";
import type { WorktreeStateService } from "./worktree-state";

function stateChanged(a: WorktreeState, b: WorktreeState): boolean {
  return (
    a.hasUpstream !== b.hasUpstream ||
    a.dirty !== b.dirty ||
    a.hasUpstream !== b.hasUpstream ||
    a.ahead !== b.ahead ||
    a.behind !== b.behind ||
    a.head !== b.head ||
    a.branch !== b.branch ||
    a.behindDefault !== b.behindDefault ||
    a.defaultBranch !== b.defaultBranch ||
    a.mergedIntoDefault !== b.mergedIntoDefault ||
    a.divergedFromDefault !== b.divergedFromDefault ||
    a.isDefaultBranch !== b.isDefaultBranch ||
    a.lastActivityAt !== b.lastActivityAt
  );
}

export type WorktreeRefresher = {
  /** Recompute one worktree; emit worktree:changed only if it actually moved. */
  refreshWorktree: (worktreeId: string) => Promise<void>;
  /** Recompute a repo; emit moved worktrees individually, then its tree once. */
  refreshRepoWorktrees: (repoId: string) => void | Promise<void>;
};

export function createWorktreeRefresher(
  state: WorktreeStateService,
  db: DB
): WorktreeRefresher {
  const refreshWorktree = async (worktreeId: string): Promise<void> => {
    const before = state.getCached(worktreeId);
    const fresh = await state.compute(worktreeId);
    if (fresh === null) return;
    if (before !== null && !stateChanged(before, fresh)) return;
    // The header reads live worktree state (worktree:changed); the sidebar's
    // badges (behind/ahead/merged/…) come from the repo tree, which reloads on
    // repo:changed — so a single-worktree change (pull/fetch/push/commit) must
    // nudge both, or e.g. the ↓N badge goes stale after a fast-forward.
    emitEvent("worktree:changed", { worktreeId });
    const row = db
      .prepare(
        `SELECT r.id AS repo_id, r.profile_id AS profile_id
         FROM worktrees w JOIN repos r ON r.id = w.repo_id
         WHERE w.id = ?`
      )
      .get(worktreeId) as
      | { repo_id: string; profile_id: string }
      | undefined;
    if (row !== undefined) {
      emitEvent("graph:changed", { repoId: row.repo_id });
      emitEvent("repo:changed", { profileId: row.profile_id });
    }
  };

  const refreshRepoWorktrees = async (repoId: string): Promise<void> => {
    const ids = (
      db
        .prepare("SELECT id FROM worktrees WHERE repo_id = ?")
        .all(repoId) as { id: string }[]
    ).map((r) => r.id);
    if (ids.length === 0) return;
    const before = new Map(ids.map((id) => [id, state.getCached(id)]));
    await state.refreshMany(ids);
    // A repo refresh is also the user's explicit escape hatch when a watcher
    // misses an external filesystem change. The repo event repaints sidebar
    // badges, but the header, graph, and Changes rail subscribe to the focused
    // worktree event. Publish that event for every snapshot that really moved
    // so all visible surfaces converge on the same refresh.
    for (const id of ids) {
      const fresh = state.getCached(id);
      const previous = before.get(id) ?? null;
      if (
        fresh !== null &&
        (previous === null || stateChanged(previous, fresh))
      ) {
        emitEvent("worktree:changed", { worktreeId: id });
      }
    }
    // Lane data is cached per repo, not per worktree. A sibling HEAD/ref can
    // change the focused graph even when that focused worktree's own snapshot
    // is identical. Invalidate the repo once after every explicit family
    // refresh; this also covers newly discovered refs that do not alter any
    // coarse worktree state.
    emitEvent("graph:changed", { repoId });
    const repo = db
      .prepare("SELECT profile_id FROM repos WHERE id = ?")
      .get(repoId) as { profile_id: string } | undefined;
    if (repo !== undefined) {
      emitEvent("repo:changed", { profileId: repo.profile_id });
    }
  };

  return { refreshWorktree, refreshRepoWorktrees };
}

export function registerWorktreeHandlers(
  bus: CommandBus,
  state: WorktreeStateService,
  db: DB,
  refresher: WorktreeRefresher,
  git: GitExec,
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

  bus.register("repo:getGitLfsStatus", async (req) => {
    const row = db
      .prepare("SELECT path FROM worktrees WHERE id = ? AND repo_id = ?")
      .get(req.worktreeId, req.repoId) as { path: string } | undefined;
    if (row === undefined) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "repo or worktree not found"
      });
    }
    const inspected = await inspectGitLfs(git, row.path);
    if (!inspected.ok) return inspected;
    return ok({
      status: inspected.value,
      announceReady: recordLfsOutcome(db, req.repoId, inspected.value)
    });
  });
}
