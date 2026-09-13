import {
  err,
  normalizeExcludes,
  ok,
  RECLAIM_DEFAULT_EXCLUDES,
  type ReclaimProgress,
  type ReclaimSummary,
  type ReclaimWorktreeOutcome,
  type ReclaimWorktreeResult
} from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import { directorySize, pathSize } from "../util/dir-size";
import { sanitizeGitLogDetail, type GitExec } from "./dugite";
import type { RepoIndexer } from "./repo-indexer";
import { previewReclaim, reclaimIgnored } from "./worktree-reclaim";
import { missingWorktreeError } from "./worktree-liveness";
import type { WorktreeRefresher } from "./worktree-handlers";
import type { WorktreeOperationQueue } from "./worktree-operation-queue";
import {
  sweepPrunableWorktrees,
  type PruneScanRepoInput
} from "./worktree-prune";

export type PruneHandlers = {
  /** Cancel work owned by a renderer window that has gone away. */
  releaseWebContents: (webContentsId: number) => void;
};

type RepoRow = { id: string; name: string; path: string };
type WorktreeStateRow = {
  repoId: string;
  worktreeId: string;
  /** ISO-8601, or null when this worktree has never been computed. */
  updatedAt: string | null;
};
type ReclaimRow = {
  id: string;
  path: string;
  branch: string;
  repoName: string;
};

const parseIso = (value: string | null): number | null => {
  if (value === null) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

/**
 * The sweep's input: every repo in the profile, each with the worktrees that
 * could possibly be prunable.
 *
 * `is_primary = 0 AND missing = 0` is not an optimization — the predicate
 * refuses both cases anyway — it is what stops the sweep spawning git for a
 * worktree whose answer is already known, and what makes `worktreeIds` empty
 * (⇒ outcome `skipped`) for a repo with nothing but its primary checkout.
 */
export function pruneScanInputs(
  db: DB,
  profileId: string
): PruneScanRepoInput[] | null {
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
  const rows = db
    .prepare(
      `SELECT w.repo_id AS repoId, w.id AS worktreeId, s.updated_at AS updatedAt
       FROM worktrees w
       JOIN repos r ON r.id = w.repo_id
       LEFT JOIN worktree_state s ON s.worktree_id = w.id
       WHERE r.profile_id = ? AND w.is_primary = 0 AND w.missing = 0
       ORDER BY w.repo_id, w.branch COLLATE NOCASE, w.id`
    )
    .all(profileId) as WorktreeStateRow[];

  const byRepo = new Map<string, { ids: string[]; oldest: number | null }>();
  for (const row of rows) {
    const bucket = byRepo.get(row.repoId) ?? { ids: [], oldest: null };
    bucket.ids.push(row.worktreeId);
    const at = parseIso(row.updatedAt);
    // One un-computed worktree makes the whole repo's answer incomplete, so
    // the oldest snapshot decides — and a missing one is older than any date.
    if (at === null) bucket.oldest = Number.NEGATIVE_INFINITY;
    else if (bucket.oldest === null || at < bucket.oldest) bucket.oldest = at;
    byRepo.set(row.repoId, bucket);
  }
  return repos.map((repo) => {
    const bucket = byRepo.get(repo.id);
    return {
      ...repo,
      worktreeIds: bucket?.ids ?? [],
      stateComputedAt:
        bucket === undefined ||
        bucket.oldest === null ||
        bucket.oldest === Number.NEGATIVE_INFINITY
          ? null
          : bucket.oldest
    };
  });
}

function reclaimRow(db: DB, worktreeId: string): ReclaimRow | undefined {
  return db
    .prepare(
      `SELECT w.id, w.path, w.branch, r.name AS repoName
       FROM worktrees w JOIN repos r ON r.id = w.repo_id
       WHERE w.id = ?`
    )
    .get(worktreeId) as ReclaimRow | undefined;
}

function emptyReclaimCounts(): Record<ReclaimWorktreeOutcome, number> {
  return {
    reclaimed: 0,
    nothing_to_reclaim: 0,
    skipped: 0,
    failed: 0,
    cancelled: 0
  };
}

/**
 * The pruner's main-process half: one bounded sweep, and the two actions.
 *
 * Removal is deliberately absent — `worktree:removeMany` already does it in
 * bulk and streams `worktree:removed`, so the dialog reuses that path rather
 * than acquiring a second one.
 */
export function registerPruneHandlers(
  bus: CommandBus,
  db: DB,
  git: GitExec,
  indexer: Pick<RepoIndexer, "getRepo">,
  refresher: WorktreeRefresher,
  operations: WorktreeOperationQueue
): PruneHandlers {
  const active = new Map<
    string,
    { controller: AbortController; webContentsId?: number }
  >();

  /** Register a cancellable operation; returns its controller and a releaser. */
  const begin = (
    operationId: string,
    ctx: { signal?: AbortSignal; webContentsId?: number }
  ): { controller: AbortController; release: () => void } => {
    const controller = new AbortController();
    const abortFromContext = (): void => controller.abort(ctx.signal?.reason);
    if (ctx.signal?.aborted === true) abortFromContext();
    else ctx.signal?.addEventListener("abort", abortFromContext, { once: true });
    active.set(operationId, {
      controller,
      ...(ctx.webContentsId === undefined
        ? {}
        : { webContentsId: ctx.webContentsId })
    });
    return {
      controller,
      release: () => {
        active.delete(operationId);
        ctx.signal?.removeEventListener("abort", abortFromContext);
      }
    };
  };

  const cancel = (
    operationId: string,
    webContentsId: number | undefined,
    message: string
  ): boolean => {
    const operation = active.get(operationId);
    if (operation === undefined) return false;
    if (
      operation.webContentsId !== undefined &&
      webContentsId !== undefined &&
      operation.webContentsId !== webContentsId
    ) {
      return false;
    }
    operation.controller.abort({ kind: "git", code: "aborted", message });
    return true;
  };

  bus.register("prune:cancelScan", (req, ctx) =>
    ok({
      cancelled: cancel(
        req.operationId,
        ctx.webContentsId,
        "The worktree sweep was cancelled."
      )
    })
  );

  bus.register("prune:cancelReclaim", (req, ctx) =>
    ok({
      cancelled: cancel(
        req.operationId,
        ctx.webContentsId,
        "Reclaiming disk space was cancelled."
      )
    })
  );

  bus.register("prune:scan", async (req, ctx) => {
    if (req.operationId.trim() === "") {
      return err({
        kind: "validation",
        code: "invalid_operation_id",
        message: "A worktree sweep needs an operation id."
      });
    }
    if (active.has(req.operationId)) {
      return err({
        kind: "git",
        code: "operation_in_progress",
        message: "This sweep is already running."
      });
    }
    const repos = pruneScanInputs(db, req.profileId);
    if (repos === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${req.profileId}"`
      });
    }
    const { controller, release } = begin(req.operationId, ctx);
    logMain(
      "info",
      "prune",
      `sweep started for profile ${req.profileId}: ${repos.length} repositories`
    );
    try {
      const summary = await sweepPrunableWorktrees(repos, {
        operationId: req.operationId,
        signal: controller.signal,
        ...(req.force === undefined ? {} : { force: req.force }),
        computeRepoState: async (repoId) => {
          await refresher.refreshRepoWorktrees(repoId);
        },
        readRepo: (repoId) => indexer.getRepo(repoId),
        sizeOf: async (path, signal) => {
          const measured = await directorySize(
            path,
            signal === undefined ? {} : { signal }
          );
          return { bytes: measured.bytes, partial: measured.partial };
        },
        onProgress: (progress) => emitEvent("prune:scanProgress", progress),
        runRepository: (repoId, operation) =>
          operations.runRepository(repoId, operation)
      });
      logMain(
        summary.cancelled ? "warn" : "info",
        "prune",
        `sweep finished for profile ${req.profileId}: ${summary.counts.candidates} candidates` +
          ` across ${summary.counts.repos.scanned} scanned / ${summary.counts.repos.cached} cached repositories` +
          `${summary.cancelled ? " (cancelled)" : ""}`
      );
      return ok(summary);
    } finally {
      release();
    }
  });

  bus.register("prune:reclaimPreview", async (req, ctx) => {
    const row = reclaimRow(db, req.worktreeId);
    if (row === undefined) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "worktree not found"
      });
    }
    const gone = missingWorktreeError(db, req.worktreeId);
    if (gone !== null) return err(gone);
    const input = {
      worktreeId: row.id,
      repoName: row.repoName,
      branch: row.branch,
      path: row.path,
      ...(req.excludes === undefined ? {} : { excludes: req.excludes })
    };
    // A dry run reads the worktree; the lock keeps it from interleaving with a
    // checkout mutation that would change the answer while it is being read.
    //
    // With an operationId the walk joins the same registry the reclaim uses,
    // so `prune:cancelReclaim` stops it. Previews of a whole selection are
    // issued one after another under one id: cancelling reaches the one that
    // is running, and the caller stops asking for the rest.
    const operationId = req.operationId?.trim() ?? "";
    if (operationId === "") {
      return operations.run(req.worktreeId, () => previewReclaim(git, input));
    }
    const existing = active.get(operationId);
    const { controller, release } =
      existing === undefined
        ? begin(operationId, ctx)
        : { controller: existing.controller, release: () => {} };
    try {
      return await operations.run(req.worktreeId, () =>
        previewReclaim(git, input, { signal: controller.signal })
      );
    } finally {
      release();
    }
  });

  bus.register("prune:reclaim", async (req, ctx) => {
    if (req.operationId.trim() === "") {
      return err({
        kind: "validation",
        code: "invalid_operation_id",
        message: "Reclaiming disk space needs an operation id."
      });
    }
    if (active.has(req.operationId)) {
      return err({
        kind: "git",
        code: "operation_in_progress",
        message: "This reclaim is already running."
      });
    }
    const excludes = normalizeExcludes([
      ...(req.excludes ?? RECLAIM_DEFAULT_EXCLUDES)
    ]);
    const { controller, release } = begin(req.operationId, ctx);
    const startedAt = new Date().toISOString();
    const results: ReclaimWorktreeResult[] = [];
    const total = req.worktreeIds.length;
    const progress = (
      payload: Omit<ReclaimProgress, "operationId" | "totalWorktrees">
    ): void =>
      emitEvent("prune:reclaimProgress", {
        operationId: req.operationId,
        totalWorktrees: total,
        ...payload
      });

    // The patterns, not just the count. This is the only unrecoverable action
    // in the pruner, and "sparing 9 patterns" cannot answer the one question
    // asked afterwards — whether `.env*` was still on the list.
    logMain(
      "info",
      "prune",
      `reclaim started for ${total} worktrees, sparing ${excludes.length} patterns: ` +
        (excludes.length === 0 ? "(none)" : excludes.join(" "))
    );
    try {
      progress({ phase: "starting", completedWorktrees: 0 });
      for (const worktreeId of req.worktreeIds) {
        const row = reclaimRow(db, worktreeId);
        if (row === undefined) {
          results.push({
            worktreeId,
            repoName: "",
            branch: "",
            path: "",
            outcome: "failed",
            plannedBytes: 0,
            plannedPaths: 0,
            message: "worktree not found"
          });
          progress({
            phase: "worktree_completed",
            completedWorktrees: results.length,
            worktreeId,
            result: results[results.length - 1]!
          });
          continue;
        }
        const base = {
          worktreeId,
          repoName: row.repoName,
          branch: row.branch,
          path: row.path
        };
        if (controller.signal.aborted) {
          results.push({
            ...base,
            outcome: "cancelled",
            reason: "cancelled",
            plannedBytes: 0,
            plannedPaths: 0
          });
          progress({
            phase: "worktree_completed",
            completedWorktrees: results.length,
            worktreeId,
            branch: row.branch,
            repoName: row.repoName,
            result: results[results.length - 1]!
          });
          continue;
        }
        progress({
          phase: "worktree_started",
          completedWorktrees: results.length,
          worktreeId,
          branch: row.branch,
          repoName: row.repoName
        });
        const result = await reclaimOne(base, excludes, controller.signal);
        results.push(result);
        progress({
          phase: "worktree_completed",
          completedWorktrees: results.length,
          worktreeId,
          branch: row.branch,
          repoName: row.repoName,
          result
        });
      }
    } finally {
      release();
    }

    const counts = emptyReclaimCounts();
    let freedBytes = 0;
    for (const result of results) {
      counts[result.outcome] += 1;
      if (result.outcome === "reclaimed") freedBytes += result.plannedBytes;
    }
    const summary: ReclaimSummary = {
      operationId: req.operationId,
      cancelled: controller.signal.aborted,
      startedAt,
      finishedAt: new Date().toISOString(),
      counts: { worktrees: counts, freedBytes },
      results
    };
    logMain(
      summary.cancelled ? "warn" : "info",
      "prune",
      `reclaim finished: ${counts.reclaimed} reclaimed, ${counts.nothing_to_reclaim} already clean,` +
        ` ${counts.skipped} skipped, ${counts.failed} failed, ${counts.cancelled} cancelled`
    );
    return ok(summary);
  });

  /**
   * Reclaim one worktree: preview, delete, then report what the preview said
   * was there. The preview is re-taken here rather than trusted from the
   * dialog — the user may have been looking at it for a while, and the number
   * reported as freed should describe what this command actually deleted.
   */
  async function reclaimOne(
    base: {
      worktreeId: string;
      repoName: string;
      branch: string;
      path: string;
    },
    excludes: string[],
    signal: AbortSignal
  ): Promise<ReclaimWorktreeResult> {
    const gone = missingWorktreeError(db, base.worktreeId);
    if (gone !== null) {
      return {
        ...base,
        outcome: "skipped",
        reason: "worktree_missing",
        plannedBytes: 0,
        plannedPaths: 0,
        message: gone.message
      };
    }
    try {
      return await operations.run(base.worktreeId, async () => {
        const plan = await previewReclaim(
          git,
          { ...base, excludes },
          {
            signal,
            sizeOf: async (target, sizeSignal) => {
              const measured = await pathSize(
                target,
                sizeSignal === undefined ? {} : { signal: sizeSignal }
              );
              return { bytes: measured.bytes, partial: measured.partial };
            }
          }
        );
        if (!plan.ok) {
          return {
            ...base,
            outcome: "failed" as const,
            reason: "clean_failed" as const,
            plannedBytes: 0,
            plannedPaths: 0,
            message: plan.error.message
          };
        }
        const plannedPaths = plan.value.pathCount;
        if (plannedPaths === 0) {
          return {
            ...base,
            outcome: "nothing_to_reclaim" as const,
            plannedBytes: 0,
            plannedPaths: 0
          };
        }
        if (signal.aborted) {
          return {
            ...base,
            outcome: "cancelled" as const,
            reason: "cancelled" as const,
            plannedBytes: 0,
            plannedPaths: 0
          };
        }
        const cleaned = await reclaimIgnored(git, base.path, excludes, {
          signal
        });
        if (!cleaned.ok) {
          // `git clean` is not atomic, so a cancel that kills it mid-run has
          // already deleted an unknown part of the set. Reporting that as a
          // plain failure would tell the user nothing happened, which is the
          // one thing it must not say about an unrecoverable deletion.
          if (signal.aborted) {
            logMain(
              "warn",
              "prune",
              `reclaim cancelled mid-clean in ${base.path}: some of the ${plannedPaths} planned paths may already be deleted`
            );
            return {
              ...base,
              outcome: "cancelled" as const,
              reason: "cancelled" as const,
              plannedBytes: 0,
              plannedPaths,
              message:
                "Cancelled while deleting — some ignored files in this worktree may already be gone."
            };
          }
          return {
            ...base,
            outcome: "failed" as const,
            reason: "clean_failed" as const,
            plannedBytes: 0,
            plannedPaths,
            message: cleaned.error.message
          };
        }
        logMain(
          "info",
          "prune",
          `reclaimed ${plan.value.totalBytes} bytes across ${plannedPaths} paths in ${base.path}`
        );
        return {
          ...base,
          outcome: "reclaimed" as const,
          plannedBytes: plan.value.totalBytes,
          plannedPaths
        };
      });
    } catch (cause) {
      return {
        ...base,
        outcome: "failed",
        reason: "clean_failed",
        plannedBytes: 0,
        plannedPaths: 0,
        message: sanitizeGitLogDetail(cause)
      };
    }
  }

  return {
    releaseWebContents: (webContentsId) => {
      for (const operation of active.values()) {
        if (operation.webContentsId !== webContentsId) continue;
        operation.controller.abort({
          kind: "git",
          code: "aborted",
          message: "The window that started this operation was closed."
        });
      }
    }
  };
}
