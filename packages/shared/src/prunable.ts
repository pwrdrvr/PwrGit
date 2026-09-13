// The one definition of "this worktree is safe to remove".
//
// It lives in shared rather than beside the sidebar because two surfaces ask
// the same question from opposite sides of the IPC boundary: the Stale lens
// (renderer, over the tree it already has) and the pruner's sweep (main, over
// freshly computed state). A second copy would drift, and the two would
// disagree about which rows the pruner is allowed to touch — so the lens and
// the verb move together by construction.

import type { PrunableReason, Worktree } from "./types";

/** How long a merged/diverged worktree must sit untouched to count as stale. */
export const STALE_AGE_DAYS = 14;

const STALE_AGE_MS = STALE_AGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * The conservative predicate, as a reason or null. Deliberately strict:
 *
 * - never the primary checkout or the repo's default branch;
 * - never a checkout whose directory is gone (the row already says so, and
 *   removal there is its own affordance);
 * - never a dirty worktree;
 * - a **merged PR** is definitive at any age — it catches squash and rebase
 *   merges, whose original commits are not in the default branch and so are
 *   invisible to the git-ancestry check below;
 * - otherwise the branch must be contained in the default branch, or share no
 *   history with it at all, **and** have been untouched for STALE_AGE_DAYS.
 */
export function prunableReason(
  w: Worktree,
  now: number = Date.now()
): PrunableReason | null {
  if (w.isDefaultBranch || w.isPrimary) return null;
  if (w.missing === true) return null;
  if (w.dirty > 0) return null;
  if (w.pr?.state === "merged") {
    return { kind: "merged_pr", prNumber: w.pr.number };
  }
  if (!w.mergedIntoDefault && !w.divergedFromDefault) return null;
  if (w.lastActivityAt === undefined) return null;
  const activityAt = new Date(w.lastActivityAt).getTime();
  if (!Number.isFinite(activityAt)) return null;
  if (now - activityAt <= STALE_AGE_MS) return null;
  return w.mergedIntoDefault
    ? { kind: "merged_into_default", defaultBranch: w.defaultBranch }
    : { kind: "diverged", defaultBranch: w.defaultBranch };
}

/** A worktree is "safe to prune": clean, finished, and not the checkout the
 *  repo is anchored on. See `prunableReason` for the whole rule. */
export function isPrunableWorktree(
  w: Worktree,
  now: number = Date.now()
): boolean {
  return prunableReason(w, now) !== null;
}
