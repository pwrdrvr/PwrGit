import type { CommitAuthorIdentityTransport, CommitAuthorProof, CommitAuthorRemoteCommit } from "./commit-author";
import { GhCliCommitAuthorIdentityTransport } from "./github/commit-author-transport";
import { GlabCliCommitAuthorIdentityTransport } from "./gitlab/commit-author-transport";
import type { ForgeKind, ForgeRepo } from "./types";

/**
 * Dispatches exact-commit lookups to the transport for that repo's forge.
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
      gitlab: overrides.gitlab ?? new GlabCliCommitAuthorIdentityTransport(),
      gitcafe: overrides.gitcafe ?? { fetchCommit: async () => ({}) }
    };
  }

  async fetchCommit(proof: CommitAuthorProof): Promise<CommitAuthorRemoteCommit> {
    return await this.byKind[proof.repo.kind].fetchCommit(proof);
  }

  /** One request per call for a forge that batches; one per SHA otherwise. */
  async fetchCommits(
    repo: ForgeRepo,
    commitShas: readonly string[]
  ): Promise<Map<string, CommitAuthorRemoteCommit>> {
    const transport = this.byKind[repo.kind];
    if (transport.fetchCommits !== undefined) {
      return await transport.fetchCommits(repo, commitShas);
    }
    const answers = new Map<string, CommitAuthorRemoteCommit>();
    for (const commitSha of commitShas) {
      answers.set(commitSha, await transport.fetchCommit({ repo, commitSha }));
    }
    return answers;
  }

  commitsPerRequest(repo: ForgeRepo): number {
    const transport = this.byKind[repo.kind];
    if (transport.fetchCommits === undefined) return 1;
    return Math.max(1, Math.floor(transport.commitsPerRequest?.(repo) ?? 1));
  }
}
