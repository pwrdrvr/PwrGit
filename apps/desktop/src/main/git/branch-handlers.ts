import { err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import { execGit } from "./dugite";
import { listBranches, switchBranch } from "./git-service";
import type { RepoIndexer } from "./repo-indexer";
import type { WorktreeRefresher } from "./worktree-handlers";

const notFound = {
  kind: "repo" as const,
  code: "not_found",
  message: "worktree not found"
};

type Row = { path: string; repo_id: string; profile_id: string };

export function registerBranchHandlers(
  bus: CommandBus,
  db: DB,
  indexer: RepoIndexer,
  refresher: WorktreeRefresher
): void {
  const rowOf = (worktreeId: string): Row | undefined =>
    db
      .prepare(
        `SELECT w.path AS path, w.repo_id AS repo_id, r.profile_id AS profile_id
         FROM worktrees w JOIN repos r ON r.id = w.repo_id
         WHERE w.id = ?`
      )
      .get(worktreeId) as Row | undefined;

  bus.register("branch:list", async (req) => {
    const row = rowOf(req.worktreeId);
    if (row === undefined) return err(notFound);
    return listBranches(execGit, row.path);
  });

  bus.register("branch:switch", async (req) => {
    const row = rowOf(req.worktreeId);
    if (row === undefined) return err(notFound);
    const result = await switchBranch(execGit, row.path, req.branch);
    if (!result.ok) return result;
    logMain("info", "branch", `switched ${row.path} to ${req.branch}`);
    // The worktree's branch column is now stale — re-list (branch is keyed by
    // path, so the id is stable) and recompute state so the header, graph, and
    // sidebar all reflect the new checkout.
    await indexer.refreshRepoWorktrees(row.repo_id);
    refresher.refreshWorktree(req.worktreeId);
    emitEvent("repo:changed", { profileId: row.profile_id });
    return ok(null);
  });
}
