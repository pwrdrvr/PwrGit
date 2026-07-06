import { err, ok, type PwrGitError } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { execGit } from "./dugite";
import { fetchRemote, pullFastForward, pushRemote } from "./git-service";
import type { WorktreeRefresher } from "./worktree-handlers";

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

  bus.register("remote:fetch", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const result = await fetchRemote(execGit, path);
    if (!result.ok) return result;
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });

  bus.register("remote:pull", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const result = await pullFastForward(execGit, path);
    if (result.ok) refresher.refreshWorktree(req.worktreeId);
    return result;
  });

  bus.register("remote:push", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const result = await pushRemote(execGit, path);
    if (!result.ok) return result;
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });
}
