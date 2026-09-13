import { describe, expect, it } from "vitest";
import { isPrunableWorktree, prunableReason, STALE_AGE_DAYS } from "./prunable";
import type { PrSummary, Worktree } from "./types";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-13T00:00:00.000Z");
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString();

function wt(partial: Partial<Worktree> & { branch: string }): Worktree {
  return {
    id: partial.branch,
    repoId: "r",
    path: `/w/${partial.branch}`,
    dirty: 0,
    ahead: 0,
    behind: 0,
    behindDefault: 0,
    defaultBranch: "main",
    mergedIntoDefault: false,
    divergedFromDefault: false,
    isDefaultBranch: false,
    pinned: false,
    isPrimary: false,
    ...partial
  };
}

const mergedPr: PrSummary = {
  number: 42,
  url: "https://example.test/pr/42",
  title: "t",
  state: "merged",
  isDraft: false
};

describe("prunableReason", () => {
  it("reports the merged PR, with its number, at any age", () => {
    const w = wt({ branch: "feat/squashed", lastActivityAt: ago(0), pr: mergedPr });
    expect(prunableReason(w, NOW)).toEqual({ kind: "merged_pr", prNumber: 42 });
  });

  it("reports containment in the default branch, naming it", () => {
    const w = wt({
      branch: "feat/done",
      mergedIntoDefault: true,
      defaultBranch: "trunk",
      lastActivityAt: ago(STALE_AGE_DAYS + 1)
    });
    expect(prunableReason(w, NOW)).toEqual({
      kind: "merged_into_default",
      defaultBranch: "trunk"
    });
  });

  it("reports a diverged branch separately from a merged one", () => {
    // These are very different claims — one says the work is safely in main,
    // the other says we cannot find any relationship to main at all — and the
    // pruner shows the difference rather than calling both "stale".
    const w = wt({
      branch: "orphan",
      divergedFromDefault: true,
      lastActivityAt: ago(90)
    });
    expect(prunableReason(w, NOW)).toEqual({
      kind: "diverged",
      defaultBranch: "main"
    });
  });

  it("prefers containment over divergence when both are somehow set", () => {
    const w = wt({
      branch: "both",
      mergedIntoDefault: true,
      divergedFromDefault: true,
      lastActivityAt: ago(90)
    });
    expect(prunableReason(w, NOW)?.kind).toBe("merged_into_default");
  });

  it("refuses a merged branch that is still inside the stale window", () => {
    const base = {
      branch: "feat/fresh",
      mergedIntoDefault: true
    };
    // The boundary is strictly greater than the window, matching the lens.
    expect(
      prunableReason(wt({ ...base, lastActivityAt: ago(STALE_AGE_DAYS) }), NOW)
    ).toBeNull();
    expect(
      prunableReason(
        wt({ ...base, lastActivityAt: new Date(NOW - STALE_AGE_DAYS * DAY - 1).toISOString() }),
        NOW
      )
    ).not.toBeNull();
  });

  it("refuses every case the sweep must never touch", () => {
    const old = { lastActivityAt: ago(90), mergedIntoDefault: true };
    expect(prunableReason(wt({ branch: "p", ...old, isPrimary: true }), NOW)).toBeNull();
    expect(
      prunableReason(wt({ branch: "main", ...old, isDefaultBranch: true }), NOW)
    ).toBeNull();
    expect(prunableReason(wt({ branch: "g", ...old, missing: true }), NOW)).toBeNull();
    expect(prunableReason(wt({ branch: "d", ...old, dirty: 3 }), NOW)).toBeNull();
    // Dirt outranks a merged PR too: the PR is about the branch, not about the
    // uncommitted file sitting in this checkout.
    expect(
      prunableReason(wt({ branch: "dp", dirty: 1, pr: mergedPr }), NOW)
    ).toBeNull();
  });

  it("refuses a locked worktree, however finished it looks", () => {
    // `git worktree lock` is the one explicit "do not touch this" in git's
    // worktree model, and removal needs --force — which the bulk remove only
    // offers for the dirty set, behind its own prompt.
    const old = { lastActivityAt: ago(90), mergedIntoDefault: true };
    expect(
      prunableReason(wt({ branch: "l", ...old, locked: true }), NOW)
    ).toBeNull();
    // A merged PR outranks age, but not a lock.
    expect(
      prunableReason(wt({ branch: "lp", pr: mergedPr, locked: true }), NOW)
    ).toBeNull();
  });

  it("refuses a merged branch with no activity date, or an unparseable one", () => {
    expect(prunableReason(wt({ branch: "a", mergedIntoDefault: true }), NOW)).toBeNull();
    expect(
      prunableReason(
        wt({ branch: "b", mergedIntoDefault: true, lastActivityAt: "not a date" }),
        NOW
      )
    ).toBeNull();
  });

  it("agrees with isPrunableWorktree in both directions", () => {
    const yes = wt({ branch: "y", mergedIntoDefault: true, lastActivityAt: ago(90) });
    const no = wt({ branch: "n", mergedIntoDefault: true, lastActivityAt: ago(1) });
    expect(isPrunableWorktree(yes, NOW)).toBe(true);
    expect(isPrunableWorktree(no, NOW)).toBe(false);
  });
});
