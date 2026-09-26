import {
  err,
  ok,
  type MaintenanceRepo,
  type MaintenanceRepoResult,
  type MaintenanceScope,
  type MaintenanceSummary,
  type MaintenanceProgress
} from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import { sanitizeGitLogDetail, type GitExec } from "./dugite";
import type { RepoIndexer } from "./repo-indexer";
import type { WorktreeOperationQueue } from "./worktree-operation-queue";
import {
  collectGarbage,
  deleteStaleBranch,
  maintenanceCommonDirectory,
  objectStorageBytes,
  scanStaleBranches
} from "./repository-maintenance";

export function maintenanceRepos(
  db: DB,
  scope: MaintenanceScope
): MaintenanceRepo[] | null {
  if (
    db.prepare("SELECT id FROM profiles WHERE id = ?").get(scope.profileId) ===
    undefined
  )
    return null;
  return db
    .prepare(
      `SELECT r.id, r.name, r.path, r.profile_id AS profileId, p.name AS profileName
    FROM repos r JOIN profiles p ON p.id = r.profile_id
    ${scope.allProfiles === true ? "" : "WHERE r.profile_id = ?"}
    ORDER BY p.name COLLATE NOCASE, r.name COLLATE NOCASE, r.id`
    )
    .all(
      ...(scope.allProfiles === true ? [] : [scope.profileId])
    ) as MaintenanceRepo[];
}

export function registerMaintenanceHandlers(
  bus: CommandBus,
  db: DB,
  git: GitExec,
  operations: WorktreeOperationQueue,
  indexer: Pick<RepoIndexer, "refreshRepoWorktrees">
): { releaseWebContents: (id: number) => void } {
  // One sweep across all windows, regardless of operation ids or profiles.
  // Renderer bugs cannot create an unbounded GC process/queue per click.
  let active:
    | { id: string; owner: number | undefined; controller: AbortController }
    | undefined;

  bus.register("maintenance:cancel", (req, ctx) => {
    if (active?.id !== req.operationId || active.owner !== ctx.webContentsId)
      return ok({ cancelled: false });
    active.controller.abort();
    return ok({ cancelled: true });
  });

  bus.register("maintenance:run", async (req, ctx) => {
    if (
      !req.operationId?.trim() ||
      !["gc", "scan-branches", "delete-branches"].includes(req.action?.kind) ||
      (req.action.kind === "gc" &&
        !["standard", "keep-largest", "aggressive"].includes(req.action.mode))
    ) {
      return err({
        kind: "validation",
        code: "invalid_maintenance",
        message: "Choose a valid maintenance operation."
      });
    }
    if (active !== undefined)
      return err({
        kind: "repo",
        code: "maintenance_running",
        message:
          "Repository maintenance is already running in another dialog. Wait for it to finish."
      });
    const knownRepos = maintenanceRepos(db, req);
    if (knownRepos === null)
      return err({
        kind: "profile",
        code: "not_found",
        message: "This profile no longer exists."
      });
    const action = req.action;
    const selected = action.kind === "delete-branches" ? action.branches : [];
    const ids = new Set(knownRepos.map((repo) => repo.id));
    if (selected.some((branch) => !ids.has(branch.repoId))) {
      return err({
        kind: "validation",
        code: "invalid_maintenance_scope",
        message:
          "A selected branch is outside the reviewed repository scope. Review branches again."
      });
    }
    const repos =
      action.kind === "delete-branches"
        ? knownRepos.filter((repo) =>
            selected.some((branch) => branch.repoId === repo.id)
          )
        : knownRepos;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (ctx.signal?.aborted === true) abort();
    else ctx.signal?.addEventListener("abort", abort, { once: true });
    active = { id: req.operationId, owner: ctx.webContentsId, controller };
    const startedAt = new Date().toISOString();
    const results: MaintenanceRepoResult[] = [];
    const commonDirectories = new Set<string>();
    const progress = (
      event: Omit<MaintenanceProgress, "operationId" | "profileId">
    ): void =>
      emitEvent("maintenance:progress", {
        ...event,
        operationId: req.operationId,
        profileId: req.profileId
      });

    try {
      progress({ phase: "starting", repos });
      for (const repo of repos) {
        const report = (detail: string): void =>
          progress({ phase: "repo_progress", repo, detail });
        let result: MaintenanceRepoResult;
        if (controller.signal.aborted) {
          result = {
            repo,
            outcome: "cancelled",
            message: "Cancelled before this repository started."
          };
        } else {
          // Announce queued before entering the repository lock. The running
          // event belongs inside it, once this sweep actually owns the slot.
          try {
            report("Waiting for the repository lock…");
            result = await operations.runRepository(
              repo.id,
              async (): Promise<MaintenanceRepoResult> => {
                if (controller.signal.aborted)
                  return {
                    repo,
                    outcome: "cancelled",
                    message: "Cancelled while waiting for this repository."
                  };
                progress({ phase: "repo_started", repo });
                const directory = await maintenanceCommonDirectory(
                  git,
                  repo.path
                );
                if (!directory.ok)
                  return {
                    repo,
                    outcome: "failed",
                    message: sanitizeGitLogDetail(directory.error.message)
                  };
                if (
                  action.kind !== "delete-branches" &&
                  commonDirectories.has(directory.value)
                ) {
                  return {
                    repo,
                    outcome: "skipped",
                    message:
                      "Shares an object store with a repository already processed in this run."
                  };
                }
                commonDirectories.add(directory.value);
                if (action.kind === "gc") {
                  report("Measuring object storage before collection…");
                  const beforeBytes = await objectStorageBytes(git, repo.path);
                  // Cooperative cancellation never interrupts a local mutation.
                  report(
                    "Repacking objects and applying Git retention settings…"
                  );
                  const collected = await collectGarbage(
                    git,
                    repo.path,
                    action.mode
                  );
                  report("Measuring object storage after collection…");
                  const afterBytes = await objectStorageBytes(git, repo.path);
                  return {
                    repo,
                    outcome: collected.ok ? "success" : "failed",
                    message: collected.ok
                      ? "Garbage collection completed."
                      : sanitizeGitLogDetail(collected.error.message),
                    ...(beforeBytes === undefined ? {} : { beforeBytes }),
                    ...(afterBytes === undefined ? {} : { afterBytes })
                  };
                }
                if (action.kind === "scan-branches") {
                  report(
                    "Checking local branches, upstreams, and merged commits…"
                  );
                  const scanned = await scanStaleBranches(
                    git,
                    repo.path,
                    repo.id
                  );
                  return scanned.ok
                    ? {
                        repo,
                        outcome: "success",
                        candidates: scanned.value,
                        message: `${scanned.value.length} eligible local branch${scanned.value.length === 1 ? "" : "es"}. Other branches are retained.`
                      }
                    : {
                        repo,
                        outcome: "failed",
                        message: sanitizeGitLogDetail(scanned.error.message)
                      };
                }
                const branches: NonNullable<MaintenanceRepoResult["branches"]> =
                  [];
                const repoCandidates = selected.filter(
                  (branch) => branch.repoId === repo.id
                );
                for (const candidate of repoCandidates) {
                  if (controller.signal.aborted) {
                    branches.push({
                      branch: candidate.branch,
                      deleted: false,
                      message: "Cancelled; retained."
                    });
                    continue;
                  }
                  report(
                    `Checking branch ${branches.length + 1} of ${repoCandidates.length}: ${candidate.branch}`
                  );
                  const deleted = await deleteStaleBranch(
                    git,
                    repo.path,
                    candidate
                  );
                  branches.push({
                    branch: candidate.branch,
                    deleted: deleted.ok,
                    message: deleted.ok
                      ? "Deleted local branch."
                      : sanitizeGitLogDetail(deleted.error.message)
                  });
                }
                const deleted = branches.filter(
                  (branch) => branch.deleted
                ).length;
                return {
                  repo,
                  branches,
                  outcome:
                    deleted === branches.length
                      ? "success"
                      : controller.signal.aborted
                        ? "cancelled"
                        : deleted > 0
                          ? "partial"
                          : "failed",
                  message: `${deleted} local branch${deleted === 1 ? "" : "es"} deleted; ${branches.length - deleted} retained.`
                };
              }
            );
            if (action.kind === "delete-branches") {
              // A failed metadata cleanup can follow a successful ref change,
              // so refresh even when the deletion result was not successful.
              try {
                await indexer.refreshRepoWorktrees(repo.id);
              } catch (cause) {
                result = {
                  ...result,
                  outcome: "partial",
                  message: `${result.message} Refresh failed: ${sanitizeGitLogDetail(cause)}`
                };
              }
              emitEvent("graph:changed", { repoId: repo.id });
              emitEvent("repo:changed", { profileId: repo.profileId });
            }
          } catch (cause) {
            result = {
              repo,
              outcome: "failed",
              message: sanitizeGitLogDetail(cause)
            };
          }
        }
        results.push(result);
        progress({ phase: "repo_completed", repo, result });
        logMain(
          result.outcome === "failed" ? "warn" : "info",
          "maintenance",
          `${action.kind}: ${repo.path}: ${result.message}`
        );
      }
      const summary: MaintenanceSummary = {
        operationId: req.operationId,
        startedAt,
        finishedAt: new Date().toISOString(),
        cancelled: controller.signal.aborted,
        results
      };
      return ok(summary);
    } finally {
      active = undefined;
      ctx.signal?.removeEventListener("abort", abort);
    }
  });
  return {
    releaseWebContents: (id) => {
      if (active?.owner === id) active.controller.abort();
    }
  };
}
