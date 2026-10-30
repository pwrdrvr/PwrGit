// The one definition of "this branch's commits are on no remote, but they
// landed".
//
// A branch with no upstream counts as ahead every commit that no fetched
// remote branch holds (`rev-list HEAD --not --remotes`). Once a squash-merged
// change request's remote branch is deleted, its commits are on no remote ref,
// so they read as local work although the forge merged them. The header chip,
// the sidebar row and anything else that says "unpushed" must agree on when
// that reading is wrong, so they all ask here.

import type { PrSummary, Worktree } from "./types";

/**
 * The merged change request whose final head IS this checkout's tip, when the
 * branch has no upstream; otherwise null.
 *
 * Exact equality only. After a squash merge nothing in Git connects the branch
 * to the merge, so the forge's `headOid` is the only proof, and a tip that
 * moved on after the merge is new work that a push would carry.
 */
export function landedChangeRequest(
  pr: PrSummary | null | undefined,
  head: string | null | undefined,
  hasUpstream: boolean
): PrSummary | null {
  if (hasUpstream || pr == null || pr.state !== "merged") return null;
  if (head == null || head === "" || pr.headOid === undefined) return null;
  return pr.headOid === head ? pr : null;
}

/** `landedChangeRequest` over a sidebar row, which knows tracking but not
 *  `hasUpstream`: `unpublished` is exactly "no upstream configured". */
export function worktreeLandedChangeRequest(
  worktree: Pick<Worktree, "pr" | "head" | "tracking">
): PrSummary | null {
  return landedChangeRequest(
    worktree.pr,
    worktree.head,
    worktree.tracking !== "unpublished"
  );
}
