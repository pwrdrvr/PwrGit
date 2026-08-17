import type { BranchReveal, RepoSearchHit, Worktree } from "@pwrgit/shared";

export type PendingRepoReveal = {
  repoId: string;
  worktreeId: string | null;
  branch: BranchReveal | null;
  /**
   * Hold the reveal until that exact worktree is in the tree, instead of
   * settling for the repo's primary. A worktree PwrGit just created is indexed
   * before the reveal is asked for, but the renderer's copy of the tree only
   * catches up on the next `repo:changed` — without this the selection lands on
   * the wrong worktree in that gap.
   */
  awaitWorktree?: boolean;
};

/** Select a worktree PwrGit created, once the tree has caught up with it. */
export function pendingRevealForCreatedWorktree(
  repoId: string,
  worktreeId: string
): PendingRepoReveal {
  return { repoId, worktreeId, branch: null, awaitWorktree: true };
}

export type RevealResolution =
  /** Nothing to select yet — keep the reveal queued for the next tree. */
  | { kind: "wait" }
  | { kind: "select"; worktreeId: string }
  /** The repo has no worktrees to select; drop the reveal. */
  | { kind: "none" };

/**
 * Which worktree a reveal lands on. A named worktree wins; otherwise the
 * primary stands in — except for a reveal that insists on its own worktree,
 * which waits for the tree to list it rather than selecting a different one.
 */
export function resolveWorktreeReveal(
  pending: PendingRepoReveal,
  worktrees: readonly Worktree[]
): RevealResolution {
  const named =
    pending.worktreeId !== null
      ? worktrees.find((worktree) => worktree.id === pending.worktreeId)
      : undefined;
  if (named !== undefined) return { kind: "select", worktreeId: named.id };
  if (pending.awaitWorktree === true) return { kind: "wait" };
  const target =
    worktrees.find((worktree) => worktree.isPrimary) ?? worktrees[0];
  return target === undefined
    ? { kind: "none" }
    : { kind: "select", worktreeId: target.id };
}

/** Preserve the user's action while the target repository list is loading. */
export function pendingRevealForSearchHit(
  hit: RepoSearchHit
): PendingRepoReveal {
  return {
    repoId: hit.repoId,
    worktreeId: hit.worktreeId ?? null,
    branch: branchRevealForSearchHit(hit)
  };
}

/**
 * The worktree-less-branch action a hit carries, if any: a remote-only branch
 * needs a start point to branch from, a local branch is checked out by name.
 */
export function branchRevealForSearchHit(
  hit: RepoSearchHit
): BranchReveal | null {
  if (hit.kind === "remote_branch" && hit.remoteRef !== undefined) {
    return { kind: "remote", name: hit.name, fullName: hit.remoteRef };
  }
  if (hit.kind === "local_branch") return { kind: "local", name: hit.name };
  return null;
}
