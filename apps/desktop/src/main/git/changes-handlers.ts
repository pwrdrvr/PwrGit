import { err, ok, type Result } from "@pwrgit/shared";
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
  readCommit,
  readChanges,
  stagePaths,
  unstagePaths
} from "./git-service";
import { appendToIgnoreFile } from "./gitignore";
import { ignoreDestinations, patternForChoice, readIgnoredSummary, readIgnoreOptions, validIgnorePath } from "./ignore-discovery";
import { readImagePreview } from "./image-preview";
import { applyPartialSelection, partialFileDiff } from "./partial-staging";
import type { WorktreeRefresher } from "./worktree-handlers";
import { liveWorktreePath, worktreeMissingError } from "./worktree-liveness";
import { WorktreeOperationQueue } from "./worktree-operation-queue";
import { recordHookReceipts } from "./repository-setup";

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

  // Not-found and a gone checkout both refuse here, in the one lookup every
  // handler goes through, so no handler can reach git without the check.
  const pathOf = (worktreeId: string): Result<string> =>
    liveWorktreePath(db, worktreeId);

  bus.register("changes:list", async (req) => {
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    const path = live.value;
    return operations.run(req.worktreeId, () => readChanges(execGit, path));
  });

  bus.register("changes:stage", async (req) => {
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    const path = live.value;
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
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    const path = live.value;
    const result = await operations.run(req.worktreeId, () =>
      unstagePaths(execGit, path, req.paths)
    );
    notifyChanged(req.worktreeId);
    if (!result.ok) return result;
    return ok(null);
  });

  bus.register("changes:applySelection", async (req) => {
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    const path = live.value;
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
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    const path = live.value;
    const result = await operations.run(req.worktreeId, () =>
      discardPaths(execGit, path, req.paths)
    );
    // Announce either way: discarding is restore-then-clean over batched
    // pathspecs, so a failure part-way still moved the working tree.
    notifyChanged(req.worktreeId);
    if (!result.ok) return result;
    return ok(null);
  });

  bus.register("changes:ignoreOptions", async (req) => {
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    return operations.run(req.worktreeId, () => readIgnoreOptions(execGit, live.value, req.path, req.directory));
  });

  bus.register("changes:ignoredSummary", async (req) => {
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    return operations.run(req.worktreeId, () => readIgnoredSummary(execGit, live.value));
  });

  bus.register("changes:ignore", async (req) => {
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    if (!validIgnorePath(req.path)) {
      return err({
        kind: "validation",
        code: "invalid_path",
        message: "Choose a path inside this worktree."
      });
    }
    const pattern = patternForChoice(req.path, req.directory, req.pattern);
    if (pattern === null) return err({ kind: "validation", code: "invalid_pattern", message: "That pattern is not available for this path." });
    const row = db.prepare("SELECT repo_id AS repoId FROM worktrees WHERE id = ?").get(req.worktreeId) as { repoId: string } | undefined;
    if (row === undefined) return err(notFound);
    const result = await operations.runRepository(row.repoId, async () => {
      const locations = await ignoreDestinations(execGit, live.value);
      if (!locations.ok) return locations;
      const target = locations.value.destinations.find((item) => item.destination === req.destination);
      if (target === undefined) return err({ kind: "validation" as const, code: "invalid_destination", message: "Choose an ignore destination." });
      return appendToIgnoreFile(target.path, [pattern]);
    });
    if (!result.ok) return result;
    if (result.value.added.length > 0) {
      logMain(
        "info",
        "changes",
        `ignored in ${result.value.targetPath}:`,
        result.value.added.join(", ")
      );
      // The ignored files leave the change set, which the coarse worktree
      // state can miss entirely — an untracked folder is one status line
      // before, and .gitignore is one status line after.
      notifyChanged(req.worktreeId);
      // info/exclude and the global file are not per-worktree: every sibling
      // checkout of this clone (and, for global, every checkout) just lost
      // the same untracked files, and none of their watchers saw it happen.
      if (req.destination !== "gitignore") {
        const siblings = (req.destination === "exclude"
          ? db.prepare("SELECT id FROM worktrees WHERE repo_id = ? AND missing = 0").all(row.repoId)
          : db.prepare("SELECT id FROM worktrees WHERE missing = 0").all()) as { id: string }[];
        for (const sibling of siblings) {
          if (sibling.id !== req.worktreeId) emitEvent("changes:changed", { worktreeId: sibling.id });
        }
      }
    }
    return ok(result.value);
  });

  bus.register("changes:discardAll", async (req) => {
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    const path = live.value;
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
        `SELECT w.path AS path, w.missing AS missing, p.email AS email,
                p.author_name AS author_name
         FROM worktrees w
         JOIN repos r ON r.id = w.repo_id
         JOIN profiles p ON p.id = r.profile_id
         WHERE w.id = ?`
      )
      .get(req.worktreeId) as
      | { path: string; missing?: number; email: string; author_name: string | null }
      | undefined;
    if (row === undefined) return err(notFound);
    if (row.missing === 1) return err(worktreeMissingError(row.path));

    const identity: CommitIdentity =
      row.author_name !== null
        ? { email: row.email, name: row.author_name }
        : { email: row.email };

    const result = await operations.run(req.worktreeId, () =>
      commitChanges(execGit, row.path, req.message, identity, {
        amend: req.amend ?? false,
        noVerify: req.noVerify ?? false
      })
    );
    if (!result.ok) {
      if (result.error.hook !== undefined) await recordHookReceipts(execGit, row.path, [result.error.hook]);
      notifyChanged(req.worktreeId);
      return result;
    }
    await recordHookReceipts(execGit, row.path, result.value.hooks);
    logMain(
      "info",
      "commit",
      `${req.amend === true ? "amended" : "committed"} in ${row.path}:`,
      req.message.split("\n")[0]
    );
    notifyChanged(req.worktreeId);
    return ok(result.value);
  });

  bus.register("diff:fileSelection", async (req) => {
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    const path = live.value;
    return operations.run(req.worktreeId, () =>
      partialFileDiff(execGit, execGitBinary, path, req.path, req.staged)
    );
  });

  bus.register("diff:commit", async (req) => {
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    const path = live.value;
    return commitDiff(execGit, path, req.hash);
  });

  bus.register("commit:lookup", async (req) => {
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    const path = live.value;
    return readCommit(execGit, path, req.hash);
  });

  bus.register("commit:files", async (req) => {
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    const path = live.value;
    return commitFiles(execGit, path, req.hash);
  });

  bus.register("commit:stats", async (req) => {
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    const path = live.value;
    return commitStats(execGit, path, req.hash);
  });

  bus.register("diff:commitFile", async (req) => {
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    const path = live.value;
    return commitFileDiff(execGit, path, req.hash, req.path);
  });

  bus.register("diff:image", async (req) => {
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    const path = live.value;
    return readImagePreview(execGit, execGitBinary, path, req.path, req.rev);
  });
}
