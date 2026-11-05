import { availableParallelism } from "node:os";
import {
  DEFAULT_BRANCH_CLEANUP_OPTIONS,
  EMPTY_MAINTENANCE_RUN_VIEW,
  err,
  foldMaintenanceProgress,
  isBranchCleanupKeepDays,
  ok,
  type BranchCleanupOptions,
  type DeletedBranchResult,
  type MaintenanceRepo,
  type MaintenanceRepoResult,
  type MaintenanceRunRecord,
  type MaintenanceRunView,
  type MaintenanceScope,
  type MaintenanceSummary,
  type MaintenanceProgress
} from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import { mapLimit } from "../util/map-limit";
import type { DB } from "../persistence/db";
import { sanitizeGitLogDetail, type GitExec } from "./dugite";
import type { RepoIndexer } from "./repo-indexer";
import type { WorktreeOperationQueue } from "./worktree-operation-queue";
import type { PrService } from "../github/pr-service";
import {
  collectGarbage,
  deleteStaleBranches,
  maintenanceCommonDirectory,
  objectStorageBytes,
  restoreStaleBranch,
  reviewStaleBranches,
  type BranchPrEvidence
} from "./repository-maintenance";
import { visibleRepoSql } from "./hidden-repos";
import { activeGitReflinkProbe } from "./dugite";
import { refreshActiveGitReflink } from "./runtime-status";
import { refreshRepositoryClones, softPullMainCheckout, type ReshareWorktreeRow } from "./worktree-reshare";

/** Linked (non-primary) worktrees per repository, for Clones' scope. */
/** Heaviest first, ties in the order given: the longest job starts first,
 *  so it is not the one left running alone at the end. */
export function largestFirst<T extends { id: string }>(items: readonly T[], weight: ReadonlyMap<string, number>): T[] {
  return [...items].sort((a, b) => (weight.get(b.id) ?? 0) - (weight.get(a.id) ?? 0));
}

/** Clones runs only where there is something to share. A repository with
 *  no linked worktree is reported apart, not counted as a skip. Both keep
 *  the order given. */
export function splitByLinkedWorktrees<T extends { id: string }>(
  repos: readonly T[],
  linked: ReadonlyMap<string, number>
): { withWorktrees: T[]; noWorktrees: T[] } {
  const has = (repo: T): boolean => (linked.get(repo.id) ?? 0) > 0;
  return { withWorktrees: repos.filter(has), noWorktrees: repos.filter((repo) => !has(repo)) };
}

function linkedWorktreeCounts(db: DB, repos: readonly MaintenanceRepo[]): Map<string, number> {
  const counts = new Map<string, number>();
  const statement = db.prepare("SELECT COUNT(*) AS n FROM worktrees WHERE repo_id = ? AND is_primary = 0");
  for (const repo of repos) counts.set(repo.id, (statement.get(repo.id) as { n: number }).n);
  return counts;
}

export function maintenanceRepos(
  db: DB,
  scope: MaintenanceScope
): MaintenanceRepo[] | null {
  if (
    db.prepare("SELECT id FROM profiles WHERE id = ?").get(scope.profileId) ===
    undefined
  )
    return null;
  const repos = db
    .prepare(
      `SELECT r.id, r.name, r.path, r.profile_id AS profileId, p.name AS profileName
    FROM repos r JOIN profiles p ON p.id = r.profile_id
    WHERE ${visibleRepoSql("r")}
    ${scope.allProfiles === true ? "" : "AND r.profile_id = ?"}
    ORDER BY p.name COLLATE NOCASE, r.name COLLATE NOCASE, r.id`
    )
    .all(
      ...(scope.allProfiles === true ? [] : [scope.profileId])
    ) as MaintenanceRepo[];
  // A narrowing, never a widening: an id outside the profile scope above is
  // dropped rather than reached.
  if (scope.repoIds === undefined) return repos;
  const wanted = new Set(scope.repoIds);
  return repos.filter((repo) => wanted.has(repo.id));
}

/**
 * Each local branch's cached pull request — the review's evidence for squash
 * and rebase merges. Read from `branch_pr`, keyed by branch name; a row with
 * no number is the cache saying "no PR", which is the same as no row here.
 */
export function branchPrEvidence(
  db: DB,
  repoId: string
): Map<string, BranchPrEvidence> {
  const rows = db
    .prepare(
      `SELECT branch, number, url, state, merged_at, head_oid FROM branch_pr
       WHERE repo_id = ? AND number IS NOT NULL`
    )
    .all(repoId) as {
    branch: string;
    number: number;
    url: string | null;
    state: string | null;
    merged_at: number | null;
    head_oid: string | null;
  }[];
  return new Map(
    rows.map((row) => [
      row.branch,
      {
        number: row.number,
        url: row.url ?? "",
        state:
          row.state === "merged"
            ? "merged"
            : row.state === "closed"
              ? "closed"
              : "open",
        ...(typeof row.merged_at === "number"
          ? { mergedAt: row.merged_at }
          : {}),
        ...(typeof row.head_oid === "string" && row.head_oid !== ""
          ? { headOid: row.head_oid }
          : {})
      }
    ])
  );
}

/** Options cross IPC; anything malformed falls back to the defaults whole. */
function cleanupOptions(
  value: BranchCleanupOptions | undefined
): BranchCleanupOptions {
  if (
    value === undefined ||
    typeof value.prProof !== "boolean" ||
    !(value.keepDays === null || isBranchCleanupKeepDays(value.keepDays))
  )
    return DEFAULT_BRANCH_CLEANUP_OPTIONS;
  return { prProof: value.prProof, keepDays: value.keepDays };
}

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

export function registerMaintenanceHandlers(
  bus: CommandBus,
  db: DB,
  git: GitExec,
  operations: WorktreeOperationQueue,
  indexer: Pick<RepoIndexer, "refreshRepoWorktrees">,
  prs?: Pick<PrService, "refreshRepo">,
  now: () => number = Date.now,
  /** The repository's default branch name, for Clones' main-checkout
   *  update. Null leaves every main checkout as it is. */
  defaultBranch: (repoId: string, repoPath: string) => Promise<string | null> = async () => null
): { releaseWebContents: (id: number) => void } {
  // One sweep across all windows, regardless of operation ids or profiles.
  // Renderer bugs cannot create an unbounded GC process/queue per click.
  // A reload keeps the webContents (and its id), so the run outlives the
  // dialog that started it. `run` and `view` are what the reloaded dialog
  // needs to draw it again; `view` is folded from the same events the
  // renderer is sent, in `progress()`.
  type RunRecord = Omit<MaintenanceRunRecord, "ownWindow">;
  let active:
    | {
        id: string;
        owner: number | undefined;
        controller: AbortController;
        run: RunRecord;
        view: MaintenanceRunView;
      }
    | undefined;
  /** Each profile's last finished run, for its receipt. Memory only. */
  const finished = new Map<
    string,
    { owner: number | undefined; run: RunRecord; summary: MaintenanceSummary; seen: boolean }
  >();

  bus.register("maintenance:cancel", (req, ctx) => {
    if (active?.id !== req.operationId || active.owner !== ctx.webContentsId)
      return ok({ cancelled: false });
    active.controller.abort();
    return ok({ cancelled: true });
  });

  // Scoped by the profile the renderer names (src/main/AGENTS.md): one
  // profile's window never reattaches to another's run, even an
  // all-profiles run whose repositories include its own.
  bus.register("maintenance:current", (req, ctx) => {
    const profileId = typeof req?.profileId === "string" ? req.profileId : null;
    if (profileId === null) return ok(null);
    if (active !== undefined && active.run.profileId === profileId)
      return ok({
        state: "running",
        run: { ...active.run, ownWindow: active.owner === ctx.webContentsId },
        view: active.view,
        cancelling: active.controller.signal.aborted
      });
    const last = finished.get(profileId);
    if (last === undefined) return ok(null);
    return ok({
      state: "finished",
      run: { ...last.run, ownWindow: last.owner === ctx.webContentsId },
      summary: last.summary,
      seen: last.seen
    });
  });

  bus.register("maintenance:seen", (req) => {
    const last = finished.get(req?.profileId);
    if (last !== undefined && last.summary.operationId === req.operationId) last.seen = true;
    return ok(null);
  });

  bus.register("maintenance:restoreBranch", async (req) => {
    const repo = db
      .prepare("SELECT id, path, profile_id AS profileId FROM repos WHERE id = ?")
      .get(req.repoId) as
      | { id: string; path: string; profileId: string }
      | undefined;
    if (repo === undefined)
      return err({
        kind: "repo",
        code: "repo_not_found",
        message: "This repository is no longer indexed."
      });
    if (!/^[0-9a-f]{40,64}$/i.test(req.head ?? "") || !req.branch?.trim())
      return err({
        kind: "validation",
        code: "invalid_restore",
        message: "Choose a deleted branch from the receipt to restore."
      });
    const restored = await operations.runRepository(repo.id, () =>
      restoreStaleBranch(git, repo.path, req.branch, req.head)
    );
    if (!restored.ok) return restored;
    logMain("info", "maintenance", `restored ${req.branch} at ${req.head.slice(0, 12)} in ${repo.path}`);
    await indexer.refreshRepoWorktrees(repo.id);
    emitEvent("graph:changed", { repoId: repo.id });
    emitEvent("repo:changed", { profileId: repo.profileId, repoIds: [repo.id] });
    return ok(null);
  });

  bus.register("maintenance:run", async (req, ctx) => {
    if (
      !req.operationId?.trim() ||
      !["gc", "scan-branches", "delete-branches", "reshare"].includes(req.action?.kind) ||
      (req.action.kind === "reshare" && typeof req.action.updateMain !== "boolean") ||
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
    if (req.action.kind === "reshare") {
      // Ask the Git in use, not the renderer: Settings can switch it between
      // the tab opening and Start.
      if (activeGitReflinkProbe() === null) await refreshActiveGitReflink();
      if (activeGitReflinkProbe()?.support.reshare !== true)
        return err({
          kind: "git",
          code: "reflink_unavailable",
          message:
            "Refreshing clones needs PwrGit’s Git with git worktree reflink. Choose it in Settings › Git."
        });
      // Another Start may have taken the slot while this one waited for the
      // probe. From here to `active = current` nothing awaits, so this check
      // holds: one run at a time is what a reloaded window reattaches to.
      if (active !== undefined)
        return err({
          kind: "repo",
          code: "maintenance_running",
          message:
            "Repository maintenance is already running in another dialog. Wait for it to finish."
        });
    }
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
    const linkedCounts =
      action.kind === "reshare" ? linkedWorktreeCounts(db, knownRepos) : null;
    const clones = linkedCounts === null ? null : splitByLinkedWorktrees(knownRepos, linkedCounts);
    const noWorktrees = clones?.noWorktrees ?? [];
    const repos =
      action.kind === "delete-branches"
        ? knownRepos.filter((repo) =>
            selected.some((branch) => branch.repoId === repo.id)
          )
        : clones?.withWorktrees ?? knownRepos;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (ctx.signal?.aborted === true) abort();
    else ctx.signal?.addEventListener("abort", abort, { once: true });
    const startedAt = new Date().toISOString();
    const run: RunRecord = {
      operationId: req.operationId,
      profileId: req.profileId,
      allProfiles: req.allProfiles === true,
      ...(req.repoIds === undefined ? {} : { repoIds: req.repoIds }),
      action,
      startedAt
    };
    const current = {
      id: req.operationId,
      owner: ctx.webContentsId,
      controller,
      run,
      view: EMPTY_MAINTENANCE_RUN_VIEW
    };
    active = current;
    // This run supersedes the profile's last receipt. If it ends on an
    // error there is no newer one, and the older one is not the latest.
    finished.delete(req.profileId);
    let seq = 0;
    let ended = false;
    const results = new Map<string, MaintenanceRepoResult>();
    const commonDirectories = new Set<string>();
    const storeTurns = new Map<string, Promise<unknown>>();
    /** Run `work` after every earlier turn on the same object store. */
    const inStoreTurn = <T>(
      directory: string,
      work: () => Promise<T>
    ): Promise<T> => {
      const turn = (storeTurns.get(directory) ?? Promise.resolve()).then(
        work,
        work
      );
      storeTurns.set(
        directory,
        turn.catch(() => undefined)
      );
      return turn;
    };
    /** The one place a run reports: the event every window hears, and the
     *  snapshot a reloaded window reattaches to. */
    const progress = (
      event: Omit<MaintenanceProgress, "operationId" | "profileId" | "seq">
    ): void => {
      const full: MaintenanceProgress = {
        ...event,
        operationId: req.operationId,
        profileId: req.profileId,
        seq: ++seq
      };
      current.view = foldMaintenanceProgress(current.view, full);
      emitEvent("maintenance:progress", full);
    };

    try {
      progress({ phase: "starting", repos, ...(linkedCounts === null ? {} : { noWorktrees }) });
      // GC and review claim each common directory before work; deletion
      // takes turns per directory instead (`inStoreTurn`).
      const concurrency = Math.max(
        1,
        Math.min(4, Math.floor(availableParallelism() / 2))
      );
      const selectedCount = new Map<string, number>();
      for (const branch of selected)
        selectedCount.set(
          branch.repoId,
          (selectedCount.get(branch.repoId) ?? 0) + 1
        );
      // The longest deletion starts first, so it is not the one left running
      // alone at the end. The rows keep their reviewed order on screen.
      // Clones does the same with worktree counts: a 400-worktree repository
      // started last would run alone for minutes.
      const order =
        action.kind === "delete-branches"
          ? largestFirst(repos, selectedCount)
          : linkedCounts !== null
            ? largestFirst(repos, linkedCounts)
            : repos;
      await mapLimit(order, concurrency, async (repo) => {
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
                      "Shares an object store with a repository already claimed in this run."
                  };
                }
                commonDirectories.add(directory.value);
                /** The review, with the evidence the action asked for. */
                const review = async (options: BranchCleanupOptions) =>
                  reviewStaleBranches(git, repo.path, repo.id, {
                    options,
                    prs: branchPrEvidence(db, repo.id),
                    now: now()
                  });
                if (action.kind === "reshare") {
                  const rows = db
                    .prepare(
                      `SELECT id, path, branch, is_primary AS isPrimary, missing, locked
                       FROM worktrees WHERE repo_id = ? ORDER BY is_primary DESC, path`
                    )
                    .all(repo.id) as Array<{
                    id: string;
                    path: string;
                    branch: string;
                    isPrimary: number;
                    missing: number;
                    locked: number;
                  }>;
                  const worktrees: ReshareWorktreeRow[] = rows.map((row) => ({
                    id: row.id,
                    path: row.path,
                    branch: row.branch,
                    isPrimary: row.isPrimary === 1,
                    missing: row.missing === 1,
                    locked: row.locked === 1
                  }));
                  return refreshRepositoryClones({
                    git,
                    repo,
                    worktrees,
                    updateMain: action.updateMain,
                    signal: controller.signal,
                    report,
                    defaultBranch: () => defaultBranch(repo.id, repo.path),
                    softPull: (primary) =>
                      softPullMainCheckout(git, repo, primary, {
                        operationId: `${req.operationId}:${repo.id}`,
                        signal: controller.signal,
                        runWorktree: (worktreeId, operation) => operations.run(worktreeId, operation),
                        report
                      }),
                    runWorktree: (worktreeId, operation) => operations.run(worktreeId, operation)
                  });
                }
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
                    action.mode,
                    () => report(
                      "Rebuilding a stale commit-graph cache before retrying collection…"
                    )
                  );
                  report("Measuring object storage after collection…");
                  const afterBytes = await objectStorageBytes(git, repo.path);
                  // Collection never removes a branch name, which is exactly
                  // what people run it hoping for. Count what the branch
                  // review would offer — cached PR rows only, no forge
                  // request — so the receipt can hand off to it. A failed
                  // count costs the offer, never the collection's result.
                  const finished =
                    collected.ok && action.branchOptions !== undefined
                      ? await review(cleanupOptions(action.branchOptions))
                      : undefined;
                  return {
                    repo,
                    outcome: collected.ok ? "success" : "failed",
                    message: collected.ok
                      ? "Garbage collection completed."
                      : sanitizeGitLogDetail(collected.error.message),
                    ...(beforeBytes === undefined ? {} : { beforeBytes }),
                    ...(afterBytes === undefined ? {} : { afterBytes }),
                    ...(finished?.ok === true
                      ? {
                          candidates: finished.value.candidates,
                          kept: finished.value.kept
                        }
                      : {})
                  };
                }
                if (action.kind === "scan-branches") {
                  const options = cleanupOptions(action.options);
                  if (options.prProof && prs !== undefined) {
                    // Squash merges are proven by a PR's head commit, and a
                    // row cached before that was fetched has none. Best
                    // effort: the refresh keeps whatever is cached when the
                    // forge cannot be reached, and those rows are kept.
                    report("Checking pull requests for local branches…");
                    try {
                      await prs.refreshRepo(repo.id, { trigger: "user" });
                    } catch (cause) {
                      logMain(
                        "warn",
                        "maintenance",
                        `PR refresh before branch review failed for ${repo.id}: ${cause instanceof Error ? cause.message : String(cause)}`
                      );
                    }
                  }
                  report(
                    "Checking local branches, upstreams, and merged commits…"
                  );
                  const scanned = await review(options);
                  return scanned.ok
                    ? {
                        repo,
                        outcome: "success",
                        candidates: scanned.value.candidates,
                        kept: scanned.value.kept,
                        message: `${plural(scanned.value.candidates.length, "finished branch", "finished branches")} · ${scanned.value.kept.length} kept.`
                      }
                    : {
                        repo,
                        outcome: "failed",
                        message: sanitizeGitLogDetail(scanned.error.message)
                      };
                }
                const repoCandidates = selected.filter(
                  (branch) => branch.repoId === repo.id
                );
                // Two rows can name one object store, and concurrent ref
                // transactions on it fight over packed-refs.lock. Rows that
                // share a store take turns; every other repository runs.
                return inStoreTurn(directory.value, async () => {
                  // Cancelled while waiting for the store: spend no Git on
                  // a review whose answer nothing will act on.
                  if (controller.signal.aborted)
                    return {
                      repo,
                      outcome: "cancelled",
                      message: `0 local branches deleted; ${repoCandidates.length} retained.`,
                      branches: repoCandidates.map((candidate) => ({
                        branch: candidate.branch,
                        head: candidate.expectedHead,
                        deleted: false,
                        message: "Cancelled; retained."
                      }))
                    };
                  // One fresh review for the batch, not one per branch, and
                  // one batched delete: per branch, the old path cost five
                  // Git processes plus one per worktree.
                  report("Checking the reviewed branches again…");
                  const fresh = await review(cleanupOptions(action.options));
                  const total = repoCandidates.length;
                  report(`Deleting ${plural(total, "branch", "branches")}…`);
                  const outcome = fresh.ok
                    ? await deleteStaleBranches(
                        git,
                        repo.path,
                        repoCandidates,
                        fresh.value,
                        {
                          signal: controller.signal,
                          onProgress: (done, deleted) =>
                            report(
                              `Checked ${done} of ${total} branches · ${deleted} deleted…`
                            )
                        }
                      )
                    : fresh;
                  const branches: DeletedBranchResult[] = repoCandidates.map(
                    (candidate) => {
                      const entry = {
                        branch: candidate.branch,
                        head: candidate.expectedHead
                      };
                      const deleted = outcome.ok
                        ? outcome.value.get(candidate.branch)
                        : outcome;
                      if (deleted === undefined)
                        return {
                          ...entry,
                          deleted: false,
                          message: "Cancelled; retained."
                        };
                      return {
                        ...entry,
                        deleted: deleted.ok,
                        message: deleted.ok
                          ? "Deleted local branch."
                          : sanitizeGitLogDetail(deleted.error.message)
                      };
                    }
                  );
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
                });
              }
            );
            if (action.kind === "reshare" && result.reshare?.main.outcome === "updated") {
              // The main checkout moved; let the sidebar and graph catch up.
              try {
                await indexer.refreshRepoWorktrees(repo.id);
              } catch {
                // Best effort: the re-share already finished.
              }
              emitEvent("graph:changed", { repoId: repo.id });
              emitEvent("repo:changed", { profileId: repo.profileId, repoIds: [repo.id] });
            }
            if (action.kind === "delete-branches") {
              // A failed metadata cleanup can follow a successful ref change,
              // so refresh even when the deletion result was not successful.
              try {
                const refreshed = await indexer.refreshRepoWorktrees(repo.id);
                if (!refreshed.ok) {
                  result = {
                    ...result,
                    outcome: "partial",
                    message: `${result.message} Refresh failed: ${sanitizeGitLogDetail(refreshed.error.message)}`
                  };
                }
              } catch (cause) {
                result = {
                  ...result,
                  outcome: "partial",
                  message: `${result.message} Refresh failed: ${sanitizeGitLogDetail(cause)}`
                };
              }
              emitEvent("graph:changed", { repoId: repo.id });
              emitEvent("repo:changed", { profileId: repo.profileId, repoIds: [repo.id] });
            }
          } catch (cause) {
            result = {
              repo,
              outcome: "failed",
              message: sanitizeGitLogDetail(cause)
            };
          }
        }
        results.set(repo.id, result);
        progress({ phase: "repo_completed", repo, result });
        logMain(
          result.outcome === "failed" ? "warn" : "info",
          "maintenance",
          `${action.kind}: ${repo.path}: ${result.message}`
        );
      });
      const summary: MaintenanceSummary = {
        operationId: req.operationId,
        startedAt,
        finishedAt: new Date().toISOString(),
        cancelled: controller.signal.aborted,
        results: repos.map((repo) => results.get(repo.id)!),
        ...(linkedCounts === null ? {} : { noWorktrees })
      };
      // Recorded before the run lets go, so a window asking in between
      // finds it either running or finished, never neither.
      finished.set(req.profileId, { owner: ctx.webContentsId, run, summary, seen: false });
      active = undefined;
      ended = true;
      progress({ phase: "finished", summary });
      return ok(summary);
    } finally {
      active = undefined;
      ctx.signal?.removeEventListener("abort", abort);
      // A reattached window awaits no answer; tell it the run is over.
      if (!ended) progress({ phase: "finished" });
    }
  });
  return {
    releaseWebContents: (id) => {
      if (active?.owner === id) active.controller.abort();
    }
  };
}
