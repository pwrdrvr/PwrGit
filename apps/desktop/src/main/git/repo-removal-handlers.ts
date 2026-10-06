import { mkdir, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { DB } from "../persistence/db";
import type { GitExec } from "./dugite";
import { HiddenRepoStore } from "./hidden-repos";
import type { RepoIndexer } from "./repo-indexer";
import { executeRepoRemoval, reviewRepoRemoval } from "./repo-removal";
import type { WorktreeOperationQueue } from "./worktree-operation-queue";
import type { WorktreeStateService } from "./worktree-state";

export type RepoRemovalHandlerDeps = {
  db: DB;
  git: GitExec;
  indexer: RepoIndexer;
  state: Pick<WorktreeStateService, "lockForRemoval">;
  operations: WorktreeOperationQueue;
  /** `shell.trashItem` in the app; see `trashIntoDirectory` for E2E. */
  trash: (path: string) => Promise<void>;
  hidden?: HiddenRepoStore;
};

/**
 * A stand-in Trash for E2E (`PWRGIT_E2E_TRASH_DIR`): a real move, so the
 * folder demonstrably leaves its place and nothing is deleted, without filling
 * the test machine's own Trash. Names are made unique the way a Trash does.
 */
export function trashIntoDirectory(dir: string): (path: string) => Promise<void> {
  let seq = 0;
  return async (path) => {
    await mkdir(dir, { recursive: true });
    seq += 1;
    await rename(path, join(dir, `${seq}-${basename(path)}`));
  };
}

export function registerRepoRemovalHandlers(
  bus: CommandBus,
  deps: RepoRemovalHandlerDeps
): void {
  const hidden = deps.hidden ?? new HiddenRepoStore(deps.db);

  bus.register("repo:hide", (req) => {
    const entry = hidden.hide(req.profileId, req.repoId);
    if (entry === null) {
      return err({ kind: "repo", code: "not_found", message: "Repository not found." });
    }
    emitEvent("repo:changed", { profileId: req.profileId });
    return ok(entry);
  });

  bus.register("repo:unhide", (req) => {
    hidden.unhide(req.profileId, req.path);
    emitEvent("repo:changed", { profileId: req.profileId });
    return ok(null);
  });

  bus.register("repo:hiddenList", (req) => ok(hidden.list(req.profileId ?? null)));

  bus.register("repo:removalReview", (req) =>
    reviewRepoRemoval({ db: deps.db, git: deps.git }, req.repoId)
  );

  bus.register("repo:remove", async (req) => {
    const profileId = (
      deps.db.prepare("SELECT profile_id FROM repos WHERE id = ?").get(req.repoId) as
        | { profile_id: string }
        | undefined
    )?.profile_id;
    if (profileId === undefined) {
      return err({ kind: "repo", code: "not_found", message: "Repository not found." });
    }
    const result = await executeRepoRemoval(
      {
        db: deps.db,
        git: deps.git,
        trash: deps.trash,
        lockForRemoval: (id) => deps.state.lockForRemoval(id),
        runWorktree: (id, op) => deps.operations.run(id, op),
        runRepository: (id, op) => deps.operations.runRepository(id, op),
        refreshRepo: async (repoId) => {
          await deps.indexer.refreshRepoWorktrees(repoId);
        },
        deleteRepo: (repoId) => deps.indexer.deleteRepo(repoId),
        onWorktreeRemoved: (worktreeId) =>
          emitEvent("worktree:removed", { worktreeId }),
        onProgress: (steps) =>
          emitEvent("repo:removalProgress", {
            operationId: req.operationId,
            profileId,
            repoId: req.repoId,
            steps
          })
      },
      {
        repoId: req.repoId,
        decisions: req.decisions,
        ...(req.confirmName === undefined ? {} : { confirmName: req.confirmName }),
        ...(req.deletePermanently === undefined
          ? {}
          : { deletePermanently: req.deletePermanently })
      }
    );
    emitEvent("repo:changed", { profileId });
    return result;
  });
}
