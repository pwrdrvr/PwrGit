import {
  type BulkSyncCounts,
  type BulkSyncMode,
  type BulkSyncProgress,
  type BulkSyncRemoteResult,
  type BulkSyncRepoResult,
  type BulkSyncSummary,
  type BulkSyncWorktreeResult,
  ok,
  type Result
} from "@pwrgit/shared";
import {
  NO_OPTIONAL_LOCKS,
  requireExit0,
  type GitExec,
  type GitOutput
} from "./dugite";

export const BULK_SYNC_CONCURRENCY = 3;

export type BulkSyncRepoInput = {
  id: string;
  name: string;
  path: string;
  worktrees: Array<{
    id: string;
    branch: string;
    path: string;
  }>;
};

type LockRunner = <T>(id: string, operation: () => Promise<T>) => Promise<T>;

export type BulkSyncOptions = {
  operationId: string;
  mode: BulkSyncMode;
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

const IN_PROGRESS_REFS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "BISECT_START",
  "AUTO_MERGE"
] as const;

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
  signal?: AbortSignal
): Promise<Result<BulkSyncRemoteResult[]>> {
  const listed = await configuredRemotes(git, repo.path);
  if (!listed.ok) return listed;
  const results: BulkSyncRemoteResult[] = [];
  for (const remote of listed.value) {
    if (remote.configError) {
      results.push({
        remote: remote.name,
        outcome: "failed",
        reason: "fetch_failed",
        message: "Git could not read this remote's fetch configuration."
      });
      continue;
    }
    if (remote.skipFetchAll) {
      results.push({
        remote: remote.name,
        outcome: "skipped",
        reason: "skip_fetch_all",
        message: "This remote opts out through remote.*.skipFetchAll."
      });
      continue;
    }
    if (isAborted(signal)) {
      results.push(cancelledRemote(remote.name));
      continue;
    }
    const raw = await git(
      ["fetch", "--atomic", "--prune", remote.name],
      repo.path,
      signal === undefined ? undefined : { signal }
    );
    if (isAborted(signal)) {
      results.push(cancelledRemote(remote.name));
      continue;
    }
    if (!raw.ok || raw.value.exitCode !== 0) {
      const detail = raw.ok ? `${raw.value.stderr}\n${raw.value.stdout}` : raw.error.message;
      const authentication = authFailure(detail);
      results.push({
        remote: remote.name,
        outcome: "failed",
        reason: authentication ? "authentication" : "fetch_failed",
        message: authentication
          ? "Authentication is required; PwrGit did not open an interactive prompt."
          : "Git could not fetch this remote. See Logs for details."
      });
      continue;
    }
    results.push({ remote: remote.name, outcome: "fetched" });
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
  expected?: ReadyWorktree
): Promise<WorktreeInspection> {
  const status = await checked(
    git,
    ["status", "--porcelain=v2", "--untracked-files=all"],
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

  for (const ref of IN_PROGRESS_REFS) {
    const raw = await git(
      ["rev-parse", "--verify", "--quiet", "--symbolic-full-name", ref],
      worktree.path,
      NO_OPTIONAL_LOCKS
    );
    if (!raw.ok) {
      return unsafeProbe(worktree, "Git could not inspect in-progress operations.");
    }
    if (raw.value.exitCode === 0 && raw.value.stdout.trim() === ref) {
      return {
        kind: "result",
        value: worktreeResult(worktree, {
          outcome: "skipped",
          reason: "in_progress",
          message: "A merge, rebase, cherry-pick, revert, or bisect is in progress."
        })
      };
    }
    if (
      raw.value.exitCode === 0 &&
      raw.value.stdout.trim().startsWith("refs/")
    ) {
      // rev-parse DWIM-resolves ordinary branches and tags with names such as
      // MERGE_HEAD. Only the literal pseudo-ref denotes an active operation.
      continue;
    }
    if (raw.value.exitCode === 0) {
      return unsafeProbe(worktree, "Git returned an ambiguous operation state.");
    }
    if (raw.value.exitCode !== 1) {
      return unsafeProbe(worktree, "Git could not verify repository operation state.");
    }
  }

  if (statusLines.length > 0) {
    return {
      kind: "result",
      value: worktreeResult(worktree, {
        outcome: "skipped",
        reason: "dirty",
        message: "The worktree has uncommitted or untracked changes."
      })
    };
  }

  const branchRaw = await checked(git, ["branch", "--show-current"], worktree.path);
  if (!branchRaw.ok) {
    return unsafeProbe(worktree, "Git could not inspect the checked-out branch.");
  }
  const branch = branchRaw.value.stdout.trim();
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

  const headRaw = await checked(git, ["rev-parse", "--verify", "HEAD"], worktree.path);
  if (!headRaw.ok || headRaw.value.stdout.trim() === "") {
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
  const head = headRaw.value.stdout.trim();

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
  if (remoteResult?.outcome !== "fetched") {
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

  const canFastForward = await git(
    ["merge-base", "--is-ancestor", head, upstreamHead],
    worktree.path,
    NO_OPTIONAL_LOCKS
  );
  if (!canFastForward.ok) {
    return unsafeProbe(worktree, "Git could not prove a fast-forward is safe.");
  }
  if (canFastForward.value.exitCode === 0) return { kind: "ready", value: ready };
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
  worktree: BulkSyncRepoInput["worktrees"][number],
  fetched: ReadonlyMap<string, BulkSyncRemoteResult>,
  signal?: AbortSignal
): Promise<BulkSyncWorktreeResult> {
  if (isAborted(signal)) {
    return worktreeResult(worktree, {
      outcome: "cancelled",
      reason: "cancelled",
      message: "Cancelled before this worktree was checked."
    });
  }
  const first = await inspectWorktree(git, worktree, fetched);
  if (first.kind === "result") return first.value;
  if (isAborted(signal)) {
    return worktreeResult(worktree, {
      branch: first.value.branch,
      outcome: "cancelled",
      reason: "cancelled",
      message: "Cancelled before the fast-forward started."
    });
  }

  // Re-read every fact immediately before mutation. The exact upstream commit
  // is passed to merge, so this never follows a ref that changed after review.
  const second = await inspectWorktree(git, worktree, fetched, first.value);
  if (second.kind === "result") return second.value;
  if (isAborted(signal)) {
    return worktreeResult(worktree, {
      branch: second.value.branch,
      outcome: "cancelled",
      reason: "cancelled",
      message: "Cancelled before the fast-forward started."
    });
  }
  const merge = await git(
    [
      "merge",
      "--ff-only",
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
  const after = await checked(git, ["rev-parse", "--verify", "HEAD"], worktree.path);
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
    remotes.some((result) => result.outcome === "skipped") ||
    worktrees.some((result) => result.outcome === "skipped");
  const succeeded =
    mode === "fetch"
      ? remotes.some((result) => result.outcome === "fetched")
      : worktrees.some(
          (result) =>
            result.outcome === "updated" || result.outcome === "up_to_date"
        );
  if ((cancelled || failed || skipped) && succeeded) return "partial";
  if (cancelled) return "cancelled";
  if (failed) return "failed";
  if (skipped || !succeeded) return "skipped";
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
        message: "Cancelled before this repository started."
      })
    )
  };
}

async function syncRepo(
  git: GitExec,
  repo: BulkSyncRepoInput,
  options: BulkSyncOptions
): Promise<BulkSyncRepoResult> {
  if (isAborted(options.signal)) return cancelledRepo(repo);
  const fetched = await fetchConfiguredRemotes(git, repo, options.signal);
  if (!fetched.ok) {
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
  const worktrees: BulkSyncWorktreeResult[] = [];
  if (options.mode === "soft-pull") {
    const fetchedByName = new Map(
      fetched.value.map((result) => [result.remote, result])
    );
    const runWorktree: LockRunner =
      options.runWorktree ?? ((_id, operation) => operation());
    for (const worktree of repo.worktrees) {
      if (isAborted(options.signal)) {
        worktrees.push(
          worktreeResult(worktree, {
            outcome: "cancelled",
            reason: "cancelled",
            message: "Cancelled before this worktree was checked."
          })
        );
        continue;
      }
      worktrees.push(
        await runWorktree(worktree.id, () =>
          softPullWorktree(git, worktree, fetchedByName, options.signal)
        )
      );
    }
  }
  return {
    repoId: repo.id,
    name: repo.name,
    path: repo.path,
    outcome: repoOutcome(options.mode, fetched.value, worktrees),
    remotes: fetched.value,
    worktrees
  };
}

function countResults(results: BulkSyncRepoResult[]): BulkSyncCounts {
  const counts: BulkSyncCounts = {
    repos: { success: 0, partial: 0, skipped: 0, failed: 0, cancelled: 0 },
    remotes: { fetched: 0, skipped: 0, failed: 0, cancelled: 0 },
    worktrees: {
      updated: 0,
      upToDate: 0,
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
      else counts.worktrees[worktree.outcome] += 1;
    }
  }
  return counts;
}

/**
 * Run a bounded profile-wide sync. Repositories are the concurrency unit, so
 * worktrees sharing refs fetch once and are inspected serially under one repo
 * lock. Results stay in input order even though progress arrives by completion.
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
  let nextIndex = 0;
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
      const index = nextIndex;
      nextIndex += 1;
      if (index >= repos.length) return;
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
        result = await runRepository(repo.id, () => syncRepo(git, repo, options));
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
