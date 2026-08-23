import { err, ok, type Result, type StashEntry } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import { execGit, type GitExec } from "./dugite";
import {
  applyStash,
  createStash,
  dropStash,
  listStashes,
  popStash,
  readStashDetails,
  readStashPatch
} from "./stash-service";
import type { WorktreeRefresher } from "./worktree-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

type StashRow = { path: string; repoId: string };

export type StashHandlerDependencies = {
  git: GitExec;
  list: typeof listStashes;
  details: typeof readStashDetails;
  patch: typeof readStashPatch;
  create: typeof createStash;
  apply: typeof applyStash;
  pop: typeof popStash;
  drop: typeof dropStash;
};

const DEFAULT_DEPENDENCIES: StashHandlerDependencies = {
  git: execGit,
  list: listStashes,
  details: readStashDetails,
  patch: readStashPatch,
  create: createStash,
  apply: applyStash,
  pop: popStash,
  drop: dropStash
};

const notFound = (message: string) =>
  err({ kind: "repo" as const, code: "not_found", message });

export function registerStashHandlers(
  bus: CommandBus,
  db: DB,
  refresher: WorktreeRefresher,
  operations: WorktreeOperationQueue,
  dependencyOverrides: Partial<StashHandlerDependencies> = {}
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const rowOf = (worktreeId: string): StashRow | undefined =>
    db
      .prepare(
        `SELECT w.path AS path, w.repo_id AS repoId
         FROM worktrees w WHERE w.id = ?`
      )
      .get(worktreeId) as StashRow | undefined;

  const currentEntry = async (
    row: StashRow,
    hash: string
  ): Promise<Result<StashEntry>> => {
    const listed = await dependencies.list(dependencies.git, row.path);
    if (!listed.ok) return listed;
    const entry = listed.value.find((candidate) => candidate.hash === hash);
    return entry === undefined
      ? notFound(
          "That stash is no longer in the repository stack. Refresh and choose an existing entry."
        )
      : ok(entry);
  };

  const announceWorktree = (row: StashRow, worktreeId: string): void => {
    emitEvent("changes:changed", { worktreeId });
    void refresher.refreshWorktree(worktreeId);
    logMain("debug", "stash", `refreshed worktree after stash operation ${row.path}`);
  };

  const announceStack = (repoId: string): void => {
    emitEvent("stash:changed", { repoId });
  };

  bus.register("stash:list", async (req) => {
    const row = rowOf(req.worktreeId);
    if (row === undefined) return notFound("Worktree not found.");
    return operations.runRepository(row.repoId, () =>
      dependencies.list(dependencies.git, row.path)
    );
  });

  bus.register("stash:details", async (req) => {
    const row = rowOf(req.worktreeId);
    if (row === undefined) return notFound("Worktree not found.");
    return operations.runRepository(row.repoId, async () => {
      const entry = await currentEntry(row, req.stashHash);
      return entry.ok
        ? dependencies.details(dependencies.git, row.path, entry.value)
        : entry;
    });
  });

  bus.register("diff:stash", async (req) => {
    const row = rowOf(req.worktreeId);
    if (row === undefined) return notFound("Worktree not found.");
    return operations.runRepository(row.repoId, async () => {
      const entry = await currentEntry(row, req.stashHash);
      return entry.ok
        ? dependencies.patch(dependencies.git, row.path, entry.value.hash)
        : entry;
    });
  });

  bus.register("stash:create", async (req) => {
    const row = rowOf(req.worktreeId);
    if (row === undefined) return notFound("Worktree not found.");
    const message = req.message.trim();
    if (message === "") {
      return err({
        kind: "validation",
        code: "empty_stash_name",
        message: "Give this stash a name."
      });
    }
    const result = await operations.runRepository(row.repoId, () =>
      operations.run(req.worktreeId, () =>
        dependencies.create(
          dependencies.git,
          row.path,
          message,
          req.includeUntracked
        )
      )
    );
    announceWorktree(row, req.worktreeId);
    announceStack(row.repoId);
    if (!result.ok) return result;
    if (result.value) {
      logMain("info", "stash", `created "${message}" in ${row.path}`);
    }
    return ok({ created: result.value });
  });

  const restore = (
    command: "stash:apply" | "stash:pop",
    operation: typeof applyStash
  ): void => {
    bus.register(command, async (req) => {
      const row = rowOf(req.worktreeId);
      if (row === undefined) return notFound("Worktree not found.");
      const result = await operations.runRepository(row.repoId, () =>
        operations.run(req.worktreeId, async () => {
          // Re-resolve the stable hash under the same repository lock as the
          // mutation. A CLI push/drop can renumber stash@{n}; stale UI must
          // never apply or delete the entry that inherited an old selector.
          const entry = await currentEntry(row, req.stashHash);
          if (!entry.ok) return entry;
          return operation(dependencies.git, row.path, entry.value.selector);
        })
      );
      // A failed apply/pop can leave conflict markers and index changes. The
      // stack is re-read too: pop keeps the entry on conflicts but drops it on
      // success, and the renderer should reflect Git's actual outcome.
      announceWorktree(row, req.worktreeId);
      announceStack(row.repoId);
      if (!result.ok) return result;
      logMain(
        "info",
        "stash",
        `${command === "stash:apply" ? "applied" : "popped"} ${req.stashHash.slice(0, 12)} into ${row.path}`
      );
      return ok(null);
    });
  };

  restore("stash:apply", dependencies.apply);
  restore("stash:pop", dependencies.pop);

  bus.register("stash:drop", async (req) => {
    const row = rowOf(req.worktreeId);
    if (row === undefined) return notFound("Worktree not found.");
    const result = await operations.runRepository(row.repoId, async () => {
      const entry = await currentEntry(row, req.stashHash);
      if (!entry.ok) return entry;
      return dependencies.drop(dependencies.git, row.path, entry.value.selector);
    });
    announceStack(row.repoId);
    if (!result.ok) return result;
    logMain("info", "stash", `dropped ${req.stashHash.slice(0, 12)} in ${row.path}`);
    return ok(null);
  });
}
