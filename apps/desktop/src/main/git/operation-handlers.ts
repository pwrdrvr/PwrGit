import { err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import { execGit, type GitExec } from "./dugite";
import {
  abortOperation,
  continueOperation,
  readOperationState,
  scanConflictMarkers
} from "./operation-service";
import type { WorktreeRefresher } from "./worktree-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

const notFound = {
  kind: "repo" as const,
  code: "not_found",
  message: "worktree not found"
};

/**
 * Command-bus boundary for in-progress Git operations. This layer reports
 * state and runs Git's own `--continue`/`--abort`; it never resolves a
 * conflict, and never writes to a working file.
 */
export function registerOperationHandlers(
  bus: CommandBus,
  db: DB,
  refresher: WorktreeRefresher,
  operations: WorktreeOperationQueue,
  git: GitExec = execGit
): void {
  const pathOf = (worktreeId: string): string | null =>
    (
      db.prepare("SELECT path FROM worktrees WHERE id = ?").get(worktreeId) as
        | { path: string }
        | undefined
    )?.path ?? null;

  const notifyChanged = (worktreeId: string): void => {
    emitEvent("changes:changed", { worktreeId });
    void refresher.refreshWorktree(worktreeId);
  };

  bus.register("operation:state", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return operations.run(req.worktreeId, () => readOperationState(git, path));
  });

  bus.register("operation:markerScan", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return ok(scanConflictMarkers(path, req.paths));
  });

  bus.register("operation:continue", async (req) => {
    // Identity is applied per-invocation with `-c`; PwrGit never writes
    // repo-local user.email (matches the commit path in changes-handlers).
    const row = db
      .prepare(
        `SELECT w.path AS path, p.email AS email, p.author_name AS author_name
         FROM worktrees w
         JOIN repos r ON r.id = w.repo_id
         JOIN profiles p ON p.id = r.profile_id
         WHERE w.id = ?`
      )
      .get(req.worktreeId) as
      | { path: string; email: string; author_name: string | null }
      | undefined;
    if (row === undefined) return err(notFound);
    const identity =
      row.author_name === null
        ? { email: row.email }
        : { email: row.email, name: row.author_name };

    const result = await operations.run(req.worktreeId, () =>
      continueOperation(git, row.path, req.operation, identity)
    );
    // A sequencer can commit one step and then stop on the next, so the
    // worktree has moved whether or not the call reports success.
    notifyChanged(req.worktreeId);
    if (!result.ok) return result;
    logMain(
      "info",
      "operation",
      `continued ${req.operation} in ${row.path}: ${result.value.kind}`
    );
    return result;
  });

  bus.register("operation:abort", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const result = await operations.run(req.worktreeId, () =>
      abortOperation(git, path, req.operation)
    );
    notifyChanged(req.worktreeId);
    if (!result.ok) return result;
    logMain("info", "operation", `aborted ${req.operation} in ${path}`);
    return ok(null);
  });
}
