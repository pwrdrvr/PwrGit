import { access, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { git, requireSuccess, type CommandRunner } from "./command.js";
import { summarizeRemotes } from "./remote.js";
import type {
  RemoteSummary,
  RepositoryInfo,
  SafeStatusSummary,
  WorktreeAggregate,
  WorktreeSummary
} from "./types.js";

const MAX_WORKTREES = 64;
/** Most repositories have one worktree. A caller that wants the long tail
 * asks for it; a caller that does not should not pay for 50+ rows. */
const DEFAULT_RETURNED_WORKTREES = 10;

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

/** Whether a worktree's checkout is still there. Git's own test for a
 * `prunable` entry is the `.git` link inside the worktree, so a folder whose
 * link is gone — an interrupted or in-flight removal — is as gone as a
 * deleted folder. The desktop app's `checkoutExists` asks the same question. */
function checkoutExists(worktreePath: string): Promise<boolean> {
  return pathExists(join(worktreePath, ".git"));
}

/** A sibling worktree's status, or null when its checkout is gone. Git in a
 * gone checkout either fails ("cannot change to", "not a git repository") or,
 * for a folder nested inside another repository, quietly answers for that one.
 * The `prunable` flag cannot stand in for this check: git never reports a
 * locked worktree prunable, even when its folder has disappeared. */
async function readWorktreeStatus(
  worktreePath: string,
  runner?: CommandRunner
): Promise<SafeStatusSummary | null> {
  if (!(await checkoutExists(worktreePath))) return null;
  try {
    return await readSafeStatus(worktreePath, runner);
  } catch (error) {
    // Removed between the check and the read: the same answer as above.
    if (!(await checkoutExists(worktreePath))) return null;
    throw error;
  }
}

type ParsedWorktree = Omit<WorktreeSummary, "primary" | "missing" | "status">;

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

/** At most `limit` reads in flight. After a failure no new read starts, and
 * the rejection waits for the reads already running: a failed call must not
 * return while git still works in a checkout its caller may remove next —
 * Windows refuses to remove a directory a process is working in. */
async function mapLimit<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value === undefined) continue;
      try {
        output[index] = await mapper(value, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, values.length) }, worker);
  await Promise.allSettled(workers);
  await Promise.all(workers);
  return output;
}

/** A worktree that needs attention sorts ahead of a quiet one, so a truncated
 * list still carries the interesting rows. The primary worktree always leads:
 * it is the one a caller asked about. */
function attentionRank(worktree: {
  primary: boolean;
  locked: boolean;
  prunable: boolean;
  missing: boolean;
  status: SafeStatusSummary | null;
}): number {
  if (worktree.primary) return 0;
  const status = worktree.status;
  if (status !== null && status.conflictedFiles > 0) return 1;
  if (status !== null && status.operation !== null) return 2;
  if (worktree.prunable || worktree.missing) return 3;
  if (status !== null && !status.clean) return 4;
  if (status !== null && (status.ahead > 0 || status.behind > 0)) return 5;
  if (worktree.locked) return 6;
  return 7;
}

function aggregateWorktrees(
  worktrees: readonly {
    detached: boolean;
    locked: boolean;
    prunable: boolean;
    missing: boolean;
    status: SafeStatusSummary | null;
  }[]
): WorktreeAggregate {
  const aggregate: WorktreeAggregate = {
    inspected: worktrees.length,
    clean: 0,
    dirty: 0,
    conflicted: 0,
    detached: 0,
    locked: 0,
    prunable: 0,
    missing: 0,
    withOperation: 0,
    ahead: 0,
    behind: 0
  };
  for (const worktree of worktrees) {
    if (worktree.detached) aggregate.detached += 1;
    if (worktree.locked) aggregate.locked += 1;
    if (worktree.prunable) aggregate.prunable += 1;
    if (worktree.missing) aggregate.missing += 1;
    const status = worktree.status;
    if (status === null) continue;
    if (status.clean) aggregate.clean += 1;
    else aggregate.dirty += 1;
    if (status.conflictedFiles > 0) aggregate.conflicted += 1;
    if (status.operation !== null) aggregate.withOperation += 1;
    if (status.ahead > 0) aggregate.ahead += 1;
    if (status.behind > 0) aggregate.behind += 1;
  }
  return aggregate;
}

export async function readRepositoryInfo(
  requestedPath: string,
  runner?: CommandRunner,
  options: { maxWorktrees?: number } = {}
): Promise<RepositoryInfo> {
  const requested = await realpath(requestedPath);
  const topLevelResult = await git(requested, ["rev-parse", "--show-toplevel"], runner);
  const topLevel = requireSuccess(topLevelResult, "locating repository").trim();
  if (topLevel === "") throw new Error("git returned an empty repository path");

  const reads = [
    git(topLevel, ["worktree", "list", "--porcelain", "-z"], runner),
    readConfiguredRemotes(topLevel, runner),
    readSafeStatus(requested, runner)
  ] as const;
  // Settle every read before surfacing a failure, as `mapLimit` does.
  await Promise.allSettled(reads);
  const [worktreeResult, remotes, status] = await Promise.all(reads);
  const parsedWorktrees = parseWorktreeList(
    requireSuccess(worktreeResult, "listing git worktrees")
  );
  const canonicalWorktrees = await mapLimit(
    parsedWorktrees,
    8,
    async (worktree) => ({
      ...worktree,
      path: await realpath(worktree.path).catch(() => worktree.path)
    })
  );
  const repositoryPath = canonicalWorktrees[0]?.path ?? (await realpath(topLevel));
  const visibleWorktrees = canonicalWorktrees.slice(0, MAX_WORKTREES);
  // Status is read for every inspected worktree so the aggregate is accurate
  // and the attention ranking below can see which rows matter. Only the
  // returned slice is bounded — the payload is what costs the caller, not
  // the reads. A sibling whose checkout is gone is reported as missing: one
  // stale registration must not fail the call for every other worktree.
  const inspectedWorktrees = await mapLimit(visibleWorktrees, 4, async (worktree, index) => {
    const status = worktree.bare ? null : await readWorktreeStatus(worktree.path, runner);
    return {
      ...worktree,
      primary: index === 0,
      missing: !worktree.bare && status === null,
      status
    };
  });
  const worktreeSummary = aggregateWorktrees(inspectedWorktrees);
  const maxWorktrees = Math.min(
    Math.max(options.maxWorktrees ?? DEFAULT_RETURNED_WORKTREES, 1),
    MAX_WORKTREES
  );
  const worktrees = [...inspectedWorktrees]
    .map((worktree, index) => ({ worktree, index }))
    .sort(
      (left, right) =>
        attentionRank(left.worktree) - attentionRank(right.worktree)
        || left.index - right.index
    )
    .slice(0, maxWorktrees)
    .map((entry) => entry.worktree);
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
    worktreesTruncated: worktrees.length < parsedWorktrees.length,
    worktreesReturned: worktrees.length,
    worktreeSummary,
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
  return root === "" ? null : realpath(root).catch(() => root);
}

export function parentOfRepository(repositoryPath: string): string {
  return dirname(repositoryPath);
}
