import { err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { execGit } from "./dugite";
import {
  commitChanges,
  commitDiff,
  commitFileDiff,
  commitFiles,
  type CommitIdentity,
  discardPath,
  fileDiff,
  readChanges,
  stagePath,
  unstagePath
} from "./git-service";
import type { WorktreeRefresher } from "./worktree-handlers";

const notFound = {
  kind: "repo" as const,
  code: "not_found",
  message: "worktree not found"
};

export function registerChangesHandlers(
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

  bus.register("changes:list", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return readChanges(execGit, path);
  });

  bus.register("changes:stage", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const result = await stagePath(execGit, path, req.path);
    if (!result.ok) return result;
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });

  bus.register("changes:unstage", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const result = await unstagePath(execGit, path, req.path);
    if (!result.ok) return result;
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });

  bus.register("changes:discard", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const result = await discardPath(execGit, path, req.path);
    if (!result.ok) return result;
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });

  bus.register("changes:commit", async (req) => {
    if (req.message.trim() === "") {
      return err({
        kind: "validation",
        code: "empty_message",
        message: "Commit message is required"
      });
    }
    // Identity from the repo's profile — a per-commit override, never written
    // to repo config.
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

    const identity: CommitIdentity =
      row.author_name !== null
        ? { email: row.email, name: row.author_name }
        : { email: row.email };

    const result = await commitChanges(execGit, row.path, req.message, identity, {
      amend: req.amend ?? false
    });
    if (!result.ok) return result;
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });

  bus.register("diff:file", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return fileDiff(execGit, path, req.path, req.staged);
  });

  bus.register("diff:commit", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return commitDiff(execGit, path, req.hash);
  });

  bus.register("commit:files", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return commitFiles(execGit, path, req.hash);
  });

  bus.register("diff:commitFile", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return commitFileDiff(execGit, path, req.hash, req.path);
  });
}
