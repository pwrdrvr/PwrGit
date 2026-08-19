import type { CommitAuthorIdentityTransport, CommitAuthorProof, CommitAuthorRemoteCommit } from "./commit-author";
import { GhCliCommitAuthorIdentityTransport } from "./github/commit-author-transport";
import { GlabCliCommitAuthorIdentityTransport } from "./gitlab/commit-author-transport";
import type { ForgeKind } from "./types";

/**
 * Dispatches one exact-commit lookup to the transport for that repo's forge.
 *
 * Both transports are credential-opaque by construction: each delegates auth to
 * its own CLI rather than extracting a token, so adding a forge here never
 * widens what the identity service can see.
 */
export class ForgeCommitAuthorIdentityTransport
  implements CommitAuthorIdentityTransport {
  private readonly byKind: Readonly<Record<ForgeKind, CommitAuthorIdentityTransport>>;

  constructor(
    overrides: Partial<Record<ForgeKind, CommitAuthorIdentityTransport>> = {}
  ) {
    this.byKind = {
      github: overrides.github ?? new GhCliCommitAuthorIdentityTransport(),
      gitlab: overrides.gitlab ?? new GlabCliCommitAuthorIdentityTransport()
    };
  }

  async fetchCommit(proof: CommitAuthorProof): Promise<CommitAuthorRemoteCommit> {
    return await this.byKind[proof.repo.kind].fetchCommit(proof);
  }
}
