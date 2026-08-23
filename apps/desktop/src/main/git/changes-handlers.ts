import { err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import { execGit, execGitBinary } from "./dugite";
import {
  commitChanges,
  commitDiff,
  commitFileDiff,
  commitFiles,
  commitStats,
  type CommitIdentity,
  discardAllChanges,
  discardPaths,
  fileDiff,
  readCommit,
  readChanges,
  stagePaths,
  unstagePaths
} from "./git-service";
import { appendToGitignore, toGitignorePattern } from "./gitignore";
import { readImagePreview } from "./image-preview";
import { applyPartialSelection, partialFileDiff } from "./partial-staging";
import type { WorktreeRefresher } from "./worktree-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

const notFound = {
  kind: "repo" as const,
  code: "not_found",
  message: "worktree not found"
};

export function registerChangesHandlers(
  bus: CommandBus,
  db: DB,
  refresher: WorktreeRefresher,
  operations: WorktreeOperationQueue
): void {
  /**
   * Announce that a worktree's index/working tree moved. `changes:changed` is
   * unconditional because staging or unstaging a file changes nothing the
   * worktree refresher compares (same dirty line count, same head), so relying
   * on `worktree:changed` alone leaves the Changes list stale — the file's
   * stage button looks dead. The refresher still runs for the coarse badges.
   */
  const notifyChanged = (worktreeId: string): void => {
    emitEvent("changes:changed", { worktreeId });
    void refresher.refreshWorktree(worktreeId);
  };

  const pathOf = (worktreeId: string): string | null =>
    (
      db.prepare("SELECT path FROM worktrees WHERE id = ?").get(worktreeId) as
        | { path: string }
        | undefined
    )?.path ?? null;

  bus.register("changes:list", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return operations.run(req.worktreeId, () => readChanges(execGit, path));
  });

  bus.register("changes:stage", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const result = await operations.run(req.worktreeId, () =>
      stagePaths(execGit, path, req.paths)
    );
    // Announce either way. Git validates a whole pathspec list before touching
    // the index, so one run is atomic — but a list longer than one batch is
    // several runs, and a failure in a later one leaves the earlier ones
    // applied. Staying quiet there would leave the list showing files as
    // unstaged that are already in the index.
    notifyChanged(req.worktreeId);
    if (!result.ok) return result;
    return ok(null);
  });

  bus.register("changes:unstage", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const result = await operations.run(req.worktreeId, () =>
      unstagePaths(execGit, path, req.paths)
    );
    notifyChanged(req.worktreeId);
    if (!result.ok) return result;
    return ok(null);
  });

  bus.register("changes:applySelection", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const result = await operations.run(req.worktreeId, () =>
      applyPartialSelection(
        execGit,
        execGitBinary,
        path,
        req.path,
        req.staged,
        req.fingerprint,
        req.lineIds
      )
    );
    // A stale result means an external tool moved this exact file or index;
    // repaint from Git immediately. A successful apply also moves only the
    // index, which the coarse worktree refresher cannot otherwise observe.
    notifyChanged(req.worktreeId);
    if (!result.ok) return result;
    return ok(null);
  });

  bus.register("changes:discard", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const result = await operations.run(req.worktreeId, () =>
      discardPaths(execGit, path, req.paths)
    );
    // Announce either way: discarding is restore-then-clean over batched
    // pathspecs, so a failure part-way still moved the working tree.
    notifyChanged(req.worktreeId);
    if (!result.ok) return result;
    return ok(null);
  });

  bus.register("changes:ignore", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    if (req.entries.length === 0) {
      return err({
        kind: "validation",
        code: "no_patterns",
        message: "Nothing to ignore"
      });
    }
    const result = appendToGitignore(
      path,
      req.entries.map((entry) =>
        toGitignorePattern(entry.path, { directory: entry.directory })
      )
    );
    if (!result.ok) return result;
    if (result.value.added.length > 0) {
      logMain(
        "info",
        "changes",
        `ignored in ${path}:`,
        result.value.added.join(", ")
      );
      // The ignored files leave the change set, which the coarse worktree
      // state can miss entirely — an untracked folder is one status line
      // before, and .gitignore is one status line after.
      notifyChanged(req.worktreeId);
    }
    return ok(result.value);
  });

  bus.register("changes:discardAll", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const result = await operations.run(req.worktreeId, () =>
      discardAllChanges(execGit, path)
    );
    if (!result.ok) return result;
    notifyChanged(req.worktreeId);
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

    const result = await operations.run(req.worktreeId, () =>
      commitChanges(execGit, row.path, req.message, identity, {
        amend: req.amend ?? false
      })
    );
    if (!result.ok) return result;
    logMain(
      "info",
      "commit",
      `${req.amend === true ? "amended" : "committed"} in ${row.path}:`,
      req.message.split("\n")[0]
    );
    notifyChanged(req.worktreeId);
    return ok(null);
  });

  bus.register("diff:file", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return fileDiff(execGit, path, req.path, req.staged);
  });

  bus.register("diff:fileSelection", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return operations.run(req.worktreeId, () =>
      partialFileDiff(execGit, execGitBinary, path, req.path, req.staged)
    );
  });

  bus.register("diff:commit", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return commitDiff(execGit, path, req.hash);
  });

  bus.register("commit:lookup", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return readCommit(execGit, path, req.hash);
  });

  bus.register("commit:files", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return commitFiles(execGit, path, req.hash);
  });

  bus.register("commit:stats", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return commitStats(execGit, path, req.hash);
  });

  bus.register("diff:commitFile", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return commitFileDiff(execGit, path, req.hash, req.path);
  });

  bus.register("diff:image", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return readImagePreview(execGit, execGitBinary, path, req.path, req.rev);
  });
}
