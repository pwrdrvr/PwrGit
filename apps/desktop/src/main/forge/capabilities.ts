import type { ForgeCapabilities, ForgeKind } from "@pwrgit/shared";

/**
 * What each forge can actually answer.
 *
 * These describe the *integration*, not a login, so they are static per forge
 * and safe to state without a network call. Callers use them to avoid asking a
 * question the provider cannot answer, and the UI uses them to say why a
 * surface is empty instead of showing a permanently blank panel.
 */
export const FORGE_CAPABILITIES: Readonly<Record<ForgeKind, ForgeCapabilities>> = {
  github: {
    batchedBranchLookup: true,
    // `associatedPullRequests` takes many commit OIDs in one aliased query.
    batchedCommitAssociation: true,
    changeSizeAndTimeline: true,
    commitAuthorIdentity: true
  },
  gitlab: {
    // `mergeRequests(sourceBranches: [...])` batches natively.
    batchedBranchLookup: true,
    // GitLab has no batch commit-association endpoint: it is one REST call per
    // SHA, which is why callers must cap the visible set rather than fan out.
    batchedCommitAssociation: false,
    changeSizeAndTimeline: true,
    commitAuthorIdentity: true
  }
};

export function capabilitiesFor(kind: ForgeKind): ForgeCapabilities {
  return FORGE_CAPABILITIES[kind];
}
