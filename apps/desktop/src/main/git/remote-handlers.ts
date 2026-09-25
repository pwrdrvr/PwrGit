import {
  err,
  ok,
  type PullProgressPhase,
  type PwrGitError,
  type RemoteActivityPhase,
  type ForkStatus,
  type RepoIdentity,
  type Result
} from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import { execGit, sanitizeGitLogDetail, type GitExec } from "./dugite";
import {
  addRemote,
  commitsSince,
  headCommit,
  controlledGit,
  fetchAllRemotes,
  fetchNamedRemote,
  fetchNamedRemotes,
  fetchRemote,
  forkFetchRemotes,
  inspectRemoteDivergence,
  inspectRemoteReset,
  pullFastForward,
  planPushRefs,
  pushBranchWithLease,
  pushPlannedRefs,
  pushRefLabel,
  pushRemote,
  rebaseOntoUpstream,
  removeRemote,
  resetToRemote,
  resetToUpstream,
  resolveForkStatus,
  resolveResetTargets,
  updateRemote,
  type FastForwardTarget,
  type ForkParentHint,
  type PullOutcome
} from "./git-service";
import {
  RemoteActivityRegistry,
  type RemoteActivityHandle,
  type RemoteActivityInput
} from "./remote-activity";
import type { WorktreeRefresher } from "./worktree-handlers";
import type { RepoIndexer } from "./repo-indexer";
import { liveWorktreePath, worktreeMissingError } from "./worktree-liveness";
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
  inspectSshPushRecovery,
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
  // A cancel is an outcome the user chose, not a failure to explain to them.
  if (error.code === "canceled") {
    return {
      kind: error.kind,
      code: error.code,
      message: `Pull canceled during ${pullPhaseDescription(phase)} after ${formatPullDuration(elapsedMs)}.`
    };
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

/**
 * Codes that already say more than "Git had no usable credential", whatever
 * their text mentions:
 * - `canceled` is the user's own decision, never a failure to remedy.
 * - `push_denied` means the forge accepted the credential and refused the
 *   account. Its remedy is the fork prompt; an SSH key signs in as the same
 *   account and would be refused the same way.
 * - `pull_stalled` / `pull_timed_out` are the watchdog's sentences, which
 *   name credentials as something to check, not as evidence.
 */
const NOT_AN_AUTH_FAILURE = new Set([
  "canceled",
  "push_denied",
  "pull_stalled",
  "pull_timed_out"
]);

/**
 * Read a failed fetch, pull or push as `authentication_required` when Git
 * could not get a credential it is not allowed to prompt for — the failure
 * the renderer answers by offering to switch an HTTPS remote to SSH.
 *
 * Both halves of the error are read: a push's `message` is PwrGit's headline
 * and Git's own stderr rides in `detail`. Both are kept, so the card still
 * quotes only what Git wrote.
 */
function classifyAuthFailure(error: PwrGitError): PwrGitError {
  if (NOT_AN_AUTH_FAILURE.has(error.code)) return error;
  if (
    /authentication failed|terminal prompts disabled|could not read (?:username|password)|username for ['"]|password for ['"]|permission denied \(publickey|credential[^\r\n]*(?:failed|unavailable)/i.test(
      `${error.message}\n${error.detail ?? ""}`
    )
  ) {
    return {
      kind: "remote",
      code: "authentication_required",
      message: error.message,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
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
  indexer?: Pick<RepoIndexer, "refreshRepoRemoteBranches">,
  /** Re-read this repo's forge identity. `force` skips the freshness gate —
   *  the repo's own remotes just changed, so the stored row is wrong now
   *  however recently it was written. */
  refreshIdentity?: (repoId: string, options?: { force?: boolean }) => void,
  /** The stored forge identity, for the reset dialog's fork-source card. */
  readIdentity?: (repoId: string) => RepoIdentity | undefined
): void {
  // Every long-running remote command reports through one registry: the live
  // status surfaces read it, and the cancel button acts on it.
  const activities = new RemoteActivityRegistry({
    emit: (list) => emitEvent("remote:activity", { activities: list }),
    log: (level, message) => logMain(level, "remote", message)
  });

  // Not-found and a gone checkout both refuse in the lookup itself, so no
  // handler below can reach git without the check.
  const worktreeOf = (
    worktreeId: string
  ): Result<{
    path: string;
    repoId: string;
    branch: string | null;
  }> => {
    const row = db
      .prepare(
        "SELECT path, repo_id AS repoId, branch, missing FROM worktrees WHERE id = ?"
      )
      .get(worktreeId) as
      | { path: string; repoId: string; branch?: string; missing?: number }
      | undefined;
    if (row === undefined) return err(notFound);
    if (row.missing === 1) return err(worktreeMissingError(row.path));
    return ok({
      path: row.path,
      repoId: row.repoId,
      branch: row.branch ?? null
    });
  };

  const pathOf = (worktreeId: string): Result<string> =>
    liveWorktreePath(db, worktreeId);

  const repoOf = (
    repoId: string
  ): { path: string; name: string; profileId: string } | null => {
    const row = db
      .prepare("SELECT path, name, profile_id AS profileId FROM repos WHERE id = ?")
      .get(repoId) as
      | { path: string; name?: string; profileId?: string }
      | undefined;
    if (row === undefined) return null;
    // Naming falls back to the id rather than refusing: a status card that
    // cannot say which repository it belongs to is still better than none.
    return {
      path: row.path,
      name: row.name ?? repoId,
      profileId: row.profileId ?? ""
    };
  };

  // The stored identity row, never a forge call: fork surfaces answer from
  // what is known, and an unknown parent falls back to the `upstream` naming
  // convention.
  const forkParentOf = (repoId: string): ForkParentHint | null => {
    const identity = readIdentity?.(repoId);
    return identity?.parent === undefined
      ? null
      : {
          hostname: identity.hostname,
          nameWithOwner: identity.parent.nameWithOwner
        };
  };

  /**
   * Wrap `execGit` so one activity sees every command it runs, the output Git
   * writes, and the liveness that proves the transfer is moving.
   *
   * `signal` is a parameter rather than `activity.signal` because Pull has a
   * watchdog of its own and must hand Git ONE signal that carries both — a
   * cancel and a stall have to reach the same process.
   */
  const activityGit = (
    activity: RemoteActivityHandle,
    signal: AbortSignal | undefined
  ): GitExec => {
    const controlled = controlledGit(execGit, {
      ...(signal === undefined ? {} : { signal }),
      onActivity: activity.onActivity,
      onStderr: activity.onStderr
    });
    return async (args, cwd, options) => {
      activity.setCommand(args);
      try {
        return await controlled(args, cwd, options);
      } finally {
        activity.setCommand(null);
      }
    };
  };

  /**
   * Run one tracked remote command under its repository lock: registered
   * BEFORE the lock is taken, so waiting behind another operation shows as
   * `queued` instead of as a silent spinner, moved to `phase` once it owns the
   * lock, and always retired afterwards.
   */
  const tracked = async <T>(
    input: RemoteActivityInput,
    phase: RemoteActivityPhase,
    run: (git: GitExec, activity: RemoteActivityHandle) => Promise<T>
  ): Promise<T> => {
    const activity = activities.begin(input);
    try {
      return await operations.runRepository(input.repoId, async () => {
        activity.setPhase(phase);
        return run(activityGit(activity, activity.signal), activity);
      });
    } finally {
      activity.finish();
    }
  };

  bus.register("remote:activities", () => ok(activities.list()));

  bus.register("remote:activityLog", (req) => {
    const lines = activities.logFor(req.operationId);
    return ok(lines === null ? null : { lines });
  });

  bus.register("remote:cancelActivity", (req) =>
    ok({
      canceled: activities.cancel(
        req.operationId,
        "Stopped at your request."
      )
    })
  );

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
    const live = worktreeOf(req.worktreeId);
    if (!live.ok) return live;
    const worktree = live.value;
    const repo = repoOf(worktree.repoId);
    const startedAt = Date.now();
    const result = await tracked(
      {
        kind: "fetch",
        profileId: repo?.profileId ?? "",
        repoId: worktree.repoId,
        repoName: repo?.name ?? worktree.repoId,
        worktreeId: req.worktreeId,
        branch: worktree.branch
      },
      "fetch",
      async (git, activity) => {
        // On a fork, a plain Fetch asks the source too: its tip is the only
        // thing that can say the fork has fallen behind.
        const remotes =
          req.remotes ??
          (await forkFetchRemotes(
            execGit,
            worktree.path,
            forkParentOf(worktree.repoId)
          )) ??
          undefined;
        const fetched = await (remotes === undefined
          ? fetchRemote(git, worktree.path, true)
          : fetchNamedRemotes(git, worktree.path, remotes, true));
        if (fetched.ok) {
          // Off the network phase before the branch index is rebuilt. Silence
          // is only evidence while `--progress` obliges Git to speak; leaving
          // the phase at `fetch` makes a long re-index report the successful
          // transfer as a stalled one.
          activity.setPhase("refresh");
          await refreshRemoteBranches(worktree.repoId, "fetch");
          // The worktree refresh below repaints the graph only when the
          // branch's own sync state moved. A second remote's tips never move
          // it — the fork source's new commits are exactly the ones it misses.
          if (remotes !== undefined) {
            emitEvent("graph:changed", { repoId: worktree.repoId });
          }
        }
        return fetched;
      }
    );
    if (!result.ok) return err(classifyAuthFailure(result.error));
    logMain(
      "info",
      "remote",
      req.remotes === undefined
        ? `fetched ${worktree.path} (${seconds(startedAt)})`
        : `fetched ${req.remotes.join(", ")} for ${worktree.path} (${seconds(startedAt)})`
    );
    refreshIdentity?.(worktree.repoId);
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });

  bus.register("remote:fetchRepo", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === null) return err({ ...notFound, message: "repo not found" });
    const startedAt = Date.now();
    const result = await tracked(
      {
        kind: "fetch",
        profileId: repo.profileId,
        repoId: req.repoId,
        repoName: repo.name
      },
      "fetch",
      async (git, activity) => {
        const fetched = await (req.remote === undefined
          ? fetchAllRemotes(git, repo.path, true)
          : fetchNamedRemote(git, repo.path, req.remote, true));
        if (fetched.ok) {
          activity.setPhase("refresh");
          await refreshRemoteBranches(req.repoId, "fetch");
        }
        return fetched;
      }
    );
    if (!result.ok) return result;
    logMain(
      "info",
      "remote",
      `fetched ${req.remote ?? "all remotes"} for ${repo.path} (${seconds(startedAt)})`
    );
    refreshIdentity?.(req.repoId);
    refresher.refreshRepoWorktrees(req.repoId);
    return ok(null);
  });

  bus.register("remote:add", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === null) return err({ ...notFound, message: "repo not found" });
    const result = await operations.runRepository(req.repoId, async () => {
      const added = await addRemote(execGit, repo.path, req);
      if (added.ok) await refreshRemoteBranches(req.repoId, "add remote");
      return added;
    });
    if (!result.ok) return result;
    logMain("info", "remote", `added remote ${req.name} to ${repo.path}`);
    // Forced: the remote set is part of the stored identity, and it just
    // changed. Without `force` the freshness gate skips the row and the
    // repo row keeps its old forge chip for up to six hours.
    refreshIdentity?.(req.repoId, { force: true });
    refresher.refreshRepoWorktrees(req.repoId);
    return ok(null);
  });

  bus.register("remote:update", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === null) return err({ ...notFound, message: "repo not found" });
    const result = await operations.runRepository(req.repoId, async () => {
      const updated = await updateRemote(execGit, repo.path, req);
      if (updated.ok) await refreshRemoteBranches(req.repoId, "update remote");
      return updated;
    });
    if (!result.ok) return result;
    logMain(
      "info",
      "remote",
      `updated remote ${req.originalName} as ${req.name} in ${repo.path}`
    );
    // Forced: the remote set is part of the stored identity, and it just
    // changed. Without `force` the freshness gate skips the row and the
    // repo row keeps its old forge chip for up to six hours.
    refreshIdentity?.(req.repoId, { force: true });
    refresher.refreshRepoWorktrees(req.repoId);
    return ok(null);
  });

  bus.register("remote:inspectSshRecovery", async (req) => {
    const live = worktreeOf(req.worktreeId);
    if (!live.ok) return live;
    const worktree = live.value;
    return req.operation === "push"
      ? inspectSshPushRecovery(execGit, worktree.path)
      : inspectSshRemoteRecovery(execGit, worktree.path);
  });

  bus.register("remote:testSshRecovery", async (req) => {
    const live = worktreeOf(req.worktreeId);
    if (!live.ok) return live;
    const worktree = live.value;
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
    const live = worktreeOf(req.worktreeId);
    if (!live.ok) return live;
    const worktree = live.value;
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
    const result = await operations.runRepository(req.repoId, async () => {
      const removed = await removeRemote(execGit, repo.path, req.remote);
      if (removed.ok) await refreshRemoteBranches(req.repoId, "remove remote");
      return removed;
    });
    if (!result.ok) return result;
    logMain("info", "remote", `removed remote ${req.remote} from ${repo.path}`);
    // Forced: the remote set is part of the stored identity, and it just
    // changed. Without `force` the freshness gate skips the row and the
    // repo row keeps its old forge chip for up to six hours.
    refreshIdentity?.(req.repoId, { force: true });
    refresher.refreshRepoWorktrees(req.repoId);
    return ok(null);
  });

  // Both halves of the push review are tracked, for the reason
  // `src/main/git/AGENTS.md` gives: they are network commands, and the review
  // fetches EVERY destination remote before it can compare anything. An SSH
  // agent that accepts the connection and then never answers wedges them
  // exactly as it wedges a fetch — and until they were registered here the
  // only thing that said so was a button in a modal reading "Pushing…", with
  // no elapsed, no Git output and no way to stop it.
  //
  // Repo-scoped: no worktree owns a push the user aimed at named remotes, and
  // `worktreeId: null` is also what makes the elsewhere-toast keep it visible
  // once the dialog is closed.
  bus.register("remote:planPushRefs", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === null) return err({ ...notFound, message: "repo not found" });
    const result = await tracked(
      {
        kind: "fetch",
        profileId: repo.profileId,
        repoId: req.repoId,
        repoName: repo.name,
        branch: pushRefLabel(req.sourceRef)
      },
      "fetch",
      async (git, activity) => {
        const planned = await planPushRefs(
          git,
          repo.path,
          req.sourceRef,
          req.destinations
        );
        if (planned.ok) {
          // PwrGit's own bookkeeping, not Git's: the quiet warning is scoped
          // to network phases, and leaving this one inside `fetch` would make
          // a slow index refresh read as a transfer that had gone silent.
          activity.setPhase("refresh");
          await refreshRemoteBranches(req.repoId, "plan push refs");
        }
        return planned;
      }
    );
    refresher.refreshRepoWorktrees(req.repoId);
    return result;
  });

  bus.register("remote:pushRefs", async (req) => {
    const repo = repoOf(req.repoId);
    if (repo === null) return err({ ...notFound, message: "repo not found" });
    const startedAt = Date.now();
    const result = await tracked(
      {
        kind: "push",
        profileId: repo.profileId,
        repoId: req.repoId,
        repoName: repo.name,
        branch:
          req.plans[0] === undefined
            ? null
            : pushRefLabel(req.plans[0].sourceRef)
      },
      "push",
      async (git, activity) => {
        const pushed = await pushPlannedRefs(git, repo.path, req.plans);
        if (pushed.ok) {
          activity.setPhase("refresh");
          await refreshRemoteBranches(req.repoId, "push refs");
        }
        return pushed;
      }
    );
    refresher.refreshRepoWorktrees(req.repoId);
    if (!result.ok) return result;
    const pushed = result.value.filter((item) => item.outcome === "pushed").length;
    logMain(
      "info",
      "remote",
      `pushed ${pushed}/${result.value.length} reviewed refs for ${repo.path} (${seconds(startedAt)})`
    );
    return result;
  });

  /** Push one reviewed object to a remote branch, leased on its reviewed tip. */
  const runLeasedPush = async (
    worktreeId: string,
    req: { remote: string; branch: string; head: string; expectedHead: string }
  ): Promise<Result<null>> => {
    const live = worktreeOf(worktreeId);
    if (!live.ok) return live;
    const worktree = live.value;
    const repo = repoOf(worktree.repoId);
    const startedAt = Date.now();
    const result = await tracked(
      {
        kind: "push",
        profileId: repo?.profileId ?? "",
        repoId: worktree.repoId,
        repoName: repo?.name ?? worktree.repoId,
        worktreeId,
        branch: worktree.branch
      },
      "push",
      async (git, activity) => {
        const pushed = await pushBranchWithLease(git, worktree.path, req);
        if (pushed.ok) {
          activity.setPhase("refresh");
          await refreshRemoteBranches(worktree.repoId, "push");
        }
        return pushed;
      }
    );
    if (!result.ok) return err(classifyAuthFailure(result.error));
    logMain(
      "info",
      "remote",
      `pushed ${req.head} to ${req.remote}/${req.branch} leased on ${req.expectedHead} for ${worktree.path} (${seconds(startedAt)})`
    );
    // The pushed branch may be the repository default, which every sibling's
    // staleness is measured against.
    refresher.refreshRepoWorktrees(worktree.repoId);
    return ok(null);
  };

  /**
   * Pull's fast-forward, with everything that makes it survivable: the
   * repository fetch lock, the stall watchdog, rollback, and the stash
   * reapply. A fork sync runs the same thing toward the fork's source.
   */
  const runPull = async (
    worktreeId: string,
    target: FastForwardTarget = { kind: "upstream" }
  ): Promise<Result<PullOutcome>> => {
    const live = worktreeOf(worktreeId);
    if (!live.ok) return live;
    const worktree = live.value;
    const path = worktree.path;
    const repo = repoOf(worktree.repoId);
    const startedAt = Date.now();
    let currentPhase: PullWatchdogPhase = "starting";
    let recoveryActive = false;
    let recoveryWatchdog: PullWatchdog | undefined;
    logMain(
      "info",
      "remote",
      `pull started ${path}${target.kind === "ref" ? ` toward ${target.label}` : ""} (${seconds(startedAt)})`
    );
    const activity = activities.begin({
      kind: "pull",
      profileId: repo?.profileId ?? "",
      repoId: worktree.repoId,
      repoName: repo?.name ?? worktree.repoId,
      worktreeId: worktreeId,
      branch: worktree.branch
    });
    try {
      // A stall warning that only says "no output" leaves the reader guessing
      // which command produced none. Name the command and the last line Git did
      // write — on a wedged transfer those two ARE the diagnosis.
      const stallContext = (): string => {
        const command = activity.command();
        const last = activity.lastLine();
        return [
          command === null ? null : `running ${command}`,
          last === null ? "Git has written nothing" : `last Git output: ${last}`
        ]
          .filter((part) => part !== null)
          .join("; ");
      };
      const onStallWarning = (snapshot: PullWatchdogSnapshot): void => {
        logMain(
          "warn",
          "remote",
          `pull still waiting ${path} during ${pullPhaseDescription(snapshot.phase)} (${formatPullDuration(snapshot.elapsedMs)} elapsed; no Git output for ${formatPullDuration(snapshot.idleMs)}; ${stallContext()})`
        );
      };
      const onTimeout = (
        error: PwrGitError,
        snapshot: PullWatchdogSnapshot
      ): void => {
        logMain(
          "error",
          "remote",
          `pull timeout ${path} during ${pullPhaseDescription(snapshot.phase)} after ${formatPullDuration(snapshot.elapsedMs)}: ${error.code}; ${stallContext()}; direct Git termination requested (LFS/filter helpers should exit when inherited pipes close)`
        );
      };
      let reportPhase: (phase: PullProgressPhase) => void = () => {};
      let result: Awaited<ReturnType<typeof pullFastForward>>;
      try {
        result = await operations.runRepository(worktree.repoId, async () => {
          // Start the watchdog only after this pull owns the repository fetch
          // scope. Time spent queued behind another fetch is not a Git stall —
          // and the activity reports that wait as `queued` for the same reason.
          const watchdog = new PullWatchdog({ onStallWarning, onTimeout });
          // Git gets one signal carrying both endings: the watchdog's timeout
          // and the user's cancel. Passing either alone loses the other.
          const signal = AbortSignal.any([watchdog.signal, activity.signal]);
          reportPhase = (phase: PullProgressPhase): void => {
            if (recoveryActive) {
              logMain(
                "info",
                "remote",
                `pull recovery step ${pullPhaseDescription(phase)} ${path} (${seconds(startedAt)})`
              );
              return;
            }
            // Once a timeout fires, preserve its phase while cleanup runs.
            if (watchdog.signal.aborted) return;
            currentPhase = phase;
            watchdog.setPhase(phase);
            activity.setPhase(phase);
            logMain(
              "info",
              "remote",
              `pull phase ${pullPhaseDescription(phase)} ${path} (${seconds(startedAt)})`
            );
          };
          activity.setPhase("fetch");
          try {
            const pulled = await operations.run(worktreeId, () =>
              pullFastForward(activityGit(activity, undefined), path, reportPhase, {
                signal,
                onActivity: () => watchdog.noteActivity(),
                startRecovery: () => {
                  watchdog.finish();
                  const priorPhase = currentPhase;
                  recoveryActive = true;
                  currentPhase = "recovery";
                  activity.setPhase("recovery");
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
                      if (succeeded) {
                        currentPhase = priorPhase;
                        if (priorPhase !== "starting") {
                          activity.setPhase(priorPhase);
                        }
                      }
                    }
                  };
                }
              }, target)
            );
            if (pulled.ok) {
              // Git has finished; branch-index maintenance remains under the
              // repository lock, but it must not be counted as a stalled pull.
              watchdog.finish();
              recoveryWatchdog?.finish();
              refreshIdentity?.(worktree.repoId);
              await refreshRemoteBranches(worktree.repoId, "pull");
            }
            return pulled;
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
        const classified = classifyAuthFailure(result.error);
        const detail = sanitizeGitLogDetail(result.error.message);
        logMain(
          classified.code === "canceled" ? "info" : "error",
          "remote",
          `pull ${classified.code === "canceled" ? "canceled" : "failed"} ${path} during ${pullPhaseDescription(currentPhase)} after ${seconds(startedAt)}: ${classified.kind}/${classified.code}${detail === "" ? "" : `: ${detail}`}`
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
          refresher.refreshWorktree(worktreeId)
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
      return result;
    } finally {
      activity.finish();
      // Pull may leave an ordinary recovery stash after a failed reapply.
      emitEvent("stash:changed", { repoId: worktree.repoId });
    }
  };

  bus.register("remote:pull", (req) => runPull(req.worktreeId));

  bus.register("remote:push", async (req) => {
    const live = worktreeOf(req.worktreeId);
    if (!live.ok) return live;
    const worktree = live.value;
    const repo = repoOf(worktree.repoId);
    const startedAt = Date.now();
    const result = await tracked(
      {
        kind: "push",
        profileId: repo?.profileId ?? "",
        repoId: worktree.repoId,
        repoName: repo?.name ?? worktree.repoId,
        worktreeId: req.worktreeId,
        branch: worktree.branch
      },
      "push",
      async (git, activity) => {
        const pushed = await pushRemote(git, worktree.path, true, req.publish);
        if (pushed.ok) {
          activity.setPhase("refresh");
          await refreshRemoteBranches(worktree.repoId, "push");
        }
        return pushed;
      }
    );
    if (!result.ok) return err(classifyAuthFailure(result.error));
    logMain("info", "remote", `pushed ${worktree.path} (${seconds(startedAt)})`);
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });

  bus.register("remote:inspectDivergence", async (req) => {
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    const path = live.value;
    return inspectRemoteDivergence(execGit, path, req.ref);
  });

  bus.register("remote:resetToUpstream", async (req) => {
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    const path = live.value;
    const startedAt = Date.now();
    const result = await operations.run(req.worktreeId, () =>
      resetToUpstream(execGit, path, req)
    );
    if (!result.ok) return result;
    logMain("info", "remote", `reset ${path} to upstream (${seconds(startedAt)})`);
    refresher.refreshWorktree(req.worktreeId);
    return ok(null);
  });

  bus.register("remote:resetTargets", async (req) => {
    const live = worktreeOf(req.worktreeId);
    if (!live.ok) return live;
    const worktree = live.value;
    return resolveResetTargets(
      execGit,
      worktree.path,
      forkParentOf(worktree.repoId)
    );
  });

  // The header asks on every worktree and graph event, and a burst of them
  // (a rebase, a run of commits) must not become a burst of full reads. One
  // read per checkout runs; everyone who asks meanwhile shares one more after
  // it, since the running read may predate the change they were told about.
  type ForkStatusRead = Promise<Result<ForkStatus | null>>;
  const forkStatusReads = new Map<
    string,
    { running: ForkStatusRead; trailing: ForkStatusRead | null }
  >();
  const startForkStatusRead = (
    worktreeId: string,
    read: () => ForkStatusRead
  ): ForkStatusRead => {
    const entry = { running: read(), trailing: null as ForkStatusRead | null };
    forkStatusReads.set(worktreeId, entry);
    const settle = (): void => {
      if (forkStatusReads.get(worktreeId) === entry && entry.trailing === null) {
        forkStatusReads.delete(worktreeId);
      }
    };
    void entry.running.then(settle, settle);
    return entry.running;
  };

  bus.register("remote:forkStatus", async (req) => {
    const live = worktreeOf(req.worktreeId);
    if (!live.ok) return live;
    const worktree = live.value;
    const read = (): ForkStatusRead =>
      resolveForkStatus(execGit, worktree.path, forkParentOf(worktree.repoId));
    const entry = forkStatusReads.get(req.worktreeId);
    if (entry === undefined) return startForkStatusRead(req.worktreeId, read);
    const next = (): ForkStatusRead => startForkStatusRead(req.worktreeId, read);
    entry.trailing ??= entry.running.then(next, next);
    return entry.trailing;
  });

  bus.register("remote:syncFork", async (req) => {
    const live = worktreeOf(req.worktreeId);
    if (!live.ok) return live;
    const worktree = live.value;
    const parent = forkParentOf(worktree.repoId);
    const before = await resolveForkStatus(execGit, worktree.path, parent);
    if (!before.ok) return before;
    const status = before.value;
    const source = status?.source ?? null;
    if (
      status === null ||
      source === null ||
      status.branch !== req.branch ||
      source.ref !== req.sourceRef
    ) {
      return err({
        kind: "remote",
        code: "fork_sync_stale",
        message: `${req.branch} is no longer checked out against that source. Nothing was changed.`
      });
    }
    const { tracked } = status;
    const pulled = await runPull(req.worktreeId, {
      kind: "ref",
      ref: source.ref,
      label: source.label,
      remotes: tracked === null ? [source.remote] : [tracked.remote, source.remote],
      branch: status.branch
    });
    if (!pulled.ok) return pulled;

    // Read again: the fetch moved both tips, and the push is judged against
    // what the tracked branch holds now, not when the chip was drawn.
    const [after, arrived] = await Promise.all([
      resolveForkStatus(execGit, worktree.path, parent),
      commitsSince(execGit, worktree.path, status.head)
    ]);
    const outcome = {
      source: source.label,
      arrived,
      stashed: pulled.value.stashed,
      reappliedWithConflicts: pulled.value.reappliedWithConflicts
    };
    const now = after.ok ? after.value : null;
    if (now === null || now.tracked === null || now.source === null) {
      return ok({ ...outcome, push: { outcome: "no_tracking" as const } });
    }
    const pushBack = now.source.pushBack;
    if (pushBack === null) {
      const remote = now.tracked.remote;
      return ok({
        ...outcome,
        push: {
          outcome: "up_to_date" as const,
          remote,
          branch: now.tracked.label.slice(remote.length + 1)
        }
      });
    }
    // Pull's "only" choice: the fast-forward was the whole request, and the
    // tracked branch waits for the user's own Push.
    if (!req.push) {
      return ok({
        ...outcome,
        push: {
          outcome: "skipped" as const,
          remote: pushBack.remote,
          branch: pushBack.branch
        }
      });
    }
    const target = { remote: pushBack.remote, branch: pushBack.branch };
    if (pushBack.overwrites > 0) {
      return ok({
        ...outcome,
        push: {
          outcome: "diverged" as const,
          ...target,
          overwrites: pushBack.overwrites
        }
      });
    }
    const pushed = await runLeasedPush(req.worktreeId, {
      ...target,
      head: now.source.head,
      expectedHead: pushBack.head
    });
    return ok({
      ...outcome,
      push: pushed.ok
        ? { outcome: "pushed" as const, ...target }
        : {
            outcome: "failed" as const,
            ...target,
            message: pushed.error.message
          }
    });
  });

  bus.register("remote:inspectReset", async (req) => {
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    const path = live.value;
    return inspectRemoteReset(execGit, path, req.remoteRef);
  });

  bus.register("remote:resetToRemote", async (req) => {
    const live = worktreeOf(req.worktreeId);
    if (!live.ok) return live;
    const worktree = live.value;
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

  bus.register("remote:pushBranchWithLease", (req) =>
    runLeasedPush(req.worktreeId, req)
  );

  bus.register("remote:rebaseOntoUpstream", async (req) => {
    const live = pathOf(req.worktreeId);
    if (!live.ok) return live;
    const path = live.value;
    const startedAt = Date.now();
    const result = await operations.run(req.worktreeId, () =>
      rebaseOntoUpstream(execGit, path, req, req.ref)
    );
    // A stopped rebase changes the checkout too; refresh so the Changes panel
    // and sync badges show the conflict state immediately.
    refresher.refreshWorktree(req.worktreeId);
    if (!result.ok) return result;
    logMain(
      "info",
      "remote",
      `rebased ${path} onto ${req.ref ?? "upstream"} (${seconds(startedAt)})`
    );
    const { pushTo } = req;
    if (pushTo === undefined) return ok({ push: null });

    // A fork's branch rebased onto its source: the tracked branch still holds
    // the commits the rebase rewrote, so only a forced push brings it along —
    // leased on the tip the review showed, so work pushed there since is
    // refused rather than replaced. The rebase stands either way.
    const target = { remote: pushTo.remote, branch: pushTo.branch };
    const head = await headCommit(execGit, path);
    if (head === null) {
      return ok({
        push: {
          outcome: "failed" as const,
          ...target,
          message: "Could not read the rebased commit to push."
        }
      });
    }
    const pushed = await runLeasedPush(req.worktreeId, {
      ...target,
      head,
      expectedHead: pushTo.expectedHead
    });
    return ok({
      push: pushed.ok
        ? { outcome: "pushed" as const, ...target }
        : { outcome: "failed" as const, ...target, message: pushed.error.message }
    });
  });
}
