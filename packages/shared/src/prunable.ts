// The one definition of "this worktree is safe to remove".
//
// It lives in shared rather than beside the sidebar because two surfaces ask
// the same question from opposite sides of the IPC boundary: the Stale lens
// (renderer, over the tree it already has) and the pruner's sweep (main, over
// freshly computed state). A second copy would drift, and the two would
// disagree about which rows the pruner is allowed to touch — so the lens and
// the verb move together by construction.

import type { PrunableReason, Worktree } from "./types";

/** How long a merged/diverged worktree must sit untouched to count as stale.
 *  The default for merged branches, and fixed for diverged ones. */
export const STALE_AGE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_AGE_MS = STALE_AGE_DAYS * DAY_MS;

/**
 * Days without commits before a branch merged into the default branch counts
 * as finished (General settings, Repository maintenance). 0 is "right away".
 * Anything else crossing IPC is refused.
 */
export const WORKTREE_FINISHED_AFTER_DAYS = [0, 1, 3, 7, 14, 30] as const;
export type WorktreeFinishedAfterDays =
  (typeof WORKTREE_FINISHED_AFTER_DAYS)[number];

export function isWorktreeFinishedAfterDays(
  value: unknown
): value is WorktreeFinishedAfterDays {
  return WORKTREE_FINISHED_AFTER_DAYS.includes(
    value as WorktreeFinishedAfterDays
  );
}

/**
 * The conservative predicate, as a reason or null. Deliberately strict:
 *
 * - never the primary checkout or the repo's default branch;
 * - never a checkout whose directory is gone (the row already says so, and
 *   removal there is its own affordance);
 * - never a dirty worktree;
 * - never a `git worktree lock`ed checkout. A lock is the one explicit "do not
 *   touch this" in git's worktree model, and repo-indexer.ts relies on the same
 *   reading: "Git never reports a LOCKED worktree prunable ... (that is what
 *   locking is for)". Removing one needs `--force`, which the bulk remove only
 *   offers for the dirty set behind its own prompt — so offering a locked row
 *   would promise a removal that then fails;
 * - a **merged PR** is definitive at any age — it catches squash and rebase
 *   merges, whose original commits are not in the default branch and so are
 *   invisible to the git-ancestry check below;
 * - otherwise the branch must be contained in the default branch and have had
 *   no commits for `finishedAfterDays` (the user's setting; 0 means right
 *   away), or share no history with it at all and have had no commits for
 *   STALE_AGE_DAYS. The second case stays fixed: nothing proves it merged.
 */
export function prunableReason(
  w: Worktree,
  now: number = Date.now(),
  finishedAfterDays: number = STALE_AGE_DAYS
): PrunableReason | null {
  if (w.isDefaultBranch || w.isPrimary) return null;
  if (w.missing === true) return null;
  if (w.locked === true) return null;
  if (w.dirty > 0) return null;
  if (w.pr?.state === "merged") {
    return { kind: "merged_pr", prNumber: w.pr.number };
  }
  if (!w.mergedIntoDefault && !w.divergedFromDefault) return null;
  if (w.lastActivityAt === undefined) return null;
  const activityAt = new Date(w.lastActivityAt).getTime();
  if (!Number.isFinite(activityAt)) return null;
  if (w.mergedIntoDefault) {
    // "Right away" skips the clock, so a commit dated ahead (clock skew) does
    // not hold a merged branch back.
    if (finishedAfterDays > 0 && now - activityAt <= finishedAfterDays * DAY_MS)
      return null;
    return { kind: "merged_into_default", defaultBranch: w.defaultBranch };
  }
  if (now - activityAt <= STALE_AGE_MS) return null;
  return { kind: "diverged", defaultBranch: w.defaultBranch };
}

/** A worktree is "safe to prune": clean, finished, and not the checkout the
 *  repo is anchored on. See `prunableReason` for the whole rule. */
export function isPrunableWorktree(
  w: Worktree,
  now: number = Date.now(),
  finishedAfterDays: number = STALE_AGE_DAYS
): boolean {
  return prunableReason(w, now, finishedAfterDays) !== null;
}
