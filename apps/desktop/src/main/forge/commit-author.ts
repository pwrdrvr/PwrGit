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
};

/** Credential-opaque seam for fetching one exact commit from a forge. */
export type CommitAuthorIdentityTransport = {
  fetchCommit(proof: CommitAuthorProof): Promise<CommitAuthorRemoteCommit>;
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
