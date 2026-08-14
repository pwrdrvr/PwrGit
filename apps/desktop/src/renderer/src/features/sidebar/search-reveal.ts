import type { RemoteBranchReveal, RepoSearchHit } from "@pwrgit/shared";

export type PendingRepoReveal = {
  repoId: string;
  worktreeId: string | null;
  remoteBranch: RemoteBranchReveal | null;
};

/** Preserve the user's action while the target repository list is loading. */
export function pendingRevealForSearchHit(
  hit: RepoSearchHit
): PendingRepoReveal {
  return {
    repoId: hit.repoId,
    worktreeId: hit.worktreeId ?? null,
    remoteBranch:
      hit.kind === "remote_branch" && hit.remoteRef !== undefined
        ? { name: hit.name, fullName: hit.remoteRef }
        : null
  };
}
