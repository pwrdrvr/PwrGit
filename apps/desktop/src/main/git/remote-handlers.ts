import { err, ok, type PwrGitError } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import { execGit } from "./dugite";
import { fetchRemote, pullFastForward, pushRemote } from "./git-service";
import type { WorktreeRefresher } from "./worktree-handlers";

const seconds = (startedAt: number): string =>
  `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

const notFound: PwrGitError = {
  kind: "repo",
  code: "not_found",
  message: "worktree not found"
};

export function registerRemoteHandlers(
  bus: CommandBus,
  db: DB,
  refresher: WorktreeRefresher
): void {
  const pathOf = (worktreeId: string): string | null =>
    (
      db.prepare("SELECT path FROM worktrees WHERE id = ?").get(worktreeId) as
        | { path: string }
        | undefined
    )?.path ?? null;

  // Successes log at info with path + duration; failures are already logged
  // by the command bus — together the Logs window tells the whole sync story.
  bus.register("remote:fetch", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const startedAt = Date.now();
    const result = await fetchRemote(execGit, path);
    if (!result.ok) return result;
    logMain("info", "remote", `fetched ${path} (${seconds(startedAt)})`);
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });

  bus.register("remote:pull", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const startedAt = Date.now();
    const result = await pullFastForward(execGit, path);
    if (result.ok) {
      const { stashed, reappliedWithConflicts } = result.value;
      const outcome = reappliedWithConflicts
        ? "fast-forwarded, stash reapplied WITH CONFLICTS"
        : stashed
          ? "fast-forwarded, stashed changes reapplied"
          : "fast-forwarded";
      logMain("info", "remote", `pulled ${path}: ${outcome} (${seconds(startedAt)})`);
      refresher.refreshWorktree(req.worktreeId);
    }
    return result;
  });

  bus.register("remote:push", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const startedAt = Date.now();
    const result = await pushRemote(execGit, path);
    if (!result.ok) return result;
    logMain("info", "remote", `pushed ${path} (${seconds(startedAt)})`);
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });
}
