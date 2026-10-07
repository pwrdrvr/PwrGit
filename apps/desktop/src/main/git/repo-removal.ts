import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
  err,
  ok,
  removalStatus,
  type RemovalCheckout,
  type RemovalDecisions,
  type RemovalInProgress,
  type RemovalStep,
  type RepoRemovalResult,
  type RepoRemovalReview,
  type Result
} from "@pwrgit/shared";
import type { DB } from "../persistence/db";
import { directorySize, type DirSizeResult } from "../util/dir-size";
import { mapLimit } from "../util/map-limit";
import { NO_OPTIONAL_LOCKS, requireExit0, type GitExec } from "./dugite";
import { listWorktrees, worktreeRemove, type WorktreeInfo } from "./git-service";
import { hashId } from "./repo-indexer";
import { listStashes } from "./stash-service";
import { checkoutExists } from "./worktree-liveness";

/** Checkouts inspected at once — the pruner's budget (PRUNE_SCAN_CONCURRENCY). */
export const REMOVAL_INSPECT_CONCURRENCY = 4;
/** A size is context on the review, not a gate, so the walk stops early and
 *  reports a floor rather than holding the dialog on a huge node_modules. */
export const REMOVAL_SIZE_ENTRY_CAP = 100_000;
/** Local branches whose unpushed commits are counted one by one. Past this
 *  the rest are still listed, as at risk, with the count left at 1+. */
export const REMOVAL_BRANCH_COUNT_CAP = 40;

export type RemovalReviewDeps = {
  db: DB;
  git: GitExec;
  measure?: (path: string) => Promise<DirSizeResult>;
};

type RepoRow = { id: string; profile_id: string; name: string; path: string };

const run = async (
  git: GitExec,
  args: string[],
  cwd: string
): Promise<Result<string>> => {
  // Every call goes through `git -C` (gitProcessInvocation): a process cwd
  // inside a checkout about to be moved is what makes Windows refuse the move.
  const raw = await git(args, cwd, NO_OPTIONAL_LOCKS);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  return checked.ok ? ok(checked.value.stdout) : checked;
};

const lines = (stdout: string): string[] =>
  stdout.split(/\r?\n/).filter((line) => line !== "");

/** `git status --porcelain=v2 --branch`, counted the way the review needs. */
export function parseRemovalStatus(stdout: string): {
  head: string;
  branch: string;
  upstream: string | null;
  uncommitted: number;
  untracked: number;
  conflicted: number;
} {
  let head = "";
  let branch = "";
  let upstream: string | null = null;
  let uncommitted = 0;
  let untracked = 0;
  let conflicted = 0;
  for (const line of lines(stdout)) {
    if (line.startsWith("# branch.oid ")) head = line.slice(13).trim();
    else if (line.startsWith("# branch.head ")) {
      const name = line.slice(14).trim();
      branch = name === "(detached)" ? "" : name;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice(18).trim();
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) uncommitted += 1;
    else if (line.startsWith("u ")) conflicted += 1;
    else if (line.startsWith("? ")) untracked += 1;
  }
  return { head, branch, upstream, uncommitted, untracked, conflicted };
}

const IN_PROGRESS_PATHS: [string, RemovalInProgress][] = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"]
];

async function inProgressOperation(
  git: GitExec,
  checkoutPath: string
): Promise<Result<RemovalInProgress | null>> {
  // One spawn for all six: `--git-path` resolves each name inside this
  // checkout's own admin directory, which for a linked worktree is not
  // `<path>/.git/…`. Relative answers are relative to the `-C` directory.
  const args = ["rev-parse", ...IN_PROGRESS_PATHS.flatMap(([name]) => ["--git-path", name])];
  const out = await run(git, args, checkoutPath);
  if (!out.ok) return out;
  const paths = lines(out.value);
  for (const [index, [, kind]] of IN_PROGRESS_PATHS.entries()) {
    const raw = paths[index];
    if (raw === undefined) continue;
    const resolved = isAbsolute(raw) ? raw : join(checkoutPath, raw);
    if (existsSync(resolved)) return ok(kind);
  }
  return ok(null);
}

type BranchInfo = { remote: string | null; upstream: string | null };

/** Where Push first goes: the branch's upstream remote, else `origin`, else
 *  the only remote there is. */
function pushRemoteFor(
  branch: string,
  branches: Map<string, BranchInfo>,
  remotes: string[]
): string | null {
  if (branch === "") return null;
  const tracked = branches.get(branch)?.remote ?? null;
  if (tracked !== null && remotes.includes(tracked)) return tracked;
  if (remotes.includes("origin")) return "origin";
  return remotes.length === 1 ? (remotes[0] ?? null) : null;
}

async function inspectCheckout(
  git: GitExec,
  measure: (path: string) => Promise<DirSizeResult>,
  info: WorktreeInfo,
  isPrimary: boolean,
  branches: Map<string, BranchInfo>,
  remotes: string[]
): Promise<RemovalCheckout> {
  const base: RemovalCheckout = {
    worktreeId: hashId(info.path),
    branch: info.detached ? "" : info.branch,
    head: info.head,
    path: info.path,
    isPrimary,
    missing: false,
    locked: info.locked,
    uncommitted: 0,
    untracked: 0,
    conflicted: 0,
    unpushed: 0,
    upstream: null,
    inProgress: null,
    pushRemote: null,
    bytes: null,
    bytesPartial: false,
    inspectError: null
  };
  // Git's `prunable` is its own `.git`-link test; it never says so for a
  // locked worktree, so stat those (repo-indexer.ts makes the same call).
  if (info.prunable || (!isPrimary && !checkoutExists(info.path))) {
    return { ...base, missing: true };
  }
  const status = await run(
    git,
    ["status", "--porcelain=v2", "--branch", "--untracked-files=all"],
    info.path
  );
  if (!status.ok) {
    return { ...base, inspectError: status.error.message };
  }
  const parsed = parseRemovalStatus(status.value);
  const operation = await inProgressOperation(git, info.path);
  let unpushed = 0;
  if (/^[0-9a-f]{7,}$/i.test(parsed.head)) {
    // Reachable from HEAD and from no remote-tracking ref. One question for a
    // branch with no upstream, one ahead of its upstream, and a detached HEAD.
    const counted = await run(
      git,
      ["rev-list", "--count", "HEAD", "--not", "--remotes"],
      info.path
    );
    if (!counted.ok) return { ...base, inspectError: counted.error.message };
    unpushed = Number(counted.value.trim()) || 0;
  }
  const size = await measure(info.path);
  return {
    ...base,
    branch: parsed.branch,
    head: parsed.head === "(initial)" ? "" : parsed.head,
    uncommitted: parsed.uncommitted,
    untracked: parsed.untracked,
    conflicted: parsed.conflicted,
    unpushed,
    upstream: parsed.upstream,
    inProgress: operation.ok ? operation.value : null,
    inspectError: operation.ok ? null : operation.error.message,
    pushRemote: pushRemoteFor(parsed.branch, branches, remotes),
    bytes: size.bytes,
    bytesPartial: size.partial
  };
}

async function readBranches(
  git: GitExec,
  repoPath: string
): Promise<Result<Map<string, BranchInfo>>> {
  const out = await run(
    git,
    [
      "for-each-ref",
      "--format=%(refname:short)%00%(upstream:remotename)%00%(upstream:short)",
      "refs/heads"
    ],
    repoPath
  );
  if (!out.ok) return out;
  const map = new Map<string, BranchInfo>();
  for (const line of lines(out.value)) {
    const [name, remote, upstream] = line.split("\0");
    if (name === undefined || name === "") continue;
    map.set(name, {
      remote: remote === undefined || remote === "" ? null : remote,
      upstream: upstream === undefined || upstream === "" ? null : upstream
    });
  }
  return ok(map);
}

/** Local branch tips that no remote-tracking ref reaches, in one walk: the
 *  log of everything on a branch and on no remote, decorated by branch, with
 *  only the decorated (tip) commits printed. */
async function branchesOnNoRemote(
  git: GitExec,
  repoPath: string
): Promise<Result<Set<string>>> {
  const out = await run(
    git,
    [
      "log",
      "--branches",
      "--not",
      "--remotes",
      "--simplify-by-decoration",
      "--decorate-refs=refs/heads/",
      "--format=%D"
    ],
    repoPath
  );
  if (!out.ok) return out;
  const names = new Set<string>();
  for (const line of lines(out.value)) {
    for (const part of line.split(", ")) {
      const name = part.replace(/^HEAD -> /, "").trim();
      if (name !== "" && name !== "HEAD") names.add(name);
    }
  }
  return ok(names);
}

/**
 * Inspect every checkout of a repository and the repository-wide things that
 * live in its `.git`: stashes, and local branches nothing has checked out that
 * hold commits on no remote. Reads only — nothing here takes a lock or writes.
 */
export async function reviewRepoRemoval(
  deps: RemovalReviewDeps,
  repoId: string,
  now: () => number = Date.now
): Promise<Result<RepoRemovalReview>> {
  const repo = deps.db
    .prepare("SELECT id, profile_id, name, path FROM repos WHERE id = ?")
    .get(repoId) as RepoRow | undefined;
  if (repo === undefined) {
    return err({ kind: "repo", code: "not_found", message: "Repository not found." });
  }
  if (!existsSync(repo.path)) {
    return err({
      kind: "repo",
      code: "primary_missing",
      message: `The main checkout is not on disk: ${repo.path}. PwrGit drops it on the next scan.`
    });
  }
  const measure =
    deps.measure ??
    ((path: string) => directorySize(path, { entryCap: REMOVAL_SIZE_ENTRY_CAP }));
  const listed = await listWorktrees(deps.git, repo.path);
  if (!listed.ok) return listed;
  const infos = listed.value.filter((w) => !w.bare);
  const [remoteOut, branches, stashes, atRisk] = await Promise.all([
    run(deps.git, ["remote", "-v"], repo.path),
    readBranches(deps.git, repo.path),
    listStashes(deps.git, repo.path),
    branchesOnNoRemote(deps.git, repo.path)
  ]);
  if (!remoteOut.ok) return remoteOut;
  if (!branches.ok) return branches;
  if (!stashes.ok) return stashes;
  if (!atRisk.ok) return atRisk;

  const remotes: { name: string; url: string }[] = [];
  for (const line of lines(remoteOut.value)) {
    const match = /^(\S+)\s+(.+?)\s+\(fetch\)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      remotes.push({ name: match[1], url: match[2] });
    }
  }
  const remoteNames = remotes.map((r) => r.name);

  const checkouts = new Array<RemovalCheckout>(infos.length);
  await mapLimit(
    infos.map((info, index) => ({ info, index })),
    REMOVAL_INSPECT_CONCURRENCY,
    async ({ info, index }) => {
      checkouts[index] = await inspectCheckout(
        deps.git,
        measure,
        info,
        index === 0,
        branches.value,
        remoteNames
      );
    }
  );

  // A worktree nested in the main checkout's folder was measured twice, and
  // goes to the Trash before the main checkout does: the main checkout's
  // share is what is left. Not from a floor, which may not have reached it.
  const [main, ...others] = checkouts;
  if (main !== undefined && main.bytes !== null && !main.bytesPartial) {
    for (const checkout of others) {
      const within = relative(main.path, checkout.path);
      if (checkout.bytes === null || within === "" || within.startsWith("..") || isAbsolute(within)) {
        continue;
      }
      main.bytes = Math.max(0, main.bytes - checkout.bytes);
    }
  }

  // A missing worktree's folder cannot be asked, but its branch lives in the
  // main checkout's .git, and a full removal takes that with it. Count what
  // only the branch holds, so the review and the name gate say so.
  await mapLimit(
    checkouts.filter(
      (c) => c.missing && !c.isPrimary && atRisk.value.has(c.branch)
    ),
    REMOVAL_INSPECT_CONCURRENCY,
    async (checkout) => {
      const counted = await run(
        deps.git,
        ["rev-list", "--count", `refs/heads/${checkout.branch}`, "--not", "--remotes"],
        repo.path
      );
      checkout.unpushed = counted.ok ? Number(counted.value.trim()) || 1 : 1;
    }
  );

  const checkedOut = new Set(checkouts.map((c) => c.branch).filter(Boolean));
  const loose = [...atRisk.value]
    .filter((name) => !checkedOut.has(name) && branches.value.has(name))
    .sort((a, b) => a.localeCompare(b));
  const counts = new Map<string, number>();
  await mapLimit(
    loose.slice(0, REMOVAL_BRANCH_COUNT_CAP),
    REMOVAL_INSPECT_CONCURRENCY,
    async (name) => {
      const counted = await run(
        deps.git,
        ["rev-list", "--count", `refs/heads/${name}`, "--not", "--remotes"],
        repo.path
      );
      counts.set(name, counted.ok ? Number(counted.value.trim()) || 1 : 1);
    }
  );

  const newest = stashes.value[0];
  const [primary, ...linked] = checkouts;
  return ok({
    repoId: repo.id,
    profileId: repo.profile_id,
    name: repo.name,
    path: repo.path,
    remotes,
    // Worktrees first, then the main checkout: that is the removal order,
    // and the main checkout carries the repository-wide rows below it.
    checkouts: primary === undefined ? linked : [...linked, primary],
    stashes: {
      count: stashes.value.length,
      newestSubject: newest?.subject ?? null,
      newestAt: newest?.createdAt ?? null
    },
    branches: loose.map((name) => ({
      name,
      unpushed: counts.get(name) ?? 1,
      pushRemote: pushRemoteFor(name, branches.value, remoteNames)
    })),
    reviewedAt: new Date(now()).toISOString()
  });
}

export type RemovalExecuteDeps = RemovalReviewDeps & {
  /** Move a folder to the OS trash; rejects when it cannot. */
  trash: (path: string) => Promise<void>;
  /** Delete a folder outright (only for paths the user named). */
  remove?: (path: string) => Promise<void>;
  /** Drain state probes for a checkout; resolves to its release. */
  lockForRemoval: (worktreeId: string) => Promise<() => void>;
  /** Serialize with other Git work on the checkout, then the repository. */
  runWorktree: <T>(worktreeId: string, op: () => Promise<T>) => Promise<T>;
  runRepository: <T>(repoId: string, op: () => Promise<T>) => Promise<T>;
  refreshRepo: (repoId: string) => Promise<void>;
  deleteRepo: (repoId: string) => void;
  onWorktreeRemoved?: (worktreeId: string) => void;
  onProgress?: (steps: RemovalStep[]) => void;
};

export type RemovalRequest = {
  repoId: string;
  decisions: RemovalDecisions;
  confirmName?: string;
  deletePermanently?: string[];
};

const failure = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Remove what a fresh review and the user's answers say may go: linked
 * worktrees first, one at a time, then — only if every one of them went and
 * nothing that lives in `.git` was kept — the main checkout. Folders go to the
 * Trash; `deletePermanently` is the user's explicit fallback after a Trash
 * move failed. Nothing runs `git worktree prune`: it is repo-wide, and would
 * also forget worktrees that are only on an unmounted volume.
 */
export async function executeRepoRemoval(
  deps: RemovalExecuteDeps,
  request: RemovalRequest
): Promise<Result<RepoRemovalResult>> {
  const reviewed = await reviewRepoRemoval(deps, request.repoId);
  if (!reviewed.ok) return reviewed;
  const review = reviewed.value;
  const status = removalStatus(review, request.decisions);
  if (status.pushWorktreeIds.length > 0 || status.pushBranches.length > 0) {
    return err({
      kind: "repo",
      code: "review_changed",
      message: "Some commits still need pushing. Review again."
    });
  }
  if (!status.ready) {
    return err({
      kind: "repo",
      code: "review_changed",
      message:
        "Something changed since the review: a checkout now needs a decision. Review again."
    });
  }
  if (status.needsName && request.confirmName !== review.name) {
    return err({
      kind: "repo",
      code: "confirm_name",
      message: `Type ${review.name} to remove it.`
    });
  }

  const permanent = new Set(request.deletePermanently ?? []);
  const byId = new Map(review.checkouts.map((c) => [c.worktreeId, c]));
  const stepFor = (checkout: RemovalCheckout): RemovalStep => ({
    id: checkout.worktreeId,
    kind: checkout.missing
      ? "forget"
      : permanent.has(checkout.path)
        ? "delete"
        : "trash",
    worktreeId: checkout.worktreeId,
    label: checkout.isPrimary
      ? "Main checkout"
      : checkout.branch === ""
        ? `detached@${checkout.head.slice(0, 7)}`
        : checkout.branch,
    path: checkout.path,
    isPrimary: checkout.isPrimary,
    status: "pending"
  });
  const steps: RemovalStep[] = status.removeWorktreeIds.flatMap((id) => {
    const checkout = byId.get(id);
    return checkout === undefined ? [] : [stepFor(checkout)];
  });
  const primary = review.checkouts.find((c) => c.isPrimary);
  if (status.removePrimary && primary !== undefined) steps.push(stepFor(primary));

  const update = (index: number, patch: Partial<RemovalStep>): void => {
    const current = steps[index];
    if (current === undefined) return;
    steps[index] = { ...current, ...patch };
    deps.onProgress?.(steps.map((s) => ({ ...s })));
  };
  const removeFolder = async (step: RemovalStep): Promise<void> => {
    if (step.kind === "delete") {
      await (deps.remove ?? ((path) => rm(path, { recursive: true, force: false })))(
        step.path
      );
    } else {
      await deps.trash(step.path);
    }
  };
  deps.onProgress?.(steps.map((s) => ({ ...s })));

  let failed = false;
  const releases: (() => void)[] = [];
  try {
    for (const [index, step] of steps.entries()) {
      if (step.isPrimary) continue;
      update(index, { status: "running" });
      const outcome = await deps.runWorktree(step.worktreeId, async () => {
        // Held until the refresh below has dropped the row, so no probe
        // spawns Git into a folder that is already in the Trash.
        releases.push(await deps.lockForRemoval(step.worktreeId));
        if (step.kind !== "forget") {
          try {
            await removeFolder(step);
          } catch (cause) {
            return { ok: false as const, message: failure(cause) };
          }
        }
        // The folder is gone now, so this only clears Git's record of this
        // one worktree — the targeted form of what `prune` would do to all.
        const forgot = await worktreeRemove(deps.git, review.path, step.path, {
          force: true
        });
        return forgot.ok
          ? { ok: true as const }
          : { ok: false as const, message: forgot.error.message };
      });
      if (outcome.ok) {
        update(index, { status: "done" });
        deps.onWorktreeRemoved?.(step.worktreeId);
      } else {
        failed = true;
        update(index, { status: "failed", message: outcome.message });
      }
    }

    const primaryIndex = steps.findIndex((s) => s.isPrimary);
    const primaryStep = steps[primaryIndex];
    if (primaryStep !== undefined && failed) {
      update(primaryIndex, {
        status: "skipped",
        message: "Not touched: a step above failed."
      });
    } else if (primaryStep !== undefined) {
      update(primaryIndex, { status: "running" });
      const outcome = await deps.runWorktree(primaryStep.worktreeId, () =>
        deps.runRepository(review.repoId, async () => {
          releases.push(await deps.lockForRemoval(primaryStep.worktreeId));
          try {
            await removeFolder(primaryStep);
            return { ok: true as const };
          } catch (cause) {
            return { ok: false as const, message: failure(cause) };
          }
        })
      );
      if (outcome.ok) {
        update(primaryIndex, { status: "done" });
        deps.deleteRepo(review.repoId);
      } else {
        failed = true;
        update(primaryIndex, { status: "failed", message: outcome.message });
      }
    }

    if (steps[primaryIndex]?.status !== "done") {
      await deps.refreshRepo(review.repoId);
    }
  } finally {
    for (const release of releases) release();
  }

  return ok({
    outcome: failed
      ? "stopped"
      : status.removePrimary
        ? "removed"
        : "partial",
    steps: steps.map((s) => ({ ...s }))
  });
}
