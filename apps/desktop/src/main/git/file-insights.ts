import { lstat, readFile, readlink } from "node:fs/promises";
import {
  err,
  ok,
  type FileBlameHunk,
  type FileBlamePage,
  type FileHistoryEntry,
  type FileHistoryPage,
  type FileInsightContext,
  type FileStatus,
  type PwrGitError,
  type Result
} from "@pwrgit/shared";
import { NO_OPTIONAL_LOCKS, requireExit0, type GitExec } from "./dugite";
import { insideWorktree } from "./worktree-path";

export const FILE_HISTORY_PAGE_DEFAULT = 30;
export const FILE_HISTORY_PAGE_MAX = 100;
export const FILE_BLAME_PAGE_DEFAULT = 200;
export const FILE_BLAME_PAGE_MAX = 400;
export const FILE_BLAME_MAX_BYTES = 1_000_000;

const FILE_HISTORY_FORMAT =
  "%x1e" +
  ["%H", "%P", "%an", "%ae", "%cI", "%s"].join("%x00") +
  "%x00";
const FULL_HASH = /^[0-9a-f]{40,64}$/i;

type HistoryCursor = {
  version: 1;
  offset: number;
  revision: string;
  lineagePath: string;
  selectedPath: string;
  context: string;
};

function validation(code: string, message: string): Result<never> {
  return err({ kind: "validation", code, message });
}

function boundedLimit(
  requested: number | undefined,
  fallback: number,
  max: number
): number {
  if (!Number.isFinite(requested)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(requested ?? fallback)));
}

function lineCursorValue(cursor: string | undefined): Result<number> {
  if (cursor === undefined) return ok(0);
  if (!/^\d+$/.test(cursor)) {
    return validation("invalid_cursor", "The file-insight cursor is invalid.");
  }
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return validation("invalid_cursor", "The file-history cursor is invalid.");
  }
  return ok(parsed);
}

function historyContextKey(context: FileInsightContext): string {
  return context.kind === "workingTree" ? "workingTree" : context.hash;
}

function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeHistoryCursor(
  value: string,
  selectedPath: string,
  context: FileInsightContext
): Result<HistoryCursor> {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as Partial<HistoryCursor>;
    if (
      parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset ?? -1) < 0 ||
      typeof parsed.revision !== "string" ||
      !FULL_HASH.test(parsed.revision) ||
      typeof parsed.lineagePath !== "string" ||
      typeof parsed.selectedPath !== "string" ||
      parsed.selectedPath !== selectedPath ||
      typeof parsed.context !== "string" ||
      parsed.context !== historyContextKey(context)
    ) {
      throw new Error("invalid cursor fields");
    }
    return ok(parsed as HistoryCursor);
  } catch {
    return validation("invalid_cursor", "The file-history cursor is invalid.");
  }
}

/**
 * Containment, as a Result.
 *
 * The rule itself lives in `worktree-path.ts`, which every main-process channel
 * that turns a renderer-supplied Git path into a real file read shares — its
 * own note says a second implementation would drift, and this module had one.
 * What stays here is the part that is specific to these commands: an empty or
 * NUL-bearing path is a malformed request rather than an escape, and says so.
 */
function safeWorktreeFile(cwd: string, gitPath: string): Result<string> {
  if (gitPath.trim() === "" || gitPath.includes("\0")) {
    return validation("invalid_path", "A repository-relative file path is required.");
  }
  const absolute = insideWorktree(cwd, gitPath);
  return absolute === null
    ? validation("invalid_path", "The file path must stay inside the worktree.")
    : ok(absolute);
}

function checkedContext(context: FileInsightContext): Result<FileInsightContext> {
  if (context.kind === "workingTree") return ok(context);
  const hash = context.hash.trim();
  return FULL_HASH.test(hash)
    ? ok({ kind: "commit", hash: hash.toLowerCase() })
    : validation("invalid_revision", "A full commit hash is required.");
}

function historyStatus(code: string | undefined): FileStatus {
  switch (code) {
    case "A":
    case "D":
    case "R":
    case "C":
    case "U":
      return code;
    default:
      return "M";
  }
}

/** Parse the record- and NUL-separated `git log --follow --name-status -z`
 * shape. NUL separators keep tabs, newlines, and non-ASCII path bytes out of
 * Git's quoted-path representation. */
/**
 * Entries, plus the commits Git actually returned.
 *
 * Paging is gated on `records`, never on `entries.length`: a record this module
 * fails to read is a reason to show less, never a reason to declare the file's
 * history finished and strand every older commit. Both come from one pass so
 * the two can never disagree about what a record is.
 */
export function parseFileHistory(stdout: string): {
  entries: FileHistoryEntry[];
  records: number;
} {
  const entries: FileHistoryEntry[] = [];
  let records = 0;
  for (const rawRecord of stdout.split("\x1e")) {
    const fields = rawRecord.split("\0");
    const [
      hash = "",
      parentsRaw = "",
      authorName = "",
      authorEmail = "",
      committedAt = "",
      subject = ""
    ] = fields;
    if (!FULL_HASH.test(hash)) continue;
    records += 1;

    let statusIndex = 6;
    let rawStatus = "";
    while (statusIndex < fields.length) {
      rawStatus = (fields[statusIndex] ?? "").replace(/^[\r\n]+/, "");
      if (/^[A-Z][0-9]*$/.test(rawStatus)) break;
      statusIndex += 1;
    }
    if (!/^[A-Z][0-9]*$/.test(rawStatus)) continue;
    const status = historyStatus(rawStatus[0]);
    const firstPath = fields[statusIndex + 1] ?? "";
    const secondPath = fields[statusIndex + 2];
    const rename =
      (status === "R" || status === "C") && secondPath !== undefined;
    const path = rename ? secondPath : firstPath;
    if (path === "") continue;

    entries.push({
      hash,
      shortHash: hash.slice(0, 7),
      parents: parentsRaw === "" ? [] : parentsRaw.split(" "),
      authorName,
      authorEmail,
      committedAt,
      subject,
      isMerge: parentsRaw.split(" ").filter(Boolean).length > 1,
      path,
      status,
      ...(rename && firstPath !== "" ? { previousPath: firstPath } : {})
    });
  }
  return { entries, records };
}

type WorkingHeadPath = {
  revision: string | null;
  path: string;
};

/** Resolve a selected working-tree path back to the blob path in HEAD. Status
 * porcelain v2 emits rename paths as NUL-delimited new/old pairs, avoiding the
 * quoting ambiguity that exists in the human-readable status formats. */
async function resolveWorkingHeadPath(
  git: GitExec,
  cwd: string,
  selectedPath: string,
  signal?: AbortSignal
): Promise<Result<WorkingHeadPath>> {
  const headArgs = ["rev-parse", "--verify", "HEAD"];
  const head = await git(headArgs, cwd, gitOptions(signal));
  if (!head.ok) return head;
  if (head.value.exitCode !== 0) {
    return ok({ revision: null, path: selectedPath });
  }
  const revision = head.value.stdout.trim();
  if (!FULL_HASH.test(revision)) {
    return err({
      kind: "git",
      code: "invalid_head",
      message: "Git returned an invalid HEAD revision."
    });
  }

  // Fast path: if the selected path is already in HEAD under this very name,
  // there is no rename to map and the status scan below would be wasted work —
  // and that scan walks the whole worktree, on every history and blame read.
  const trackedArgs = ["cat-file", "-e", `${revision}:${selectedPath}`];
  const tracked = await git(trackedArgs, cwd, gitOptions(signal));
  if (!tracked.ok) return tracked;
  if (tracked.value.exitCode === 0) {
    return ok({ revision, path: selectedPath });
  }

  // A pathspec causes Git to report the destination as an add and omit the
  // source, so inspect tracked changes as a cancellable status read and select
  // only the requested rename pair from its output.
  const statusArgs = [
    "-c",
    "core.quotePath=false",
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=no"
  ];
  const status = await git(statusArgs, cwd, gitOptions(signal));
  if (!status.ok) return status;
  const checked = requireExit0(status.value, statusArgs);
  if (!checked.ok) return checked;
  const records = checked.value.stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (!record.startsWith("2 ")) continue;
    const renamed = record.match(/^2 (?:[^ ]+ ){8}(.*)$/s);
    const currentPath = renamed?.[1] ?? "";
    const previousPath = records[index + 1] ?? "";
    if (currentPath === selectedPath && previousPath !== "") {
      const safePrevious = safeWorktreeFile(cwd, previousPath);
      if (!safePrevious.ok) return safePrevious;
      return ok({ revision, path: previousPath });
    }
    index += 1;
  }
  return ok({ revision, path: selectedPath });
}

function gitOptions(signal?: AbortSignal) {
  return {
    ...NO_OPTIONAL_LOCKS,
    ...(signal === undefined ? {} : { signal })
  };
}

export async function readFileHistory(
  git: GitExec,
  cwd: string,
  request: {
    path: string;
    context: FileInsightContext;
    cursor?: string;
    limit?: number;
  },
  signal?: AbortSignal
): Promise<Result<FileHistoryPage>> {
  const context = checkedContext(request.context);
  if (!context.ok) return context;
  const path = safeWorktreeFile(cwd, request.path);
  if (!path.ok) return path;
  const limit = boundedLimit(
    request.limit,
    FILE_HISTORY_PAGE_DEFAULT,
    FILE_HISTORY_PAGE_MAX
  );
  let cursor: HistoryCursor;
  if (request.cursor !== undefined) {
    const decoded = decodeHistoryCursor(
      request.cursor,
      request.path,
      context.value
    );
    if (!decoded.ok) return decoded;
    // `selectedPath` is pinned to the request, but `lineagePath` is the value
    // actually handed to Git — so it gets the same containment every other path
    // in this module gets, rather than only a typeof check.
    const lineagePath = safeWorktreeFile(cwd, decoded.value.lineagePath);
    if (!lineagePath.ok) return lineagePath;
    cursor = decoded.value;
  } else if (context.value.kind === "commit") {
    cursor = {
      version: 1,
      offset: 0,
      revision: context.value.hash,
      lineagePath: request.path,
      selectedPath: request.path,
      context: context.value.hash
    };
  } else {
    const headPath = await resolveWorkingHeadPath(
      git,
      cwd,
      request.path,
      signal
    );
    if (!headPath.ok) return headPath;
    if (headPath.value.revision === null) {
      return ok({ entries: [], nextCursor: null });
    }
    cursor = {
      version: 1,
      offset: 0,
      revision: headPath.value.revision,
      lineagePath: headPath.value.path,
      selectedPath: request.path,
      context: "workingTree"
    };
  }
  const args = [
    "-c",
    "core.quotePath=false",
    // Paths here are exact files, never patterns. Without this a leading `:`
    // turns the pathspec magic — `:(glob)**` answers with the whole
    // repository's history instead of this file's.
    "--literal-pathspecs",
    "log",
    "--follow",
    "--find-renames",
    "--no-show-signature",
    `--format=${FILE_HISTORY_FORMAT}`,
    "--name-status",
    "-z",
    `--skip=${cursor.offset}`,
    `-n${limit + 1}`,
    cursor.revision,
    "--",
    cursor.lineagePath
  ];
  const raw = await git(args, cwd, gitOptions(signal));
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) return checked;
  const parsed = parseFileHistory(checked.value.stdout);
  // `offset` counts commits Git walked, not rows rendered, so it advances by
  // `limit` even when a record was dropped — the next page resumes where this
  // one stopped either way.
  return ok({
    entries: parsed.entries.slice(0, limit),
    nextCursor:
      parsed.records > limit
        ? encodeHistoryCursor({ ...cursor, offset: cursor.offset + limit })
        : null
  });
}

type BlameLine = Omit<FileBlameHunk, "startLine" | "endLine" | "lines"> & {
  lineNumber: number;
  text: string;
};

/** Parse `git blame --line-porcelain`; line records are intentionally retained
 *  before coalescing so a page can stop at an exact line boundary. */
export function parseBlameLines(stdout: string): BlameLine[] {
  const lines = stdout.split(/\r?\n/);
  const parsed: BlameLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const header = lines[index] ?? "";
    const match = header.match(/^(\^?[0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/i);
    if (match === null) {
      index += 1;
      continue;
    }
    const rawHash = (match[1] ?? "").replace(/^\^/, "");
    const originalStartLine = Number(match[2]);
    const lineNumber = Number(match[3]);
    let authorName = "Unknown author";
    let authorEmail = "";
    let authorTime: number | null = null;
    let subject = "";
    let sourcePath = "";
    let text = "";
    index += 1;
    while (index < lines.length) {
      const line = lines[index] ?? "";
      index += 1;
      if (line.startsWith("\t")) {
        text = line.slice(1);
        break;
      }
      const separator = line.indexOf(" ");
      const key = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? "" : line.slice(separator + 1);
      if (key === "author") authorName = value;
      else if (key === "author-mail") authorEmail = value.replace(/^<|>$/g, "");
      else if (key === "author-time") authorTime = Number(value);
      else if (key === "summary") subject = value;
      else if (key === "filename") sourcePath = value;
    }
    const uncommitted = /^0+$/.test(rawHash);
    parsed.push({
      hash: uncommitted ? null : rawHash,
      shortHash: uncommitted ? null : rawHash.slice(0, 7),
      authorName: uncommitted ? "Uncommitted" : authorName,
      authorEmail: uncommitted ? "" : authorEmail,
      committedAt:
        uncommitted || authorTime === null || !Number.isFinite(authorTime)
          ? null
          : new Date(authorTime * 1000).toISOString(),
      subject: uncommitted ? "Working-tree changes" : subject,
      sourcePath,
      originalStartLine,
      lineNumber,
      text,
      uncommitted
    });
  }
  return parsed;
}

function coalesceBlame(lines: BlameLine[]): FileBlameHunk[] {
  const hunks: FileBlameHunk[] = [];
  for (const line of lines) {
    const current = hunks[hunks.length - 1];
    if (
      current !== undefined &&
      current.hash === line.hash &&
      current.sourcePath === line.sourcePath &&
      current.endLine + 1 === line.lineNumber
    ) {
      current.endLine = line.lineNumber;
      current.lines.push(line.text);
      continue;
    }
    hunks.push({
      hash: line.hash,
      shortHash: line.shortHash,
      authorName: line.authorName,
      authorEmail: line.authorEmail,
      committedAt: line.committedAt,
      subject: line.subject,
      sourcePath: line.sourcePath,
      originalStartLine: line.originalStartLine,
      startLine: line.lineNumber,
      endLine: line.lineNumber,
      lines: [line.text],
      uncommitted: line.uncommitted
    });
  }
  return hunks;
}

type ContentResolution = {
  effectiveContext: FileInsightContext;
  bytes: number;
  content: string;
  /** Revision and historical path whose committed lines Git should attribute. */
  blameRevision?: string;
  blamePath: string;
  /** A regular working-tree file whose bytes should be compared to HEAD. */
  contentsPath?: string;
  synthetic: boolean;
  notice?: string;
};

async function gitObjectContent(
  git: GitExec,
  cwd: string,
  revision: string,
  path: string,
  signal?: AbortSignal
): Promise<Result<ContentResolution | null>> {
  const spec = `${revision}:${path}`;
  const sizeArgs = ["cat-file", "-s", spec];
  const size = await git(sizeArgs, cwd, gitOptions(signal));
  if (!size.ok) return size;
  if (size.value.exitCode !== 0) return ok(null);
  const bytes = Number(size.value.stdout.trim());
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    return err({
      kind: "git",
      code: "invalid_blob_size",
      message: `Git returned an invalid size for ${path}.`
    });
  }
  if (bytes > FILE_BLAME_MAX_BYTES) {
    return ok({
      effectiveContext: { kind: "commit", hash: revision },
      bytes,
      content: "",
      blameRevision: revision,
      blamePath: path,
      synthetic: false
    });
  }
  const showArgs = ["show", spec];
  const shown = await git(showArgs, cwd, gitOptions(signal));
  if (!shown.ok) return shown;
  const checked = requireExit0(shown.value, showArgs);
  if (!checked.ok) return checked;
  return ok({
    effectiveContext: { kind: "commit", hash: revision },
    bytes,
    content: checked.value.stdout,
    blameRevision: revision,
    blamePath: path,
    synthetic: false
  });
}

async function resolveBlameContent(
  git: GitExec,
  cwd: string,
  path: string,
  context: FileInsightContext,
  signal?: AbortSignal
): Promise<Result<ContentResolution | null>> {
  if (context.kind === "commit") {
    const atCommit = await gitObjectContent(git, cwd, context.hash, path, signal);
    if (!atCommit.ok || atCommit.value !== null) return atCommit;
    const parentArgs = ["rev-parse", "--verify", `${context.hash}^`];
    const parent = await git(parentArgs, cwd, gitOptions(signal));
    if (!parent.ok) return parent;
    if (parent.value.exitCode !== 0) return ok(null);
    const parentHash = parent.value.stdout.trim();
    if (!FULL_HASH.test(parentHash)) return ok(null);
    const fallback = await gitObjectContent(git, cwd, parentHash, path, signal);
    if (!fallback.ok || fallback.value === null) return fallback;
    return ok({
      ...fallback.value,
      notice: "This file is deleted in the selected commit. Showing its parent revision."
    });
  }

  const localPath = safeWorktreeFile(cwd, path);
  if (!localPath.ok) return localPath;
  const headPath = await resolveWorkingHeadPath(git, cwd, path, signal);
  if (!headPath.ok) return headPath;
  try {
    const info = await lstat(localPath.value);
    if (!info.isFile() && !info.isSymbolicLink()) return ok(null);
    const content = info.isSymbolicLink()
      ? await readlink(localPath.value)
      : info.size <= FILE_BLAME_MAX_BYTES
        ? await readFile(localPath.value, "utf8")
        : "";
    const bytes = info.isSymbolicLink()
      ? Buffer.byteLength(content)
      : info.size;
    if (headPath.value.revision === null) {
      return ok({
        effectiveContext: { kind: "workingTree" },
        bytes,
        content,
        blamePath: path,
        synthetic: true
      });
    }
    const trackedArgs = [
      "cat-file",
      "-e",
      `${headPath.value.revision}:${headPath.value.path}`
    ];
    const tracked = await git(trackedArgs, cwd, gitOptions(signal));
    if (!tracked.ok) return tracked;
    const isTracked = tracked.value.exitCode === 0;
    let synthetic = !isTracked;
    if (isTracked && info.isSymbolicLink()) {
      const committed = await gitObjectContent(
        git,
        cwd,
        headPath.value.revision,
        headPath.value.path,
        signal
      );
      if (!committed.ok) return committed;
      synthetic =
        committed.value === null || committed.value.content !== content;
    }
    return ok({
      effectiveContext: { kind: "workingTree" },
      bytes,
      content,
      blamePath: headPath.value.path,
      ...(isTracked ? { blameRevision: headPath.value.revision } : {}),
      ...(isTracked && info.isFile() ? { contentsPath: localPath.value } : {}),
      synthetic
    });
  } catch (cause) {
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? String(cause.code)
        : "";
    if (code !== "ENOENT") {
      return err({
        kind: "git",
        code: "file_read_failed",
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }

  if (headPath.value.revision === null) return ok(null);
  const fallback = await gitObjectContent(
    git,
    cwd,
    headPath.value.revision,
    headPath.value.path,
    signal
  );
  if (!fallback.ok || fallback.value === null) return fallback;
  return ok({
    ...fallback.value,
    notice: "This file is deleted in the working tree. Showing its HEAD revision."
  });
}

function unavailablePage(
  path: string,
  resolution: ContentResolution | null,
  reason: "binary" | "too_large" | "missing",
  requestedContext: FileInsightContext = { kind: "workingTree" }
): FileBlamePage {
  return {
    path,
    effectiveContext: resolution?.effectiveContext ?? requestedContext,
    hunks: [],
    nextCursor: null,
    bytes: resolution?.bytes ?? null,
    unavailableReason: reason,
    ...(resolution?.notice === undefined ? {} : { notice: resolution.notice })
  };
}

function contentLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export async function readFileBlame(
  git: GitExec,
  cwd: string,
  request: {
    path: string;
    context: FileInsightContext;
    cursor?: string;
    limit?: number;
  },
  signal?: AbortSignal
): Promise<Result<FileBlamePage, PwrGitError>> {
  const context = checkedContext(request.context);
  if (!context.ok) return context;
  const checkedPath = safeWorktreeFile(cwd, request.path);
  if (!checkedPath.ok) return checkedPath;
  const cursor = lineCursorValue(request.cursor);
  if (!cursor.ok) return cursor;
  const startLine = cursor.value + 1;
  const limit = boundedLimit(
    request.limit,
    FILE_BLAME_PAGE_DEFAULT,
    FILE_BLAME_PAGE_MAX
  );
  const resolution = await resolveBlameContent(
    git,
    cwd,
    request.path,
    context.value,
    signal
  );
  if (!resolution.ok) return resolution;
  if (resolution.value === null) {
    return ok(unavailablePage(request.path, null, "missing", context.value));
  }
  const resolved = resolution.value;
  if (resolved.bytes > FILE_BLAME_MAX_BYTES) {
    return ok(unavailablePage(request.path, resolved, "too_large"));
  }
  if (resolved.content.includes("\0")) {
    return ok(unavailablePage(request.path, resolved, "binary"));
  }
  if (resolved.content === "") {
    return ok({
      path: request.path,
      effectiveContext: resolved.effectiveContext,
      hunks: [],
      nextCursor: null,
      bytes: resolved.bytes,
      ...(resolved.notice === undefined ? {} : { notice: resolved.notice })
    });
  }

  if (resolved.synthetic) {
    const allLines = contentLines(resolved.content);
    const pageLines = allLines.slice(cursor.value, cursor.value + limit);
    const hunk: FileBlameHunk | undefined = pageLines.length === 0
      ? undefined
      : {
          hash: null,
          shortHash: null,
          authorName: "Uncommitted",
          authorEmail: "",
          committedAt: null,
          subject: "Working-tree changes",
          sourcePath: request.path,
          originalStartLine: startLine,
          startLine,
          endLine: startLine + pageLines.length - 1,
          lines: pageLines,
          uncommitted: true
        };
    return ok({
      path: request.path,
      effectiveContext: resolved.effectiveContext,
      hunks: hunk === undefined ? [] : [hunk],
      nextCursor:
        cursor.value + pageLines.length < allLines.length
          ? String(cursor.value + limit)
          : null,
      bytes: resolved.bytes,
      ...(resolved.notice === undefined ? {} : { notice: resolved.notice })
    });
  }

  const args = [
    "-c",
    "core.quotePath=false",
    "--literal-pathspecs",
    "blame",
    "--line-porcelain",
    // -M follows lines moved WITHIN this file. -C is deliberately absent:
    // cross-file copy detection attributed boilerplate — an import line, a
    // closing brace — to whichever unrelated file the same commit touched,
    // and the resulting "from <path>" note was worse than no note at all.
    // Whole-file renames are followed by blame's own history walk regardless.
    "-M",
    "-L",
    `${startLine},+${limit + 1}`,
    ...(resolved.contentsPath === undefined
      ? []
      : ["--contents", resolved.contentsPath]),
    ...(resolved.blameRevision === undefined ? [] : [resolved.blameRevision]),
    "--",
    resolved.blamePath
  ];
  const raw = await git(args, cwd, gitOptions(signal));
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) return checked;
  const parsed = parseBlameLines(checked.value.stdout);
  return ok({
    path: request.path,
    effectiveContext: resolved.effectiveContext,
    hunks: coalesceBlame(parsed.slice(0, limit)),
    nextCursor: parsed.length > limit ? String(cursor.value + limit) : null,
    bytes: resolved.bytes,
    ...(resolved.notice === undefined ? {} : { notice: resolved.notice })
  });
}
