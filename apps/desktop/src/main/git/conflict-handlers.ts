import { shell } from "electron";
import { err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import {
  execGit,
  execGitBinary,
  type GitExec,
  type GitExecBinary
} from "./dugite";
import {
  abortConflictOperation,
  acceptConflictSide,
  conflictWorkingPath,
  continueConflictOperation,
  inspectConflict,
  readConflictState,
  stageConflictResolution,
  writeConflictWorkingFile
} from "./conflict-service";
import type { WorktreeRefresher } from "./worktree-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

export type ConflictHandlerDependencies = {
  git: GitExec;
  gitBinary: GitExecBinary;
  openPath: (path: string) => Promise<string>;
};

const DEFAULT_DEPENDENCIES: ConflictHandlerDependencies = {
  git: execGit,
  gitBinary: execGitBinary,
  openPath: (path) => shell.openPath(path)
};

const notFound = {
  kind: "repo" as const,
  code: "not_found",
  message: "Worktree not found."
};

/** Command-bus boundary for conservative, path-scoped conflict operations. */
export function registerConflictHandlers(
  bus: CommandBus,
  db: DB,
  refresher: WorktreeRefresher,
  operations: WorktreeOperationQueue,
  dependencyOverrides: Partial<ConflictHandlerDependencies> = {}
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
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

  bus.register("conflict:state", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return operations.run(req.worktreeId, () =>
      readConflictState(dependencies.git, path)
    );
  });

  bus.register("conflict:inspect", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return operations.run(req.worktreeId, () =>
      inspectConflict(dependencies.git, dependencies.gitBinary, path, req.path)
    );
  });

  bus.register("conflict:accept", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const result = await operations.run(req.worktreeId, () =>
      acceptConflictSide(dependencies.git, path, req)
    );
    notifyChanged(req.worktreeId);
    if (!result.ok) return result;
    logMain(
      "info",
      "conflict",
      `accepted ${req.side} for ${req.path} in ${path}`
    );
    return ok(null);
  });

  bus.register("conflict:stage", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const result = await operations.run(req.worktreeId, () =>
      stageConflictResolution(dependencies.git, path, req.path)
    );
    notifyChanged(req.worktreeId);
    if (!result.ok) return result;
    return ok(null);
  });

  bus.register("conflict:writeWorkingFile", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const result = await operations.run(req.worktreeId, () =>
      writeConflictWorkingFile(dependencies.git, path, req)
    );
    if (!result.ok) return result;
    notifyChanged(req.worktreeId);
    return ok(null);
  });

  bus.register("conflict:openExternal", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const target = await operations.run(req.worktreeId, () =>
      conflictWorkingPath(dependencies.git, path, req.path)
    );
    if (!target.ok) return target;
    const message = await dependencies.openPath(target.value);
    return message === ""
      ? ok(null)
      : err({
          kind: "repo",
          code: "open_external_failed",
          message
        });
  });

  bus.register("conflict:continue", async (req) => {
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
    const identity = {
      email: row.email,
      ...(row.author_name === null ? {} : { name: row.author_name })
    };
    const result = await operations.run(req.worktreeId, () =>
      continueConflictOperation(
        dependencies.git,
        row.path,
        req.operation,
        identity
      )
    );
    // A sequencer can advance before a later step fails, so refresh either way.
    notifyChanged(req.worktreeId);
    if (!result.ok) return result;
    logMain("info", "conflict", `continued ${req.operation} in ${row.path}`);
    return ok(null);
  });

  bus.register("conflict:abort", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const result = await operations.run(req.worktreeId, () =>
      abortConflictOperation(dependencies.git, path, req.operation)
    );
    notifyChanged(req.worktreeId);
    if (!result.ok) return result;
    logMain("info", "conflict", `aborted ${req.operation} in ${path}`);
    return ok(null);
  });
}
