import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
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

export const FILE_HISTORY_PAGE_DEFAULT = 30;
export const FILE_HISTORY_PAGE_MAX = 100;
export const FILE_BLAME_PAGE_DEFAULT = 200;
export const FILE_BLAME_PAGE_MAX = 400;
export const FILE_BLAME_MAX_BYTES = 1_000_000;

const FILE_HISTORY_FORMAT =
  "%x1e" + ["%H", "%P", "%an", "%ae", "%cI", "%s"].join("%x1f");
const FULL_HASH = /^[0-9a-f]{40,64}$/i;

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

function cursorValue(cursor: string | undefined): Result<number> {
  if (cursor === undefined) return ok(0);
  if (!/^\d+$/.test(cursor)) {
    return validation("invalid_cursor", "The file-history cursor is invalid.");
  }
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return validation("invalid_cursor", "The file-history cursor is invalid.");
  }
  return ok(parsed);
}

function safeWorktreeFile(cwd: string, gitPath: string): Result<string> {
  if (gitPath.trim() === "" || gitPath.includes("\0")) {
    return validation("invalid_path", "A repository-relative file path is required.");
  }
  const absolute = resolve(cwd, gitPath);
  const fromRoot = relative(cwd, absolute);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromRoot)
  ) {
    return validation("invalid_path", "The file path must stay inside the worktree.");
  }
  return ok(absolute);
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

/** Parse the record-separated `git log --follow --name-status` shape. */
export function parseFileHistory(stdout: string): FileHistoryEntry[] {
  const entries: FileHistoryEntry[] = [];
  for (const rawRecord of stdout.split("\x1e")) {
    const record = rawRecord.replace(/^\s*\r?\n/, "").trimEnd();
    if (record === "") continue;
    const [header = "", ...statusLines] = record.split(/\r?\n/);
    const [hash = "", parentsRaw = "", authorName = "", authorEmail = "", committedAt = "", subject = ""] =
      header.split("\x1f");
    if (!FULL_HASH.test(hash)) continue;

    const statusLine = statusLines.find((line) => /^[A-Z][0-9]*\t/.test(line));
    if (statusLine === undefined) continue;
    const [rawStatus = "M", firstPath = "", secondPath] = statusLine.split("\t");
    const status = historyStatus(rawStatus[0]);
    const rename = (status === "R" || status === "C") && secondPath !== undefined;
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
  return entries;
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
  const offset = cursorValue(request.cursor);
  if (!offset.ok) return offset;
  const limit = boundedLimit(
    request.limit,
    FILE_HISTORY_PAGE_DEFAULT,
    FILE_HISTORY_PAGE_MAX
  );
  const revision = context.value.kind === "commit" ? context.value.hash : "HEAD";
  const args = [
    "log",
    "--follow",
    "--find-renames",
    "--no-show-signature",
    `--format=${FILE_HISTORY_FORMAT}`,
    "--name-status",
    `--skip=${offset.value}`,
    `-n${limit + 1}`,
    revision,
    "--",
    request.path
  ];
  const raw = await git(args, cwd, gitOptions(signal));
  if (!raw.ok) return raw;
  if (
    raw.value.exitCode !== 0 &&
    context.value.kind === "workingTree" &&
    /(?:bad revision|does not have any commits yet|unknown revision)/i.test(
      raw.value.stderr
    )
  ) {
    return ok({ entries: [], nextCursor: null });
  }
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) return checked;
  const parsed = parseFileHistory(checked.value.stdout);
  return ok({
    entries: parsed.slice(0, limit),
    nextCursor: parsed.length > limit ? String(offset.value + limit) : null
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
  /** Undefined asks blame to compare HEAD against the working tree. */
  blameRevision?: string;
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
  try {
    const info = await lstat(localPath.value);
    if (!info.isFile()) return ok(null);
    const bytes = info.size;
    const content = bytes <= FILE_BLAME_MAX_BYTES
      ? await readFile(localPath.value, "utf8")
      : "";
    const trackedArgs = ["cat-file", "-e", `HEAD:${path}`];
    const tracked = await git(trackedArgs, cwd, gitOptions(signal));
    if (!tracked.ok) return tracked;
    return ok({
      effectiveContext: { kind: "workingTree" },
      bytes,
      content,
      synthetic: tracked.value.exitCode !== 0
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

  const headArgs = ["rev-parse", "--verify", "HEAD"];
  const head = await git(headArgs, cwd, gitOptions(signal));
  if (!head.ok) return head;
  if (head.value.exitCode !== 0) return ok(null);
  const headHash = head.value.stdout.trim();
  if (!FULL_HASH.test(headHash)) return ok(null);
  const fallback = await gitObjectContent(git, cwd, headHash, path, signal);
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
  const cursor = cursorValue(request.cursor);
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
    "blame",
    "--line-porcelain",
    "-M",
    "-C",
    "-L",
    `${startLine},+${limit + 1}`,
    ...(resolved.blameRevision === undefined ? [] : [resolved.blameRevision]),
    "--",
    request.path
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
