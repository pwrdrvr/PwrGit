import {
  associatedAuthorMatches,
  parseGitLabGlobalId,
  type CommitAuthorIdentityTransport,
  type CommitAuthorProof,
  type CommitAuthorRemoteCommit,
  type ForgeAccountProfile
} from "../commit-author";
import { runGlab } from "./glab-cli";

/**
 * GitLab's commit-author transport, through `glab api`.
 *
 * Like the GitHub transport it is deliberately credential-opaque: `glab` reads
 * its own store, so no token enters this class, the service, the cache, the
 * shared protocol, logs, or the renderer. It does not reuse the MR client's
 * token flow for exactly that reason.
 *
 * GitLab's REST commit response carries only raw Git trailers — it has no
 * linked-account field at all. The account link exists only in GraphQL, as
 * `project.repository.commit.author`, which is why this transport speaks
 * GraphQL where the GitHub one speaks REST.
 */
const COMMIT_QUERY = `query ($path: ID!, $sha: String!) {
  project(fullPath: $path) {
    repository {
      commit(ref: $sha) {
        sha
        authorName
        authorEmail
        author { id username name avatarUrl }
      }
    }
  }
}`;

export type GlabCommitAuthorIdentityTransportOptions = {
  /** Test/non-desktop seam. The production path delegates auth to `glab`. */
  run?: (args: string[]) => Promise<string>;
};

export class GlabCliCommitAuthorIdentityTransport
  implements CommitAuthorIdentityTransport {
  private readonly run: (args: string[]) => Promise<string>;

  constructor(options: GlabCommitAuthorIdentityTransportOptions = {}) {
    this.run = options.run ?? runGlab;
  }

  async fetchCommit(proof: CommitAuthorProof): Promise<CommitAuthorRemoteCommit> {
    const stdout = await this.run([
      "api",
      "--hostname",
      proof.repo.host,
      "graphql",
      // Variables, never interpolation — the path and SHA reach GitLab as
      // typed values and cannot alter the query.
      "-f",
      `query=${COMMIT_QUERY}`,
      "-f",
      `path=${proof.repo.path}`,
      "-f",
      `sha=${proof.commitSha}`
    ]);
    const commit = parseGitLabCommitResponse(JSON.parse(stdout));
    if (commit.account !== null || commit.author == null) return commit;

    const fallback = await this.fetchAssociatedMergeRequestAuthor(
      proof,
      commit.author
    );
    return fallback === undefined ? commit : { ...commit, account: fallback };
  }

  /**
   * GitLab links ordinary command-line commits by account email, so a custom
   * unlinked email yields `author: null`. Accept the author of a uniquely
   * associated merge request only when its username matches the commit's own
   * Git author name or email local part — the same guard the GitHub side puts
   * on the same class of weaker claim.
   */
  private async fetchAssociatedMergeRequestAuthor(
    proof: CommitAuthorProof,
    author: NonNullable<CommitAuthorRemoteCommit["author"]>
  ): Promise<ForgeAccountProfile | undefined> {
    const endpoint = [
      "projects",
      encodeURIComponent(proof.repo.path),
      "repository",
      "commits",
      encodeURIComponent(proof.commitSha),
      "merge_requests"
    ].join("/");
    const authors = parseAssociatedMergeRequestAuthors(
      JSON.parse(
        await this.run(["api", "--hostname", proof.repo.host, endpoint, "--method", "GET"])
      )
    );
    if (authors.length !== 1) return undefined;

    const candidate = authors[0]!;
    return associatedAuthorMatches(candidate, author) ? candidate : undefined;
  }
}

export function parseGitLabCommitResponse(
  value: unknown
): CommitAuthorRemoteCommit {
  const commit = asRecord(
    asRecord(asRecord(asRecord(value)?.data)?.project)?.repository
  )?.commit;
  const record = asRecord(commit);
  // A commit GitLab cannot see at all is inconclusive, never a negative.
  if (record === undefined) return {};

  const sha = readString(record.sha);
  const name = readString(record.authorName);
  const email = readString(record.authorEmail);
  const rawAccount = record.author;
  const account =
    rawAccount === null
      ? null
      : toAccountProfile(asRecord(rawAccount));

  return {
    ...(sha === undefined ? {} : { sha }),
    ...(name === undefined && email === undefined
      ? {}
      : {
          author: {
            ...(name === undefined ? {} : { name }),
            ...(email === undefined ? {} : { email })
          }
        }),
    ...(account === undefined ? {} : { account })
  };
}

export function parseAssociatedMergeRequestAuthors(
  value: unknown
): ForgeAccountProfile[] {
  if (!Array.isArray(value)) return [];
  const authors = new Map<string, ForgeAccountProfile>();
  for (const item of value) {
    const profile = toAccountProfile(asRecord(asRecord(item)?.author));
    if (profile !== undefined) authors.set(profile.login.toLowerCase(), profile);
  }
  return [...authors.values()];
}

function toAccountProfile(
  value: Record<string, unknown> | undefined
): ForgeAccountProfile | undefined {
  if (value === undefined) return undefined;
  const login = readString(value.username);
  if (login === undefined) return undefined;
  const id = parseGitLabGlobalId(value.id);
  const avatarUrl = readString(value.avatar_url) ?? readString(value.avatarUrl);
  return {
    ...(id === undefined ? {} : { id }),
    login,
    ...(avatarUrl === undefined ? {} : { avatarUrl })
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
