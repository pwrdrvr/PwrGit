import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  err,
  ok,
  type BranchCleanupOptions,
  type GarbageCollectionMode,
  type KeptBranch,
  type PrLifecycle,
  type Result,
  type StaleBranch,
  type StaleBranchPr
} from "@pwrgit/shared";
import { deleteReviewedBranches } from "./branch-lifecycle";
import { requireExit0, type GitExec } from "./dugite";
import { checkoutExists } from "./worktree-liveness";

async function output(
  git: GitExec,
  cwd: string,
  args: string[]
): Promise<Result<string>> {
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  return checked.ok ? ok(checked.value.stdout) : checked;
}

/** Resolve aliases and linked worktrees to one object store, without walking
 * up into a parent repository if a discovered checkout has disappeared. */
export async function maintenanceCommonDirectory(
  git: GitExec,
  cwd: string
): Promise<Result<string>> {
  if (!checkoutExists(cwd)) {
    return err({
      kind: "repo",
      code: "worktree_missing",
      message:
        "The repository checkout is missing. Restore its folder before running maintenance."
    });
  }
  const common = await output(git, cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir"
  ]);
  if (!common.ok) return common;
  return ok(await realpath(resolve(cwd, common.value.trim())));
}

/** count-objects reports KiB of loose objects and packs, not volume free space. */
export async function objectStorageBytes(
  git: GitExec,
  cwd: string
): Promise<number | undefined> {
  const counted = await output(git, cwd, ["count-objects", "-v"]);
  if (!counted.ok) return undefined;
  const values = new Map(
    counted.value
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const [key, value] = line.split(": ");
        return [key, Number(value)] as const;
      })
  );
  const loose = values.get("size");
  const packs = values.get("size-pack");
  return loose !== undefined &&
    packs !== undefined &&
    Number.isFinite(loose + packs)
    ? (loose + packs) * 1024
    : undefined;
}

export function garbageCollectionArgs(mode: GarbageCollectionMode): string[] {
  // Missing worktrees may be on unmounted volumes. GC must not expire their
  // registration. Foreground execution keeps completion tied to Git's exit.
  return [
    "-c",
    "gc.worktreePruneExpire=never",
    "gc",
    "--no-detach",
    ...(mode === "aggressive"
      ? ["--aggressive"]
      : mode === "keep-largest"
        ? ["--keep-largest-pack"]
        : [])
  ];
}

export async function collectGarbage(
  git: GitExec,
  cwd: string,
  mode: GarbageCollectionMode
): Promise<Result<void>> {
  const result = await output(git, cwd, garbageCollectionArgs(mode));
  return result.ok ? ok(undefined) : result;
}

/** What the review knows about a branch's pull request, from `branch_pr`. */
export type BranchPrEvidence = {
  number: number;
  url: string;
  state: PrLifecycle;
  mergedAt?: number;
  /** The PR's final head commit. Absent on rows cached before it was fetched,
   *  and on forges that do not report it. */
  headOid?: string;
};

export type StaleBranchReview = {
  candidates: StaleBranch[];
  kept: KeptBranch[];
};

export type StaleBranchReviewInput = {
  options: BranchCleanupOptions;
  /** Cached pull requests by local branch name. */
  prs: ReadonlyMap<string, BranchPrEvidence>;
  /** Epoch ms, injected so the age guard is testable. */
  now: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** "today", "yesterday", "12 days ago" — the Kept line's age. */
export function touchedAgo(touchedAt: number, now: number): string {
  const days = Math.max(0, Math.floor((now - touchedAt) / DAY_MS));
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

/**
 * Review every local branch whose upstream is gone, and give each one verdict.
 *
 * The rule underneath: a branch is offered only when every commit on it is
 * proven to exist somewhere else. Ancestry proves it when the tip is in HEAD.
 * For a squash or rebase merge nothing reaches HEAD by ancestry, so a merged
 * PR proves it — but only when the PR's final head IS the local tip, or
 * contains it. A merged PR alone proves the branch was finished once, not
 * that nobody committed to it the next morning. That same proof covers "never
 * pushed" by construction: an unpushed tip cannot be any PR's head, and a
 * branch with no upstream is never gone in the first place.
 *
 * No translated '[gone]' strings: an upstream must be a missing
 * `refs/remotes/*` ref on a known remote.
 */
export async function reviewStaleBranches(
  git: GitExec,
  cwd: string,
  repoId: string,
  input: StaleBranchReviewInput
): Promise<Result<StaleBranchReview>> {
  const { options, prs, now } = input;
  const refs = await output(git, cwd, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)%09%(upstream)%09%(worktreepath)%09%(upstream:remotename)%09%(committerdate:unix)",
    "refs/heads/",
    "refs/remotes/"
  ]);
  if (!refs.ok) return refs;
  const rows = refs.value
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.split("\t"));
  const empty: StaleBranchReview = { candidates: [], kept: [] };
  if (!rows.some((row) => row[0]?.startsWith("refs/heads/"))) return ok(empty);
  const merged = await output(git, cwd, [
    "for-each-ref",
    "--merged=HEAD",
    "--format=%(refname)",
    "refs/heads/"
  ]);
  if (!merged.ok) return merged;
  const remotes = await output(git, cwd, ["remote"]);
  if (!remotes.ok) return remotes;
  const remoteNames = new Set(
    remotes.value.trim().split(/\r?\n/).filter(Boolean)
  );
  const names = new Set(rows.map((row) => row[0]));
  const mergedRefs = new Set(merged.value.trim().split(/\r?\n/));
  const protectedNames = new Set([
    "main",
    "master",
    "trunk",
    "develop",
    "development"
  ]);
  for (const remote of remoteNames) {
    // for-each-ref omits a dangling remote HEAD after fetch pruning. Read
    // the symbolic target directly so its default branch stays protected.
    const args = ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`];
    const raw = await git(args, cwd);
    if (!raw.ok) return raw;
    // Exit 1 means there is no symbolic HEAD configured for this remote.
    if (raw.value.exitCode === 1) continue;
    const checked = requireExit0(raw.value, args);
    if (!checked.ok) return checked;
    const symbolic = checked.value.stdout.trim();
    for (const owner of remoteNames) {
      if (symbolic.startsWith(`refs/remotes/${owner}/`)) {
        protectedNames.add(symbolic.slice(`refs/remotes/${owner}/`.length));
      }
    }
  }
  // Read lazily: only a proven branch whose commit date is already outside
  // the age guard needs its reflog, and most reviews prove few branches.
  let checkouts: Map<string, number> | undefined;
  const candidates: StaleBranch[] = [];
  const kept: KeptBranch[] = [];
  for (const [
    ref = "",
    head = "",
    upstream = "",
    worktree = "",
    remote = "",
    committed = ""
  ] of rows) {
    if (!ref.startsWith("refs/heads/")) continue;
    const branch = ref.slice("refs/heads/".length);
    if (protectedNames.has(branch)) continue;
    if (
      !upstream.startsWith("refs/remotes/") ||
      names.has(upstream) ||
      !remoteNames.has(remote)
    )
      continue;
    const cached = prs.get(branch);
    const pr: StaleBranchPr | undefined =
      cached === undefined
        ? undefined
        : {
            number: cached.number,
            url: cached.url,
            ...(cached.mergedAt === undefined
              ? {}
              : { mergedAt: cached.mergedAt })
          };
    const withPr = pr === undefined ? {} : { pr };
    const committedAt = Number(committed) * 1000;
    const base = Number.isFinite(committedAt) && committedAt > 0
      ? { touchedAt: committedAt }
      : {};
    if (worktree !== "") {
      kept.push({
        branch,
        reason: "worktree",
        detail: `Checked out in ${basename(worktree)}`,
        ...withPr,
        ...base
      });
      continue;
    }
    let evidence: StaleBranch["evidence"];
    if (mergedRefs.has(ref)) evidence = "ancestry";
    else {
      const verdict = await prVerdict(git, cwd, head, cached);
      if (verdict !== "proven") {
        kept.push({ branch, ...verdict, ...withPr, ...base });
        continue;
      }
      if (!options.prProof) {
        kept.push({
          branch,
          reason: "pr_proof_off",
          detail: `#${cached!.number} merged, but its commits are not in HEAD by ancestry`,
          ...withPr,
          ...base
        });
        continue;
      }
      evidence = "pr";
    }
    let touchedAt = base.touchedAt;
    if (options.keepDays !== null) {
      const guard = options.keepDays * DAY_MS;
      if (touchedAt === undefined || now - touchedAt >= guard) {
        checkouts ??= await lastCheckouts(git, cwd);
        const reflogged = Math.max(
          checkouts.get(branch) ?? 0,
          await lastReflogEntry(git, cwd, ref)
        );
        if (reflogged > (touchedAt ?? 0)) touchedAt = reflogged;
      }
      if (touchedAt !== undefined && now - touchedAt < guard) {
        kept.push({
          branch,
          reason: "recent",
          detail: `Touched ${touchedAgo(touchedAt, now)}, inside the ${options.keepDays}-day guard`,
          ...withPr,
          touchedAt
        });
        continue;
      }
    }
    candidates.push({
      repoId,
      branch,
      expectedHead: head,
      upstream,
      evidence,
      ...(evidence === "pr" ? withPr : {}),
      ...(touchedAt === undefined ? {} : { touchedAt })
    });
  }
  return ok({ candidates, kept });
}

/**
 * Does the branch's merged PR prove its tip? "proven" when the tip is the
 * PR's final head, or an ancestor of it — the PR carried everything local and
 * perhaps more. Otherwise the reason it does not.
 */
async function prVerdict(
  git: GitExec,
  cwd: string,
  head: string,
  pr: BranchPrEvidence | undefined
): Promise<"proven" | Pick<KeptBranch, "reason" | "detail">> {
  if (pr === undefined)
    return {
      reason: "no_proof",
      detail: "No merged pull request found, and not in HEAD"
    };
  if (pr.state === "open")
    return { reason: "pr_open", detail: `#${pr.number} is still open` };
  if (pr.state === "closed")
    return {
      reason: "pr_closed",
      detail: `#${pr.number} closed without merging`
    };
  if (pr.headOid === undefined)
    return {
      reason: "no_proof",
      detail: `#${pr.number} merged, but its head commit is not known yet`
    };
  if (pr.headOid === head) return "proven";
  // Exit 0: the tip is inside the PR. 1: it is not. Anything else (128): the
  // PR's head was never fetched here, so the two cannot be compared.
  const ancestor = await git(
    ["merge-base", "--is-ancestor", head, pr.headOid],
    cwd
  );
  if (ancestor.ok && ancestor.value.exitCode === 0) return "proven";
  if (ancestor.ok && ancestor.value.exitCode === 1) {
    const count = await git(
      ["rev-list", "--count", `${pr.headOid}..${head}`],
      cwd
    );
    const extra =
      count.ok && count.value.exitCode === 0
        ? Number(count.value.stdout.trim())
        : NaN;
    return {
      reason: "unmerged_commits",
      detail: Number.isFinite(extra) && extra > 0
        ? `${extra} local commit${extra === 1 ? "" : "s"} not in #${pr.number}`
        : `Local commits not in #${pr.number}`
    };
  }
  return {
    reason: "unmerged_commits",
    detail: `Tip differs from #${pr.number}'s head, which was never fetched here`
  };
}

/** When each branch was last checked out, from this checkout's HEAD reflog.
 *  Epoch ms. A checkout does not touch the branch's own reflog. */
async function lastCheckouts(
  git: GitExec,
  cwd: string
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const raw = await git(
    ["log", "-g", "-n", "5000", "--date=unix", "--format=%gd%x09%gs", "HEAD", "--"],
    cwd
  );
  if (!raw.ok || raw.value.exitCode !== 0) return out;
  for (const line of raw.value.stdout.split(/\r?\n/)) {
    const [selector = "", subject = ""] = line.split("\t");
    const at = reflogTime(selector);
    const moved = /^checkout: moving from .+ to (.+)$/.exec(subject);
    if (at === 0 || moved === null) continue;
    const branch = moved[1]!;
    if (at > (out.get(branch) ?? 0)) out.set(branch, at);
  }
  return out;
}

/** The newest entry in one branch's own reflog (a commit, reset, rename), in
 *  epoch ms, or 0 when it has none. */
async function lastReflogEntry(
  git: GitExec,
  cwd: string,
  ref: string
): Promise<number> {
  const raw = await git(
    ["log", "-g", "-n", "1", "--date=unix", "--format=%gd", ref, "--"],
    cwd
  );
  if (!raw.ok || raw.value.exitCode !== 0) return 0;
  return reflogTime(raw.value.stdout.trim());
}

/** `HEAD@{1700000000}` under `--date=unix` → epoch ms. */
function reflogTime(selector: string): number {
  const match = /@\{(\d+)\}$/.exec(selector);
  return match === null ? 0 : Number(match[1]) * 1000;
}

/**
 * Delete reviewed branches, against a review taken just before the batch.
 *
 * Each must still be a candidate in `fresh`, at the same tip and upstream and
 * on the same evidence. Ancestry is asked of Git once more right before the
 * delete — the check `git branch -d` makes per branch, made here once for the
 * batch — and every deletion is a compare-and-swap on the reviewed tip
 * (`deleteReviewedBranches`), so a branch that moved after the review is
 * refused as stale. That CAS is also what PR evidence needs: `git branch -d`
 * refuses a squash merge.
 *
 * Results are per branch. A branch missing from them was never attempted:
 * the signal stopped the batch first.
 */
export async function deleteStaleBranches(
  git: GitExec,
  cwd: string,
  candidates: readonly StaleBranch[],
  fresh: StaleBranchReview,
  progress: {
    onProgress?: (done: number, deleted: number) => void;
    signal?: AbortSignal;
  } = {}
): Promise<Result<Map<string, Result<void>>>> {
  const results = new Map<string, Result<void>>();
  if (progress.signal?.aborted === true) return ok(results);
  const stale = (message: string): Result<void> =>
    err({ kind: "repo", code: "stale_branch_review", message });
  const eligible = candidates.filter((candidate) => {
    const current = fresh.candidates.some(
      (branch) =>
        branch.branch === candidate.branch &&
        branch.expectedHead === candidate.expectedHead &&
        branch.upstream === candidate.upstream &&
        branch.evidence === candidate.evidence
    );
    if (!current)
      results.set(
        candidate.branch,
        stale(
          "The branch changed or is no longer eligible. Review it again; nothing was deleted."
        )
      );
    return current;
  });
  let proven = eligible;
  if (eligible.some((candidate) => candidate.evidence === "ancestry")) {
    const merged = await output(git, cwd, [
      "for-each-ref",
      "--merged=HEAD",
      "--format=%(refname)",
      "refs/heads/"
    ]);
    if (!merged.ok) return merged;
    const inHead = new Set(merged.value.split(/\r?\n/));
    proven = eligible.filter((candidate) => {
      if (
        candidate.evidence !== "ancestry" ||
        inHead.has(`refs/heads/${candidate.branch}`)
      )
        return true;
      results.set(
        candidate.branch,
        stale(
          "The branch is no longer in HEAD. Review it again; nothing was deleted."
        )
      );
      return false;
    });
  }
  const deleted = await deleteReviewedBranches(git, cwd, proven, progress);
  if (!deleted.ok) return deleted;
  for (const [branch, result] of deleted.value) results.set(branch, result);
  return ok(results);
}

/**
 * Recreate a branch the clean-up deleted, at its reviewed tip. `--no-track`:
 * its upstream is the thing that was gone. Fails, and changes nothing, when
 * the name is taken again or Git has since pruned the commit.
 */
export async function restoreStaleBranch(
  git: GitExec,
  cwd: string,
  branch: string,
  head: string
): Promise<Result<void>> {
  const args = ["branch", "--no-track", "--", branch, head];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  if (raw.value.exitCode !== 0) {
    const detail = raw.value.stderr.trim();
    return err({
      kind: "repo",
      code: /already exists/i.test(detail)
        ? "branch_exists"
        : "branch_restore_failed",
      message: /already exists/i.test(detail)
        ? `A branch named ${branch} exists again; nothing was restored.`
        : `Could not restore ${branch} at ${head.slice(0, 8)}. Git may have pruned the commit. ${detail}`.trim()
    });
  }
  return ok(undefined);
}
