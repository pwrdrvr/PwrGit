import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  err,
  ok,
  type HistoryEditProgram,
  type PwrGitError,
  type RebaseCommitRef,
  type RebaseOperation,
  type RebasePlan,
  type RebaseProof,
  type RebaseSnagDetail,
  type RebaseTreeChange,
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
  proof: RebaseProof;
};

/** A rebase failure, with the structured detail a conflict or a changed tree
 *  carries so the renderer (and a Tidy revision) can act on it. */
export type RebaseFailure = Omit<PwrGitError, "detail"> & {
  detail?: string;
  snag?: RebaseSnagDetail;
};

export type RebaseDryRunOptions = {
  /** Test seam; production checks use the operating system temp directory. */
  tempParent?: string;
  /** Required for `tidy`; for `squash` it carries the edited message. */
  program?: HistoryEditProgram;
};

/** Longest commit message PwrGit will write, agent-authored or not. */
export const MAX_COMMIT_MESSAGE_LENGTH = 8_000;

const OP_LABEL: Record<RebaseOperation, string> = {
  squash: "Squash",
  reorder: "Reorder",
  tidy: "Tidy"
};

const short = (hash: string): string => hash.slice(0, 7);

function rebaseError(
  code: string,
  message: string,
  snag?: RebaseSnagDetail
): RebaseFailure {
  return snag === undefined
    ? { kind: "rebase", code, message }
    : { kind: "rebase", code, message, snag };
}

/** The message Squash starts from: every subject, oldest first. */
export function joinedSubjects(commits: RebaseCommitRef[]): string {
  return [...commits]
    .reverse()
    .map((c) => c.subject)
    .join("\n\n");
}

/**
 * Normalise a message for `commit -m`: strip control characters other than
 * newline and tab, trailing whitespace per line, and surrounding blank lines.
 * Returns null when nothing usable is left or it is too long to be a message.
 */
export function normalizeCommitMessage(raw: string): string | null {
  const cleaned = Array.from(raw.replace(/\r\n?/g, "\n"))
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code === 9 || code === 10 || (code >= 32 && code !== 127);
    })
    .join("");
  const lines = cleaned.split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const message = lines.join("\n");
  if (message === "" || message.length > MAX_COMMIT_MESSAGE_LENGTH) return null;
  return message;
}

/**
 * The program Squash and Reorder compile to. `commits` are newest-first
 * (graph order). Squash folds everything into one commit; Reorder recreates
 * each commit on its own, newest first, which reverses the selected history.
 */
export function defaultProgram(
  commits: RebaseCommitRef[],
  op: Exclude<RebaseOperation, "tidy">
): HistoryEditProgram {
  if (op === "squash") {
    return {
      commits: [
        {
          members: [...commits].reverse().map((c) => c.hash),
          message: joinedSubjects(commits)
        }
      ]
    };
  }
  return { commits: commits.map((c) => ({ members: [c.hash], message: null })) };
}

/**
 * The shape check every program must pass, whoever wrote it: at least one
 * commit, every selected commit used exactly once, nothing from outside the
 * selection, and a usable message wherever one is required.
 */
export function validateProgramShape(
  commits: RebaseCommitRef[],
  program: HistoryEditProgram
): Result<HistoryEditProgram, RebaseFailure> {
  if (program.commits.length === 0) {
    return err(rebaseError("program_empty", "The plan creates no commits."));
  }
  const selected = new Set(commits.map((c) => c.hash));
  const seen = new Set<string>();
  const normalized: HistoryEditProgram = { commits: [] };
  for (const commit of program.commits) {
    if (commit.members.length === 0) {
      return err(rebaseError("program_empty_commit", "The plan has a commit with no changes in it."));
    }
    for (const hash of commit.members) {
      if (!selected.has(hash)) {
        return err(
          rebaseError("unknown_commit", `The plan uses ${short(hash)}, which is not in the selection.`)
        );
      }
      if (seen.has(hash)) {
        return err(rebaseError("duplicate_commit", `The plan uses ${short(hash)} more than once.`));
      }
      seen.add(hash);
    }
    let message: string | null = null;
    if (commit.message === null) {
      if (commit.members.length > 1) {
        return err(
          rebaseError("message_required", "A commit that combines several commits needs a message.")
        );
      }
    } else {
      message = normalizeCommitMessage(commit.message);
      if (message === null) {
        return err(rebaseError("invalid_message", "A commit message is empty or too long."));
      }
    }
    normalized.commits.push({ members: [...commit.members], message });
  }
  const missing = commits.find((c) => !seen.has(c.hash));
  if (missing !== undefined) {
    return err(
      rebaseError("missing_commit", `The plan leaves out ${short(missing.hash)} ${missing.subject}.`)
    );
  }
  return ok(normalized);
}

/**
 * The program a request asks for. Squash and Reorder are PwrGit's own plans;
 * a Squash request may carry a program only to supply its edited message, and
 * must otherwise have exactly Squash's shape. Tidy must carry its program.
 */
export function resolveProgram(
  commits: RebaseCommitRef[],
  op: RebaseOperation,
  program?: HistoryEditProgram
): Result<HistoryEditProgram, RebaseFailure> {
  if (op === "tidy") {
    if (program === undefined) {
      return err(rebaseError("program_required", "Tidy needs a proposed plan."));
    }
    return validateProgramShape(commits, program);
  }
  const canonical = defaultProgram(commits, op);
  if (program === undefined) return ok(canonical);
  if (!sameProgramShape(canonical, program)) {
    return err(
      rebaseError("program_mismatch", `The ${OP_LABEL[op]} plan does not match the selection.`)
    );
  }
  const message = program.commits[0]?.message ?? null;
  return validateProgramShape(
    commits,
    op === "squash" ? { commits: [{ ...canonical.commits[0]!, message }] } : canonical
  );
}

/** True when two programs fold the same commits together in the same order.
 *  Messages are deliberately ignored. */
export function sameProgramShape(a: HistoryEditProgram, b: HistoryEditProgram): boolean {
  return (
    a.commits.length === b.commits.length &&
    a.commits.every((commit, i) => {
      const other = b.commits[i];
      return (
        other !== undefined &&
        (commit.message === null) === (other.message === null) &&
        commit.members.length === other.members.length &&
        commit.members.every((hash, j) => hash === other.members[j])
      );
    })
  );
}

function stepsFor(
  commits: RebaseCommitRef[],
  program: HistoryEditProgram,
  combine: "squash" | "fixup"
): RebasePlan["steps"] {
  const subjects = new Map(commits.map((c) => [c.hash, c.subject]));
  return program.commits.flatMap((commit) =>
    commit.members.map((hash, i) => ({
      action: i === 0 ? ("pick" as const) : combine,
      shortHash: short(hash),
      subject: subjects.get(hash) ?? ""
    }))
  );
}

/**
 * Build the plan preview from a selection. `commits` are newest-first (graph
 * order). The steps are listed in execution order.
 */
export function planRebase(
  commits: RebaseCommitRef[],
  op: RebaseOperation,
  program?: HistoryEditProgram
): RebasePlan {
  if (commits.length < 2) {
    return {
      op,
      steps: [],
      summary: "",
      valid: false,
      reason: "Select at least two commits."
    };
  }
  if (op === "tidy" && program === undefined) {
    // Tidy has nothing to show until an agent proposes a history.
    return { op, steps: [], summary: "", valid: true };
  }
  const resolved = resolveProgram(commits, op, program);
  if (!resolved.ok) {
    return { op, steps: [], summary: "", valid: false, reason: resolved.error.message };
  }
  if (op === "squash") {
    return {
      op,
      steps: stepsFor(commits, resolved.value, "squash"),
      summary: "→ 1 commit",
      valid: true
    };
  }
  if (op === "reorder") {
    return {
      op,
      // Reorder resets to the base and cherry-picks newest-first, so the plan
      // is shown in the exact execution order (and the history is reversed).
      steps: stepsFor(commits, resolved.value, "fixup"),
      summary: "→ reversed order, no content change",
      valid: true
    };
  }
  const count = resolved.value.commits.length;
  return {
    op,
    steps: stepsFor(commits, resolved.value, "fixup"),
    summary: `→ ${count} commit${count === 1 ? "" : "s"}`,
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

async function conflictedFiles(git: GitExec, cwd: string): Promise<string[]> {
  const raw = await git(["diff", "--name-only", "--diff-filter=U"], cwd);
  if (!raw.ok || raw.value.exitCode !== 0) return [];
  return raw.value.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 20);
}

async function readTree(git: GitExec, cwd: string, rev: string): Promise<string | null> {
  const raw = await git(["rev-parse", `${rev}^{tree}`], cwd);
  if (!raw.ok || raw.value.exitCode !== 0) return null;
  const tree = raw.value.stdout.trim();
  return tree === "" ? null : tree;
}

async function treeChanges(
  git: GitExec,
  cwd: string,
  from: string,
  to: string
): Promise<RebaseTreeChange[]> {
  const raw = await git(["diff", "--numstat", "--no-renames", from, to], cwd);
  if (!raw.ok || raw.value.exitCode !== 0) return [];
  return raw.value.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .slice(0, 20)
    .map((line) => {
      const [added = "0", removed = "0", ...path] = line.split("\t");
      return {
        path: path.join("\t"),
        added: Number.parseInt(added, 10) || 0,
        removed: Number.parseInt(removed, 10) || 0
      };
    });
}

type RewriteOutcome = { steps: number; tree: string };

/**
 * Execute a program on `cwd`: reset to the base, then recreate each commit in
 * order. A single member with no new message is cherry-picked as-is (message
 * and author kept); anything else is cherry-picked without committing and
 * committed once under `identity` with its message. Finally the rewritten tip
 * must carry exactly the tree `expectedTreeOf` had — a history edit may move
 * changes between commits, never change the code.
 */
async function rewriteHistory(
  git: GitExec,
  cwd: string,
  commits: RebaseCommitRef[],
  op: RebaseOperation,
  program: HistoryEditProgram,
  identity: CommitIdentity,
  base: string,
  expectedTreeOf: string,
  restoreHead?: string,
  hooksPath: string = join(
    tmpdir(),
    `pwrgit-disabled-hooks-${randomUUID()}`
  )
): Promise<Result<RewriteOutcome, RebaseFailure>> {
  const configArgs = gitConfigArgs(identity, hooksPath);
  const label = OP_LABEL[op];
  const restore = async (): Promise<void> => {
    if (restoreHead !== undefined) {
      await git(["reset", "--hard", restoreHead], cwd);
    }
  };

  const expectedTree = await readTree(git, cwd, expectedTreeOf);
  if (expectedTree === null) {
    return err(rebaseError("tree_unavailable", "Could not read the current commit's files."));
  }

  const reset = await git(["reset", "--hard", base], cwd);
  if (!reset.ok || reset.value.exitCode !== 0) {
    await restore();
    return err(rebaseError("reset_failed", `Could not start the ${label.toLowerCase()}.`));
  }

  const subjects = new Map(commits.map((c) => [c.hash, c.subject]));
  const total = program.commits.reduce((sum, c) => sum + c.members.length, 0);
  let step = 0;
  const conflict = async (hash: string): Promise<RebaseFailure> => {
    const files = await conflictedFiles(git, cwd);
    await git([...configArgs, "cherry-pick", "--abort"], cwd);
    await restore();
    return rebaseError("conflict", `${label} hit a conflict.`, {
      kind: "conflict",
      step,
      total,
      hash,
      subject: subjects.get(hash) ?? "",
      files
    });
  };

  for (const commit of program.commits) {
    if (commit.message === null && commit.members.length === 1) {
      const hash = commit.members[0]!;
      step += 1;
      const pick = await git([...configArgs, "cherry-pick", hash], cwd);
      if (!pick.ok || pick.value.exitCode !== 0) return err(await conflict(hash));
      continue;
    }
    for (const hash of commit.members) {
      step += 1;
      const pick = await git([...configArgs, "cherry-pick", "--no-commit", hash], cwd);
      if (!pick.ok || pick.value.exitCode !== 0) return err(await conflict(hash));
    }
    const made = await git(
      [...configArgs, "commit", "-m", commit.message ?? ""],
      cwd
    );
    if (!made.ok || made.value.exitCode !== 0) {
      await restore();
      return err(
        rebaseError(
          "commit_failed",
          op === "squash"
            ? "Could not create the squashed commit."
            : "Could not create one of the rewritten commits."
        )
      );
    }
  }

  const tree = await readTree(git, cwd, "HEAD");
  if (tree !== expectedTree) {
    const files = await treeChanges(git, cwd, expectedTreeOf, "HEAD");
    await restore();
    return err(
      rebaseError(
        "tree_changed",
        "The rewrite would change the code, not just the history.",
        { kind: "tree_changed", files }
      )
    );
  }
  return ok({ steps: step, tree });
}

async function simulateInTemporaryRepository(
  git: GitExec,
  sourceCwd: string,
  cloneRoot: string,
  commits: RebaseCommitRef[],
  op: RebaseOperation,
  program: HistoryEditProgram,
  identity: CommitIdentity,
  source: RebaseSourceState
): Promise<Result<RewriteOutcome, RebaseFailure>> {
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
  return rewriteHistory(
    git,
    repositoryPath,
    commits,
    op,
    program,
    identity,
    validated.value.base,
    source.head,
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
 * Check the exact rewrite in a disposable local repository, and prove it: every
 * selected commit used once, a clean replay, and a tree identical to the current
 * tip. The source worktree is only read: every checkout, reset, stage, commit,
 * and cherry-pick runs in the temporary clone, which is removed before this
 * function returns.
 */
export async function dryRunRebase(
  git: GitExec,
  sourceCwd: string,
  commits: RebaseCommitRef[],
  op: RebaseOperation,
  identity: CommitIdentity,
  options: RebaseDryRunOptions = {}
): Promise<Result<RebaseDryRunSuccess, RebaseFailure>> {
  const started = Date.now();
  const program = resolveProgram(commits, op, options.program);
  if (!program.ok) return program;
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

  let simulation: Result<RewriteOutcome, RebaseFailure>;
  let cleanupFailure: unknown;
  try {
    try {
      simulation = await simulateInTemporaryRepository(
        git,
        sourceCwd,
        cloneRoot,
        commits,
        op,
        program.value,
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
    const code = simulation.error.code;
    const message =
      code === "conflict"
        ? `${OP_LABEL[op]} would hit a conflict. The worktree was not changed.`
        : code === "tree_changed"
          ? "The rewrite would change the code, not just the history. It was discarded; the worktree was not changed."
          : simulation.error.message;
    return err({ ...simulation.error, message });
  }
  return ok({
    sourceHead: preflight.value.source.head,
    sourceRef: preflight.value.source.headRef,
    proof: {
      commitCount: commits.length,
      resultCount: program.value.commits.length,
      steps: simulation.value.steps,
      tree: simulation.value.tree,
      durationMs: Date.now() - started
    }
  });
}

/** Apply the rewrite locally with clean-tree checks and rollback. Never pushes. */
export async function applyRebase(
  git: GitExec,
  cwd: string,
  commits: RebaseCommitRef[],
  op: RebaseOperation,
  identity: CommitIdentity,
  expectedSource?: RebaseSourceState,
  program?: HistoryEditProgram
): Promise<Result<void, RebaseFailure>> {
  const resolved = resolveProgram(commits, op, program);
  if (!resolved.ok) return resolved;
  const preflight = await preflightRebase(git, cwd, commits, expectedSource);
  if (!preflight.ok) return preflight;
  const result = await rewriteHistory(
    git,
    cwd,
    commits,
    op,
    resolved.value,
    identity,
    preflight.value.base,
    preflight.value.source.head,
    preflight.value.source.head
  );
  if (!result.ok) {
    if (result.error.code === "conflict" || result.error.code === "tree_changed") {
      const lead =
        result.error.code === "conflict"
          ? `${OP_LABEL[op]} hit a conflict.`
          : "The rewrite would have changed the code.";
      return err({
        ...result.error,
        message: `${lead} The worktree was restored unchanged.`
      });
    }
    return result;
  }
  return ok(undefined);
}
