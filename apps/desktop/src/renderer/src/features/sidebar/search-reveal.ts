import type { BranchReveal, RepoSearchHit } from "@pwrgit/shared";

export type PendingRepoReveal = {
  repoId: string;
  worktreeId: string | null;
  branch: BranchReveal | null;
};

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
