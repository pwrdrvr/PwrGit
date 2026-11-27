import {
  type BulkSyncForkMode,
  type BulkSyncRemoteResult,
  type BulkSyncWorktreeResult,
  type ForgeHostMap,
  type ForkSyncPush,
  type RemoteForgeIdentity,
  type RepoIdentity
} from "@pwrgit/shared";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { nestedWorktreePathspec } from "@pwrgit/mcp-server/nested-worktrees";
import {
  NO_OPTIONAL_LOCKS,
  requireExit0,
  sanitizeGitLogDetail,
  type GitExec,
  type GitOutput
} from "./dugite";
import {
  BULK_OPERATION_STATE_PATHS,
  type BulkSyncSnapshot
} from "./bulk-sync-preflight";
import {
  pushBranchWithLease,
  resolveForkStatus,
  verifiedForkPushUrl,
  type ForkParentHint,
  type ForkStatusOptions
} from "./git-service";

/** Per-repository fork-sync configuration supplied by bulk-sync handlers. */
export type BulkSyncForkConfig = {
  mode: BulkSyncForkMode;
  parent: ForkParentHint | null;
  identity?: RepoIdentity;
  remoteIdentities: readonly RemoteForgeIdentity[];
  forkSyncPrefs: ReadonlyMap<string, boolean>;
  hosts: ForgeHostMap;
  onDiscoverSiblings?: (trackedRemote: string | null, sourceRemote: string) => void;
};

type WorktreeInput = {
  id: string;
  branch: string;
  path: string;
};

const HEAD_REVISIONS = ["--revs-only", "HEAD", "--symbolic-full-name", "HEAD", "--"];

const authFailure = (message: string): boolean =>
  /authentication (?:failed|is required)|terminal prompts disabled|could not read (?:username|password)|username for ['"]|password for ['"]|permission denied \(publickey|credential[^\r\n]*(?:failed|unavailable)|http basic: access denied/i.test(
    message
  );

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted ?? false;

const checked = async (
  git: GitExec,
  args: string[],
  cwd: string
) => {
  const raw = await git(args, cwd, NO_OPTIONAL_LOCKS);
  if (!raw.ok) return raw;
  return requireExit0(raw.value, args);
};

function worktreeResult(
  worktree: WorktreeInput,
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
  worktree: WorktreeInput,
  message: string
): BulkSyncWorktreeResult {
  return worktreeResult(worktree, {
    outcome: "failed",
    reason: "unsafe_state",
    message
  });
}

/**
 * Fast O(1) pre-filter: can this repository possibly have a fork source to
 * sync during bulk pull? Non-fork single-remote repositories skip fork-status
 * resolution with zero extra Git subprocesses.
 */
export function repoMaySyncFork(
  snapshot: BulkSyncSnapshot | null,
  forkSync: BulkSyncForkConfig | undefined
): boolean {
  if (forkSync === undefined || forkSync.mode === "tracked") return false;
  if (snapshot === null) return true;
  if (snapshot.remotes.length < 2) return false;
  return (
    snapshot.remotes.some((remote) => remote.name === "upstream") ||
    forkSync.parent !== null ||
    forkSync.remoteIdentities.some((entry) => entry.parent !== undefined)
  );
}

/**
 * Per-worktree fast-path check using the repository ref snapshot. Feature
 * branches that do not exist on any other remote (and do not track their home
 * remote's default branch) still take `inspectReadOnlyWorktree` with zero
 * extra Git spawns.
 */
export function worktreeMayHaveForkSource(
  snapshot: BulkSyncSnapshot | null,
  worktreePath: string,
  forkSync: BulkSyncForkConfig | undefined
): boolean {
  if (!repoMaySyncFork(snapshot, forkSync)) return false;
  if (snapshot === null) return true;
  const checkout = snapshot.checkouts.get(resolve(worktreePath));
  if (checkout === undefined || !checkout.name.startsWith("refs/heads/")) {
    return false;
  }
  if (
    checkout.upstream === "" ||
    !checkout.upstream.startsWith("refs/remotes/") ||
    checkout.remote === ""
  ) {
    return false;
  }
  const trackedPrefix = `refs/remotes/${checkout.remote}/`;
  if (!checkout.upstream.startsWith(trackedPrefix)) return false;
  const trackedBranch = checkout.upstream.slice(trackedPrefix.length);
  const homeDefault = snapshot.refs.get(`${trackedPrefix}HEAD`)?.symbolic;
  if (homeDefault === checkout.upstream) return true;
  return snapshot.remotes.some(
    (remote) =>
      remote.name !== checkout.remote &&
      snapshot.refs.has(`refs/remotes/${remote.name}/${trackedBranch}`)
  );
}

function statusOptionsOf(forkSync: BulkSyncForkConfig): ForkStatusOptions {
  return {
    remoteIdentities: forkSync.remoteIdentities,
    forkSyncPrefs: forkSync.forkSyncPrefs,
    hosts: forkSync.hosts,
    includeMissingSiblings: false
  };
}

function formatPushTargets(pushes: readonly ForkSyncPush[]): string {
  return pushes
    .filter((entry): entry is Extract<ForkSyncPush, { remote: string; branch: string }> =>
      "remote" in entry && "branch" in entry
    )
    .map((entry) => `${entry.remote}/${entry.branch}`)
    .join(", ");
}

/**
 * Fold local fast-forward status and per-fork push outcomes into one
 * `BulkSyncWorktreeResult`. Pure so every combination of outcomes is directly
 * testable.
 */
export function summarizeBulkForkSyncResult(input: {
  worktree: WorktreeInput;
  branch: string;
  beforeHead: string;
  afterHead: string;
  headMoved: boolean;
  sourceLabel: string;
  pushes: ForkSyncPush[];
  /** Explicit signal that a fork remote fetch or push failed for authentication. */
  authFailed?: boolean;
}): BulkSyncWorktreeResult {
  const {
    worktree,
    branch,
    beforeHead,
    afterHead,
    headMoved,
    sourceLabel,
    pushes,
    authFailed = false
  } = input;
  const stopped = pushes.some((entry) => entry.outcome === "stopped");
  if (stopped) {
    return worktreeResult(worktree, {
      branch,
      outcome: "cancelled",
      reason: "cancelled",
      message: "Cancelled before fork sync push completed.",
      beforeHead,
      ...(headMoved ? { afterHead } : {}),
      forkSource: sourceLabel,
      ...(pushes.length > 0 ? { forkPushes: pushes } : {})
    });
  }

  const failures = pushes.filter(
    (entry): entry is Extract<ForkSyncPush, { outcome: "failed" | "fetch_failed" }> =>
      entry.outcome === "failed" || entry.outcome === "fetch_failed"
  );
  if (failures.length > 0) {
    const auth = authFailed || failures.some((entry) => authFailure(entry.message));
    const detail = failures
      .map((entry) => `${entry.remote}/${entry.branch}: ${entry.message}`)
      .join("; ");
    return worktreeResult(worktree, {
      branch,
      outcome: "failed",
      reason: auth ? "authentication" : "fork_push_failed",
      message: detail,
      beforeHead,
      ...(headMoved ? { afterHead } : {}),
      forkSource: sourceLabel,
      forkPushes: pushes
    });
  }

  const pushed = pushes.filter((entry) => entry.outcome === "pushed");
  const diverged = pushes.filter((entry) => entry.outcome === "diverged");
  if (headMoved || pushed.length > 0) {
    const parts: string[] = [];
    if (pushed.length > 0) {
      parts.push(`pushed to ${formatPushTargets(pushed)}`);
    }
    if (diverged.length > 0) {
      parts.push(`skipped diverged ${formatPushTargets(diverged)}`);
    }
    return worktreeResult(worktree, {
      branch,
      outcome: "updated",
      beforeHead,
      afterHead,
      forkSource: sourceLabel,
      ...(pushes.length > 0 ? { forkPushes: pushes } : {}),
      ...(parts.length > 0 ? { message: parts.join(" · ") } : {})
    });
  }

  if (diverged.length > 0) {
    return worktreeResult(worktree, {
      branch,
      outcome: "skipped",
      reason: "diverged",
      message: `${formatPushTargets(diverged)} has commits ${sourceLabel} doesn't.`,
      beforeHead,
      afterHead,
      forkSource: sourceLabel,
      forkPushes: pushes
    });
  }

  return worktreeResult(worktree, {
    branch,
    outcome: "up_to_date",
    beforeHead,
    afterHead,
    forkSource: sourceLabel,
    ...(pushes.length > 0 ? { forkPushes: pushes } : {})
  });
}

type CheckoutProbe =
  | { kind: "result"; value: BulkSyncWorktreeResult }
  | { kind: "ok"; branch: string; head: string; dirty: boolean };

async function probeCheckoutSafety(
  git: GitExec,
  worktree: WorktreeInput,
  report: (detail: string) => void
): Promise<CheckoutProbe> {
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
    return {
      kind: "result",
      value: unsafeProbe(worktree, "Git could not inspect the working tree safely.")
    };
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
  const pathArgs = BULK_OPERATION_STATE_PATHS.flatMap((path) => ["--git-path", path]);
  const checkout = await git(
    ["rev-parse", ...pathArgs, ...HEAD_REVISIONS],
    worktree.path,
    NO_OPTIONAL_LOCKS
  );
  if (!checkout.ok) {
    return {
      kind: "result",
      value: unsafeProbe(worktree, "Git could not inspect in-progress operations.")
    };
  }
  const lines = checkout.value.stdout.trimEnd().split(/\r?\n/);
  const pathCount = BULK_OPERATION_STATE_PATHS.length;
  const headOid = lines[pathCount];
  const headRef = lines[pathCount + 1];
  const branchPrefix = "refs/heads/";
  const batched =
    checkout.value.exitCode === 0 &&
    lines.length === pathCount + 2 &&
    headOid !== undefined &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headOid) &&
    headRef !== undefined &&
    (headRef === "HEAD" || headRef.startsWith(branchPrefix));
  let paths = lines.slice(0, pathCount);
  if (!batched) {
    const statePaths = await checked(git, ["rev-parse", ...pathArgs], worktree.path);
    if (!statePaths.ok) {
      return {
        kind: "result",
        value: unsafeProbe(worktree, "Git could not inspect in-progress operations.")
      };
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

  let branch: string;
  if (batched) {
    branch = headRef === "HEAD" ? "" : headRef.slice(branchPrefix.length);
  } else {
    const branchRaw = await checked(git, ["branch", "--show-current"], worktree.path);
    if (!branchRaw.ok) {
      return {
        kind: "result",
        value: unsafeProbe(worktree, "Git could not inspect the checked-out branch.")
      };
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

  return { kind: "ok", branch, head, dirty: statusLines.length > 0 };
}

/**
 * Attempt fork-aware pull (and optional multi-fork leased fast-forward push)
 * for one worktree during bulk `soft-pull`.
 *
 * Returns `null` when the branch does not have a fork source counterpart or is
 * strictly ahead of the fork source (for example a moved-on fork), so the
 * caller falls through to the standard `@{u}` fast-forward path.
 */
export async function tryBulkForkSync(
  git: GitExec,
  finishGit: GitExec,
  worktree: WorktreeInput,
  forkSync: BulkSyncForkConfig,
  fetched: ReadonlyMap<string, BulkSyncRemoteResult>,
  signal: AbortSignal | undefined,
  report: (detail: string) => void,
  runRepoPush: <T>(operation: () => Promise<T>) => Promise<T>
): Promise<BulkSyncWorktreeResult | null> {
  if (forkSync.mode === "tracked") return null;
  const cancelled = (): BulkSyncWorktreeResult =>
    worktreeResult(worktree, {
      outcome: "cancelled",
      reason: "cancelled",
      message: "Cancelled before the fast-forward started."
    });
  if (isAborted(signal)) return cancelled();

  report("Checking fork upstream…");
  const statusOptions = statusOptionsOf(forkSync);
  const initial = await resolveForkStatus(
    git,
    worktree.path,
    forkSync.parent,
    forkSync.identity,
    statusOptions
  );
  if (isAborted(signal)) return cancelled();
  if (!initial.ok) {
    return unsafeProbe(worktree, "Git could not inspect fork status safely.");
  }
  const fork = initial.value;
  if (fork === null || fork.source === null || fork.tracked === null) {
    return null;
  }
  const { source, tracked } = fork;
  forkSync.onDiscoverSiblings?.(tracked.remote, source.remote);

  const sourceRemoteResult = fetched.get(source.remote);
  if (
    sourceRemoteResult?.outcome !== "fetched" &&
    sourceRemoteResult?.reason !== "unchanged"
  ) {
    const reason =
      sourceRemoteResult?.reason === "authentication"
        ? "authentication"
        : sourceRemoteResult?.outcome === "failed"
          ? "fetch_failed"
          : "upstream_not_fetched";
    return worktreeResult(worktree, {
      branch: fork.branch,
      outcome: "skipped",
      reason,
      forkSource: source.label,
      message:
        reason === "authentication"
          ? "The upstream remote needs authentication."
          : reason === "fetch_failed"
            ? "The upstream remote could not be fetched."
            : "The upstream remote was not fetched."
    });
  }

  const probe = await probeCheckoutSafety(git, worktree, report);
  if (isAborted(signal)) return cancelled();
  if (probe.kind === "result") return probe.value;
  if (probe.branch !== fork.branch || probe.head !== fork.head) {
    return worktreeResult(worktree, {
      branch: probe.branch,
      outcome: "skipped",
      reason: "unsafe_state",
      message: "The branch or upstream changed during the safety check."
    });
  }

  const { branch, head, dirty } = probe;
  const sourceHead = source.head;
  let headMoved = false;

  // If HEAD already equals the fork source while the tracked fork branch has
  // commits beyond it (the fork moved on and nothing new is on upstream),
  // fall through to the tracked `@{u}` pull path — matching WorktreeHeader.
  if (head === sourceHead && tracked.behind > 0 && tracked.ahead === 0) {
    return null;
  }

  if (head !== sourceHead) {
    report(`Comparing local branch with ${source.label}…`);
    const canFastForward = await git(
      ["merge-base", "--is-ancestor", head, sourceHead],
      worktree.path,
      NO_OPTIONAL_LOCKS
    );
    if (isAborted(signal)) return cancelled();
    if (!canFastForward.ok) {
      return unsafeProbe(worktree, "Git could not prove a fast-forward is safe.");
    }
    if (canFastForward.value.exitCode === 0) {
      if (dirty) {
        return worktreeResult(worktree, {
          branch,
          outcome: "skipped",
          reason: "dirty",
          forkSource: source.label,
          message: "The worktree has uncommitted or untracked changes."
        });
      }

      // Re-verify checkout cleanliness, branch, HEAD and fork source right
      // before mutating, matching softPullWorktree's TOCTOU guard.
      const recheck = await probeCheckoutSafety(git, worktree, (detail) =>
        report(`Rechecking before update: ${detail}`)
      );
      if (isAborted(signal)) return cancelled();
      if (recheck.kind === "result") return recheck.value;
      if (recheck.dirty) {
        return worktreeResult(worktree, {
          branch,
          outcome: "skipped",
          reason: "dirty",
          forkSource: source.label,
          message: "The worktree has uncommitted or untracked changes."
        });
      }
      const recheckFork = await resolveForkStatus(
        git,
        worktree.path,
        forkSync.parent,
        forkSync.identity,
        statusOptions
      );
      if (isAborted(signal)) return cancelled();
      if (
        !recheckFork.ok ||
        recheckFork.value === null ||
        recheckFork.value.branch !== branch ||
        recheckFork.value.head !== head ||
        recheckFork.value.source?.ref !== source.ref ||
        recheckFork.value.source.head !== sourceHead ||
        recheckFork.value.tracked?.ref !== tracked.ref ||
        recheck.branch !== branch ||
        recheck.head !== head
      ) {
        return worktreeResult(worktree, {
          branch,
          outcome: "skipped",
          reason: "unsafe_state",
          forkSource: source.label,
          message: "The branch or upstream changed during the safety check."
        });
      }

      report(`Fast-forwarding from ${source.label}…`);
      if (isAborted(signal)) return cancelled();
      const checkout = await checked(git, ["rev-parse", ...HEAD_REVISIONS], worktree.path);
      if (isAborted(signal)) return cancelled();
      const [liveHead, liveRef] = checkout.ok
        ? checkout.value.stdout.trimEnd().split(/\r?\n/)
        : [];
      const expectedRef = `refs/heads/${branch}`;
      let sameBranch = liveRef === expectedRef;
      if (liveRef === undefined && liveHead === head) {
        const symbolic = await checked(git, ["symbolic-ref", "--quiet", "HEAD"], worktree.path);
        if (isAborted(signal)) return cancelled();
        sameBranch = symbolic.ok && symbolic.value.stdout.trim() === expectedRef;
      }
      if (liveHead !== head || !sameBranch) {
        return worktreeResult(worktree, {
          branch,
          outcome: "skipped",
          reason: "unsafe_state",
          forkSource: source.label,
          message: "The checked-out branch or commit could not be verified before the fast-forward."
        });
      }

      const merge = await finishGit(
        [
          "merge",
          "--ff-only",
          "--progress",
          "--no-edit",
          "--no-overwrite-ignore",
          sourceHead
        ],
        worktree.path
      );
      if (!merge.ok || merge.value.exitCode !== 0) {
        return worktreeResult(worktree, {
          branch,
          outcome: "failed",
          reason: "merge_failed",
          forkSource: source.label,
          message: "Git refused or could not complete the fast-forward. See Logs for details.",
          beforeHead: head
        });
      }
      report("Verifying updated commit…");
      const after = await checked(finishGit, ["rev-parse", "--verify", "HEAD"], worktree.path);
      if (!after.ok || after.value.stdout.trim() !== sourceHead) {
        return worktreeResult(worktree, {
          branch,
          outcome: "failed",
          reason: "merge_failed",
          forkSource: source.label,
          message: "The fast-forward did not finish at the reviewed upstream commit.",
          beforeHead: head,
          ...(after.ok ? { afterHead: after.value.stdout.trim() } : {})
        });
      }
      headMoved = true;
    } else if (canFastForward.value.exitCode !== 1) {
      return unsafeProbe(worktree, "Git could not compare the local and upstream tips.");
    } else {
      // Local branch is not behind the fork source. If it is strictly ahead of
      // the fork source (for example a moved-on fork or local unpushed commits),
      // fall through to the tracked `@{u}` pull path so the branch can still
      // fast-forward from its own fork remote without touching upstream.
      const sourceIsAncestor = await git(
        ["merge-base", "--is-ancestor", sourceHead, head],
        worktree.path,
        NO_OPTIONAL_LOCKS
      );
      if (isAborted(signal)) return cancelled();
      if (!sourceIsAncestor.ok) {
        return unsafeProbe(worktree, "Git could not compare the local and upstream tips.");
      }
      if (sourceIsAncestor.value.exitCode === 0) {
        return null;
      }
      if (sourceIsAncestor.value.exitCode !== 1) {
        return unsafeProbe(worktree, "Git could not compare the local and upstream tips.");
      }
      return worktreeResult(worktree, {
        branch,
        outcome: "skipped",
        reason: "diverged",
        forkSource: source.label,
        message: `${branch} and ${source.label} have diverged.`
      });
    }
  }

  if (forkSync.mode === "source") {
    return worktreeResult(worktree, {
      branch,
      outcome: headMoved ? "updated" : "up_to_date",
      beforeHead: head,
      afterHead: sourceHead,
      forkSource: source.label
    });
  }

  // `mode === "sync"`: push `sourceHead` (fast-forward only, leased on the
  // fetched tip) to every enabled writable fork remote that carries this branch.
  let fetchAuthFailed = false;
  const pushes = await runRepoPush(async (): Promise<ForkSyncPush[]> => {
    const results: ForkSyncPush[] = [];
    if (isAborted(signal)) {
      return [{ outcome: "stopped", remote: tracked.remote, branch }];
    }
    const fresh = await resolveForkStatus(
      git,
      worktree.path,
      forkSync.parent,
      forkSync.identity,
      statusOptions
    );
    if (isAborted(signal)) {
      return [{ outcome: "stopped", remote: tracked.remote, branch }];
    }
    if (!fresh.ok) {
      return [
        {
          outcome: "failed",
          remote: tracked.remote,
          branch,
          message:
            sanitizeGitLogDetail(fresh.error.message) ||
            "Git could not inspect fork status before pushing."
        }
      ];
    }
    const now = fresh.value;
    if (
      now === null ||
      now.branch !== branch ||
      now.source === null ||
      now.source.ref !== source.ref ||
      now.source.head !== sourceHead ||
      now.tracked?.ref !== tracked.ref
    ) {
      return [
        {
          outcome: "failed",
          remote: tracked.remote,
          branch,
          message: "The branch or fork sync route changed before pushing."
        }
      ];
    }

    const planned = (now.source.syncTargets ?? []).filter(
      (target) => target.enabled && !target.unfetched
    );
    for (const target of planned) {
      if (isAborted(signal)) {
        results.push({ outcome: "stopped", remote: target.remote, branch: target.branch });
        continue;
      }
      const remoteResult = fetched.get(target.remote);
      if (
        remoteResult?.outcome !== "fetched" &&
        remoteResult?.reason !== "unchanged"
      ) {
        if (remoteResult?.reason === "skip_fetch_all") {
          results.push({ outcome: "skipped", remote: target.remote, branch: target.branch });
        } else {
          if (remoteResult?.reason === "authentication") fetchAuthFailed = true;
          results.push({
            outcome: "fetch_failed",
            remote: target.remote,
            branch: target.branch,
            message:
              remoteResult?.message ??
              "The fork remote could not be fetched."
          });
        }
        continue;
      }

      const { pushBack } = target;
      if (pushBack === null) {
        results.push({ outcome: "up_to_date", remote: target.remote, branch: target.branch });
        continue;
      }
      if (pushBack.overwrites > 0) {
        results.push({
          outcome: "diverged",
          remote: target.remote,
          branch: target.branch,
          overwrites: pushBack.overwrites
        });
        continue;
      }

      // Independent fast-forward ancestry proof before pushing.
      const ancestor = await git(
        ["merge-base", "--is-ancestor", pushBack.head, sourceHead],
        worktree.path,
        NO_OPTIONAL_LOCKS
      );
      if (isAborted(signal)) {
        results.push({ outcome: "stopped", remote: target.remote, branch: target.branch });
        continue;
      }
      if (!ancestor.ok || ancestor.value.exitCode !== 0) {
        results.push({ outcome: "skipped", remote: target.remote, branch: target.branch });
        continue;
      }

      let verifiedUrl: string | undefined;
      if (!target.tracked) {
        if (target.hostname === undefined || target.nameWithOwner === undefined) {
          results.push({
            outcome: "failed",
            remote: target.remote,
            branch: target.branch,
            message: `${target.remote} is missing confirmed fork repository metadata.`
          });
          continue;
        }
        const verified = await verifiedForkPushUrl(
          git,
          worktree.path,
          target.remote,
          { hostname: target.hostname, nameWithOwner: target.nameWithOwner },
          forkSync.hosts
        );
        if (isAborted(signal)) {
          results.push({ outcome: "stopped", remote: target.remote, branch: target.branch });
          continue;
        }
        if (verified === null) {
          results.push({
            outcome: "failed",
            remote: target.remote,
            branch: target.branch,
            message: `${target.remote}'s push URLs no longer match the confirmed fork repository.`
          });
          continue;
        }
        verifiedUrl = verified;
      }

      report(`Pushing to ${target.remote}/${target.branch}…`);
      const pushed = await pushBranchWithLease(
        git,
        worktree.path,
        {
          remote: target.remote,
          branch: target.branch,
          head: sourceHead,
          expectedHead: pushBack.head
        },
        verifiedUrl
      );
      if (pushed.ok) {
        if (verifiedUrl !== undefined) {
          // Older Git does not update remote-tracking refs on URL-based pushes.
          const refreshed: { ok: boolean; value?: GitOutput } = await git(
            [
              "fetch",
              "--no-tags",
              "--",
              target.remote,
              `+refs/heads/${target.branch}:${pushBack.ref}`
            ],
            worktree.path
          );
          if (!refreshed.ok) {
            // The push itself succeeded; ref refresh is best-effort.
          }
        }
        results.push({ outcome: "pushed", remote: target.remote, branch: target.branch });
      } else if (isAborted(signal) || pushed.error.code === "aborted") {
        results.push({ outcome: "stopped", remote: target.remote, branch: target.branch });
      } else {
        results.push({
          outcome: "failed",
          remote: target.remote,
          branch: target.branch,
          message: sanitizeGitLogDetail(pushed.error.message)
        });
      }
    }
    return results;
  });

  return summarizeBulkForkSyncResult({
    worktree,
    branch,
    beforeHead: head,
    afterHead: sourceHead,
    headMoved,
    sourceLabel: source.label,
    pushes,
    authFailed: fetchAuthFailed
  });
}
