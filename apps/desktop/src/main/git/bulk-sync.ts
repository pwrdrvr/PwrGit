import {
  type BulkSyncCounts,
  type BulkSyncMode,
  type BulkSyncProgress,
  type BulkSyncRemoteResult,
  type BulkSyncRepoResult,
  type BulkSyncSummary,
  type BulkSyncWorktreeResult,
  type PwrGitError,
  err,
  ok,
  type Result
} from "@pwrgit/shared";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { mapLimit } from "../util/map-limit";
import { logMain } from "../logs";
import { nestedWorktreePathspec } from "@pwrgit/mcp-server/nested-worktrees";
import {
  NO_OPTIONAL_LOCKS,
  requireExit0,
  sanitizeGitLogDetail,
  type GitExec,
  type GitProcessEvent,
  type GitOutput
} from "./dugite";
import { formatPullDuration, PullWatchdog } from "./pull-watchdog";
import {
  BULK_OPERATION_STATE_PATHS, readBulkSyncSnapshot, readBulkSyncRefs,
  bulkSyncRefsChanged, remoteTipsUnchanged, inspectReadOnlyWorktree, type BulkSyncSnapshot
} from "./bulk-sync-preflight";

export const BULK_SYNC_CONCURRENCY = 3;
/** Each repository worker runs at most four independent checkout operations. */
export const BULK_WORKTREE_CONCURRENCY = 4;

const HEAD_REVISIONS = ["--revs-only", "HEAD", "--symbolic-full-name", "HEAD", "--"];

export type BulkSyncRepoInput = {
  id: string;
  name: string;
  path: string;
  worktrees: Array<{
    id: string;
    branch: string;
    path: string;
  }>;
  /** Stored worktree state already shows a clean checkout behind its upstream
   * and not ahead of it: a fast-forward this pull can very likely make. */
  pullPending?: boolean;
};

type LockRunner = <T>(id: string, operation: () => Promise<T>) => Promise<T>;

export type BulkSyncOptions = {
  operationId: string;
  mode: BulkSyncMode;
  /** Stops queued work, transfers and probes. A started checkout finishes and
   * verifies its commit under the worktree lock before cancellation completes. */
  signal?: AbortSignal;
  concurrency?: number;
  runRepository?: LockRunner;
  runWorktree?: LockRunner;
  onProgress?: (progress: BulkSyncProgress) => void;
  onRepoCompleted?: (
    repo: BulkSyncRepoInput,
    result: BulkSyncRepoResult
  ) => void | Promise<void>;
  now?: () => Date;
};

type RepoProgressUpdate = Pick<
  BulkSyncProgress,
  "detail" | "worktreePath" | "remoteResult" | "worktreeResult"
>;
type ReportProgress = (update: RepoProgressUpdate) => void;

/** Each interruptible Git invocation gets a clock after its queue lock is held.
 * Output from another repository/checkout cannot keep a wedged command alive. */
export function watchedGit(git: GitExec, signal: AbortSignal | undefined): GitExec {
  return async (args, cwd, options) => {
    if (signal?.aborted) {
      return err({ kind: "remote", code: "aborted", message: "Repository synchronization was cancelled." });
    }
    const commandLabel = () => sanitizeGitLogDetail(`git ${args.join(" ")} (${cwd})`);
    let processState: GitProcessEvent | undefined;
    let interruptionReported = false;
    let pendingOutput = "";
    let droppingOutput = false;
    const tail: string[] = [];
    const processContext = (): string =>
      processState === undefined ? "spawn not observed" :
        `pid=${processState.pid ?? "unknown"} event=${processState.event} exit=${processState.exitCode ?? "none"} signal=${processState.signalCode ?? "none"}`;
    const stallContext = (): string => {
      // An unfinished URL can contain credentials whose trailing @ has not
      // arrived yet. Describe partial output without logging those bytes.
      const pending = pendingOutput === "" ? "" :
        `; ${pendingOutput.length} chars of unfinished stderr withheld${/password|passphrase|username|continue connecting/i.test(pendingOutput) ? " (possible authentication or host-key prompt)" : ""}`;
      return `${processContext()}; stderr tail: ${tail.join(" | ") || "(no complete stderr lines)"}${pending}`;
    };
    let timeout: PwrGitError | undefined;
    const watchdog = new PullWatchdog({
      operationName: "Repository synchronization",
      onStallWarning: (snapshot) => logMain(
        "warn", "remote",
        `bulk sync still waiting: ${commandLabel()}; ${formatPullDuration(snapshot.elapsedMs)} elapsed; no Git output for ${formatPullDuration(snapshot.idleMs)}; ${stallContext()}`
      ),
      onTimeout: (error) => {
        timeout = error;
        interruptionReported = true;
        logMain("error", "remote", `bulk sync timeout: ${commandLabel()}; ${error.code}; ${error.message}; ${stallContext()}; direct Git termination requested`);
      }
    });
    watchdog.setPhase(args[0] === "fetch" ? "fetch" : args[0] === "merge" ? "fast_forward" : "prepare");
    const signals = [watchdog.signal];
    if (signal !== undefined) signals.push(signal);
    if (options?.signal !== undefined) signals.push(options.signal);
    try {
      const commandSignal = AbortSignal.any(signals);
      const result = await git(args, cwd, {
        ...options,
        signal: commandSignal,
        killSignal: "SIGKILL",
        onActivity: () => {
          watchdog.noteActivity();
          options?.onActivity?.();
        },
        onProcess: (event) => {
          processState = event;
          // GitExec can settle on abort before the child closes its pipes.
          if (interruptionReported && event.event === "close") {
            logMain("debug", "remote", `bulk sync Git closed after interruption: ${commandLabel()}; ${processContext()}`);
          }
          options?.onProcess?.(event);
        },
        onStderr: (chunk) => {
          // Keep complete lines so a credential split across chunks is redacted
          // before logging. Omit oversized lines instead of retaining fragments.
          const lines = (pendingOutput + chunk).split(/[\r\n]/);
          pendingOutput = lines.pop() ?? "";
          if (droppingOutput) {
            if (lines.length === 0) pendingOutput = "";
            else {
              lines.shift();
              droppingOutput = false;
            }
          }
          for (const line of lines) {
            if (line) tail.push(line.length > 16_384 ? "[oversized Git output line omitted]" : sanitizeGitLogDetail(line));
          }
          if (pendingOutput.length > 16_384) {
            pendingOutput = "";
            droppingOutput = true;
            tail.push("[oversized Git output line omitted]");
          }
          tail.splice(0, Math.max(0, tail.length - 3));
          options?.onStderr?.(chunk);
        }
      });
      // A timeout is a failure, even if the process reports a generic abort or
      // exits successfully as the deadline fires. It does not cancel the batch.
      if (timeout !== undefined) return err(timeout);
      // execGit already reports nonzero exits and spawn failures. Record
      // process state here. Git stderr can contain custom HTTP credentials.
      const aborted = commandSignal.aborted;
      if (aborted || processState?.signalCode != null) {
        interruptionReported = true;
        const reason = aborted ? "aborted" : "Git stopped by signal";
        logMain(aborted ? "debug" : "warn", "remote", `bulk sync ${reason}: ${commandLabel()}; ${processContext()}`);
      }
      return result;
    } finally {
      watchdog.finish();
    }
  };
}

type ConfiguredRemote = {
  name: string;
  skipFetchAll: boolean;
  configError: boolean;
};
type ReadyWorktree = {
  branch: string;
  head: string;
  upstream: string;
  upstreamHead: string;
  remote: string;
};
type WorktreeInspection =
  | { kind: "ready"; value: ReadyWorktree }
  | { kind: "result"; value: BulkSyncWorktreeResult };

const authFailure = (message: string): boolean =>
  /authentication failed|terminal prompts disabled|could not read (?:username|password)|username for ['"]|password for ['"]|permission denied \(publickey|credential[^\r\n]*(?:failed|unavailable)|http basic: access denied/i.test(
    message
  );

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted ?? false;

const checked = async (
  git: GitExec,
  args: string[],
  cwd: string
): Promise<Result<GitOutput>> => {
  const raw = await git(args, cwd, NO_OPTIONAL_LOCKS);
  if (!raw.ok) return raw;
  return requireExit0(raw.value, args);
};

async function configuredRemotes(
  git: GitExec,
  cwd: string
): Promise<Result<ConfiguredRemote[]>> {
  const listed = await checked(git, ["remote"], cwd);
  if (!listed.ok) return listed;
  const names = listed.value.stdout
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const remotes: ConfiguredRemote[] = [];
  for (const name of names) {
    const key = `remote.${name}.skipFetchAll`;
    const raw = await git(["config", "--bool", "--get", key], cwd, NO_OPTIONAL_LOCKS);
    if (!raw.ok) return raw;
    remotes.push({
      name,
      skipFetchAll:
        raw.value.exitCode === 0 && raw.value.stdout.trim() === "true",
      configError: raw.value.exitCode !== 0 && raw.value.exitCode !== 1
    });
  }
  return ok(remotes);
}

function cancelledRemote(remote: string): BulkSyncRemoteResult {
  return {
    remote,
    outcome: "cancelled",
    reason: "cancelled",
    message: "Cancelled before this remote completed."
  };
}

async function fetchConfiguredRemotes(
  git: GitExec,
  repo: BulkSyncRepoInput,
  signal: AbortSignal | undefined,
  report: ReportProgress,
  snapshot: BulkSyncSnapshot | null
): Promise<Result<BulkSyncRemoteResult[]>> {
  report({ detail: "Reading remote configuration…" });
  const listed = snapshot === null ? await configuredRemotes(git, repo.path) : ok(snapshot.remotes);
  if (!listed.ok) return listed;
  const results: BulkSyncRemoteResult[] = [];
  const complete = (result: BulkSyncRemoteResult): void => {
    results.push(result);
    report({ remoteResult: result });
  };
  for (const remote of listed.value) {
    if (remote.configError) {
      complete({
        remote: remote.name,
        outcome: "failed",
        reason: "fetch_failed",
        message: "Git could not read this remote's fetch configuration."
      });
      continue;
    }
    if (remote.skipFetchAll) {
      complete({
        remote: remote.name,
        outcome: "skipped",
        reason: "skip_fetch_all",
        message: "This remote opts out through remote.*.skipFetchAll."
      });
      continue;
    }
    if (isAborted(signal)) {
      complete(cancelledRemote(remote.name));
      continue;
    }
    let raw: Result<GitOutput> | undefined;
    // Ordinary fetch must retain automatic tag following even when every
    // branch tip is unchanged. Only an explicit --no-tags remote can skip it.
    if (snapshot !== null && snapshot.remotes.some((entry) => entry.name === remote.name && entry.standardMapping && entry.noTags)) {
      report({ detail: `Checking ${remote.name} branch tips…` });
      raw = await git(["ls-remote", "--heads", "--refs", remote.name], repo.path);
      if (raw.ok && raw.value.exitCode === 0) {
        if (remoteTipsUnchanged(snapshot, remote.name, raw.value.stdout)) {
          if (isAborted(signal)) complete(cancelledRemote(remote.name));
          else complete({ remote: remote.name, outcome: "skipped", reason: "unchanged", message: "Remote branch tips are unchanged." });
          continue;
        }
        raw = undefined;
      }
    }
    if (raw === undefined) {
      report({ detail: `Fetching ${remote.name}…` });
      raw = await git(
        ["fetch", "--atomic", "--prune", "--progress", remote.name],
        repo.path,
        signal === undefined ? undefined : { signal }
      );
    }
    if (isAborted(signal)) {
      complete(cancelledRemote(remote.name));
      continue;
    }
    if (!raw.ok || raw.value.exitCode !== 0) {
      const detail = raw.ok ? `${raw.value.stderr}\n${raw.value.stdout}` : raw.error.message;
      const timeoutMessage = !raw.ok && ["pull_stalled", "pull_timed_out"].includes(raw.error.code) ? raw.error.message : null;
      const authentication = timeoutMessage === null && authFailure(detail);
      complete({
        remote: remote.name,
        outcome: "failed",
        reason: authentication ? "authentication" : "fetch_failed",
        message: timeoutMessage ?? (authentication
          ? "Authentication is required; PwrGit did not open an interactive prompt."
          : "Git could not fetch this remote. See Logs for details.")
      });
      continue;
    }
    complete({ remote: remote.name, outcome: "fetched" });
  }
  return ok(results);
}

function worktreeResult(
  worktree: BulkSyncRepoInput["worktrees"][number],
  result: Omit<BulkSyncWorktreeResult, "worktreeId" | "branch" | "path"> & {
    branch?: string;
  }
): BulkSyncWorktreeResult {
  const { branch = worktree.branch, ...rest } = result;
  return {
    worktreeId: worktree.id,
    branch,
    path: worktree.path,
    ...rest
  };
}

function unsafeProbe(
  worktree: BulkSyncRepoInput["worktrees"][number],
  message: string
): WorktreeInspection {
  return {
    kind: "result",
    value: worktreeResult(worktree, {
      outcome: "failed",
      reason: "unsafe_state",
      message
    })
  };
}

async function inspectWorktree(
  git: GitExec,
  worktree: BulkSyncRepoInput["worktrees"][number],
  fetched: ReadonlyMap<string, BulkSyncRemoteResult>,
  report: (detail: string) => void,
  expected?: ReadyWorktree
): Promise<WorktreeInspection> {
  report("Checking for uncommitted changes…");
  const status = await checked(
    git,
    [
      "status",
      "--porcelain=v2",
      "--untracked-files=all",
      ...(await nestedWorktreePathspec(worktree.path))
    ],
    worktree.path
  );
  if (!status.ok) {
    return unsafeProbe(worktree, "Git could not inspect the working tree safely.");
  }
  const statusLines = status.value.stdout.split("\n").filter(Boolean);
  if (statusLines.some((line) => line.startsWith("u "))) {
    return {
      kind: "result",
      value: worktreeResult(worktree, {
        outcome: "skipped",
        reason: "conflicts",
        message: "The worktree has unresolved conflicts."
      })
    };
  }

  report("Checking for in-progress Git operations…");
  // Resolve the operation paths, HEAD's object id, and then its full ref
  // name in one invocation. --symbolic-full-name applies to the second
  // HEAD argument. The trailing -- keeps filenames out of revision parsing.
  const pathArgs = BULK_OPERATION_STATE_PATHS.flatMap((path) => ["--git-path", path]);
  const checkout = await git(
    ["rev-parse", ...pathArgs, ...HEAD_REVISIONS],
    worktree.path,
    NO_OPTIONAL_LOCKS
  );
  if (!checkout.ok) {
    return unsafeProbe(worktree, "Git could not inspect in-progress operations.");
  }
  const lines = checkout.value.stdout.trimEnd().split(/\r?\n/);
  const pathCount = BULK_OPERATION_STATE_PATHS.length;
  const headOid = lines[pathCount];
  const headRef = lines[pathCount + 1];
  const branchPrefix = "refs/heads/";
  const batched = checkout.value.exitCode === 0 && lines.length === pathCount + 2 &&
    headOid !== undefined && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headOid) &&
    headRef !== undefined && (headRef === "HEAD" || headRef.startsWith(branchPrefix));
  let paths = lines.slice(0, pathCount);
  if (!batched) {
    // An unborn or ambiguous HEAD may produce a partial answer. Keep the
    // individual queries for those cases, including operation detection.
    const statePaths = await checked(git, ["rev-parse", ...pathArgs], worktree.path);
    if (!statePaths.ok) {
      return unsafeProbe(worktree, "Git could not inspect in-progress operations.");
    }
    paths = statePaths.value.stdout.split("\n");
  }
  const present = await Promise.all(
    paths
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) =>
        access(resolve(worktree.path, path)).then(
          () => true,
          () => false
        )
      )
  );
  if (present.includes(true)) {
    return {
      kind: "result",
      value: worktreeResult(worktree, {
        outcome: "skipped",
        reason: "in_progress",
        message: "A merge, rebase, cherry-pick, revert, or bisect is in progress."
      })
    };
  }

  // Uncommitted changes only block a pull that would move HEAD. A dirty
  // worktree already at its upstream (or ahead of it) has nothing to pull, so
  // it reports as up to date rather than inflating the skipped count.
  const dirty = statusLines.length > 0;

  report("Reading branch and upstream…");
  let branch: string;
  if (batched) {
    branch = headRef === "HEAD" ? "" : headRef.slice(branchPrefix.length);
  } else {
    const branchRaw = await checked(git, ["branch", "--show-current"], worktree.path);
    if (!branchRaw.ok) {
      return unsafeProbe(worktree, "Git could not inspect the checked-out branch.");
    }
    branch = branchRaw.value.stdout.trim();
  }
  if (branch === "") {
    return {
      kind: "result",
      value: worktreeResult(worktree, {
        branch: "(detached)",
        outcome: "skipped",
        reason: "detached_head",
        message: "Detached HEADs are never moved by bulk pull."
      })
    };
  }

  let head = batched ? headOid : "";
  if (!batched) {
    const headRaw = await checked(git, ["rev-parse", "--verify", "HEAD"], worktree.path);
    if (headRaw.ok) head = headRaw.value.stdout.trim();
  }
  if (head === "") {
    return {
      kind: "result",
      value: worktreeResult(worktree, {
        branch,
        outcome: "skipped",
        reason: "no_head",
        message: "The checked-out branch has no commit to fast-forward."
      })
    };
  }
  const upstreamNameRaw = await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    worktree.path,
    NO_OPTIONAL_LOCKS
  );
  if (
    !upstreamNameRaw.ok ||
    upstreamNameRaw.value.exitCode !== 0 ||
    upstreamNameRaw.value.stdout.trim() === ""
  ) {
    return {
      kind: "result",
      value: worktreeResult(worktree, {
        branch,
        outcome: "skipped",
        reason: "no_upstream",
        message: "The branch has no usable upstream."
      })
    };
  }
  const upstream = upstreamNameRaw.value.stdout.trim();
  const upstreamHeadRaw = await checked(
    git,
    ["rev-parse", "--verify", "@{u}"],
    worktree.path
  );
  if (!upstreamHeadRaw.ok || upstreamHeadRaw.value.stdout.trim() === "") {
    return {
      kind: "result",
      value: worktreeResult(worktree, {
        branch,
        outcome: "skipped",
        reason: "no_upstream",
        message: "The configured upstream could not be resolved."
      })
    };
  }
  const upstreamHead = upstreamHeadRaw.value.stdout.trim();

  const branchRemoteRaw = await git(
    ["config", "--get", `branch.${branch}.remote`],
    worktree.path,
    NO_OPTIONAL_LOCKS
  );
  if (!branchRemoteRaw.ok) {
    return unsafeProbe(worktree, "Git could not inspect the branch remote.");
  }
  const remote = branchRemoteRaw.value.stdout.trim();
  if (branchRemoteRaw.value.exitCode !== 0 || remote === "" || remote === ".") {
    return {
      kind: "result",
      value: worktreeResult(worktree, {
        branch,
        outcome: "skipped",
        reason: "upstream_not_fetched",
        message: "The upstream is not backed by a fetched remote."
      })
    };
  }

  const remoteResult = fetched.get(remote);
  if (remoteResult?.outcome !== "fetched" && remoteResult?.reason !== "unchanged") {
    const reason =
      remoteResult?.reason === "authentication"
        ? "authentication"
        : remoteResult?.outcome === "failed"
          ? "fetch_failed"
          : "upstream_not_fetched";
    return {
      kind: "result",
      value: worktreeResult(worktree, {
        branch,
        outcome: "skipped",
        reason,
        message:
          reason === "authentication"
            ? "The upstream remote needs authentication."
            : reason === "fetch_failed"
              ? "The upstream remote could not be fetched."
              : "The upstream remote was not fetched."
      })
    };
  }

  const ready = { branch, head, upstream, upstreamHead, remote };
  if (
    expected !== undefined &&
    (ready.branch !== expected.branch ||
      ready.head !== expected.head ||
      ready.upstream !== expected.upstream ||
      ready.upstreamHead !== expected.upstreamHead ||
      ready.remote !== expected.remote)
  ) {
    return {
      kind: "result",
      value: worktreeResult(worktree, {
        branch,
        outcome: "skipped",
        reason: "unsafe_state",
        message: "The branch or upstream changed during the safety check."
      })
    };
  }

  if (head === upstreamHead) {
    return {
      kind: "result",
      value: worktreeResult(worktree, {
        branch,
        outcome: "up_to_date",
        beforeHead: head,
        afterHead: head
      })
    };
  }

  report("Comparing local and upstream commits…");
  const canFastForward = await git(
    ["merge-base", "--is-ancestor", head, upstreamHead],
    worktree.path,
    NO_OPTIONAL_LOCKS
  );
  if (!canFastForward.ok) {
    return unsafeProbe(worktree, "Git could not prove a fast-forward is safe.");
  }
  if (canFastForward.value.exitCode === 0) {
    if (dirty) {
      return {
        kind: "result",
        value: worktreeResult(worktree, {
          branch,
          outcome: "skipped",
          reason: "dirty",
          message: "The worktree has uncommitted or untracked changes."
        })
      };
    }
    return { kind: "ready", value: ready };
  }
  if (canFastForward.value.exitCode !== 1) {
    return unsafeProbe(worktree, "Git could not compare the local and upstream tips.");
  }

  const upstreamIsAncestor = await git(
    ["merge-base", "--is-ancestor", upstreamHead, head],
    worktree.path,
    NO_OPTIONAL_LOCKS
  );
  if (!upstreamIsAncestor.ok) {
    return unsafeProbe(worktree, "Git could not compare the local and upstream tips.");
  }
  if (upstreamIsAncestor.value.exitCode === 0) {
    return {
      kind: "result",
      value: worktreeResult(worktree, {
        branch,
        outcome: "skipped",
        reason: "ahead",
        message: "The local branch is ahead; there is nothing to fast-forward."
      })
    };
  }
  if (upstreamIsAncestor.value.exitCode !== 1) {
    return unsafeProbe(worktree, "Git could not compare the local and upstream tips.");
  }
  return {
    kind: "result",
    value: worktreeResult(worktree, {
      branch,
      outcome: "skipped",
      reason: "diverged",
      message: "The local branch and upstream have diverged."
    })
  };
}

async function softPullWorktree(
  git: GitExec,
  finishGit: GitExec,
  worktree: BulkSyncRepoInput["worktrees"][number],
  fetched: ReadonlyMap<string, BulkSyncRemoteResult>,
  signal: AbortSignal | undefined,
  report: (detail: string) => void
): Promise<BulkSyncWorktreeResult> {
  const cancelled = (): BulkSyncWorktreeResult => worktreeResult(worktree, {
    outcome: "cancelled", reason: "cancelled",
    message: "Cancelled before the fast-forward started."
  });
  if (isAborted(signal)) return cancelled();
  const first = await inspectWorktree(git, worktree, fetched, report);
  if (isAborted(signal)) return cancelled();
  if (first.kind === "result") return first.value;

  // Re-read every fact immediately before mutation. The exact upstream commit
  // is passed to merge, so this never follows a ref that changed after review.
  const second = await inspectWorktree(
    git, worktree, fetched,
    (detail) => report(`Rechecking before update: ${detail}`),
    first.value
  );
  if (isAborted(signal)) return cancelled();
  if (second.kind === "result") return second.value;
  report("Fast-forwarding…");
  if (isAborted(signal)) return cancelled();
  // A switch to a sibling tracking the same upstream can pass every upstream
  // check. Read HEAD again after inspecting operation paths and ancestry.
  const checkout = await checked(git, ["rev-parse", ...HEAD_REVISIONS], worktree.path);
  if (isAborted(signal)) return cancelled();
  const [head, ref] = checkout.ok ? checkout.value.stdout.trimEnd().split(/\r?\n/) : [];
  const expectedRef = `refs/heads/${second.value.branch}`;
  let sameBranch = ref === expectedRef;
  // A tag named HEAD can suppress the symbolic name without suppressing the
  // OID. Ask Git for the exact symbolic ref in that case.
  if (ref === undefined && head === second.value.head) {
    const symbolic = await checked(git, ["symbolic-ref", "--quiet", "HEAD"], worktree.path);
    if (isAborted(signal)) return cancelled();
    sameBranch = symbolic.ok && symbolic.value.stdout.trim() === expectedRef;
  }
  if (head !== second.value.head || !sameBranch) {
    return worktreeResult(worktree, {
      branch: second.value.branch,
      outcome: "skipped",
      reason: "unsafe_state",
      message: "The checked-out branch or commit could not be verified before the fast-forward."
    });
  }
  // Checkout can partially write files before it moves HEAD. Preserve bulk
  // pull's non-interruptible mutation semantics: keep this merge and its final
  // verification under the worktree lock, outside cancellation and watchdogs.
  const merge = await finishGit(
    [
      "merge",
      "--ff-only",
      "--progress",
      "--no-edit",
      "--no-overwrite-ignore",
      second.value.upstreamHead
    ],
    worktree.path
  );
  if (!merge.ok || merge.value.exitCode !== 0) {
    return worktreeResult(worktree, {
      branch: second.value.branch,
      outcome: "failed",
      reason: "merge_failed",
      message: "Git refused or could not complete the fast-forward. See Logs for details.",
      beforeHead: second.value.head
    });
  }
  report("Verifying updated commit…");
  const after = await checked(finishGit, ["rev-parse", "--verify", "HEAD"], worktree.path);
  if (!after.ok || after.value.stdout.trim() !== second.value.upstreamHead) {
    return worktreeResult(worktree, {
      branch: second.value.branch,
      outcome: "failed",
      reason: "merge_failed",
      message: "The fast-forward did not finish at the reviewed upstream commit.",
      beforeHead: second.value.head,
      ...(after.ok ? { afterHead: after.value.stdout.trim() } : {})
    });
  }
  return worktreeResult(worktree, {
    branch: second.value.branch,
    outcome: "updated",
    beforeHead: second.value.head,
    afterHead: second.value.upstreamHead
  });
}

// Skips with nothing to pull: a detached HEAD, a branch with no upstream (or
// one deleted on the remote), or a branch only ahead. The worktree row keeps
// its reason, but the repository is not held back by it. Agent worktrees are
// mostly these, so counting them turned whole repositories "partial".
const NOTHING_TO_PULL = new Set<NonNullable<BulkSyncWorktreeResult["reason"]>>([
  "detached_head",
  "no_upstream",
  "ahead"
]);
const nothingToPull = (result: BulkSyncWorktreeResult): boolean =>
  result.outcome === "skipped" &&
  result.reason !== undefined &&
  NOTHING_TO_PULL.has(result.reason);

function repoOutcome(
  mode: BulkSyncMode,
  remotes: BulkSyncRemoteResult[],
  worktrees: BulkSyncWorktreeResult[]
): BulkSyncRepoResult["outcome"] {
  const cancelled =
    remotes.some((result) => result.outcome === "cancelled") ||
    worktrees.some((result) => result.outcome === "cancelled");
  const failed =
    remotes.some((result) => result.outcome === "failed") ||
    worktrees.some((result) => result.outcome === "failed");
  const skipped =
    remotes.some((result) => result.outcome === "skipped" && result.reason !== "unchanged") ||
    worktrees.some(
      (result) => result.outcome === "skipped" && !nothingToPull(result)
    );
  const succeeded =
    mode === "fetch"
      ? remotes.some((result) => result.outcome === "fetched")
      : worktrees.some(
          (result) =>
            result.outcome === "updated" || result.outcome === "up_to_date"
        );
  // Nothing-to-pull worktrees are neutral: they don't make a failed or
  // blocked repository partial, and a repository of only those succeeded.
  const idle =
    mode === "soft-pull" && worktrees.length > 0 && worktrees.every(nothingToPull);
  if ((cancelled || failed || skipped) && succeeded) return "partial";
  if (cancelled) return "cancelled";
  if (failed) return "failed";
  if (skipped || !(succeeded || idle)) return "skipped";
  return "success";
}

function cancelledRepo(repo: BulkSyncRepoInput): BulkSyncRepoResult {
  return {
    repoId: repo.id,
    name: repo.name,
    path: repo.path,
    outcome: "cancelled",
    remotes: [],
    worktrees: repo.worktrees.map((worktree) =>
      worktreeResult(worktree, {
        outcome: "cancelled",
        reason: "cancelled",
        message: "Cancelled before this repository completed."
      })
    )
  };
}

async function syncRepo(
  exec: GitExec,
  repo: BulkSyncRepoInput,
  options: BulkSyncOptions,
  report: ReportProgress
): Promise<BulkSyncRepoResult> {
  if (isAborted(options.signal)) return cancelledRepo(repo);
  const git = watchedGit(exec, options.signal);
  let snapshot = options.mode === "soft-pull" && repo.worktrees.length > 0
    ? await readBulkSyncSnapshot(git, repo.path) : null;
  const fetched = await fetchConfiguredRemotes(git, repo, options.signal, report, snapshot);
  if (!fetched.ok) {
    if (isAborted(options.signal)) return cancelledRepo(repo);
    return {
      repoId: repo.id,
      name: repo.name,
      path: repo.path,
      outcome: "failed",
      remotes: [],
      worktrees: [],
      message: "Git could not read or fetch the repository's remotes."
    };
  }
  let worktrees: BulkSyncWorktreeResult[] = [];
  let refsChanged: boolean | undefined;
  if (options.mode === "soft-pull") {
    // Fetch may have added, deleted or rewritten upstream tips. Read them in
    // one batch again before selecting checkouts that actually need a pull.
    if (snapshot !== null && fetched.value.some((remote) => remote.outcome === "fetched")) {
      const refs = await readBulkSyncRefs(git, repo.path);
      refsChanged = refs === null ? undefined : bulkSyncRefsChanged(snapshot.refs, refs.refs);
      snapshot = refs === null ? null : { ...snapshot, ...refs };
    }
    const fetchedByName = new Map(
      fetched.value.map((result) => [result.remote, result])
    );
    const runWorktree: LockRunner =
      options.runWorktree ?? ((_id, operation) => operation());
    worktrees = await mapLimit(repo.worktrees, BULK_WORKTREE_CONCURRENCY, async (worktree) => {
      if (isAborted(options.signal)) {
        return worktreeResult(worktree, {
          outcome: "cancelled",
          reason: "cancelled",
          message: "Cancelled before this worktree was checked."
        });
      }
      const reportWorktree = (detail: string): void => report({
        detail: `${worktree.branch || "(detached)"}: ${detail}`,
        worktreePath: worktree.path
      });
      reportWorktree("Waiting for another worktree operation…");
      const result = await runWorktree(worktree.id, async () => {
        if (isAborted(options.signal)) return worktreeResult(worktree, {
          outcome: "cancelled", reason: "cancelled", message: "Cancelled before this worktree was checked."
        });
        const readOnly = await inspectReadOnlyWorktree(git, snapshot, worktree.path, fetchedByName);
        if (readOnly !== null && !isAborted(options.signal)) return worktreeResult(worktree, readOnly);
        return softPullWorktree(git, exec, worktree, fetchedByName, options.signal, reportWorktree);
      });
      report({ worktreeResult: result });
      return result;
    });
  }
  return {
    repoId: repo.id,
    name: repo.name,
    path: repo.path,
    outcome: repoOutcome(options.mode, fetched.value, worktrees),
    remotes: fetched.value,
    worktrees,
    ...(refsChanged === undefined ? {} : { refsChanged })
  };
}

function countResults(results: BulkSyncRepoResult[]): BulkSyncCounts {
  const counts: BulkSyncCounts = {
    repos: { success: 0, partial: 0, skipped: 0, failed: 0, cancelled: 0 },
    remotes: { fetched: 0, skipped: 0, failed: 0, cancelled: 0 },
    worktrees: {
      updated: 0,
      upToDate: 0,
      nothingToPull: 0,
      skipped: 0,
      failed: 0,
      cancelled: 0
    }
  };
  for (const repo of results) {
    counts.repos[repo.outcome] += 1;
    for (const remote of repo.remotes) counts.remotes[remote.outcome] += 1;
    for (const worktree of repo.worktrees) {
      if (worktree.outcome === "up_to_date") counts.worktrees.upToDate += 1;
      else if (nothingToPull(worktree)) counts.worktrees.nothingToPull += 1;
      else counts.worktrees[worktree.outcome] += 1;
    }
  }
  return counts;
}

/**
 * The order repositories start in. A pull starts the repositories whose stored
 * state already shows a pending fast-forward first, so the commits the sidebar
 * is advertising land before an unrelated fetch sweep; everything else keeps
 * its input order. A fetch has nothing known to gain and runs in input order.
 */
export function bulkSyncStartOrder(
  repos: readonly BulkSyncRepoInput[],
  mode: BulkSyncMode
): number[] {
  const order = repos.map((_, index) => index);
  if (mode === "fetch") return order;
  return [
    ...order.filter((index) => repos[index]!.pullPending === true),
    ...order.filter((index) => repos[index]!.pullPending !== true)
  ];
}

/**
 * Run a bounded profile-wide sync. Repositories are the concurrency unit, so
 * worktrees sharing refs fetch once and are inspected serially under one repo
 * lock. Repositories start in `bulkSyncStartOrder`; results stay in input
 * order even though progress arrives by completion.
 */
export async function bulkSyncRepositories(
  git: GitExec,
  repos: BulkSyncRepoInput[],
  options: BulkSyncOptions
): Promise<BulkSyncSummary> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const totalRepos = repos.length;
  const results: Array<BulkSyncRepoResult | undefined> = new Array(totalRepos);
  const startOrder = bulkSyncStartOrder(repos, options.mode);
  let nextStart = 0;
  let completedRepos = 0;
  const runRepository: LockRunner =
    options.runRepository ?? ((_id, operation) => operation());
  options.onProgress?.({
    operationId: options.operationId,
    mode: options.mode,
    phase: "starting",
    totalRepos,
    completedRepos
  });

  const complete = async (
    index: number,
    result: BulkSyncRepoResult
  ): Promise<void> => {
    results[index] = result;
    completedRepos += 1;
    options.onProgress?.({
      operationId: options.operationId,
      mode: options.mode,
      phase: "repo_completed",
      totalRepos,
      completedRepos,
      repoId: result.repoId,
      repoName: result.name,
      result
    });
    try {
      await options.onRepoCompleted?.(repos[index]!, result);
    } catch {
      // Refresh/index maintenance is best-effort after Git has completed. It
      // must not erase this repository's result or stop unrelated workers.
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (isAborted(options.signal)) return;
      if (nextStart >= startOrder.length) return;
      const index = startOrder[nextStart]!;
      nextStart += 1;
      const repo = repos[index]!;
      options.onProgress?.({
        operationId: options.operationId,
        mode: options.mode,
        phase: "repo_started",
        totalRepos,
        completedRepos,
        repoId: repo.id,
        repoName: repo.name
      });
      let result: BulkSyncRepoResult;
      try {
        const report: ReportProgress = (update) => options.onProgress?.({
          operationId: options.operationId,
          mode: options.mode,
          phase: "repo_progress",
          totalRepos,
          completedRepos,
          repoId: repo.id,
          repoName: repo.name,
          totalWorktrees: repo.worktrees.length,
          ...update
        });
        report({ detail: "Waiting for another repository operation…" });
        result = await runRepository(repo.id, () => syncRepo(git, repo, options, report));
      } catch {
        result = {
          repoId: repo.id,
          name: repo.name,
          path: repo.path,
          outcome: "failed",
          remotes: [],
          worktrees: [],
          message: "An unexpected synchronization failure occurred. See Logs for details."
        };
      }
      await complete(index, result);
    }
  };

  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? BULK_SYNC_CONCURRENCY, totalRepos || 1)
  );
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  for (let index = 0; index < repos.length; index += 1) {
    if (results[index] !== undefined) continue;
    await complete(index, cancelledRepo(repos[index]!));
  }
  const ordered = results as BulkSyncRepoResult[];
  return {
    operationId: options.operationId,
    mode: options.mode,
    cancelled: isAborted(options.signal),
    startedAt,
    finishedAt: now().toISOString(),
    counts: countResults(ordered),
    results: ordered
  };
}
