import { err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import { bulkSyncRepositories, type BulkSyncRepoInput } from "./bulk-sync";
import { execGit, sanitizeGitLogDetail } from "./dugite";
import type { RepoIndexer } from "./repo-indexer";
import type { WorktreeRefresher } from "./worktree-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

export type BulkSyncHandlers = {
  /** Cancel work owned by a renderer window that has gone away. */
  releaseWebContents: (webContentsId: number) => void;
};

type RepoRow = { id: string; name: string; path: string };
type WorktreeRow = {
  id: string;
  repoId: string;
  branch: string;
  path: string;
};

function profileRepos(db: DB, profileId: string): BulkSyncRepoInput[] | null {
  const profile = db
    .prepare("SELECT id FROM profiles WHERE id = ?")
    .get(profileId) as { id: string } | undefined;
  if (profile === undefined) return null;
  const repos = db
    .prepare(
      `SELECT id, name, path FROM repos
       WHERE profile_id = ?
       ORDER BY name COLLATE NOCASE, name, id`
    )
    .all(profileId) as RepoRow[];
  const worktrees = db
    .prepare(
      `SELECT w.id, w.repo_id AS repoId, w.branch, w.path
       FROM worktrees w
       JOIN repos r ON r.id = w.repo_id
       WHERE r.profile_id = ?
       ORDER BY w.repo_id, w.is_primary DESC, w.branch COLLATE NOCASE, w.id`
    )
    .all(profileId) as WorktreeRow[];
  const byRepo = new Map<string, WorktreeRow[]>();
  for (const worktree of worktrees) {
    const rows = byRepo.get(worktree.repoId) ?? [];
    rows.push(worktree);
    byRepo.set(worktree.repoId, rows);
  }
  return repos.map((repo) => ({
    ...repo,
    worktrees: (byRepo.get(repo.id) ?? []).map(({ repoId: _repoId, ...row }) =>
      row
    )
  }));
}

/** Profile-wide fetch and conservative pull handlers with cooperative cancel. */
export function registerBulkSyncHandlers(
  bus: CommandBus,
  db: DB,
  refresher: WorktreeRefresher,
  operations: WorktreeOperationQueue,
  indexer?: Pick<RepoIndexer, "refreshRepoRemoteBranches">
): BulkSyncHandlers {
  const active = new Map<
    string,
    { controller: AbortController; webContentsId?: number }
  >();

  bus.register("remote:cancelBulkSync", (req, ctx) => {
    const operation = active.get(req.operationId);
    if (operation === undefined) return ok({ cancelled: false });
    if (
      operation.webContentsId !== undefined &&
      ctx.webContentsId !== undefined &&
      operation.webContentsId !== ctx.webContentsId
    ) {
      return ok({ cancelled: false });
    }
    operation.controller.abort({
      kind: "remote",
      code: "aborted",
      message: "Repository synchronization was cancelled."
    });
    return ok({ cancelled: true });
  });

  bus.register("remote:bulkSync", async (req, ctx) => {
    if (req.operationId.trim() === "") {
      return err({
        kind: "validation",
        code: "invalid_operation_id",
        message: "Bulk synchronization needs an operation id."
      });
    }
    if (active.has(req.operationId)) {
      return err({
        kind: "remote",
        code: "operation_in_progress",
        message: "This bulk synchronization is already running."
      });
    }
    const repos = profileRepos(db, req.profileId);
    if (repos === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${req.profileId}"`
      });
    }

    const controller = new AbortController();
    const abortFromContext = (): void => controller.abort(ctx.signal?.reason);
    if (ctx.signal?.aborted === true) abortFromContext();
    else ctx.signal?.addEventListener("abort", abortFromContext, { once: true });
    active.set(req.operationId, {
      controller,
      ...(ctx.webContentsId === undefined
        ? {}
        : { webContentsId: ctx.webContentsId })
    });
    logMain(
      "info",
      "remote",
      `bulk ${req.mode} started for profile ${req.profileId}: ${repos.length} repositories`
    );
    try {
      const summary = await bulkSyncRepositories(execGit, repos, {
        operationId: req.operationId,
        mode: req.mode,
        signal: controller.signal,
        runRepository: (repoId, operation) =>
          operations.runRepository(repoId, operation),
        runWorktree: (worktreeId, operation) =>
          operations.run(worktreeId, operation),
        onProgress: (progress) =>
          emitEvent("remote:bulkSyncProgress", progress),
        onRepoCompleted: async (repo, result) => {
          const fetched = result.remotes.some(
            (remote) => remote.outcome === "fetched"
          );
          const updated = result.worktrees.some(
            (worktree) => worktree.outcome === "updated"
          );
          if (fetched && indexer !== undefined) {
            try {
              const indexed = await operations.runRepository(repo.id, () =>
                indexer.refreshRepoRemoteBranches(repo.id)
              );
              if (!indexed.ok) {
                logMain(
                  "warn",
                  "remote",
                  `bulk ${req.mode} branch-index refresh failed for ${repo.path}: ${indexed.error.message}`
                );
              }
            } catch (cause) {
              logMain(
                "warn",
                "remote",
                `bulk ${req.mode} branch-index refresh failed for ${repo.path}: ${sanitizeGitLogDetail(cause)}`
              );
            }
          }
          if (fetched || updated) {
            try {
              await refresher.refreshRepoWorktrees(repo.id);
            } catch (cause) {
              logMain(
                "warn",
                "remote",
                `bulk ${req.mode} state refresh failed for ${repo.path}: ${sanitizeGitLogDetail(cause)}`
              );
            }
          }
          logMain(
            result.outcome === "failed" ? "warn" : "info",
            "remote",
            `bulk ${req.mode} ${result.outcome} for ${repo.path}`
          );
        }
      });
      logMain(
        summary.cancelled ? "warn" : "info",
        "remote",
        `bulk ${req.mode} finished for profile ${req.profileId}: ${summary.counts.repos.success} succeeded, ${summary.counts.repos.partial} partial, ${summary.counts.repos.skipped} skipped, ${summary.counts.repos.failed} failed, ${summary.counts.repos.cancelled} cancelled`
      );
      return ok(summary);
    } finally {
      active.delete(req.operationId);
      ctx.signal?.removeEventListener("abort", abortFromContext);
    }
  });

  return {
    releaseWebContents: (webContentsId) => {
      for (const operation of active.values()) {
        if (operation.webContentsId !== webContentsId) continue;
        operation.controller.abort({
          kind: "remote",
          code: "aborted",
          message: "The window that started synchronization was closed."
        });
      }
    }
  };
}
