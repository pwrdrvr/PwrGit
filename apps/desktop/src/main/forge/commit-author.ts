import type { ForgeRepo } from "./types";

/**
 * The evidence a commit-author identity is allowed to rest on.
 *
 * An identity is only ever accepted for an *exact* commit on an *exact* repo:
 * the forge must echo back the same SHA and the same Git author name/email we
 * saw locally. `repo` carries the whole `ForgeRepo` so a nested GitLab path and
 * a self-managed host survive, and so a cache key can be scoped per forge.
 */
export type CommitAuthorProof = {
  repo: ForgeRepo;
  commitSha: string;
};

/** One forge account, in the shape both forges' responses collapse into. */
export type ForgeAccountProfile = {
  /** Numeric account id where the forge exposes one. */
  id?: number;
  /** GitHub login / GitLab username. */
  login: string;
  avatarUrl?: string;
};

/**
 * A forge's verdict on one commit's signature, in the shape GitHub's GraphQL
 * `Commit.signature` collapses into.
 */
export type CommitSignatureVerdict = {
  /** The forge checked the signature and it is good (GitHub: `state: VALID`). */
  valid: boolean;
  /** The forge signed it itself (GitHub: `wasSignedByGitHub`), as it does for
   *  a web merge or squash. That vouches for the forge, not for the author. */
  signedByForge: boolean;
  /** The forge account the signing key belongs to, when the forge names one. */
  signerLogin?: string;
};

/**
 * Canonical subset of a forge's commit response used for verification.
 *
 * `account` is deliberately tri-state and mirrors both forges exactly:
 * - an object — the forge links this commit to that account
 * - `null` — the forge authoritatively says there is no linked account
 * - absent — we could not tell, and nothing may be cached
 */
export type CommitAuthorRemoteCommit = {
  sha?: string | null;
  author?: {
    name?: string | null;
    email?: string | null;
  } | null;
  account?: ForgeAccountProfile | null;
  /**
   * The forge's verdict on this commit's signature. Absent when the forge did
   * not say (no signature, or a forge that never reports one), and dropped
   * when `account` came from a fallback rather than the commit itself.
   */
  signature?: CommitSignatureVerdict;
};

/**
 * Whether a forge answer lets PwrGit call the commit's author verified: the
 * forge found a valid signature, did not make it itself, and the key belongs
 * to the very account the commit is linked to (logins compare case-blind).
 *
 * A squash merge GitHub signed (`web-flow`), a reviewer's signed cherry-pick,
 * or a rebase someone else signed all verify a different person, so each is a
 * match at best. So is a signature with no named signer.
 */
export function signedByAuthor(
  response: Pick<CommitAuthorRemoteCommit, "account" | "signature">
): boolean {
  const signature = response.signature;
  if (signature?.valid !== true || signature.signedByForge) return false;
  const account = safeLower(response.account?.login);
  const signer = safeLower(signature.signerLogin);
  return account !== undefined && account === signer;
}

/**
 * Credential-opaque seam for fetching exact commits from a forge.
 *
 * `fetchCommits` is the batch form, for a forge that can answer many commits
 * in one request. It answers only SHAs the forge could see: an omitted SHA is
 * "not visible" (unpushed, rewritten, or refused), never "no account". A
 * refusal of the whole request — the repository did not resolve, a spent rate
 * limit — throws rather than omitting everything.
 */
export type CommitAuthorIdentityTransport = {
  fetchCommit(proof: CommitAuthorProof): Promise<CommitAuthorRemoteCommit>;
  fetchCommits?(
    repo: ForgeRepo,
    commitShas: readonly string[]
  ): Promise<Map<string, CommitAuthorRemoteCommit>>;
  /** Most SHAs one `fetchCommits` call sends as one request. */
  commitsPerRequest?(repo: ForgeRepo): number;
};

/**
 * Accept an account inferred from an associated change request only when its
 * handle matches the commit's own Git author name or email local part.
 *
 * This is the guard on the weakest evidence either forge offers. GitHub needs
 * it only as a fallback for an unlinked email; on GitLab it is the same rule
 * applied to the same kind of claim.
 */
export function associatedAuthorMatches(
  profile: ForgeAccountProfile,
  author: { name?: string | null; email?: string | null }
): boolean {
  const login = safeLower(profile.login);
  const authorName = safeLower(author.name);
  const authorEmail = safeLower(author.email);
  if (login === undefined || authorName === undefined || authorEmail === undefined) {
    return false;
  }
  if (authorName === login) return true;

  const separator = authorEmail.indexOf("@");
  if (separator <= 0) return false;
  return authorEmail.slice(0, separator) === login;
}

function safeLower(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.normalize("NFC").toLowerCase();
}

/** GitLab GraphQL ids arrive as `gid://gitlab/User/35145513`. */
export function parseGitLabGlobalId(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const match = /\/(\d+)$/.exec(value.trim());
  if (match?.[1] === undefined) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
