import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  err,
  ok,
  type ConflictBlobPreview,
  type ConflictInspection,
  type ConflictOperation,
  type ConflictOperationKind,
  type ConflictPathKind,
  type ConflictStageInfo,
  type ConflictStagePreview,
  type ConflictState,
  type ConflictedPath,
  type ConflictWorkingTreeInfo,
  type ConflictWorkingTreePreview,
  type Result
} from "@pwrgit/shared";
import {
  NO_OPTIONAL_LOCKS,
  requireExit0,
  type GitExec,
  type GitExecBinary
} from "./dugite";

/** Keep IPC previews useful without handing multi-megabyte generated files to React. */
export const CONFLICT_TEXT_PREVIEW_LIMIT = 256 * 1024;

type StageSlots = {
  base: ConflictStageInfo | null;
  ours: ConflictStageInfo | null;
  theirs: ConflictStageInfo | null;
};

function conflictError(code: string, message: string) {
  return err({ kind: "git" as const, code, message });
}

function classifyStages(stages: StageSlots): ConflictPathKind {
  const base = stages.base !== null;
  const ours = stages.ours !== null;
  const theirs = stages.theirs !== null;
  if (base && ours && theirs) return "both_modified";
  if (!base && ours && theirs) return "both_added";
  if (base && !ours && theirs) return "delete_or_rename_by_ours";
  if (base && ours && !theirs) return "delete_or_rename_by_theirs";
  if (!base && ours && !theirs) return "added_by_ours";
  if (!base && !ours && theirs) return "added_by_theirs";
  return "complex";
}

/** Parse `git ls-files --unmerged -z`, preserving every missing stage as null. */
export function parseUnmergedIndex(stdout: string): Array<
  Omit<ConflictedPath, "workingTree">
> {
  const byPath = new Map<string, StageSlots>();
  for (const record of stdout.split("\0")) {
    if (record === "") continue;
    const match = /^([0-7]{6}) ([0-9a-f]+) ([123])\t([\s\S]+)$/.exec(record);
    if (match === null) continue;
    const [, mode = "", oid = "", stageText = "", path = ""] = match;
    const stage = Number(stageText) as 1 | 2 | 3;
    const slots = byPath.get(path) ?? { base: null, ours: null, theirs: null };
    const info = { stage, oid, mode } satisfies ConflictStageInfo;
    if (stage === 1) slots.base = info;
    else if (stage === 2) slots.ours = info;
    else slots.theirs = info;
    byPath.set(path, slots);
  }
  return [...byPath.entries()].map(([path, stages]) => ({
    path,
    kind: classifyStages(stages),
    ...stages
  }));
}

function filesystemPath(cwd: string, gitPath: string): string {
  return resolve(cwd, ...gitPath.split("/"));
}

function safeFilesystemPath(cwd: string, gitPath: string): Result<string> {
  const target = filesystemPath(cwd, gitPath);
  const rel = relative(resolve(cwd), target);
  const parentPrefix = process.platform === "win32" ? "..\\" : "../";
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(parentPrefix) ||
    isAbsolute(rel)
  ) {
    return err({
      kind: "validation",
      code: "invalid_conflict_path",
      message: "The conflicted path is outside this worktree."
    });
  }
  return ok(target);
}

function workingTreeInfo(
  cwd: string,
  gitPath: string
): ConflictWorkingTreeInfo | null {
  const target = safeFilesystemPath(cwd, gitPath);
  if (!target.ok) return null;
  try {
    const stat = lstatSync(target.value);
    return {
      kind: stat.isFile()
        ? "file"
        : stat.isSymbolicLink()
          ? "symlink"
          : stat.isDirectory()
            ? "directory"
            : "other",
      size: stat.size
    };
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause.code === "ENOENT" || cause.code === "ENOTDIR")
    ) {
      return null;
    }
    throw cause;
  }
}

function readCounter(path: string): number | null {
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function detectOperation(gitDir: string): ConflictOperation | null {
  const rebaseDir = existsSync(join(gitDir, "rebase-merge"))
    ? join(gitDir, "rebase-merge")
    : existsSync(join(gitDir, "rebase-apply"))
      ? join(gitDir, "rebase-apply")
      : null;
  if (rebaseDir !== null) {
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
  if (existsSync(join(gitDir, "MERGE_HEAD"))) {
    return { kind: "merge", label: "Merge" };
  }
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) {
    return { kind: "cherry-pick", label: "Cherry-pick" };
  }
  if (existsSync(join(gitDir, "REVERT_HEAD"))) {
    return { kind: "revert", label: "Revert" };
  }
  return null;
}

async function absoluteGitDir(
  git: GitExec,
  cwd: string
): Promise<Result<string>> {
  const args = ["rev-parse", "--absolute-git-dir"];
  const raw = await git(args, cwd, NO_OPTIONAL_LOCKS);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) return checked;
  const path = checked.value.stdout.trim();
  return path === ""
    ? conflictError(
        "git_dir_missing",
        "Git did not report its worktree state directory."
      )
    : ok(path);
}

/** Read operation markers and all stage-1/2/3 entries from fresh Git state. */
export async function readConflictState(
  git: GitExec,
  cwd: string
): Promise<Result<ConflictState>> {
  const gitDir = await absoluteGitDir(git, cwd);
  if (!gitDir.ok) return gitDir;
  const args = ["ls-files", "--unmerged", "-z"];
  const raw = await git(args, cwd, NO_OPTIONAL_LOCKS);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) return checked;
  try {
    const conflicts = parseUnmergedIndex(checked.value.stdout).map((entry) => ({
      ...entry,
      workingTree: workingTreeInfo(cwd, entry.path)
    }));
    return ok({ operation: detectOperation(gitDir.value), conflicts });
  } catch (cause) {
    return err({
      kind: "repo",
      code: "conflict_state_unreadable",
      message: cause instanceof Error ? cause.message : String(cause),
      cause
    });
  }
}

function contentPreview(bytes: Buffer): ConflictBlobPreview {
  if (bytes.byteLength > CONFLICT_TEXT_PREVIEW_LIMIT) {
    return {
      size: bytes.byteLength,
      content: { kind: "too-large", limit: CONFLICT_TEXT_PREVIEW_LIMIT }
    };
  }
  if (bytes.includes(0)) {
    return { size: bytes.byteLength, content: { kind: "binary" } };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { size: bytes.byteLength, content: { kind: "text", text } };
  } catch {
    return { size: bytes.byteLength, content: { kind: "binary" } };
  }
}

async function inspectStage(
  gitBinary: GitExecBinary,
  cwd: string,
  info: ConflictStageInfo | null
): Promise<Result<ConflictStagePreview | null>> {
  if (info === null) return ok(null);
  const args = ["cat-file", "blob", info.oid];
  const raw = await gitBinary(args, cwd);
  if (!raw.ok) return raw;
  if (raw.value.exitCode !== 0) {
    return conflictError(
      `exit_${raw.value.exitCode}`,
      raw.value.stderr.trim() || `git ${args.join(" ")} failed`
    );
  }
  return ok({ ...info, ...contentPreview(raw.value.stdout) });
}

function inspectWorkingTree(
  cwd: string,
  gitPath: string,
  info: ConflictWorkingTreeInfo | null
): Result<ConflictWorkingTreePreview | null> {
  if (info === null) return ok(null);
  const target = safeFilesystemPath(cwd, gitPath);
  if (!target.ok) return target;
  if (info.kind !== "file") {
    return ok({
      ...info,
      contentHash: "",
      content: {
        kind: "unavailable",
        reason: `The working-copy entry is a ${info.kind}, not a regular file.`
      },
      editable: false
    });
  }
  try {
    const bytes = readFileSync(target.value);
    const preview = contentPreview(bytes);
    return ok({
      ...info,
      ...preview,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      editable: preview.content.kind === "text"
    });
  } catch (cause) {
    return err({
      kind: "repo",
      code: "working_file_unreadable",
      message: cause instanceof Error ? cause.message : String(cause),
      cause
    });
  }
}

/** Lazily inspect only the path the user selected. */
export async function inspectConflict(
  git: GitExec,
  gitBinary: GitExecBinary,
  cwd: string,
  path: string
): Promise<Result<ConflictInspection>> {
  const state = await readConflictState(git, cwd);
  if (!state.ok) return state;
  const conflict = state.value.conflicts.find((entry) => entry.path === path);
  if (conflict === undefined) {
    return conflictError(
      "conflict_stale",
      "This path is no longer conflicted. Refresh before choosing a resolution."
    );
  }
  const [base, ours, theirs] = await Promise.all([
    inspectStage(gitBinary, cwd, conflict.base),
    inspectStage(gitBinary, cwd, conflict.ours),
    inspectStage(gitBinary, cwd, conflict.theirs)
  ]);
  if (!base.ok) return base;
  if (!ours.ok) return ours;
  if (!theirs.ok) return theirs;
  const workingTree = inspectWorkingTree(cwd, path, conflict.workingTree);
  if (!workingTree.ok) return workingTree;
  return ok({
    path,
    kind: conflict.kind,
    base: base.value,
    ours: ours.value,
    theirs: theirs.value,
    workingTree: workingTree.value
  });
}

async function checkedMutation(
  git: GitExec,
  cwd: string,
  args: string[]
): Promise<Result<void>> {
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  return checked.ok ? ok(undefined) : checked;
}

async function currentConflict(
  git: GitExec,
  cwd: string,
  path: string
): Promise<Result<ConflictedPath>> {
  const state = await readConflictState(git, cwd);
  if (!state.ok) return state;
  const conflict = state.value.conflicts.find((entry) => entry.path === path);
  return conflict === undefined
    ? conflictError(
        "conflict_stale",
        "This path is no longer conflicted. Refresh before changing it."
      )
    : ok(conflict);
}

/** Materialize and stage stage 2/3, or stage deletion when that side is absent. */
export async function acceptConflictSide(
  git: GitExec,
  cwd: string,
  input: { path: string; side: "ours" | "theirs"; expectedOid: string | null }
): Promise<Result<void>> {
  const current = await currentConflict(git, cwd, input.path);
  if (!current.ok) return current;
  const selected = current.value[input.side];
  if ((selected?.oid ?? null) !== input.expectedOid) {
    return conflictError(
      "conflict_changed",
      "The selected index side changed since it was inspected. Refresh and review it again."
    );
  }
  if (selected === null) {
    return checkedMutation(git, cwd, [
      "rm",
      "-f",
      "--ignore-unmatch",
      "--",
      input.path
    ]);
  }
  const checkedOut = await checkedMutation(git, cwd, [
    "checkout-index",
    "--force",
    `--stage=${selected.stage}`,
    "--",
    input.path
  ]);
  if (!checkedOut.ok) return checkedOut;
  return checkedMutation(git, cwd, ["add", "-A", "--", input.path]);
}

/** Stage a manual/external resolution, including an intentional deletion. */
export async function stageConflictResolution(
  git: GitExec,
  cwd: string,
  path: string
): Promise<Result<void>> {
  const current = await currentConflict(git, cwd, path);
  if (!current.ok) return current;
  return checkedMutation(git, cwd, ["add", "-A", "--", path]);
}

/** Save regular UTF-8 text only, refusing to clobber a newer external edit. */
export async function writeConflictWorkingFile(
  git: GitExec,
  cwd: string,
  input: { path: string; text: string; expectedContentHash: string }
): Promise<Result<void>> {
  const current = await currentConflict(git, cwd, input.path);
  if (!current.ok) return current;
  if (Buffer.byteLength(input.text, "utf8") > CONFLICT_TEXT_PREVIEW_LIMIT) {
    return err({
      kind: "validation",
      code: "conflict_edit_too_large",
      message:
        "Inline conflict edits are limited to 256 KiB. Open this file externally instead."
    });
  }
  const inspected = inspectWorkingTree(cwd, input.path, current.value.workingTree);
  if (!inspected.ok) return inspected;
  if (inspected.value === null || !inspected.value.editable) {
    return err({
      kind: "validation",
      code: "conflict_not_editable",
      message: "Only an existing regular UTF-8 text file can be edited inline."
    });
  }
  if (inspected.value.contentHash !== input.expectedContentHash) {
    return conflictError(
      "working_file_changed",
      "The working file changed outside PwrGit. Refresh before saving so that edit is not overwritten."
    );
  }
  const target = safeFilesystemPath(cwd, input.path);
  if (!target.ok) return target;
  try {
    writeFileSync(target.value, input.text, "utf8");
    return ok(undefined);
  } catch (cause) {
    return err({
      kind: "repo",
      code: "working_file_write_failed",
      message: cause instanceof Error ? cause.message : String(cause),
      cause
    });
  }
}

/** Validate that a renderer-supplied path is still one of Git's conflicts. */
export async function conflictWorkingPath(
  git: GitExec,
  cwd: string,
  path: string
): Promise<Result<string>> {
  const current = await currentConflict(git, cwd, path);
  if (!current.ok) return current;
  if (current.value.workingTree === null) {
    return conflictError(
      "working_file_missing",
      "This conflict has no working-copy file to open."
    );
  }
  return safeFilesystemPath(cwd, path);
}

const CONTINUE_ARGS: Record<ConflictOperationKind, string[]> = {
  merge: ["merge", "--continue"],
  rebase: ["rebase", "--continue"],
  "cherry-pick": ["cherry-pick", "--continue"],
  revert: ["revert", "--continue"]
};

const ABORT_ARGS: Record<ConflictOperationKind, string[]> = {
  merge: ["merge", "--abort"],
  rebase: ["rebase", "--abort"],
  "cherry-pick": ["cherry-pick", "--abort"],
  revert: ["revert", "--abort"]
};

async function requireOperation(
  git: GitExec,
  cwd: string,
  expected: ConflictOperationKind,
  requireResolved: boolean
): Promise<Result<ConflictState>> {
  const state = await readConflictState(git, cwd);
  if (!state.ok) return state;
  if (state.value.operation?.kind !== expected) {
    return conflictError(
      "operation_changed",
      `The ${expected} is no longer the operation in progress. Refresh before acting.`
    );
  }
  if (requireResolved && state.value.conflicts.length > 0) {
    return conflictError(
      "unresolved_conflicts",
      `${state.value.conflicts.length} conflicted path${state.value.conflicts.length === 1 ? " remains" : "s remain"}. Resolve and stage every path before continuing.`
    );
  }
  return state;
}

/** Run Git's exact continue command, non-interactively, and preserve failure state. */
export async function continueConflictOperation(
  git: GitExec,
  cwd: string,
  operation: ConflictOperationKind,
  identity?: { email: string; name?: string }
): Promise<Result<void>> {
  const current = await requireOperation(git, cwd, operation, true);
  if (!current.ok) return current;
  const args = [
    ...(identity === undefined ? [] : ["-c", `user.email=${identity.email}`]),
    ...(identity?.name === undefined || identity.name === ""
      ? []
      : ["-c", `user.name=${identity.name}`]),
    ...CONTINUE_ARGS[operation]
  ];
  const raw = await git(args, cwd, {
    env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" }
  });
  if (!raw.ok) return raw;
  if (raw.value.exitCode === 0) return ok(undefined);
  return conflictError(
    "continue_failed",
    raw.value.stderr.trim() ||
      raw.value.stdout.trim() ||
      `git ${args.join(" ")} failed`
  );
}

/** Run Git's exact abort command after revalidating the operation marker. */
export async function abortConflictOperation(
  git: GitExec,
  cwd: string,
  operation: ConflictOperationKind
): Promise<Result<void>> {
  const current = await requireOperation(git, cwd, operation, false);
  if (!current.ok) return current;
  return checkedMutation(git, cwd, ABORT_ARGS[operation]);
}
