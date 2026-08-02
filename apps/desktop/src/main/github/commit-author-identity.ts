import { createHash } from "node:crypto";
import type {
  GitHubCommitAuthorAvatarCacheStatus,
  GitHubCommitAuthorIdentity,
  GitHubCommitAuthorIdentityLookup
} from "@pwrgit/shared";
import type { GitExec } from "../git/dugite";
import type { DB } from "../persistence/db";
import {
  NoopGitHubAvatarThumbnailStore,
  normalizeGitHubAvatarSourceUrl,
  type GitHubAvatarThumbnailStore
} from "./avatar-thumbnail-cache";
import { runGh } from "./gh-cli";
import { parseGitHubRemote } from "./remote";

/** How long a proven GitHub identity remains fresh before revalidation. */
export const GITHUB_COMMIT_AUTHOR_IDENTITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long an exact commit with no GitHub account remains negative-cached. */
export const GITHUB_COMMIT_AUTHOR_IDENTITY_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
/** First delay before retrying a failed remote, auth, or network lookup. */
export const GITHUB_COMMIT_AUTHOR_IDENTITY_INITIAL_BACKOFF_MS = 60 * 1000;
/** Upper bound for exponential retry gates; this service never polls itself. */
export const GITHUB_COMMIT_AUTHOR_IDENTITY_MAX_BACKOFF_MS = 60 * 60 * 1000;

const RESOLVED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const NEGATIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const UNAVAILABLE_RETENTION_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const ACCESS_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export type GitHubCommitAuthorProof = {
  owner: string;
  repo: string;
  commitSha: string;
};

/** Canonical subset of GitHub's REST commit response used for verification. */
export type GitHubCommitAuthorRemoteCommit = {
  sha?: string | null;
  author?: {
    name?: string | null;
    email?: string | null;
  } | null;
  /** `null` means GitHub authoritatively has no associated account. */
  githubAuthor?: {
    login?: string | null;
    avatarUrl?: string | null;
  } | null;
};

/** Credential-opaque seam for fetching one exact GitHub commit. */
export type GitHubCommitAuthorIdentityTransport = {
  fetchCommit(proof: GitHubCommitAuthorProof): Promise<GitHubCommitAuthorRemoteCommit>;
};

export type GhCliCommitAuthorIdentityTransportOptions = {
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
  implements GitHubCommitAuthorIdentityTransport {
  private readonly run: (args: string[]) => Promise<string>;

  constructor(options: GhCliCommitAuthorIdentityTransportOptions = {}) {
    this.run = options.run ?? runGh;
  }

  async fetchCommit(
    proof: GitHubCommitAuthorProof
  ): Promise<GitHubCommitAuthorRemoteCommit> {
    const endpoint = [
      "repos",
      encodeURIComponent(proof.owner),
      encodeURIComponent(proof.repo),
      "commits",
      encodeURIComponent(proof.commitSha)
    ].join("/");
    const stdout = await this.run([
      "api",
      "--hostname",
      "github.com",
      endpoint,
      "--method",
      "GET",
      "--header",
      "Accept: application/vnd.github+json",
      "--header",
      "X-GitHub-Api-Version: 2022-11-28"
    ]);
    return parseGitHubCommitResponse(JSON.parse(stdout));
  }
}

export type GitHubCommitAuthorIdentityRequest = {
  lookup: GitHubCommitAuthorIdentityLookup;
  /** Settles after any best-effort background work and never rejects. */
  completion?: Promise<GitHubCommitAuthorIdentityLookup>;
};

export type GitHubCommitAuthorIdentityServiceOptions = {
  transport?: GitHubCommitAuthorIdentityTransport;
  /** Persistent, local thumbnail cache. Omit only for isolated/unit use. */
  thumbnailStore?: GitHubAvatarThumbnailStore;
  now?: () => number;
  resolvedTtlMs?: number;
  negativeTtlMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
};

type CacheStatus = "resolved" | "negative" | "unavailable";

type CacheEntry = {
  identityKey: string;
  status: CacheStatus;
  /** The remote source URL stays main-process-only; output gets local bytes. */
  identity?: CachedIdentity;
  fetchedAt: number;
  expiresAt: number;
  lastAccessedAt: number;
  failureCount: number;
  nextRetryAt?: number;
  updatedAt: number;
};

type CacheRow = {
  identity_key: string;
  status: string;
  github_login: string | null;
  avatar_url: string | null;
  fetched_at: number;
  expires_at: number;
  last_accessed_at: number;
  failure_count: number;
  next_retry_at: number | null;
  updated_at: number;
};

type NormalizedAuthor = { name: string; email: string };

type CachedIdentity = {
  login: string;
  avatarSourceUrl?: string;
};

type PreparedRequest = {
  worktreeId: string;
  commitSha: string;
  author: NormalizedAuthor;
};

type RemoteOutcome =
  | { kind: "resolved"; identity: CachedIdentity }
  | { kind: "negative" }
  | { kind: "inconclusive" };

/**
 * Persistent exact-proof verification of a local Git commit author's GitHub
 * account. The local name/email remain the source of truth; this service only
 * supplies login/avatar fields after proving an exact GitHub commit match.
 */
export class GitHubCommitAuthorIdentityService {
  private readonly transport: GitHubCommitAuthorIdentityTransport;
  private readonly thumbnails: GitHubAvatarThumbnailStore;
  private readonly now: () => number;
  private readonly resolvedTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly inFlight = new Map<
    string,
    Promise<GitHubCommitAuthorIdentityLookup>
  >();
  private readonly revalidationInFlight = new Map<
    string,
    Promise<CacheEntry | undefined>
  >();
  private lastPrunedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly db: DB,
    private readonly git: GitExec,
    options: GitHubCommitAuthorIdentityServiceOptions = {}
  ) {
    this.transport = options.transport ?? new GhCliCommitAuthorIdentityTransport();
    this.thumbnails = options.thumbnailStore ?? new NoopGitHubAvatarThumbnailStore();
    this.now = options.now ?? Date.now;
    this.resolvedTtlMs = positiveDuration(
      options.resolvedTtlMs,
      GITHUB_COMMIT_AUTHOR_IDENTITY_TTL_MS
    );
    this.negativeTtlMs = positiveDuration(
      options.negativeTtlMs,
      GITHUB_COMMIT_AUTHOR_IDENTITY_NEGATIVE_TTL_MS
    );
    this.initialBackoffMs = positiveDuration(
      options.initialBackoffMs,
      GITHUB_COMMIT_AUTHOR_IDENTITY_INITIAL_BACKOFF_MS
    );
    this.maxBackoffMs = Math.max(
      this.initialBackoffMs,
      positiveDuration(
        options.maxBackoffMs,
        GITHUB_COMMIT_AUTHOR_IDENTITY_MAX_BACKOFF_MS
      )
    );
  }

  /**
   * Start an exact-proof lookup in the background. The GitHub remote must be
   * resolved before a cache row can be read: cache keys are scoped to owner,
   * repo, and full commit SHA, so they cannot bleed across commits or remotes.
   * Callers must render local Git author data immediately and observe
   * `completion` only to repaint. A stale resolved row is returned promptly
   * and then revalidated in the background; `onBackgroundUpdate` receives the
   * resulting targeted repaint without a polling loop.
   */
  request(input: {
    worktreeId: string;
    commitHash: string;
    authorName: string;
    authorEmail: string;
  }, onBackgroundUpdate?: (lookup: GitHubCommitAuthorIdentityLookup) => void): GitHubCommitAuthorIdentityRequest {
    const author = normalizeAuthor({
      name: input.authorName,
      email: input.authorEmail
    });
    if (author === undefined) return { lookup: notEligibleLookup() };

    const worktreeId = safeText(input.worktreeId, 512);
    const commitSha = normalizeCommitSha(input.commitHash);
    if (worktreeId === undefined || commitSha === undefined) {
      return { lookup: notEligibleLookup() };
    }

    this.pruneIfDue(this.now());

    const completion = this.startRefresh({
      worktreeId,
      commitSha,
      author
    }, onBackgroundUpdate);
    return {
      lookup: { cacheState: "miss", refreshState: "in-flight" },
      completion
    };
  }

  private startRefresh(
    prepared: PreparedRequest,
    onBackgroundUpdate?: (lookup: GitHubCommitAuthorIdentityLookup) => void
  ): Promise<GitHubCommitAuthorIdentityLookup> {
    const requestKey = buildRequestKey(prepared);
    const existing = this.inFlight.get(requestKey);
    if (existing !== undefined) return existing;

    const completion = Promise.resolve()
      .then(async () => await this.refresh(prepared, onBackgroundUpdate))
      .catch(
        (): GitHubCommitAuthorIdentityLookup => ({
          cacheState: "miss",
          refreshState: "backing-off"
        })
      );

    this.inFlight.set(requestKey, completion);
    void completion.then(() => {
      if (this.inFlight.get(requestKey) === completion) {
        this.inFlight.delete(requestKey);
      }
    });
    return completion;
  }

  private async refresh(
    prepared: PreparedRequest,
    onBackgroundUpdate?: (lookup: GitHubCommitAuthorIdentityLookup) => void
  ): Promise<GitHubCommitAuthorIdentityLookup> {
    let identityKey: string | undefined;
    try {
      const worktree = this.db
        .prepare("SELECT path FROM worktrees WHERE id = ?")
        .get(prepared.worktreeId) as { path: string } | undefined;
      if (worktree === undefined) return notEligibleLookup();

      const remote = await this.originRemote(worktree.path);
      if (remote === null) return notEligibleLookup();
      if (remote === undefined) {
        return { cacheState: "miss", refreshState: "backing-off" };
      }

      const proof = normalizeProof({
        owner: remote.owner,
        repo: remote.repo,
        commitSha: prepared.commitSha
      });
      if (proof === undefined) return notEligibleLookup();
      identityKey = buildGitHubCommitAuthorIdentityCacheKey(prepared.author, proof);
      if (identityKey === undefined) return notEligibleLookup();

      const now = this.now();
      const cached = this.readCache(identityKey);
      if (cached !== undefined) this.touch(cached, now);

      if (isFresh(cached, now)) {
        return await this.lookupFromCache(cached, now, "idle", onBackgroundUpdate);
      }
      if (cached?.nextRetryAt !== undefined && cached.nextRetryAt > now) {
        return await this.lookupFromCache(cached, now, "backing-off", onBackgroundUpdate);
      }

      // Preserve a known local identity (and its on-disk thumbnail) while the
      // next exact-commit proof runs. This is stale-while-revalidate, never a
      // shortcut around the origin/SHA proof that was already established.
      if (cached?.status === "resolved" || cached?.status === "negative") {
        const stale = await this.lookupFromCache(
          cached,
          now,
          "in-flight",
          onBackgroundUpdate
        );
        this.scheduleRevalidation(prepared, proof, identityKey, onBackgroundUpdate);
        return stale;
      }

      const refreshed = await this.revalidate(prepared, proof, identityKey);
      const completedAt = this.now();
      return await this.lookupFromCache(
        refreshed,
        completedAt,
        refreshStateFor(refreshed, completedAt),
        onBackgroundUpdate
      );
    } catch {
      const now = this.now();
      if (identityKey === undefined) {
        return { cacheState: "miss", refreshState: "backing-off" };
      }
      this.recordFailure(identityKey, now);
      const cached = this.readCache(identityKey);
      return await this.lookupFromCache(cached, now, "backing-off", onBackgroundUpdate);
    }
  }

  private scheduleRevalidation(
    prepared: PreparedRequest,
    proof: GitHubCommitAuthorProof,
    identityKey: string,
    onBackgroundUpdate?: (lookup: GitHubCommitAuthorIdentityLookup) => void
  ): void {
    void this.revalidate(prepared, proof, identityKey)
      .then(async (entry) => {
        if (onBackgroundUpdate === undefined) return;
        const now = this.now();
        onBackgroundUpdate(
          await this.lookupFromCache(
            entry,
            now,
            refreshStateFor(entry, now),
            onBackgroundUpdate
          )
        );
      })
      .catch(() => {
        // `revalidate` handles expected failures; never surface a card error.
      });
  }

  private revalidate(
    prepared: PreparedRequest,
    proof: GitHubCommitAuthorProof,
    identityKey: string
  ): Promise<CacheEntry | undefined> {
    const existing = this.revalidationInFlight.get(identityKey);
    if (existing !== undefined) return existing;

    const completion = Promise.resolve()
      .then(async () => {
        const response = await this.transport.fetchCommit(proof);
        const completedAt = this.now();
        const outcome = evaluateRemoteCommit(response, prepared.author, proof);
        if (outcome.kind === "resolved") {
          this.writeResolved({
            identityKey,
            identity: outcome.identity,
            fetchedAt: completedAt,
            expiresAt: completedAt + this.resolvedTtlMs
          });
        } else if (outcome.kind === "negative") {
          this.writeNegative({
            identityKey,
            fetchedAt: completedAt,
            expiresAt: completedAt + this.negativeTtlMs
          });
        } else {
          this.recordFailure(identityKey, completedAt);
        }
        return this.readCache(identityKey);
      })
      .catch(() => {
        this.recordFailure(identityKey, this.now());
        return this.readCache(identityKey);
      });

    this.revalidationInFlight.set(identityKey, completion);
    void completion.then(() => {
      if (this.revalidationInFlight.get(identityKey) === completion) {
        this.revalidationInFlight.delete(identityKey);
      }
    });
    return completion;
  }

  private async lookupFromCache(
    entry: CacheEntry | undefined,
    now: number,
    refreshState: GitHubCommitAuthorIdentityLookup["refreshState"],
    onBackgroundUpdate?: (lookup: GitHubCommitAuthorIdentityLookup) => void
  ): Promise<GitHubCommitAuthorIdentityLookup> {
    if (entry?.identity === undefined) return toLookup(entry, now, refreshState);

    const identity: GitHubCommitAuthorIdentity = { login: entry.identity.login };
    const sourceUrl = entry.identity.avatarSourceUrl;
    if (sourceUrl === undefined) return toLookup(entry, now, refreshState, identity);

    try {
      const thumbnail = await this.thumbnails.read(sourceUrl, now);
      if (thumbnail.avatarUrl !== undefined) identity.avatarUrl = thumbnail.avatarUrl;
      const avatarCache = toAvatarCacheStatus(
        thumbnail,
        thumbnail.needsRefresh ? "in-flight" : undefined
      );
      if (thumbnail.needsRefresh) {
        this.scheduleThumbnailRefresh(
          entry,
          sourceUrl,
          now,
          refreshState,
          identity.avatarUrl,
          onBackgroundUpdate
        );
      }
      return toLookup(entry, now, refreshState, identity, avatarCache);
    } catch {
      // A damaged/missing local thumbnail must not hide a proven login.
    }
    return toLookup(entry, now, refreshState, identity);
  }

  private scheduleThumbnailRefresh(
    entry: CacheEntry,
    sourceUrl: string,
    now: number,
    refreshState: GitHubCommitAuthorIdentityLookup["refreshState"],
    previousAvatarUrl: string | undefined,
    onBackgroundUpdate?: (lookup: GitHubCommitAuthorIdentityLookup) => void
  ): void {
    void this.thumbnails
      .refresh(sourceUrl, now)
      .then((thumbnail) => {
        if (onBackgroundUpdate === undefined) return;
        const current = this.readCache(entry.identityKey);
        if (
          current?.identity === undefined ||
          current.identity.login !== entry.identity?.login ||
          current.identity.avatarSourceUrl !== sourceUrl
        ) {
          return;
        }
        const avatarUrl = thumbnail.avatarUrl ?? previousAvatarUrl;
        onBackgroundUpdate(
          toLookup(current, this.now(), refreshState, {
            login: current.identity.login,
            ...(avatarUrl === undefined ? {} : { avatarUrl })
          }, toAvatarCacheStatus(thumbnail))
        );
      })
      .catch(() => {
        // The thumbnail store has its own persisted backoff; remain silent.
      });
  }

  /** `null` is a recognized non-GitHub remote; `undefined` is a transient Git failure. */
  private async originRemote(
    worktreePath: string
  ): Promise<{ owner: string; repo: string } | null | undefined> {
    const result = await this.git(["remote", "get-url", "origin"], worktreePath);
    if (!result.ok || result.value.exitCode !== 0) return undefined;
    return parseGitHubRemote(result.value.stdout);
  }

  private readCache(identityKey: string): CacheEntry | undefined {
    try {
      const row = this.db
        .prepare(
          `SELECT identity_key, status, github_login, avatar_url, fetched_at,
                  expires_at, last_accessed_at, failure_count, next_retry_at, updated_at
             FROM github_commit_author_identity_cache
            WHERE identity_key = ?`
        )
        .get(identityKey) as CacheRow | undefined;
      return row === undefined ? undefined : parseCacheRow(row);
    } catch {
      return undefined;
    }
  }

  private writeResolved(params: {
    identityKey: string;
    identity: CachedIdentity;
    fetchedAt: number;
    expiresAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO github_commit_author_identity_cache(
           identity_key, status, github_login, avatar_url, fetched_at,
           expires_at, last_accessed_at, failure_count, next_retry_at, updated_at
         ) VALUES (?, 'resolved', ?, ?, ?, ?, ?, 0, NULL, ?)
         ON CONFLICT(identity_key) DO UPDATE SET
           status = excluded.status,
           github_login = excluded.github_login,
           avatar_url = excluded.avatar_url,
           fetched_at = excluded.fetched_at,
           expires_at = excluded.expires_at,
           last_accessed_at = excluded.last_accessed_at,
           failure_count = 0,
           next_retry_at = NULL,
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= github_commit_author_identity_cache.updated_at`
      )
      .run(
        params.identityKey,
        params.identity.login,
        params.identity.avatarSourceUrl ?? null,
        params.fetchedAt,
        params.expiresAt,
        params.fetchedAt,
        params.fetchedAt
      );
  }

  private writeNegative(params: {
    identityKey: string;
    fetchedAt: number;
    expiresAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO github_commit_author_identity_cache(
           identity_key, status, github_login, avatar_url, fetched_at,
           expires_at, last_accessed_at, failure_count, next_retry_at, updated_at
         ) VALUES (?, 'negative', NULL, NULL, ?, ?, ?, 0, NULL, ?)
         ON CONFLICT(identity_key) DO UPDATE SET
           status = excluded.status,
           github_login = NULL,
           avatar_url = NULL,
           fetched_at = excluded.fetched_at,
           expires_at = excluded.expires_at,
           last_accessed_at = excluded.last_accessed_at,
           failure_count = 0,
           next_retry_at = NULL,
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= github_commit_author_identity_cache.updated_at`
      )
      .run(
        params.identityKey,
        params.fetchedAt,
        params.expiresAt,
        params.fetchedAt,
        params.fetchedAt
      );
  }

  /** Keep stale proven data while a temporary failure is backed off. */
  private recordFailure(identityKey: string, now: number): void {
    const failureCount = Math.min(
      16,
      (this.readCache(identityKey)?.failureCount ?? 0) + 1
    );
    const retryAfterMs = backoffMs(
      failureCount,
      this.initialBackoffMs,
      this.maxBackoffMs
    );
    try {
      this.db
        .prepare(
          `INSERT INTO github_commit_author_identity_cache(
             identity_key, status, github_login, avatar_url, fetched_at,
             expires_at, last_accessed_at, failure_count, next_retry_at, updated_at
           ) VALUES (?, 'unavailable', NULL, NULL, 0, 0, ?, ?, ?, ?)
           ON CONFLICT(identity_key) DO UPDATE SET
             failure_count = excluded.failure_count,
             next_retry_at = excluded.next_retry_at,
             updated_at = excluded.updated_at
           WHERE excluded.updated_at >= github_commit_author_identity_cache.updated_at
             AND (
               github_commit_author_identity_cache.status = 'unavailable'
               OR github_commit_author_identity_cache.expires_at <= excluded.updated_at
             )`
        )
        .run(identityKey, now, failureCount, now + retryAfterMs, now);
    } catch {
      // Cache problems never become visible commit-card failures.
    }
  }

  private touch(entry: CacheEntry, now: number): void {
    if (now - entry.lastAccessedAt < ACCESS_TOUCH_INTERVAL_MS) return;
    try {
      this.db
        .prepare(
          `UPDATE github_commit_author_identity_cache
              SET last_accessed_at = ?
            WHERE identity_key = ? AND last_accessed_at <= ?`
        )
        .run(now, entry.identityKey, now - ACCESS_TOUCH_INTERVAL_MS);
    } catch {
      // A cache read is still useful if the last-access bookkeeping cannot write.
    }
  }

  private pruneIfDue(now: number): void {
    if (now - this.lastPrunedAt < PRUNE_INTERVAL_MS) return;
    this.lastPrunedAt = now;
    void this.thumbnails.pruneIfDue(now);
    try {
      this.db
        .prepare(
          `DELETE FROM github_commit_author_identity_cache
            WHERE (status = 'resolved' AND last_accessed_at < ?)
               OR (status = 'negative' AND last_accessed_at < ?)
               OR (status = 'unavailable' AND last_accessed_at < ?)`
        )
        .run(
          now - RESOLVED_RETENTION_MS,
          now - NEGATIVE_RETENTION_MS,
          now - UNAVAILABLE_RETENTION_MS
        );
    } catch {
      // A cache cleanup failure must not affect an author lookup.
    }
  }
}

/**
 * Versioned opaque cache key for one exact, remote-proven commit. Raw author
 * fields, remote name, and commit SHA are never persisted outside this digest.
 */
export function buildGitHubCommitAuthorIdentityCacheKey(
  author: { name: string; email: string },
  proof: GitHubCommitAuthorProof
): string | undefined {
  const normalized = normalizeAuthor(author);
  const normalizedProof = normalizeProof(proof);
  if (normalized === undefined || normalizedProof === undefined) return undefined;
  return createHash("sha256")
    .update(
      `pwrgit-github-commit-author-identity:v2\0${normalizedProof.owner}\0${normalizedProof.repo}\0${normalizedProof.commitSha}\0${normalized.email}\0${normalized.name}`
    )
    .digest("hex");
}

function buildRequestKey(prepared: PreparedRequest): string {
  return createHash("sha256")
    .update(
      `pwrgit-github-commit-author-request:v1\0${prepared.worktreeId}\0${prepared.commitSha}\0${prepared.author.email}\0${prepared.author.name}`
    )
    .digest("hex");
}

function parseGitHubCommitResponse(value: unknown): GitHubCommitAuthorRemoteCommit {
  const response = asRecord(value);
  const commit = asRecord(response?.commit);
  const commitAuthor = asRecord(commit?.author);
  const githubAuthor = response?.author === null ? null : asRecord(response?.author);
  const sha = readString(response?.sha);
  const author =
    commitAuthor === undefined
      ? undefined
      : toRemoteCommitAuthor(commitAuthor);
  const identity =
    githubAuthor === null
      ? null
      : githubAuthor === undefined
        ? undefined
        : toRemoteGitHubAuthor(githubAuthor);

  return {
    ...(sha === undefined ? {} : { sha }),
    ...(author === undefined ? {} : { author }),
    ...(identity === undefined ? {} : { githubAuthor: identity })
  };
}

function evaluateRemoteCommit(
  response: GitHubCommitAuthorRemoteCommit,
  expectedAuthor: NormalizedAuthor,
  expectedProof: GitHubCommitAuthorProof
): RemoteOutcome {
  if (normalizeCommitSha(response.sha) !== expectedProof.commitSha) {
    return { kind: "inconclusive" };
  }
  const remoteAuthor = normalizeAuthor(response.author);
  if (
    remoteAuthor === undefined ||
    remoteAuthor.name !== expectedAuthor.name ||
    remoteAuthor.email !== expectedAuthor.email
  ) {
    return { kind: "inconclusive" };
  }
  if (response.githubAuthor === null) return { kind: "negative" };
  const identity = normalizeGitHubIdentity(response.githubAuthor);
  return identity === undefined
    ? { kind: "inconclusive" }
    : { kind: "resolved", identity };
}

function parseCacheRow(row: CacheRow): CacheEntry | undefined {
  if (
    !isCacheStatus(row.status) ||
    !isTimestamp(row.fetched_at) ||
    !isTimestamp(row.expires_at) ||
    !isTimestamp(row.last_accessed_at) ||
    !isTimestamp(row.updated_at) ||
    !Number.isSafeInteger(row.failure_count) ||
    row.failure_count < 0
  ) {
    return undefined;
  }

  const nextRetryAt = isTimestamp(row.next_retry_at) ? row.next_retry_at : undefined;
  if (row.status === "resolved") {
    const login = safeText(row.github_login, 255);
    if (login === undefined) return undefined;
    const avatarSourceUrl = normalizeAvatarUrl(row.avatar_url);
    return {
      identityKey: row.identity_key,
      status: row.status,
      identity: {
        login,
        ...(avatarSourceUrl === undefined ? {} : { avatarSourceUrl })
      },
      fetchedAt: row.fetched_at,
      expiresAt: row.expires_at,
      lastAccessedAt: row.last_accessed_at,
      failureCount: row.failure_count,
      ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
      updatedAt: row.updated_at
    };
  }

  return {
    identityKey: row.identity_key,
    status: row.status,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
    lastAccessedAt: row.last_accessed_at,
    failureCount: row.failure_count,
    ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
    updatedAt: row.updated_at
  };
}

function normalizeAuthor(value: unknown): NormalizedAuthor | undefined {
  if (!isRecord(value)) return undefined;
  const name = safeText(value.name, 512)?.normalize("NFC");
  const email = safeText(value.email, 320)?.normalize("NFC").toLowerCase();
  return name !== undefined && email !== undefined && email.includes("@") && !/\s/.test(email)
    ? { name, email }
    : undefined;
}

function normalizeCommitSha(value: unknown): string | undefined {
  const sha = safeText(value, 40)?.toLowerCase();
  return sha !== undefined && /^[a-f0-9]{40}$/.test(sha) ? sha : undefined;
}

function normalizeProof(value: unknown): GitHubCommitAuthorProof | undefined {
  if (!isRecord(value)) return undefined;
  const owner = normalizeGitHubPathSegment(value.owner);
  const repo = normalizeGitHubPathSegment(value.repo);
  const commitSha = normalizeCommitSha(value.commitSha);
  return owner === undefined || repo === undefined || commitSha === undefined
    ? undefined
    : { owner, repo, commitSha };
}

function normalizeGitHubPathSegment(value: unknown): string | undefined {
  const segment = safeText(value, 100);
  return segment !== undefined && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(segment)
    ? segment
    : undefined;
}

function normalizeGitHubIdentity(
  value: GitHubCommitAuthorRemoteCommit["githubAuthor"]
): CachedIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const login = safeText(value.login, 255);
  if (login === undefined) return undefined;
  const avatarSourceUrl = normalizeAvatarUrl(value.avatarUrl);
  return {
    login,
    ...(avatarSourceUrl === undefined ? {} : { avatarSourceUrl })
  };
}

function normalizeAvatarUrl(value: unknown): string | undefined {
  const raw = safeText(value, 2_048);
  return raw === undefined ? undefined : normalizeGitHubAvatarSourceUrl(raw);
}

function toLookup(
  entry: CacheEntry | undefined,
  now: number,
  refreshState: GitHubCommitAuthorIdentityLookup["refreshState"],
  identity?: GitHubCommitAuthorIdentity,
  avatarCache?: GitHubCommitAuthorAvatarCacheStatus
): GitHubCommitAuthorIdentityLookup {
  const cacheState =
    entry === undefined || entry.status === "unavailable"
      ? "miss"
      : entry.expiresAt > now
        ? "fresh"
        : "stale";
  return {
    ...(identity === undefined ? {} : { identity }),
    cacheState,
    refreshState,
    ...(entry !== undefined && entry.status !== "unavailable" && entry.fetchedAt > 0
      ? { refreshedAt: entry.fetchedAt }
      : {}),
    ...(entry?.nextRetryAt === undefined ? {} : { nextRetryAt: entry.nextRetryAt }),
    ...(avatarCache === undefined ? {} : { avatarCache })
  };
}

function toAvatarCacheStatus(
  thumbnail: Awaited<ReturnType<GitHubAvatarThumbnailStore["read"]>>,
  refreshState?: "in-flight"
): GitHubCommitAuthorAvatarCacheStatus | undefined {
  if (thumbnail.cacheState === "fresh" && thumbnail.refreshState === "idle") {
    return undefined;
  }
  const effectiveRefreshState = refreshState ?? thumbnail.refreshState;
  if (effectiveRefreshState !== "in-flight" && effectiveRefreshState !== "backing-off") {
    return undefined;
  }
  return {
    cacheState: thumbnail.cacheState === "stale" ? "stale" : "miss",
    refreshState: effectiveRefreshState,
    ...(thumbnail.refreshedAt === undefined ? {} : { refreshedAt: thumbnail.refreshedAt }),
    ...(thumbnail.nextRetryAt === undefined ? {} : { nextRetryAt: thumbnail.nextRetryAt })
  };
}

function refreshStateFor(
  entry: CacheEntry | undefined,
  now: number
): GitHubCommitAuthorIdentityLookup["refreshState"] {
  return entry === undefined || (entry.nextRetryAt !== undefined && entry.nextRetryAt > now)
    ? "backing-off"
    : "idle";
}

function notEligibleLookup(): GitHubCommitAuthorIdentityLookup {
  return { cacheState: "miss", refreshState: "not-eligible" };
}

function isFresh(entry: CacheEntry | undefined, now: number): boolean {
  return entry !== undefined && entry.status !== "unavailable" && entry.expiresAt > now;
}

function isCacheStatus(value: string): value is CacheStatus {
  return value === "resolved" || value === "negative" || value === "unavailable";
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized !== "" &&
    normalized.length <= maxLength &&
    !hasControlCharacter(normalized)
    ? normalized
    : undefined;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function toRemoteCommitAuthor(
  value: Record<string, unknown>
): NonNullable<GitHubCommitAuthorRemoteCommit["author"]> {
  const name = readString(value.name);
  const email = readString(value.email);
  return {
    ...(name === undefined ? {} : { name }),
    ...(email === undefined ? {} : { email })
  };
}

function toRemoteGitHubAuthor(
  value: Record<string, unknown>
): NonNullable<GitHubCommitAuthorRemoteCommit["githubAuthor"]> {
  const login = readString(value.login);
  const avatarUrl = readString(value.avatar_url);
  return {
    ...(login === undefined ? {} : { login }),
    ...(avatarUrl === undefined ? {} : { avatarUrl })
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function backoffMs(
  failureCount: number,
  initialBackoffMs: number,
  maxBackoffMs: number
): number {
  return Math.min(
    maxBackoffMs,
    initialBackoffMs * 2 ** Math.max(0, failureCount - 1)
  );
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
