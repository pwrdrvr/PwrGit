import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  err,
  ok,
  type GitOperation,
  type GitOperationKind,
  type OperationContinueOutcome,
  type OperationState,
  type Result
} from "@pwrgit/shared";
import { NO_OPTIONAL_LOCKS, requireExit0, type GitExec } from "./dugite";

/**
 * Reports what Git is in the middle of, and offers only the two ways out that
 * Git itself defines: `--continue` and `--abort`. Resolving the conflicts is
 * deliberately not in scope — that happens in the user's editor or agent.
 */

function operationError(code: string, message: string) {
  return err({ kind: "git" as const, code, message });
}

/** A rebase counter file; absent, empty, or non-positive all mean "unknown". */
function readCounter(path: string): number | null {
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Classify from Git's own marker files. Order matters: the rebase backends own
 * `rebase-merge`/`rebase-apply` and must be checked before `MERGE_HEAD`, which
 * a rebase step can also leave behind.
 */
export function detectOperation(gitDir: string): GitOperation | null {
  const rebaseMergeDir = join(gitDir, "rebase-merge");
  const rebaseApplyDir = join(gitDir, "rebase-apply");

  // `git am` and `git rebase --apply` share rebase-apply/; only am writes
  // `applying`, so that file is what separates them.
  if (existsSync(join(rebaseApplyDir, "applying"))) {
    return { kind: "am", label: "Apply patches" };
  }
  const rebaseDir = existsSync(rebaseMergeDir)
    ? rebaseMergeDir
    : existsSync(rebaseApplyDir)
      ? rebaseApplyDir
      : null;
  if (rebaseDir !== null) {
    // The merge backend writes msgnum/end; the apply backend writes next/last.
    const current =
      readCounter(join(rebaseDir, "msgnum")) ??
      readCounter(join(rebaseDir, "next"));
    const total =
      readCounter(join(rebaseDir, "end")) ??
      readCounter(join(rebaseDir, "last"));
    return {
      kind: "rebase",
      label: "Rebase",
      ...(current !== null && total !== null
        ? { progress: { current, total } }
        : {})
    };
  }
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) {
    return { kind: "cherry-pick", label: "Cherry-pick" };
  }
  if (existsSync(join(gitDir, "REVERT_HEAD"))) {
    return { kind: "revert", label: "Revert" };
  }
  if (existsSync(join(gitDir, "MERGE_HEAD"))) {
    return { kind: "merge", label: "Merge" };
  }
  return null;
}

/** Distinct paths carrying at least one unmerged stage. */
export function countUnmergedPaths(stdout: string): number {
  const paths = new Set<string>();
  for (const record of stdout.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    paths.add(record.slice(tab + 1));
  }
  return paths.size;
}

async function gitDirOf(git: GitExec, cwd: string): Promise<Result<string>> {
  const args = ["rev-parse", "--absolute-git-dir"];
  const raw = await git(args, cwd, NO_OPTIONAL_LOCKS);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) return checked;
  const path = checked.value.stdout.trim();
  return path === ""
    ? operationError(
        "git_dir_missing",
        "Git did not report its worktree state directory."
      )
    : ok(path);
}

async function conflictCount(
  git: GitExec,
  cwd: string
): Promise<Result<number>> {
  const args = ["ls-files", "--unmerged", "-z"];
  const raw = await git(args, cwd, NO_OPTIONAL_LOCKS);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  return checked.ok ? ok(countUnmergedPaths(checked.value.stdout)) : checked;
}

async function headOid(git: GitExec, cwd: string): Promise<string | null> {
  const raw = await git(["rev-parse", "HEAD"], cwd, NO_OPTIONAL_LOCKS);
  if (!raw.ok || raw.value.exitCode !== 0) return null;
  const oid = raw.value.stdout.trim();
  return oid === "" ? null : oid;
}

/** Fresh operation markers plus the current unmerged-path count. */
export async function readOperationState(
  git: GitExec,
  cwd: string
): Promise<Result<OperationState>> {
  const [gitDir, conflicts] = await Promise.all([
    gitDirOf(git, cwd),
    conflictCount(git, cwd)
  ]);
  if (!gitDir.ok) return gitDir;
  if (!conflicts.ok) return conflicts;
  return ok({
    operation: detectOperation(gitDir.value),
    conflictCount: conflicts.value
  });
}

const CONTINUE_ARGS: Record<GitOperationKind, string[]> = {
  merge: ["merge", "--continue"],
  rebase: ["rebase", "--continue"],
  am: ["am", "--continue"],
  "cherry-pick": ["cherry-pick", "--continue"],
  revert: ["revert", "--continue"]
};

const ABORT_ARGS: Record<GitOperationKind, string[]> = {
  merge: ["merge", "--abort"],
  rebase: ["rebase", "--abort"],
  am: ["am", "--abort"],
  "cherry-pick": ["cherry-pick", "--abort"],
  revert: ["revert", "--abort"]
};

/**
 * Re-read state and refuse unless it is still the operation the caller saw.
 * Guards against acting on a stale renderer view after an external Git change.
 */
async function requireOperation(
  git: GitExec,
  cwd: string,
  expected: GitOperationKind
): Promise<Result<OperationState>> {
  const state = await readOperationState(git, cwd);
  if (!state.ok) return state;
  if (state.value.operation === null) {
    return operationError(
      "operation_gone",
      "Git is no longer mid-operation in this worktree."
    );
  }
  if (state.value.operation.kind !== expected) {
    return operationError(
      "operation_changed",
      `This worktree is now in a ${state.value.operation.kind}, not a ${expected}. Refresh before acting.`
    );
  }
  return state;
}

function describeStop(state: OperationState): string {
  const step =
    state.operation?.progress === undefined
      ? ""
      : ` at step ${state.operation.progress.current} of ${state.operation.progress.total}`;
  if (state.conflictCount === 0) {
    return `Git stopped${step} with nothing to resolve.`;
  }
  return `Git stopped${step} on ${state.conflictCount} conflicted path${state.conflictCount === 1 ? "" : "s"}.`;
}

/**
 * Run Git's own `--continue`, non-interactively.
 *
 * Git exits non-zero **both** when the operation genuinely fails and when it
 * successfully applies a step and then stops on the *next* conflict — a normal
 * multi-commit rebase does exactly that. Classifying on the exit code alone
 * reports ordinary progress as failure, so the outcome is decided by what
 * actually moved: HEAD, the sequencer counter, or the conflict count.
 */
export async function continueOperation(
  git: GitExec,
  cwd: string,
  operation: GitOperationKind,
  identity?: { email: string; name?: string }
): Promise<Result<OperationContinueOutcome>> {
  const before = await requireOperation(git, cwd, operation);
  if (!before.ok) return before;
  if (before.value.conflictCount > 0) {
    const n = before.value.conflictCount;
    return operationError(
      "unresolved_conflicts",
      `${n} path${n === 1 ? " is" : "s are"} still unmerged. Resolve ${n === 1 ? "it" : "them"} and stage ${n === 1 ? "it" : "them"} before continuing.`
    );
  }
  const beforeHead = await headOid(git, cwd);
  const beforeStep = before.value.operation?.progress?.current ?? null;

  const args = [
    ...(identity === undefined ? [] : ["-c", `user.email=${identity.email}`]),
    ...(identity?.name === undefined || identity.name === ""
      ? []
      : ["-c", `user.name=${identity.name}`]),
    ...CONTINUE_ARGS[operation]
  ];
  // Git would otherwise open $EDITOR for the commit/todo message and hang.
  const raw = await git(args, cwd, {
    env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" }
  });
  if (!raw.ok) return raw;

  const after = await readOperationState(git, cwd);
  if (!after.ok) return after;
  if (after.value.operation === null) return ok({ kind: "completed" });

  const afterHead = await headOid(git, cwd);
  const afterStep = after.value.operation.progress?.current ?? null;
  const advanced =
    (beforeHead !== null && afterHead !== null && beforeHead !== afterHead) ||
    (beforeStep !== null && afterStep !== null && afterStep > beforeStep) ||
    after.value.conflictCount > 0;

  if (raw.value.exitCode === 0 || advanced) {
    return ok({
      kind: "stopped",
      state: after.value,
      detail: describeStop(after.value)
    });
  }
  return operationError(
    "continue_failed",
    raw.value.stderr.trim() ||
      raw.value.stdout.trim() ||
      `git ${CONTINUE_ARGS[operation].join(" ")} failed`
  );
}

/** Run Git's own `--abort` after re-validating the operation marker. */
export async function abortOperation(
  git: GitExec,
  cwd: string,
  operation: GitOperationKind
): Promise<Result<void>> {
  const current = await requireOperation(git, cwd, operation);
  if (!current.ok) return current;
  const args = ABORT_ARGS[operation];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  return checked.ok ? ok(undefined) : checked;
}

/**
 * True when text carries a complete, unresolved conflict region.
 *
 * Both an opening and a closing marker are required. A file that mentions
 * `<<<<<<<` once — documentation about merge conflicts, a test fixture — is
 * not flagged, which keeps the warning trustworthy enough to act on.
 */
export function hasConflictMarkers(text: string): boolean {
  let opened = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("<<<<<<< ") || line === "<<<<<<<") opened = true;
    else if (opened && (line.startsWith(">>>>>>> ") || line === ">>>>>>>")) {
      return true;
    }
  }
  return false;
}

/** Files larger than this are not scanned for markers; the read is not worth it. */
export const MARKER_SCAN_SIZE_LIMIT = 5 * 1024 * 1024;

/** Total bytes one scan will read, so a huge conflict set cannot stall main. */
export const MARKER_SCAN_TOTAL_BUDGET = 64 * 1024 * 1024;

/** Resolve a Git path inside `cwd`, refusing anything that escapes it. */
function insideWorktree(cwd: string, gitPath: string): string | null {
  const root = resolve(cwd);
  const target = resolve(root, ...gitPath.split("/"));
  const rel = relative(root, target);
  const parentPrefix = process.platform === "win32" ? "..\\" : "../";
  if (rel === "" || rel === ".." || rel.startsWith(parentPrefix) || isAbsolute(rel)) {
    return null;
  }
  return target;
}

/**
 * Of `paths`, which still contain an unresolved conflict region. Unreadable,
 * oversized, binary, and non-file entries are skipped rather than guessed at:
 * a false warning here trains people to click through it.
 */
export function scanConflictMarkers(cwd: string, paths: string[]): string[] {
  const flagged: string[] = [];
  let budget = MARKER_SCAN_TOTAL_BUDGET;
  for (const gitPath of paths) {
    if (budget <= 0) break;
    const target = insideWorktree(cwd, gitPath);
    if (target === null) continue;
    try {
      // lstat, not stat: a symlink is never the conflicted regular file we
      // want to read, and following one leaves the worktree.
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.size > MARKER_SCAN_SIZE_LIMIT) continue;
      budget -= stat.size;
      const bytes = readFileSync(target);
      if (bytes.includes(0)) continue;
      if (hasConflictMarkers(bytes.toString("utf8"))) flagged.push(gitPath);
    } catch {
      continue;
    }
  }
  return flagged;
}
