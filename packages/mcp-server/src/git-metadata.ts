import { access, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { git, requireSuccess, type CommandRunner } from "./command.js";
import { summarizeRemotes } from "./remote.js";
import type {
  RemoteSummary,
  RepositoryInfo,
  SafeStatusSummary,
  WorktreeSummary
} from "./types.js";

const MAX_WORKTREES = 64;

export async function readConfiguredRemotes(
  cwd: string,
  runner?: CommandRunner
): Promise<RemoteSummary[]> {
  const result = await git(
    cwd,
    ["config", "--get-regexp", "^remote\\..*\\.url$"],
    runner
  );
  if (result.exitCode === 1) return [];
  const stdout = requireSuccess(result, "reading git remotes");
  const configured: Array<{ name: string; url: string }> = [];
  for (const line of stdout.split("\n")) {
    const match = /^remote\.(.+)\.url\s+(.+)$/.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) continue;
    configured.push({ name: match[1], url: match[2] });
  }
  return summarizeRemotes(configured);
}

export function parsePorcelainStatus(stdout: string): SafeStatusSummary {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let stagedFiles = 0;
  let unstagedFiles = 0;
  let untrackedFiles = 0;
  let conflictedFiles = 0;
  let changedFiles = 0;

  for (const record of stdout.split("\0")) {
    if (record.startsWith("# branch.head ")) {
      const value = record.slice("# branch.head ".length).trim();
      branch = value === "(detached)" ? null : value;
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice("# branch.upstream ".length).trim() || null;
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const counts = /\+(\d+)\s+-(\d+)/.exec(record);
      if (counts !== null) {
        ahead = Number(counts[1]);
        behind = Number(counts[2]);
      }
      continue;
    }
    if (record.startsWith("? ")) {
      untrackedFiles += 1;
      continue;
    }
    if (record.startsWith("u ")) {
      conflictedFiles += 1;
      changedFiles += 1;
      continue;
    }
    if (record.startsWith("1 ") || record.startsWith("2 ")) {
      const xy = record.slice(2, 4);
      if (xy[0] !== ".") stagedFiles += 1;
      if (xy[1] !== ".") unstagedFiles += 1;
      changedFiles += 1;
    }
  }

  return {
    branch,
    upstream,
    ahead,
    behind,
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    conflictedFiles,
    changedFiles,
    clean:
      stagedFiles === 0 &&
      unstagedFiles === 0 &&
      untrackedFiles === 0 &&
      conflictedFiles === 0,
    operation: null
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function currentOperation(
  cwd: string,
  runner?: CommandRunner
): Promise<SafeStatusSummary["operation"]> {
  const names = [
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD"
  ] as const;
  const result = await git(
    cwd,
    ["rev-parse", ...names.flatMap((name) => ["--git-path", name])],
    runner
  );
  if (result.exitCode !== 0) return null;
  const paths = result.stdout
    .trim()
    .split("\n")
    .map((path) => resolve(cwd, path));
  const exists = await Promise.all(paths.map(pathExists));
  if (exists[0] === true || exists[1] === true) return "rebase";
  if (exists[2] === true) return "merge";
  if (exists[3] === true) return "cherry_pick";
  if (exists[4] === true) return "revert";
  return null;
}

export async function readSafeStatus(
  cwd: string,
  runner?: CommandRunner
): Promise<SafeStatusSummary> {
  const result = await git(
    cwd,
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"],
    runner
  );
  const parsed = parsePorcelainStatus(requireSuccess(result, "reading git status"));
  parsed.operation = await currentOperation(cwd, runner);
  return parsed;
}

type ParsedWorktree = Omit<WorktreeSummary, "primary" | "status">;

export function parseWorktreeList(stdout: string): ParsedWorktree[] {
  const rows: ParsedWorktree[] = [];
  let current: Partial<ParsedWorktree> = {};
  const finish = (): void => {
    if (typeof current.path !== "string") {
      current = {};
      return;
    }
    rows.push({
      path: current.path,
      head: current.head ?? null,
      branch: current.branch ?? null,
      detached: current.detached ?? false,
      bare: current.bare ?? false,
      locked: current.locked ?? false,
      prunable: current.prunable ?? false
    });
    current = {};
  };
  for (const field of stdout.split("\0")) {
    if (field === "") {
      finish();
      continue;
    }
    if (field.startsWith("worktree ")) current.path = field.slice(9);
    else if (field.startsWith("HEAD ")) current.head = field.slice(5);
    else if (field.startsWith("branch ")) {
      current.branch = field.slice(7).replace(/^refs\/heads\//, "");
    } else if (field === "detached") current.detached = true;
    else if (field === "bare") current.bare = true;
    else if (field.startsWith("locked")) current.locked = true;
    else if (field.startsWith("prunable")) current.prunable = true;
  }
  finish();
  return rows;
}

async function resolveDefaultBranch(
  cwd: string,
  canonicalRemoteName: string | null,
  runner?: CommandRunner
): Promise<string | null> {
  if (canonicalRemoteName !== null) {
    const remotePrefix = `refs/remotes/${canonicalRemoteName}/`;
    const symbolic = await git(
      cwd,
      ["symbolic-ref", "--quiet", `${remotePrefix}HEAD`],
      runner
    );
    if (symbolic.exitCode === 0) {
      const ref = symbolic.stdout.trim();
      if (ref.startsWith(remotePrefix)) {
        const name = ref.slice(remotePrefix.length);
        if (name !== "") return name;
      }
    }
  }
  for (const candidate of ["main", "master"]) {
    const refs = [
      `refs/heads/${candidate}`,
      ...(canonicalRemoteName === null
        ? []
        : [`refs/remotes/${canonicalRemoteName}/${candidate}`])
    ];
    for (const ref of refs) {
      const result = await git(
        cwd,
        ["show-ref", "--verify", "--quiet", ref],
        runner
      );
      if (result.exitCode === 0) return candidate;
    }
  }
  return null;
}

async function mapLimit<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) output[index] = await mapper(value, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

export async function readRepositoryInfo(
  requestedPath: string,
  runner?: CommandRunner
): Promise<RepositoryInfo> {
  const requested = await realpath(requestedPath);
  const topLevelResult = await git(requested, ["rev-parse", "--show-toplevel"], runner);
  const topLevel = requireSuccess(topLevelResult, "locating repository").trim();
  if (topLevel === "") throw new Error("git returned an empty repository path");

  const [worktreeResult, remotes, status] = await Promise.all([
    git(topLevel, ["worktree", "list", "--porcelain", "-z"], runner),
    readConfiguredRemotes(topLevel, runner),
    readSafeStatus(requested, runner)
  ]);
  const parsedWorktrees = parseWorktreeList(
    requireSuccess(worktreeResult, "listing git worktrees")
  );
  const repositoryPath = parsedWorktrees[0]?.path ?? topLevel;
  const visibleWorktrees = parsedWorktrees.slice(0, MAX_WORKTREES);
  const worktrees = await mapLimit(visibleWorktrees, 4, async (worktree, index) => ({
    ...worktree,
    primary: index === 0,
    status: worktree.bare ? null : await readSafeStatus(worktree.path, runner)
  }));
  const canonicalRemote = remotes.find((remote) => remote.role === "canonical") ?? null;
  const explicitUpstream = remotes.find((remote) => remote.role === "upstream") ?? null;
  const differentUpstream =
    explicitUpstream !== null &&
    canonicalRemote !== null &&
    (explicitUpstream.host !== canonicalRemote.host ||
      explicitUpstream.path.toLowerCase() !== canonicalRemote.path.toLowerCase())
      ? explicitUpstream
      : null;

  return {
    requestedPath: requested,
    repositoryPath,
    currentBranch: status.branch,
    defaultBranch: await resolveDefaultBranch(
      topLevel,
      canonicalRemote?.name ?? null,
      runner
    ),
    canonicalRemote,
    remotes,
    fork: {
      isFork: differentUpstream === null ? null : true,
      upstream:
        differentUpstream === null
          ? null
          : {
              provider: differentUpstream.provider,
              host: differentUpstream.host,
              path: differentUpstream.path
            },
      evidence: differentUpstream === null ? "not_determinable" : "upstream_remote"
    },
    worktreeCount: parsedWorktrees.length,
    worktreesTruncated: parsedWorktrees.length > MAX_WORKTREES,
    worktrees,
    status
  };
}

export async function repositoryRootFor(
  path: string,
  runner?: CommandRunner
): Promise<string | null> {
  const result = await git(path, ["rev-parse", "--show-toplevel"], runner);
  if (result.exitCode !== 0) return null;
  const root = result.stdout.trim();
  return root === "" ? null : root;
}

export function parentOfRepository(repositoryPath: string): string {
  return dirname(repositoryPath);
}
