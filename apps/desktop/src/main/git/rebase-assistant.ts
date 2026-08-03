import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  err,
  ok,
  type PwrGitError,
  type RebaseCommitRef,
  type RebaseOperation,
  type RebasePlan,
  type Result
} from "@pwrgit/shared";
import type { GitExec } from "./dugite";
import type { CommitIdentity } from "./git-service";

export type RebaseSourceState = {
  head: string;
  /** Full symbolic ref, or null when HEAD is detached. */
  headRef: string | null;
};

export type RebaseDryRunSuccess = {
  sourceHead: string;
  sourceRef: string | null;
};

export type RebaseDryRunOptions = {
  /** Test seam; production checks use the operating system temp directory. */
  tempParent?: string;
};

/**
 * Build the plan preview from a selection. `commits` are newest-first (graph
 * order). Squash creates one commit; reorder reverses the selected history.
 */
export function planRebase(
  commits: RebaseCommitRef[],
  op: RebaseOperation
): RebasePlan {
  const short = (h: string): string => h.slice(0, 7);
  if (commits.length < 2) {
    return {
      op,
      steps: [],
      summary: "",
      valid: false,
      reason: "Select at least two commits."
    };
  }
  const oldestFirst = [...commits].reverse();
  if (op === "squash") {
    return {
      op,
      steps: oldestFirst.map((c, i) => ({
        action: i === 0 ? "pick" : "squash",
        shortHash: short(c.hash),
        subject: c.subject
      })),
      summary: `→ 1 commit, message built from ${commits.length} subjects`,
      valid: true
    };
  }
  return {
    op,
    // Reorder resets to the base and cherry-picks newest-first, so the plan is
    // shown in the exact execution order (and the final history is reversed).
    steps: commits.map((c) => ({
      action: "pick",
      shortHash: short(c.hash),
      subject: c.subject
    })),
    summary: "→ reversed order, no content change",
    valid: true
  };
}

/** The selection must be exactly the N most-recent commits (contiguous, incl HEAD). */
export async function validateSelection(
  git: GitExec,
  cwd: string,
  commits: RebaseCommitRef[]
): Promise<Result<{ oldest: string; base: string }>> {
  const n = commits.length;
  const raw = await git(["log", "-n", String(n), "--format=%H"], cwd);
  if (!raw.ok) return raw;
  if (raw.value.exitCode !== 0) {
    return err({
      kind: "rebase",
      code: "history_unavailable",
      message: "Could not read the selected commit history."
    });
  }
  const top = raw.value.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const selected = new Set(commits.map((c) => c.hash));
  if (top.length !== n || !top.every((h) => selected.has(h))) {
    return err({
      kind: "rebase",
      code: "not_top_run",
      message: "Select a contiguous run of the most recent commits."
    });
  }
  const oldest = top[n - 1];
  if (oldest === undefined) {
    return err({
      kind: "rebase",
      code: "empty",
      message: "No commits selected."
    });
  }
  const baseRaw = await git(["rev-parse", `${oldest}^`], cwd);
  if (!baseRaw.ok) return baseRaw;
  if (baseRaw.value.exitCode !== 0) {
    return err({
      kind: "rebase",
      code: "includes_root",
      message: "Can't rebase a range that includes the initial commit."
    });
  }
  return ok({ oldest, base: baseRaw.value.stdout.trim() });
}

async function readSourceState(
  git: GitExec,
  cwd: string
): Promise<Result<RebaseSourceState>> {
  const head = await git(["rev-parse", "HEAD"], cwd);
  if (!head.ok) return head;
  if (head.value.exitCode !== 0 || head.value.stdout.trim() === "") {
    return err({
      kind: "rebase",
      code: "head_unavailable",
      message: "Could not read the current commit."
    });
  }

  const symbolic = await git(["symbolic-ref", "--quiet", "HEAD"], cwd);
  if (!symbolic.ok) return symbolic;
  if (symbolic.value.exitCode !== 0 && symbolic.value.exitCode !== 1) {
    return err({
      kind: "rebase",
      code: "head_ref_unavailable",
      message: "Could not identify the checked-out branch."
    });
  }
  return ok({
    head: head.value.stdout.trim(),
    headRef:
      symbolic.value.exitCode === 0 ? symbolic.value.stdout.trim() : null
  });
}

function sameSource(a: RebaseSourceState, b: RebaseSourceState): boolean {
  return a.head === b.head && a.headRef === b.headRef;
}

async function preflightRebase(
  git: GitExec,
  cwd: string,
  commits: RebaseCommitRef[],
  expectedSource?: RebaseSourceState
): Promise<Result<{ base: string; source: RebaseSourceState }>> {
  const status = await git(["status", "--porcelain"], cwd);
  if (!status.ok) return status;
  if (status.value.exitCode !== 0) {
    return err({
      kind: "rebase",
      code: "status_failed",
      message: "Could not check whether the worktree is clean."
    });
  }
  if (status.value.stdout.trim() !== "") {
    return err({
      kind: "rebase",
      code: "dirty",
      message: "Commit or stash your changes before rebasing."
    });
  }

  const before = await readSourceState(git, cwd);
  if (!before.ok) return before;
  if (
    expectedSource !== undefined &&
    !sameSource(before.value, expectedSource)
  ) {
    return err({
      kind: "rebase",
      code: "dry_run_stale",
      message:
        "The checked-out branch or commit changed since the last check. Run the check again."
    });
  }

  const validated = await validateSelection(git, cwd, commits);
  if (!validated.ok) return validated;
  const after = await readSourceState(git, cwd);
  if (!after.ok) return after;
  if (!sameSource(after.value, before.value)) {
    return err({
      kind: "rebase",
      code: "source_changed",
      message:
        "The checked-out branch or commit changed while it was being checked. Try again."
    });
  }
  return ok({ base: validated.value.base, source: after.value });
}

function gitConfigArgs(
  identity: CommitIdentity,
  hooksPath: string
): string[] {
  const args = [
    "-c",
    `core.hooksPath=${hooksPath}`,
    "-c",
    "commit.gpgSign=false",
    "-c",
    "rerere.enabled=false",
    "-c",
    `user.email=${identity.email}`
  ];
  if (identity.name !== undefined && identity.name !== "") {
    args.push("-c", `user.name=${identity.name}`);
  }
  return args;
}

async function rewriteSelectedCommits(
  git: GitExec,
  cwd: string,
  commits: RebaseCommitRef[],
  op: RebaseOperation,
  identity: CommitIdentity,
  base: string,
  restoreHead?: string,
  hooksPath: string = join(
    tmpdir(),
    `pwrgit-disabled-hooks-${randomUUID()}`
  )
): Promise<Result<void>> {
  const configArgs = gitConfigArgs(identity, hooksPath);
  const restore = async (): Promise<void> => {
    if (restoreHead !== undefined) {
      await git(["reset", "--hard", restoreHead], cwd);
    }
  };

  if (op === "squash") {
    const reset = await git(["reset", "--soft", base], cwd);
    if (!reset.ok || reset.value.exitCode !== 0) {
      await restore();
      return err({
        kind: "rebase",
        code: "reset_failed",
        message: "Could not start the squash."
      });
    }
    const message = [...commits].reverse().map((c) => c.subject).join("\n\n");
    const commit = await git([...configArgs, "commit", "-m", message], cwd);
    if (!commit.ok || commit.value.exitCode !== 0) {
      await restore();
      return err({
        kind: "rebase",
        code: "commit_failed",
        message: "Could not create the squashed commit."
      });
    }
    return ok(undefined);
  }

  // Reorder resets to the base, then applies newest-first to reverse history.
  const reset = await git(["reset", "--hard", base], cwd);
  if (!reset.ok || reset.value.exitCode !== 0) {
    await restore();
    return err({
      kind: "rebase",
      code: "reset_failed",
      message: "Could not start the reorder."
    });
  }
  for (const c of commits) {
    const pick = await git([...configArgs, "cherry-pick", c.hash], cwd);
    if (!pick.ok || pick.value.exitCode !== 0) {
      await git([...configArgs, "cherry-pick", "--abort"], cwd);
      await restore();
      return err({
        kind: "rebase",
        code: "conflict",
        message: "Reorder hit a conflict."
      });
    }
  }
  return ok(undefined);
}

async function simulateInTemporaryRepository(
  git: GitExec,
  sourceCwd: string,
  cloneRoot: string,
  commits: RebaseCommitRef[],
  op: RebaseOperation,
  identity: CommitIdentity,
  source: RebaseSourceState
): Promise<Result<void>> {
  const repositoryPath = join(cloneRoot, "repo");
  const hooksPath = join(cloneRoot, "disabled-hooks");
  await mkdir(hooksPath);

  const init = await git(["init", "--quiet", repositoryPath], cloneRoot);
  if (!init.ok || init.value.exitCode !== 0) {
    return err({
      kind: "rebase",
      code: "init_failed",
      message: "Could not create an isolated repository for the check."
    });
  }

  // Fetch only the checked ref, selected commits, and their base. Starting
  // from an empty repo prevents unrelated branches and tags from being copied.
  const fetch = await git(
    [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      `--depth=${commits.length + 1}`,
      "--",
      sourceCwd,
      source.headRef ?? "HEAD"
    ],
    repositoryPath
  );
  if (!fetch.ok || fetch.value.exitCode !== 0) {
    return err({
      kind: "rebase",
      code: "fetch_failed",
      message: "Could not copy the selected history into the isolated repository."
    });
  }

  const checkout = await git(
    ["-c", `core.hooksPath=${hooksPath}`, "checkout", "--detach", source.head],
    repositoryPath
  );
  if (!checkout.ok || checkout.value.exitCode !== 0) {
    return err({
      kind: "rebase",
      code: "checkout_failed",
      message: "Could not check out the selected commit in the isolated repository."
    });
  }

  const validated = await validateSelection(git, repositoryPath, commits);
  if (!validated.ok) return validated;
  return rewriteSelectedCommits(
    git,
    repositoryPath,
    commits,
    op,
    identity,
    validated.value.base,
    undefined,
    hooksPath
  );
}

async function dryRunIdentity(
  git: GitExec,
  sourceCwd: string,
  identity: CommitIdentity
): Promise<CommitIdentity> {
  if (identity.name !== undefined && identity.name !== "") return identity;
  const configuredName = await git(["config", "--get", "user.name"], sourceCwd);
  if (
    configuredName.ok &&
    configuredName.value.exitCode === 0 &&
    configuredName.value.stdout.trim() !== ""
  ) {
    return { ...identity, name: configuredName.value.stdout.trim() };
  }
  return identity;
}

/**
 * Check the exact rewrite in a disposable local repository. The source worktree is
 * only read: every checkout, reset, stage, commit, and cherry-pick runs in the
 * temporary clone, which is removed before this function returns.
 */
export async function dryRunRebase(
  git: GitExec,
  sourceCwd: string,
  commits: RebaseCommitRef[],
  op: RebaseOperation,
  identity: CommitIdentity,
  options: RebaseDryRunOptions = {}
): Promise<Result<RebaseDryRunSuccess>> {
  const preflight = await preflightRebase(git, sourceCwd, commits);
  if (!preflight.ok) return preflight;

  let cloneRoot: string;
  try {
    cloneRoot = await mkdtemp(
      join(options.tempParent ?? tmpdir(), "pwrgit-rebase-check-")
    );
  } catch (cause) {
    return err({
      kind: "rebase",
      code: "temp_create_failed",
      message: "Could not create temporary space for the rebase check.",
      cause
    });
  }

  let simulation: Result<void>;
  let cleanupFailure: unknown;
  try {
    try {
      simulation = await simulateInTemporaryRepository(
        git,
        sourceCwd,
        cloneRoot,
        commits,
        op,
        await dryRunIdentity(git, sourceCwd, identity),
        preflight.value.source
      );
    } catch (cause) {
      simulation = err({
        kind: "rebase",
        code: "check_failed",
        message: "The isolated rebase check could not finish.",
        cause
      });
    }
  } finally {
    try {
      // cloneRoot is the exact path returned by mkdtemp; no parent or glob is
      // ever used as a deletion target.
      await rm(cloneRoot, { recursive: true, force: true });
    } catch (cause) {
      cleanupFailure = cause;
    }
  }

  if (cleanupFailure !== undefined) {
    return err({
      kind: "rebase",
      code: "temp_cleanup_failed",
      message:
        "The rebase check finished, but its temporary files could not be removed.",
      cause: cleanupFailure
    });
  }

  if (!simulation.ok) {
    const message =
      simulation.error.code === "conflict"
        ? "Reorder would hit a conflict. The worktree was not changed."
        : simulation.error.message;
    const error: PwrGitError = { ...simulation.error, message };
    return err(error);
  }
  return ok({
    sourceHead: preflight.value.source.head,
    sourceRef: preflight.value.source.headRef
  });
}

/** Apply the rebase locally with clean-tree checks and rollback. Never pushes. */
export async function applyRebase(
  git: GitExec,
  cwd: string,
  commits: RebaseCommitRef[],
  op: RebaseOperation,
  identity: CommitIdentity,
  expectedSource?: RebaseSourceState
): Promise<Result<void>> {
  const preflight = await preflightRebase(git, cwd, commits, expectedSource);
  if (!preflight.ok) return preflight;
  const result = await rewriteSelectedCommits(
    git,
    cwd,
    commits,
    op,
    identity,
    preflight.value.base,
    preflight.value.source.head
  );
  if (!result.ok && result.error.code === "conflict") {
    return err({
      ...result.error,
      message: "Reorder hit a conflict. The worktree was restored unchanged."
    });
  }
  return result;
}
