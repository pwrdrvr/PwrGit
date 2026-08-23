import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import {
  err,
  ok,
  type FileStatus,
  type PartialDiffCapability,
  type PartialDiffHunk,
  type PartialFileDiff,
  type PwrGitError,
  type Result
} from "@pwrgit/shared";
import {
  requireExit0,
  type GitExec,
  type GitExecBinary
} from "./dugite";
import { fileDiff, parseChanges } from "./git-service";

const HUNK_HEADER =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/;
const SNAPSHOT_ATTEMPTS = 3;

export type ZeroContextLine = {
  kind: "add" | "delete" | "context";
  text: string;
  oldLine: number | null;
  newLine: number | null;
  noNewline: boolean;
  id: string | null;
};

export type ZeroContextHunk = {
  id: string;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ZeroContextLine[];
};

export type ZeroContextPatch = {
  oldHeader: string | null;
  newHeader: string | null;
  hunks: ZeroContextHunk[];
  binary: boolean;
  gitlink: boolean;
  renamed: boolean;
  modeChanged: boolean;
  unsupported: boolean;
};

type PartialSnapshot = {
  response: PartialFileDiff;
  parsed: ZeroContextPatch;
};

const fingerprintFor = (
  path: string,
  staged: boolean,
  status: string,
  patch: Uint8Array
): string =>
  createHash("sha256")
    .update(staged ? "staged\0" : "unstaged\0")
    .update(path)
    .update("\0")
    .update(status)
    .update("\0")
    .update(patch)
    .digest("base64url");

/** Parse Git's single-file `--unified=0` output without interpreting paths.
 * Raw `---` / `+++` headers are retained verbatim so quoted, non-ASCII, and
 * whitespace-bearing paths go back to Git exactly as Git wrote them. */
export function parseZeroContextDiff(patch: string): ZeroContextPatch {
  const parsed: ZeroContextPatch = {
    oldHeader: null,
    newHeader: null,
    hunks: [],
    binary: false,
    gitlink: false,
    renamed: false,
    modeChanged: false,
    unsupported: false
  };
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  let hunk: ZeroContextHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      const oldStart = Number(header[1]);
      const newStart = Number(header[3]);
      hunk = {
        id: `h:${parsed.hunks.length}:${oldStart}:${newStart}`,
        header: line,
        oldStart,
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart,
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: []
      };
      parsed.hunks.push(hunk);
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }

    // Parse a hunk body before looking for file headers: a deleted source line
    // beginning with "-- " is itself serialized as "--- ", and likewise an
    // added line beginning with "++ ". Prefix-looking content must stay data.
    if (hunk !== null) {
      if (line === "\\ No newline at end of file") {
        const previous = hunk.lines.at(-1);
        if (previous === undefined) parsed.unsupported = true;
        else previous.noNewline = true;
        continue;
      }
      if (line.startsWith("-")) {
        const id = `${hunk.id}:d:${oldLine}`;
        hunk.lines.push({
          kind: "delete",
          text: line.slice(1),
          oldLine,
          newLine: null,
          noNewline: false,
          id
        });
        oldLine += 1;
        continue;
      }
      if (line.startsWith("+")) {
        const id = `${hunk.id}:a:${newLine}`;
        hunk.lines.push({
          kind: "add",
          text: line.slice(1),
          oldLine: null,
          newLine,
          noNewline: false,
          id
        });
        newLine += 1;
        continue;
      }
      if (line.startsWith(" ")) {
        hunk.lines.push({
          kind: "context",
          text: line.slice(1),
          oldLine,
          newLine,
          noNewline: false,
          id: null
        });
        oldLine += 1;
        newLine += 1;
        continue;
      }
      if (line === "") continue;
      parsed.unsupported = true;
      hunk = null;
    }

    if (
      line.startsWith("Binary files ") ||
      line === "GIT binary patch" ||
      line.startsWith("literal ") ||
      line.startsWith("delta ")
    ) {
      parsed.binary = true;
    }
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      parsed.renamed = true;
    }
    if (
      line.startsWith("old mode ") ||
      line.startsWith("new mode ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ")
    ) {
      parsed.modeChanged = true;
    }
    if (
      /^index \S+\.\.\S+ 160000$/.test(line) ||
      line === "old mode 160000" ||
      line === "new mode 160000"
    ) {
      parsed.gitlink = true;
    }
    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      parsed.unsupported = true;
    }

    if (line.startsWith("--- ")) {
      parsed.oldHeader = line.slice(4);
      hunk = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      parsed.newHeader = line.slice(4);
      hunk = null;
      continue;
    }

    // A zero-context hunk consists solely of unified-diff body lines and the
    // no-newline marker. Anything else is safer as a whole-file operation.
  }

  for (const candidate of parsed.hunks) {
    const oldCount = candidate.lines.filter(
      (line) => line.kind !== "add"
    ).length;
    const newCount = candidate.lines.filter(
      (line) => line.kind !== "delete"
    ).length;
    if (oldCount !== candidate.oldCount || newCount !== candidate.newCount) {
      parsed.unsupported = true;
    }
  }
  return parsed;
}

function publicHunks(parsed: ZeroContextPatch): PartialDiffHunk[] {
  return parsed.hunks.map((hunk) => ({
    id: hunk.id,
    header: hunk.header,
    lineSelection: !hunk.lines.some((line) => line.noNewline),
    lines: hunk.lines.flatMap((line) =>
      line.kind === "context" || line.id === null
        ? []
        : [
            {
              id: line.id,
              kind: line.kind,
              oldLine: line.oldLine,
              newLine: line.newLine,
              text: line.text
            }
          ]
    )
  }));
}

export function partialDiffCapability(
  parsed: ZeroContextPatch,
  statuses: FileStatus[],
  utf8Valid: boolean
): PartialDiffCapability {
  if (statuses.includes("U")) {
    return {
      available: false,
      reason: "conflicted",
      message: "Resolve this conflict before staging individual hunks."
    };
  }
  if (statuses.includes("R") || statuses.includes("C") || parsed.renamed) {
    return {
      available: false,
      reason: "renamed_file",
      message: "Stage or unstage renamed files as a whole to preserve the rename."
    };
  }
  if (
    statuses.includes("?") ||
    statuses.includes("A") ||
    parsed.oldHeader === "/dev/null"
  ) {
    return {
      available: false,
      reason: "new_file",
      message: "New files can only be staged or unstaged as a whole file."
    };
  }
  if (statuses.includes("D") || parsed.newHeader === "/dev/null") {
    return {
      available: false,
      reason: "deleted_file",
      message: "Deleted files can only be staged or unstaged as a whole file."
    };
  }
  if (parsed.binary) {
    return {
      available: false,
      reason: "binary",
      message: "Binary changes can only be staged as a whole file."
    };
  }
  if (parsed.gitlink) {
    return {
      available: false,
      reason: "gitlink",
      message: "Submodule pointers can only be staged as a whole entry."
    };
  }
  if (!utf8Valid) {
    return {
      available: false,
      reason: "non_utf8",
      message: "Non-UTF-8 text can only be staged as a whole file to preserve its exact bytes."
    };
  }
  if (parsed.unsupported) {
    return {
      available: false,
      reason: "unsupported_patch",
      message: "Git produced a patch shape that is not safe to split."
    };
  }
  if (parsed.hunks.length === 0) {
    return parsed.modeChanged
      ? {
          available: false,
          reason: "mode_only",
          message: "File-mode changes can only be staged as a whole file."
        }
      : {
          available: false,
          reason: "no_changes",
          message: "There are no textual hunks to select."
        };
  }
  if (parsed.oldHeader === null || parsed.newHeader === null) {
    return {
      available: false,
      reason: "unsupported_patch",
      message: "Git produced a patch shape that is not safe to split."
    };
  }
  return { available: true };
}

async function checkedStdout(
  git: GitExec,
  cwd: string,
  args: string[]
): Promise<Result<string>> {
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  return checked.ok ? ok(checked.value.stdout) : checked;
}

async function checkedBinaryStdout(
  git: GitExecBinary,
  cwd: string,
  args: string[]
): Promise<Result<Buffer>> {
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  if (raw.value.exitCode !== 0) {
    return err({
      kind: "git",
      code: `exit_${raw.value.exitCode}`,
      message:
        raw.value.stderr.trim() !== ""
          ? raw.value.stderr.trim()
          : `git ${args.join(" ")} exited ${raw.value.exitCode}`
    });
  }
  return ok(raw.value.stdout);
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function decodePatch(buffer: Buffer): { text: string; valid: boolean } {
  try {
    return { text: UTF8_DECODER.decode(buffer), valid: true };
  } catch {
    // The display may retain replacement glyphs, but partialDiffCapability refuses to
    // expose IDs from this lossy representation. Whole-file Git actions keep
    // operating on the original bytes.
    return { text: buffer.toString("utf8"), valid: false };
  }
}

const diffArgs = (
  path: string,
  staged: boolean,
  context: number
): string[] => [
  "diff",
  ...(staged ? ["--cached"] : []),
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--binary",
  "--full-index",
  "--find-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  `--unified=${context}`,
  "--",
  path
];

const statusArgs = (): string[] => [
  "status",
  "--porcelain=v2",
  "--untracked-files=all"
];

/** Read a consistent display/selection snapshot. A tool writing the same file
 * while the snapshot reads run either settles within the bounded retry or is
 * reported instead of returning line IDs from a torn view. */
async function readSnapshot(
  git: GitExec,
  gitBinary: GitExecBinary,
  cwd: string,
  path: string,
  staged: boolean
): Promise<Result<PartialSnapshot>> {
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await checkedBinaryStdout(
      gitBinary,
      cwd,
      diffArgs(path, staged, 0)
    );
    if (!before.ok) return before;
    const display = await checkedBinaryStdout(
      gitBinary,
      cwd,
      diffArgs(path, staged, 3)
    );
    if (!display.ok) return display;
    const status = await checkedStdout(git, cwd, statusArgs());
    if (!status.ok) return status;
    const after = await checkedBinaryStdout(
      gitBinary,
      cwd,
      diffArgs(path, staged, 0)
    );
    if (!after.ok) return after;
    if (!before.value.equals(after.value)) continue;

    const selectionPatch = decodePatch(after.value);
    const displayPatch = decodePatch(display.value);
    const parsed = parseZeroContextDiff(selectionPatch.text);
    const changes = parseChanges(status.value);
    const statuses = [
      ...changes.staged.filter((file) => file.path === path),
      ...changes.unstaged.filter((file) => file.path === path)
    ].map((file) => file.status);
    // Status is read repo-wide so a path-limited query cannot disguise the
    // destination of a rename as a brand-new file. Only this path's decoded
    // statuses enter the token; an edit to an unrelated file should not stale
    // a diff the user is already reviewing.
    const fingerprint = fingerprintFor(
      path,
      staged,
      statuses.join(","),
      after.value
    );
    let patch = displayPatch.text;
    if (!staged && patch === "" && statuses.includes("?")) {
      const untracked = await fileDiff(git, cwd, path, false);
      if (!untracked.ok) return untracked;
      patch = untracked.value;
    }
    return ok({
      parsed,
      response: {
        path,
        staged,
        patch,
        fingerprint,
        capability: partialDiffCapability(
          parsed,
          statuses,
          selectionPatch.valid && displayPatch.valid
        ),
        hunks: publicHunks(parsed)
      }
    });
  }
  return err({
    kind: "git",
    code: "concurrent_edit",
    message: "The file kept changing while PwrGit read its diff. Try again once the writer is finished."
  });
}

export async function partialFileDiff(
  git: GitExec,
  gitBinary: GitExecBinary,
  cwd: string,
  path: string,
  staged: boolean
): Promise<Result<PartialFileDiff>> {
  const snapshot = await readSnapshot(git, gitBinary, cwd, path, staged);
  return snapshot.ok ? ok(snapshot.value.response) : snapshot;
}

function appendLine(
  out: string[],
  prefix: " " | "+" | "-",
  line: ZeroContextLine
): void {
  out.push(`${prefix}${line.text}`);
  if (line.noNewline) out.push("\\ No newline at end of file");
}

const changedLines = (hunk: ZeroContextHunk): ZeroContextLine[] =>
  hunk.lines.filter((line) => line.kind !== "context");

/** Build a minimal patch from trusted IDs in one exact zero-context snapshot.
 * For unstaging, the patch describes residual-index -> current-index and is
 * applied with `--reverse`; this keeps replacement ordering and no-newline
 * markers native to Git instead of trying to invent a reverse edit script. */
export function buildSelectedPatch(
  parsed: ZeroContextPatch,
  staged: boolean,
  selectedIds: ReadonlySet<string>
): Result<{ patch: string; reverse: boolean }, PwrGitError> {
  const currentHeader = staged ? parsed.newHeader : parsed.oldHeader;
  if (currentHeader === null || currentHeader === "/dev/null") {
    return err({
      kind: "validation",
      code: "partial_unavailable",
      message: "This file cannot be changed a hunk at a time."
    });
  }

  const out = [`--- ${currentHeader}`, `+++ ${currentHeader}`];
  let selectedCount = 0;
  let priorDelta = 0;

  for (const hunk of parsed.hunks) {
    const changes = changedLines(hunk);
    const selected = changes.filter(
      (line) => line.id !== null && selectedIds.has(line.id)
    );
    if (selected.length === 0) continue;
    selectedCount += selected.length;

    // A no-newline marker describes the file boundary, not an independent
    // line. Splitting that hunk could claim a middle line ends the file.
    if (
      changes.some((line) => line.noNewline) &&
      selected.length !== changes.length
    ) {
      return err({
        kind: "validation",
        code: "atomic_no_newline_hunk",
        message: "The final hunk must be staged or unstaged as one unit because the file has no trailing newline."
      });
    }

    const body: string[] = [];
    let sourceCount = 0;
    let targetCount = 0;
    let selectedAdds = 0;
    let selectedDeletes = 0;

    for (const line of hunk.lines) {
      const chosen = line.id !== null && selectedIds.has(line.id);
      if (!staged) {
        // Real index (old) -> selected result.
        if (line.kind === "delete") {
          appendLine(body, chosen ? "-" : " ", line);
          sourceCount += 1;
          if (chosen) selectedDeletes += 1;
          else targetCount += 1;
        } else if (line.kind === "add") {
          if (chosen) {
            appendLine(body, "+", line);
            targetCount += 1;
            selectedAdds += 1;
          }
        } else {
          appendLine(body, " ", line);
          sourceCount += 1;
          targetCount += 1;
        }
      } else {
        // Residual index -> current index; Git applies this patch in reverse.
        if (line.kind === "delete") {
          if (chosen) {
            appendLine(body, "-", line);
            sourceCount += 1;
            selectedDeletes += 1;
          }
        } else if (line.kind === "add") {
          appendLine(body, chosen ? "+" : " ", line);
          targetCount += 1;
          if (chosen) selectedAdds += 1;
          else sourceCount += 1;
        } else {
          appendLine(body, " ", line);
          sourceCount += 1;
          targetCount += 1;
        }
      }
    }

    const delta = staged
      ? selectedDeletes - selectedAdds
      : selectedAdds - selectedDeletes;
    // A zero-count range names the line *before* an insertion/deletion while a
    // non-empty range names its first line. Convert through that boundary so
    // pure additions at BOF or after a line do not drift by one.
    const sourceStart = staged
      ? (hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1) +
        priorDelta +
        (sourceCount > 0 ? 1 : 0)
      : hunk.oldStart;
    const targetStart = staged
      ? hunk.newStart
      : (hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1) +
        priorDelta +
        (targetCount > 0 ? 1 : 0);
    out.push(
      `@@ -${sourceStart},${sourceCount} +${targetStart},${targetCount} @@`,
      ...body
    );
    priorDelta += delta;
  }

  if (selectedCount === 0) {
    return err({
      kind: "validation",
      code: "empty_selection",
      message: "Select at least one changed line."
    });
  }
  return ok({ patch: `${out.join("\n")}\n`, reverse: staged });
}

export async function applyPartialSelection(
  git: GitExec,
  gitBinary: GitExecBinary,
  cwd: string,
  path: string,
  staged: boolean,
  expectedFingerprint: string,
  lineIds: string[],
  options: {
    removeTemp?: (path: string) => void;
  } = {}
): Promise<Result<void>> {
  if (lineIds.length === 0) {
    return err({
      kind: "validation",
      code: "empty_selection",
      message: "Select at least one changed line."
    });
  }
  const snapshot = await readSnapshot(git, gitBinary, cwd, path, staged);
  if (!snapshot.ok) return snapshot;
  if (snapshot.value.response.fingerprint !== expectedFingerprint) {
    return err({
      kind: "validation",
      code: "stale_diff",
      message: "This diff changed since it was opened. Review the refreshed lines before trying again."
    });
  }
  if (!snapshot.value.response.capability.available) {
    return err({
      kind: "validation",
      code: "partial_unavailable",
      message: snapshot.value.response.capability.message
    });
  }

  const known = new Set(
    snapshot.value.response.hunks.flatMap((hunk) =>
      hunk.lines.map((line) => line.id)
    )
  );
  const selected = new Set(lineIds);
  if (selected.size !== lineIds.length || lineIds.some((id) => !known.has(id))) {
    return err({
      kind: "validation",
      code: "invalid_selection",
      message: "The selected lines do not belong to this diff snapshot."
    });
  }

  const built = buildSelectedPatch(snapshot.value.parsed, staged, selected);
  if (!built.ok) return built;

  const temp = mkdtempSync(join(tmpdir(), "pwrgit-partial-stage-"));
  const patchPath = join(temp, "selection.patch");
  try {
    writeFileSync(patchPath, built.value.patch, {
      encoding: "utf8",
      mode: 0o600
    });
    const common = [
      "apply",
      "--cached",
      "--unidiff-zero",
      "--recount",
      "--whitespace=nowarn",
      "-p1",
      ...(built.value.reverse ? ["--reverse"] : [])
    ];
    const checked = await git([...common, "--check", patchPath], cwd);
    if (!checked.ok) return checked;
    const checkExit = requireExit0(checked.value, [...common, "--check"]);
    if (!checkExit.ok) {
      return err({
        kind: "validation",
        code: "stale_diff",
        message: "The index changed before this selection could be applied. Refresh the diff and try again.",
        cause: checkExit.error.message
      });
    }
    const applied = await git([...common, patchPath], cwd);
    if (!applied.ok) return applied;
    const applyExit = requireExit0(applied.value, common);
    if (!applyExit.ok) {
      return err({
        kind: "validation",
        code: "stale_diff",
        message: "The index changed before this selection could be applied. Refresh the diff and try again.",
        cause: applyExit.error.message
      });
    }
    return ok(undefined);
  } finally {
    try {
      if (options.removeTemp !== undefined) options.removeTemp(temp);
      else rmSync(temp, { recursive: true, force: true });
    } catch {
      // The patch file is ephemeral. In particular, Windows scanners can hold
      // it briefly after Git exits; cleanup failure must never turn a completed
      // atomic index update into a reported command failure.
    }
  }
}
