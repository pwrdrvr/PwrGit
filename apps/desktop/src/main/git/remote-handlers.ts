import {
  err,
  ok,
  type PullProgressPhase,
  type PwrGitError
} from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import { execGit, sanitizeGitLogDetail } from "./dugite";
import {
  addRemote,
  fetchAllRemotes,
  fetchNamedRemote,
  fetchRemote,
  inspectRemoteDivergence,
  inspectRemoteReset,
  pullFastForward,
  planPushRefs,
  pushPlannedRefs,
  pushRemote,
  rebaseOntoUpstream,
  removeRemote,
  resetToRemote,
  resetToUpstream,
  updateRemote
} from "./git-service";
import type { WorktreeRefresher } from "./worktree-handlers";
import type { RepoIndexer } from "./repo-indexer";
import {
  formatPullDuration,
  PULL_RECOVERY_OPERATION_TIMEOUT_MS,
  PULL_RECOVERY_STALL_TIMEOUT_MS,
  PULL_RECOVERY_STALL_WARNING_MS,
  pullPhaseDescription,
  PullWatchdog,
  type PullWatchdogPhase,
  type PullWatchdogSnapshot
} from "./pull-watchdog";
import {
  applySshRemoteRecovery,
  inspectSshRemoteRecovery,
  testSshRemoteRecovery
} from "./ssh-remote-recovery";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

const seconds = (startedAt: number): string =>
  `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

export const PULL_REFRESH_WAIT_LIMIT_MS = 2 * 60_000;

function safePullError(
  error: PwrGitError,
  phase: PullWatchdogPhase,
  elapsedMs: number
): PwrGitError {
  if (error.code === "pull_stalled" || error.code === "pull_timed_out") {
    return error;
  }
  if (error.code === "not_fast_forward") return error;
  const base = { kind: error.kind, code: error.code };
  const elapsed = formatPullDuration(elapsedMs);
  switch (error.code) {
    case "no_upstream":
      return {
        ...base,
        message:
          "The current branch has no usable upstream. Configure an upstream branch, then retry Pull."
      };
    case "authentication_required":
      return {
        ...base,
        message: `Pull needs authentication during ${pullPhaseDescription(phase)} after ${elapsed}. Configure a credential manager, authenticated remote, or SSH key, then retry. PwrGit does not open terminal credential prompts. See Logs for details.`
      };
    case "stash_reapply_failed":
      return {
        ...base,
        message: `Pull stopped during ${pullPhaseDescription(phase)} after ${elapsed}. PwrGit could not reapply the saved local changes; the stash was kept. See Logs for details.`
      };
    case "pull_rollback_failed":
      return {
        ...base,
        message: `Pull stopped during ${pullPhaseDescription(phase)} after ${elapsed}, and PwrGit could not fully restore the original checkout. Inspect the worktree and stash before retrying. See Logs for details.`
      };
    default:
      return {
        ...base,
        message: `Pull failed during ${pullPhaseDescription(phase)} after ${elapsed}. See Logs for Git details, then retry.`
      };
  }
}

function classifyPullError(error: PwrGitError): PwrGitError {
  if (
    /authentication failed|terminal prompts disabled|could not read (?:username|password)|username for ['"]|password for ['"]|permission denied \(publickey|credential[^\r\n]*(?:failed|unavailable)/i.test(
      error.message
    )
  ) {
    return {
      kind: "remote",
      code: "authentication_required",
      message: error.message,
      cause: error
    };
  }
  return error;
}

async function waitForRefresh(
  refresh: Promise<void>,
  timeoutMs = PULL_REFRESH_WAIT_LIMIT_MS
): Promise<"complete" | "timed_out"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      refresh.then(() => "complete" as const),
      new Promise<"timed_out">((resolve) => {
        timeout = setTimeout(() => resolve("timed_out"), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

const notFound: PwrGitError = {
  kind: "repo",
  code: "not_found",
  message: "worktree not found"
};

export function registerRemoteHandlers(
  bus: CommandBus,
  db: DB,
  refresher: WorktreeRefresher,
  operations: WorktreeOperationQueue,
  indexer?: Pick<RepoIndexer, "refreshRepoRemoteBranches">
): void {
  const worktreeOf = (
    worktreeId: string
  ): { path: string; repoId: string } | null =>
    (
      db
        .prepare("SELECT path, repo_id AS repoId FROM worktrees WHERE id = ?")
        .get(worktreeId) as
        | { path: string; repoId: string }
        | undefined
    ) ?? null;

  const pathOf = (worktreeId: string): string | null =>
    worktreeOf(worktreeId)?.path ?? null;

  const repoOf = (repoId: string): { path: string } | null => {
    const row = db
      .prepare("SELECT path FROM repos WHERE id = ?")
      .get(repoId) as { path: string } | undefined;
    return row === undefined ? null : { path: row.path };
  };

  const refreshRemoteBranches = async (
    repoId: string,
    operation: string
  ): Promise<void> => {
    if (indexer === undefined) return;
    try {
      const refreshed = await indexer.refreshRepoRemoteBranches(repoId);
      if (!refreshed.ok) {
        logMain(
          "warn",
          "remote",
          `${operation} branch-index refresh failed for ${repoId}: ${refreshed.error.message}`
        );
      }
    } catch (cause) {
      logMain(
        "warn",
        "remote",
        `${operation} branch-index refresh failed for ${repoId}: ${sanitizeGitLogDetail(cause)}`
      );
    }
  };

  // Ordinary sync successes log at info; Pull adds live phase/failure details
  // below because a long-running command cannot wait for command-bus logging.
  bus.register("remote:fetch", async (req) => {
    const worktree = worktreeOf(req.worktreeId);
    if (worktree === null) return err(notFound);
    const startedAt = Date.now();
    const result = await operations.runRepository(worktree.repoId, () =>
      fetchRemote(execGit, worktree.path)
    );
    if (!result.ok) return result;
    logMain(
      "info",
      "remote",
      `fetched ${worktree.path} (${seconds(startedAt)})`
    );
    await refreshRemoteBranches(worktree.repoId, "fetch");
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });

  bus.register("remote:fetchRepo", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === null) return err({ ...notFound, message: "repo not found" });
    const startedAt = Date.now();
    const result = await operations.runRepository(req.repoId, () =>
      req.remote === undefined
        ? fetchAllRemotes(execGit, repo.path)
        : fetchNamedRemote(execGit, repo.path, req.remote)
    );
    if (!result.ok) return result;
    logMain(
      "info",
      "remote",
      `fetched ${req.remote ?? "all remotes"} for ${repo.path} (${seconds(startedAt)})`
    );
    await refreshRemoteBranches(req.repoId, "fetch");
    refresher.refreshRepoWorktrees(req.repoId);
    return ok(null);
  });

  bus.register("remote:add", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === null) return err({ ...notFound, message: "repo not found" });
    const result = await addRemote(execGit, repo.path, req);
    if (!result.ok) return result;
    logMain("info", "remote", `added remote ${req.name} to ${repo.path}`);
    await refreshRemoteBranches(req.repoId, "add remote");
    refresher.refreshRepoWorktrees(req.repoId);
    return ok(null);
  });

  bus.register("remote:update", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === null) return err({ ...notFound, message: "repo not found" });
    const result = await updateRemote(execGit, repo.path, req);
    if (!result.ok) return result;
    logMain(
      "info",
      "remote",
      `updated remote ${req.originalName} as ${req.name} in ${repo.path}`
    );
    await refreshRemoteBranches(req.repoId, "update remote");
    refresher.refreshRepoWorktrees(req.repoId);
    return ok(null);
  });

  bus.register("remote:inspectSshRecovery", async (req) => {
    const worktree = worktreeOf(req.worktreeId);
    if (worktree === null) return err(notFound);
    return inspectSshRemoteRecovery(execGit, worktree.path);
  });

  bus.register("remote:testSshRecovery", async (req) => {
    const worktree = worktreeOf(req.worktreeId);
    if (worktree === null) return err(notFound);
    const startedAt = Date.now();
    logMain(
      "info",
      "remote",
      `testing SSH read access for ${req.recovery.remote} in ${worktree.path}`
    );
    const result = await operations.run(req.worktreeId, () =>
      testSshRemoteRecovery(execGit, worktree.path, req.recovery)
    );
    if (!result.ok) return result;
    logMain(
      "info",
      "remote",
      `SSH read test succeeded for ${req.recovery.remote} in ${worktree.path} (${seconds(startedAt)})`
    );
    return ok(null);
  });

  bus.register("remote:applySshRecovery", async (req) => {
    const worktree = worktreeOf(req.worktreeId);
    if (worktree === null) return err(notFound);
    const result = await operations.run(req.worktreeId, () =>
      applySshRemoteRecovery(execGit, worktree.path, req.recovery)
    );
    if (!result.ok) return result;
    logMain(
      "info",
      "remote",
      `changed ${req.recovery.remote} from HTTPS to SSH in ${worktree.path}`
    );
    refresher.refreshRepoWorktrees(worktree.repoId);
    return ok(null);
  });

  bus.register("remote:remove", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === null) return err({ ...notFound, message: "repo not found" });
    const result = await removeRemote(execGit, repo.path, req.remote);
    if (!result.ok) return result;
    logMain("info", "remote", `removed remote ${req.remote} from ${repo.path}`);
    await refreshRemoteBranches(req.repoId, "remove remote");
    refresher.refreshRepoWorktrees(req.repoId);
    return ok(null);
  });

  bus.register("remote:planPushRefs", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === null) return err({ ...notFound, message: "repo not found" });
    const result = await operations.runRepository(req.repoId, () =>
      planPushRefs(execGit, repo.path, req.sourceRef, req.destinations)
    );
    refresher.refreshRepoWorktrees(req.repoId);
    return result;
  });

  bus.register("remote:pushRefs", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === null) return err({ ...notFound, message: "repo not found" });
    const startedAt = Date.now();
    const result = await operations.runRepository(req.repoId, () =>
      pushPlannedRefs(execGit, repo.path, req.plans)
    );
    refresher.refreshRepoWorktrees(req.repoId);
    if (!result.ok) return result;
    await refreshRemoteBranches(req.repoId, "push refs");
    const pushed = result.value.filter((item) => item.outcome === "pushed").length;
    logMain(
      "info",
      "remote",
      `pushed ${pushed}/${result.value.length} reviewed refs for ${repo.path} (${seconds(startedAt)})`
    );
    return result;
  });

  bus.register("remote:pull", async (req) => {
    const worktree = worktreeOf(req.worktreeId);
    if (worktree === null) return err(notFound);
    const path = worktree.path;
    const startedAt = Date.now();
    let currentPhase: PullWatchdogPhase = "starting";
    let recoveryActive = false;
    let recoveryWatchdog: PullWatchdog | undefined;
    logMain("info", "remote", `pull started ${path} (${seconds(startedAt)})`);
    const onStallWarning = (snapshot: PullWatchdogSnapshot): void => {
      logMain(
        "warn",
        "remote",
        `pull still waiting ${path} during ${pullPhaseDescription(snapshot.phase)} (${formatPullDuration(snapshot.elapsedMs)} elapsed; no Git output for ${formatPullDuration(snapshot.idleMs)})`
      );
    };
    const onTimeout = (
      error: PwrGitError,
      snapshot: PullWatchdogSnapshot
    ): void => {
      logMain(
        "error",
        "remote",
        `pull timeout ${path} during ${pullPhaseDescription(snapshot.phase)} after ${formatPullDuration(snapshot.elapsedMs)}: ${error.code}; direct Git termination requested (LFS/filter helpers should exit when inherited pipes close)`
      );
    };
    let reportPhase: (phase: PullProgressPhase) => void = () => {};
    let result: Awaited<ReturnType<typeof pullFastForward>>;
    try {
      result = await operations.runRepository(worktree.repoId, async () => {
        // Start the watchdog only after this pull owns the repository fetch
        // scope. Time spent queued behind another fetch is not a Git stall.
        const watchdog = new PullWatchdog({ onStallWarning, onTimeout });
        reportPhase = (phase: PullProgressPhase): void => {
          if (recoveryActive) {
            logMain(
              "info",
              "remote",
              `pull recovery step ${pullPhaseDescription(phase)} ${path} (${seconds(startedAt)})`
            );
            emitEvent("worktree:pullProgress", {
              worktreeId: req.worktreeId,
              phase
            });
            return;
          }
          // Once a timeout fires, preserve its phase while cleanup runs.
          if (watchdog.signal.aborted) return;
          currentPhase = phase;
          watchdog.setPhase(phase);
          logMain(
            "info",
            "remote",
            `pull phase ${pullPhaseDescription(phase)} ${path} (${seconds(startedAt)})`
          );
          emitEvent("worktree:pullProgress", {
            worktreeId: req.worktreeId,
            phase
          });
        };
        try {
          return await operations.run(req.worktreeId, () =>
            pullFastForward(execGit, path, reportPhase, {
              signal: watchdog.signal,
              onActivity: () => watchdog.noteActivity(),
              startRecovery: () => {
                watchdog.finish();
                const priorPhase = currentPhase;
                recoveryActive = true;
                currentPhase = "recovery";
                logMain(
                  "info",
                  "remote",
                  `pull phase ${pullPhaseDescription("recovery")} ${path} (${seconds(startedAt)})`
                );
                recoveryWatchdog = new PullWatchdog({
                  stallWarningMs: PULL_RECOVERY_STALL_WARNING_MS,
                  stallTimeoutMs: PULL_RECOVERY_STALL_TIMEOUT_MS,
                  operationTimeoutMs: PULL_RECOVERY_OPERATION_TIMEOUT_MS,
                  onStallWarning,
                  onTimeout
                });
                recoveryWatchdog.setPhase("recovery");
                return {
                  signal: recoveryWatchdog.signal,
                  onActivity: () => recoveryWatchdog?.noteActivity(),
                  finish: (succeeded: boolean) => {
                    recoveryWatchdog?.finish();
                    recoveryActive = false;
                    if (succeeded) currentPhase = priorPhase;
                  }
                };
              }
            })
          );
        } finally {
          watchdog.finish();
          recoveryWatchdog?.finish();
        }
      });
    } catch (cause) {
      const detail = sanitizeGitLogDetail(cause);
      logMain(
        "error",
        "remote",
        `pull failed ${path} during ${pullPhaseDescription(currentPhase)} after ${seconds(startedAt)}: handler exception${detail === "" ? "" : `: ${detail}`}`
      );
      return err({
        kind: "remote",
        code: "pull_failed",
        message: `Pull failed during ${pullPhaseDescription(currentPhase)} after ${formatPullDuration(Date.now() - startedAt)}. See Logs for details, then retry.`
      });
    }
    if (!result.ok) {
      const classified = classifyPullError(result.error);
      const detail = sanitizeGitLogDetail(result.error.message);
      logMain(
        "error",
        "remote",
        `pull failed ${path} during ${pullPhaseDescription(currentPhase)} after ${seconds(startedAt)}: ${classified.kind}/${classified.code}${detail === "" ? "" : `: ${detail}`}`
      );
      return err(
        safePullError(classified, currentPhase, Date.now() - startedAt)
      );
    }

    const { stashed, reappliedWithConflicts } = result.value;
    const outcome = reappliedWithConflicts
      ? "fast-forwarded, stash reapplied WITH CONFLICTS"
      : stashed
        ? "fast-forwarded, stashed changes reapplied"
        : "fast-forwarded";
    reportPhase("refresh");
    try {
      const refresh = await waitForRefresh(
        refresher.refreshWorktree(req.worktreeId)
      );
      if (refresh === "timed_out") {
        logMain(
          "warn",
          "remote",
          `pull refresh still running for ${path} after ${formatPullDuration(PULL_REFRESH_WAIT_LIMIT_MS)}; completing the successful pull without waiting longer (${seconds(startedAt)} elapsed)`
        );
      }
    } catch (cause) {
      // The pull has already changed the repository successfully. A failed
      // state refresh must not turn that completed mutation into "Pull failed".
      logMain(
        "warn",
        "remote",
        `pull refresh failed ${path} during ${pullPhaseDescription("refresh")} after ${seconds(startedAt)}: ${sanitizeGitLogDetail(cause)}`
      );
    }
    logMain(
      "info",
      "remote",
      `pull finished ${path}: ${outcome} (${seconds(startedAt)})`
    );
    const pulledWorktree = worktreeOf(req.worktreeId);
    if (pulledWorktree !== null) {
      await refreshRemoteBranches(pulledWorktree.repoId, "pull");
    }
    return result;
  });

  bus.register("remote:push", async (req) => {
    const worktree = worktreeOf(req.worktreeId);
    if (worktree === null) return err(notFound);
    const startedAt = Date.now();
    const result = await pushRemote(execGit, worktree.path);
    if (!result.ok) return result;
    logMain("info", "remote", `pushed ${worktree.path} (${seconds(startedAt)})`);
    await refreshRemoteBranches(worktree.repoId, "push");
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });

  bus.register("remote:inspectDivergence", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return inspectRemoteDivergence(execGit, path);
  });

  bus.register("remote:resetToUpstream", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const startedAt = Date.now();
    const result = await operations.run(req.worktreeId, () =>
      resetToUpstream(execGit, path, req)
    );
    if (!result.ok) return result;
    logMain("info", "remote", `reset ${path} to upstream (${seconds(startedAt)})`);
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });

  bus.register("remote:inspectReset", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    return inspectRemoteReset(execGit, path, req.remoteRef);
  });

  bus.register("remote:resetToRemote", async (req) => {
    const worktree = worktreeOf(req.worktreeId);
    if (worktree === null) return err(notFound);
    const startedAt = Date.now();
    const result = await operations.run(req.worktreeId, () =>
      resetToRemote(execGit, worktree.path, req, req.mode)
    );
    // A failed hard reset can still have touched the checkout before a file
    // operation failed. The moved branch may also be the repository default,
    // which changes every sibling's derived staleness/merge relationships.
    // Recompute the repository once for both outcomes.
    refresher.refreshRepoWorktrees(worktree.repoId);
    if (!result.ok) return result;
    logMain(
      "info",
      "remote",
      `${req.mode}-reset ${worktree.path} (${req.branch}) to ${req.remoteRef} at ${req.remoteHead} (${seconds(startedAt)})`
    );
    return ok(null);
  });

  bus.register("remote:rebaseOntoUpstream", async (req) => {
    const path = pathOf(req.worktreeId);
    if (path === null) return err(notFound);
    const startedAt = Date.now();
    const result = await operations.run(req.worktreeId, () =>
      rebaseOntoUpstream(execGit, path, req)
    );
    // A stopped rebase changes the checkout too; refresh so the Changes panel
    // and sync badges show the conflict state immediately.
    refresher.refreshWorktree(req.worktreeId);
    if (!result.ok) return result;
    logMain("info", "remote", `rebased ${path} onto upstream (${seconds(startedAt)})`);
    return ok(null);
  });
}
