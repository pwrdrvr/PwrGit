import { runGh } from "../../github/gh-cli";
import {
  associatedAuthorMatches,
  type CommitAuthorIdentityTransport,
  type CommitAuthorProof,
  type CommitAuthorRemoteCommit,
  type ForgeAccountProfile
} from "../commit-author";

export type GhCommitAuthorIdentityTransportOptions = {
  /** Test/non-desktop seam. The production path delegates auth to `gh`. */
  run?: (args: string[]) => Promise<string>;
};

/**
 * Fetches exact commit metadata through `gh api` without extracting a token.
 *
 * `gh` reads its own credential store; no token enters this class, the service,
 * cache, shared protocol, logs, or renderer process.
 */
export class GhCliCommitAuthorIdentityTransport
  implements CommitAuthorIdentityTransport {
  private readonly run: (args: string[]) => Promise<string>;

  constructor(options: GhCommitAuthorIdentityTransportOptions = {}) {
    this.run = options.run ?? runGh;
  }

  async fetchCommit(proof: CommitAuthorProof): Promise<CommitAuthorRemoteCommit> {
    const commit = parseGitHubCommitResponse(
      JSON.parse(await this.api(proof, ["commits", proof.commitSha]))
    );
    if (commit.account !== null || commit.author == null) return commit;

    const fallback = await this.fetchAssociatedPullAuthor(proof, commit.author);
    return fallback === undefined ? commit : { ...commit, account: fallback };
  }

  /**
   * GitHub links ordinary command-line commits by account email. For a custom
   * unlinked email, accept a unique associated-PR author only when its handle
   * matches the exact commit author's Git name or email local part.
   */
  private async fetchAssociatedPullAuthor(
    proof: CommitAuthorProof,
    author: NonNullable<CommitAuthorRemoteCommit["author"]>
  ): Promise<ForgeAccountProfile | undefined> {
    const pulls = parseAssociatedPullAuthors(
      JSON.parse(await this.api(proof, ["commits", proof.commitSha, "pulls"]))
    );
    if (pulls.length !== 1) return undefined;

    const pullAuthor = pulls[0]!;
    return associatedAuthorMatches(pullAuthor, author) ? pullAuthor : undefined;
  }

  private async api(proof: CommitAuthorProof, tail: string[]): Promise<string> {
    const endpoint = ["repos", proof.repo.path, ...tail.map(encodeURIComponent)].join(
      "/"
    );
    return await this.run([
      "api",
      "--hostname",
      proof.repo.host,
      endpoint,
      "--method",
      "GET",
      "--header",
      "Accept: application/vnd.github+json",
      "--header",
      "X-GitHub-Api-Version: 2022-11-28"
    ]);
  }
}

export function parseGitHubCommitResponse(
  value: unknown
): CommitAuthorRemoteCommit {
  const response = asRecord(value);
  const commitAuthor = asRecord(asRecord(response?.commit)?.author);
  const sha = readString(response?.sha);
  const name = readString(commitAuthor?.name);
  const email = readString(commitAuthor?.email);
  const account =
    response?.author === null ? null : toAccountProfile(asRecord(response?.author));

  return {
    ...(sha === undefined ? {} : { sha }),
    ...(commitAuthor === undefined
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

export function parseAssociatedPullAuthors(value: unknown): ForgeAccountProfile[] {
  if (!Array.isArray(value)) return [];
  const authors = new Map<string, ForgeAccountProfile>();
  for (const item of value) {
    const profile = toAccountProfile(asRecord(asRecord(item)?.user));
    if (profile !== undefined) authors.set(profile.login.toLowerCase(), profile);
  }
  return [...authors.values()];
}

function toAccountProfile(
  value: Record<string, unknown> | undefined
): ForgeAccountProfile | undefined {
  if (value === undefined) return undefined;
  const login = readString(value.login);
  if (login === undefined) return undefined;
  const id = readSafeInteger(value.id);
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

function readSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}
