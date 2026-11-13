import { runGh, type GhRunOptions } from "../../github/gh-cli";
import {
  associatedAuthorMatches,
  type CommitAuthorIdentityTransport,
  type CommitAuthorProof,
  type CommitAuthorRemoteCommit,
  type CommitSignatureVerdict,
  type ForgeAccountProfile
} from "../commit-author";
import { githubOwnerAndName } from "../resolve";
import type { ForgeRepo } from "../types";

/** Commits one GraphQL request asks about, as `pr-query.ts` batches branches. */
export const GITHUB_COMMITS_PER_REQUEST = 50;
/**
 * Associated pull requests read per commit for the unlinked-email fallback,
 * the size of the REST page it replaces. More than this and the author cannot
 * be shown to be unique, so it declines.
 */
const ASSOCIATED_PULLS = 30;
/**
 * One request answers up to 50 commits, and `associatedPullRequests` is slow
 * on a large repository, so it gets longer than the runner's 10 s default
 * meant for a single REST call. A timeout fails every commit in the batch.
 */
const BATCH_TIMEOUT_MS = 30_000;

const COMMIT_FIELDS = `fragment CommitAuthorFields on Commit {
  oid
  author { name email user { login databaseId avatarUrl } }
  signature { isValid state wasSignedByGitHub signer { login } }
  associatedPullRequests(first: ${ASSOCIATED_PULLS}) {
    totalCount
    nodes { author { login avatarUrl ... on User { databaseId } } }
  }
}`;

export type GhCommitAuthorIdentityTransportOptions = {
  /** Test/non-desktop seam. The production path delegates auth to `gh`. */
  run?: (args: string[], options?: GhRunOptions) => Promise<string>;
};

/**
 * Fetches exact commit metadata through `gh api graphql`, many commits per
 * request, without extracting a token.
 *
 * `gh` reads its own credential store; no token enters this class, the service,
 * cache, shared protocol, logs, or renderer process.
 *
 * GraphQL, not REST: one request answers up to `GITHUB_COMMITS_PER_REQUEST`
 * commits, and only GraphQL names who made a signature (`signer.login`) and
 * whether GitHub made it itself (`wasSignedByGitHub`). REST's
 * `verification.verified` says neither.
 */
export class GhCliCommitAuthorIdentityTransport
  implements CommitAuthorIdentityTransport {
  private readonly run: (args: string[], options?: GhRunOptions) => Promise<string>;

  constructor(options: GhCommitAuthorIdentityTransportOptions = {}) {
    this.run = options.run ?? runGh;
  }

  async fetchCommit(proof: CommitAuthorProof): Promise<CommitAuthorRemoteCommit> {
    return (await this.fetchCommits(proof.repo, [proof.commitSha])).get(proof.commitSha) ?? {};
  }

  /** One request for at most `GITHUB_COMMITS_PER_REQUEST` SHAs; more throws. */
  async fetchCommits(
    repo: ForgeRepo,
    commitShas: readonly string[]
  ): Promise<Map<string, CommitAuthorRemoteCommit>> {
    if (commitShas.length === 0) return new Map();
    if (commitShas.length > GITHUB_COMMITS_PER_REQUEST) {
      throw new RangeError(
        `At most ${GITHUB_COMMITS_PER_REQUEST} commits per request, got ${commitShas.length}`
      );
    }
    const target = githubOwnerAndName(repo);
    if (target === null) throw new Error("Not a GitHub owner/name path");
    const { query, variables } = buildCommitAuthorQuery(target, commitShas);
    const args = ["api", "--hostname", repo.host, "graphql", "-f", `query=${query}`];
    // Variables, never interpolation: the owner, name and SHAs reach GitHub
    // as typed values and cannot alter the query.
    for (const [name, value] of Object.entries(variables)) {
      args.push("-f", `${name}=${value}`);
    }
    return parseGitHubCommitAuthorResponse(
      commitShas,
      JSON.parse(await this.run(args, { timeoutMs: BATCH_TIMEOUT_MS }))
    );
  }

  commitsPerRequest(): number {
    return GITHUB_COMMITS_PER_REQUEST;
  }
}

/** One aliased `object(oid: $cN)` per commit under one `repository`. */
export function buildCommitAuthorQuery(
  target: { owner: string; name: string },
  commitShas: readonly string[]
): { query: string; variables: Record<string, string> } {
  const variables: Record<string, string> = { owner: target.owner, name: target.name };
  const decls = ["$owner: String!", "$name: String!"];
  const aliases: string[] = [];
  commitShas.forEach((sha, i) => {
    variables[`c${i}`] = sha;
    decls.push(`$c${i}: GitObjectID!`);
    aliases.push(`c${i}: object(oid: $c${i}) { ...CommitAuthorFields }`);
  });
  const query = `query (${decls.join(", ")}) {
  repository(owner: $owner, name: $name) {
    ${aliases.join("\n    ")}
  }
}
${COMMIT_FIELDS}`;
  return { query, variables };
}

/**
 * Map a response back to SHA → commit. Only commits GitHub could see are
 * answered; a null alias (not pushed, rewritten away) is omitted, which the
 * service treats as inconclusive rather than "no account".
 *
 * Check the container, not `data`: a refusal (SAML, a revoked scope, a spent
 * budget) answers `{"data":{"repository":null},"errors":[…]}`, and reading
 * aliases off it would say "not visible" for every commit. It throws instead.
 */
export function parseGitHubCommitAuthorResponse(
  commitShas: readonly string[],
  value: unknown
): Map<string, CommitAuthorRemoteCommit> {
  const repository = asRecord(asRecord(asRecord(value)?.data)?.repository);
  if (repository === undefined) {
    throw new Error("GitHub did not resolve the repository for a commit-author query");
  }
  const answers = new Map<string, CommitAuthorRemoteCommit>();
  commitShas.forEach((sha, i) => {
    const node = asRecord(repository[`c${i}`]);
    if (node === undefined) return;
    const commit = parseCommitNode(node);
    if (commit.sha?.toLowerCase() === sha.toLowerCase()) answers.set(sha, commit);
  });
  return answers;
}

function parseCommitNode(node: Record<string, unknown>): CommitAuthorRemoteCommit {
  const sha = readString(node.oid);
  const gitAuthor = asRecord(node.author);
  const name = readString(gitAuthor?.name);
  const email = readString(gitAuthor?.email);
  const linked = gitAuthor === undefined
    ? undefined
    : gitAuthor.user === null
      ? null
      : toAccountProfile(asRecord(gitAuthor.user));
  const signature = parseSignature(asRecord(node.signature));
  const commit: CommitAuthorRemoteCommit = {
    ...(sha === undefined ? {} : { sha }),
    ...(gitAuthor === undefined
      ? {}
      : {
          author: {
            ...(name === undefined ? {} : { name }),
            ...(email === undefined ? {} : { email })
          }
        }),
    ...(linked === undefined ? {} : { account: linked }),
    ...(signature === undefined ? {} : { signature })
  };
  if (commit.account !== null || commit.author == null) return commit;

  // GitHub links ordinary command-line commits by account email. For a custom
  // unlinked email, accept a unique associated-PR author only when its handle
  // matches the exact commit author's Git name or email local part.
  const fallback = uniquePullAuthor(asRecord(node.associatedPullRequests));
  if (fallback === undefined || !associatedAuthorMatches(fallback, commit.author)) {
    return commit;
  }
  // The signature vouches for the commit's own link, which was empty; it says
  // nothing about an account a pull request supplied.
  const matched: CommitAuthorRemoteCommit = { ...commit, account: fallback };
  delete matched.signature;
  return matched;
}

function parseSignature(
  value: Record<string, unknown> | undefined
): CommitSignatureVerdict | undefined {
  if (value === undefined) return undefined;
  const signerLogin = readString(asRecord(value.signer)?.login);
  return {
    valid: value.isValid === true && value.state === "VALID",
    signedByForge: value.wasSignedByGitHub === true,
    ...(signerLogin === undefined ? {} : { signerLogin })
  };
}

/** The one author of every associated PR, or undefined if not provably one. */
function uniquePullAuthor(
  connection: Record<string, unknown> | undefined
): ForgeAccountProfile | undefined {
  const nodes = Array.isArray(connection?.nodes) ? connection.nodes : [];
  const total = connection?.totalCount;
  // PRs past the page could have another author, so uniqueness is unproven.
  if (typeof total !== "number" || total > nodes.length) return undefined;
  const authors = new Map<string, ForgeAccountProfile>();
  for (const node of nodes) {
    const profile = toAccountProfile(asRecord(asRecord(node)?.author));
    if (profile !== undefined) authors.set(profile.login.toLowerCase(), profile);
  }
  return authors.size === 1 ? [...authors.values()][0] : undefined;
}

function toAccountProfile(
  value: Record<string, unknown> | undefined
): ForgeAccountProfile | undefined {
  if (value === undefined) return undefined;
  const login = readString(value.login);
  if (login === undefined) return undefined;
  const id = readSafeInteger(value.databaseId);
  const avatarUrl = readString(value.avatarUrl);
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
