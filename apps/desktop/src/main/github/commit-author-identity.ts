import { createHash } from "node:crypto";
import type {
  GitHubCommitAuthorAvatarCacheStatus,
  GitHubCommitAuthorIdentity,
  GitHubCommitAuthorIdentityLookup
} from "@pwrgit/shared";
import type { GitExec } from "../git/dugite";
import type { DB } from "../persistence/db";
import { normalizeForgeAvatarSourceUrl, rememberForgeAvatarHost } from "../forge/avatar-source";
import type {
  CommitAuthorIdentityTransport,
  CommitAuthorProof,
  CommitAuthorRemoteCommit,
  ForgeAccountProfile
} from "../forge/commit-author";
import { ForgeCommitAuthorIdentityTransport } from "../forge/commit-author-transport";
import { resolveForgeRepo } from "../forge/resolve";
import { forgeOrigin, type ForgeRepo } from "../forge/types";
import {
  NoopGitHubAvatarThumbnailStore,
  type GitHubAvatarThumbnailStore
} from "./avatar-thumbnail-cache";

/** How long a proven GitHub identity remains fresh before revalidation. */
export const GITHUB_COMMIT_AUTHOR_IDENTITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long an exact commit with no GitHub account remains negative-cached. */
export const GITHUB_COMMIT_AUTHOR_IDENTITY_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
/** First delay before retrying a failed remote, auth, or network lookup. */
export const GITHUB_COMMIT_AUTHOR_IDENTITY_INITIAL_BACKOFF_MS = 60 * 1000;
/** Upper bound for exponential retry gates; this service never polls itself. */
export const GITHUB_COMMIT_AUTHOR_IDENTITY_MAX_BACKOFF_MS = 60 * 60 * 1000;
/** Keep stale graph warming from fanning out into an API burst. */
export const GITHUB_COMMIT_AUTHOR_IDENTITY_MAX_CONCURRENT_REFRESHES = 2;
/** GitHub's email-to-account association is reusable across repositories. */
export const GITHUB_COMMIT_AUTHOR_ACCOUNT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const RESOLVED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const NEGATIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const UNAVAILABLE_RETENTION_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const ACCESS_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Re-exported under their historical names; the definitions are forge-wide now
 * and live in `../forge/commit-author`.
 */
export type GitHubCommitAuthorProof = CommitAuthorProof;
export type GitHubCommitAuthorRemoteCommit = CommitAuthorRemoteCommit;
export type GitHubCommitAuthorIdentityTransport = CommitAuthorIdentityTransport;

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
  github_user_id: number | null;
  avatar_url: string | null;
  fetched_at: number;
  expires_at: number;
  last_accessed_at: number;
  failure_count: number;
  next_retry_at: number | null;
  updated_at: number;
};

type AccountRow = {
  author_key: string;
  status: string;
  github_user_id: number | null;
  github_login: string | null;
  avatar_url: string | null;
  fetched_at: number;
  expires_at: number;
  last_accessed_at: number;
  updated_at: number;
};

type NormalizedAuthor = { name: string; email: string };

type CachedIdentity = {
  userId?: number;
  login: string;
  avatarSourceUrl?: string;
};

type PreparedRequest = {
  worktreeId: string;
  commitSha: string;
  author: NormalizedAuthor;
  cacheOnly: boolean;
};

type RemoteOutcome =
  | { kind: "resolved"; identity: CachedIdentity }
  | { kind: "negative" }
  | { kind: "inconclusive" };

/**
 * Persistent verification of a local Git commit author's GitHub account. An
 * exact GitHub commit is the proof source; its email-to-account association is
 * then reusable for the same hashed author email on other GitHub commits.
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
  /** Coalesce only concurrent local `git remote` checks; never cache an origin. */
  private readonly originLookupsInFlight = new Map<
    string,
    Promise<ForgeRepo | null | undefined>
  >();
  private readonly queuedRevalidations: Array<() => void> = [];
  private activeRevalidations = 0;
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
    this.transport = options.transport ?? new ForgeCommitAuthorIdentityTransport();
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
   * Start an identity lookup in the background. The GitHub remote is validated
   * before either the exact-SHA cache or reusable author-account cache is read.
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
    /** Read only already-proven exact or author-account data. */
    cacheOnly?: boolean;
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
      author,
      cacheOnly: input.cacheOnly === true
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
    let authorKey: string | undefined;
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

      const proof = normalizeProof({ repo: remote, commitSha: prepared.commitSha });
      if (proof === undefined) return notEligibleLookup();
      identityKey = buildGitHubCommitAuthorIdentityCacheKey(prepared.author, proof);
      authorKey = buildGitHubCommitAuthorAccountCacheKey(prepared.author, proof.repo);
      if (identityKey === undefined || authorKey === undefined) return notEligibleLookup();

      const now = this.now();
      const cached = this.readCache(identityKey);
      if (cached !== undefined) this.touch(cached, now);
      if (cached?.identity !== undefined) {
        // Backfill the reusable author account from exact proofs written by
        // versions that only cached one SHA at a time.
        this.writeAuthorAccount(
          authorKey,
          cached.identity,
          cached.fetchedAt,
          Math.max(cached.expiresAt, now + GITHUB_COMMIT_AUTHOR_ACCOUNT_TTL_MS)
        );
      }

      if (cached?.identity !== undefined && isFresh(cached, now)) {
        return await this.lookupFromCache(cached, now, "idle", onBackgroundUpdate);
      }
      if (
        cached?.identity !== undefined &&
        cached.nextRetryAt !== undefined &&
        cached.nextRetryAt > now
      ) {
        return await this.lookupFromCache(cached, now, "backing-off", onBackgroundUpdate);
      }

      // Preserve a known local identity (and its on-disk thumbnail) while the
      // next exact-commit proof runs. This is stale-while-revalidate, never a
      // shortcut around the origin/SHA proof that was already established.
      if (cached?.status === "resolved") {
        const stale = await this.lookupFromCache(
          cached,
          now,
          "in-flight",
          onBackgroundUpdate
        );
        this.scheduleRevalidation(prepared, proof, identityKey, onBackgroundUpdate);
        return stale;
      }

      // An exact negative is authoritative for this SHA and must suppress a
      // broader author-email association. Preserve that decision while stale
      // and revalidate it, just as we do for an exact resolved identity.
      if (cached?.status === "negative") {
        if (isFresh(cached, now)) {
          return await this.lookupFromCache(cached, now, "idle", onBackgroundUpdate);
        }
        if (cached.nextRetryAt !== undefined && cached.nextRetryAt > now) {
          return await this.lookupFromCache(
            cached,
            now,
            "backing-off",
            onBackgroundUpdate
          );
        }
        const stale = await this.lookupFromCache(
          cached,
          now,
          "in-flight",
          onBackgroundUpdate
        );
        this.scheduleRevalidation(prepared, proof, identityKey, onBackgroundUpdate);
        return stale;
      }

      // GitHub associates command-line commits with accounts by author email.
      // Once an exact response proves that association, reuse the same hashed
      // author account across SHAs and repositories. Conflicts become
      // ambiguous and are never served.
      const account = this.readAuthorAccount(authorKey);
      if (account !== undefined) {
        this.touchAuthorAccount(account, now);
        if (isFresh(account, now) || prepared.cacheOnly) {
          return await this.lookupFromAuthorAccount(
            account,
            now,
            "idle",
            onBackgroundUpdate
          );
        }
        const stale = await this.lookupFromAuthorAccount(
          account,
          now,
          "in-flight",
          onBackgroundUpdate
        );
        this.scheduleRevalidation(prepared, proof, identityKey, onBackgroundUpdate);
        return stale;
      }

      if (cached?.nextRetryAt !== undefined && cached.nextRetryAt > now) {
        return await this.lookupFromCache(cached, now, "backing-off", onBackgroundUpdate);
      }

      // The graph's bounded warm pass only hydrates identity proofs already in
      // SQLite. It never turns opening a large history into a burst of GitHub
      // requests; a hover sends the normal request when a proof is absent.
      if (prepared.cacheOnly) {
        return { cacheState: "miss", refreshState: "idle" };
      }

      const refreshed = await this.revalidate(prepared, proof, identityKey);
      const completedAt = this.now();
      return await this.lookupBestAvailable(
        authorKey,
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
      return await this.lookupBestAvailable(
        authorKey,
        cached,
        now,
        "backing-off",
        onBackgroundUpdate
      );
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
          await this.lookupBestAvailable(
            buildGitHubCommitAuthorAccountCacheKey(prepared.author, proof.repo),
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

    const completion = this.enqueueRevalidation(async () => {
      try {
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
          const authorKey = buildGitHubCommitAuthorAccountCacheKey(prepared.author, proof.repo);
          if (authorKey !== undefined) {
            this.writeAuthorAccount(
              authorKey,
              outcome.identity,
              completedAt,
              completedAt + GITHUB_COMMIT_AUTHOR_ACCOUNT_TTL_MS
            );
          }
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
      } catch {
        this.recordFailure(identityKey, this.now());
        return this.readCache(identityKey);
      }
    });

    this.revalidationInFlight.set(identityKey, completion);
    void completion.then(() => {
      if (this.revalidationInFlight.get(identityKey) === completion) {
        this.revalidationInFlight.delete(identityKey);
      }
    });
    return completion;
  }

  private enqueueRevalidation<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queuedRevalidations.push(() => {
        this.activeRevalidations += 1;
        void Promise.resolve()
          .then(work)
          .then(resolve, reject)
          .finally(() => {
            this.activeRevalidations -= 1;
            this.startQueuedRevalidations();
          });
      });
      this.startQueuedRevalidations();
    });
  }

  private startQueuedRevalidations(): void {
    while (
      this.activeRevalidations < GITHUB_COMMIT_AUTHOR_IDENTITY_MAX_CONCURRENT_REFRESHES
    ) {
      const next = this.queuedRevalidations.shift();
      if (next === undefined) return;
      next();
    }
  }

  private async lookupFromCache(
    entry: CacheEntry | undefined,
    now: number,
    refreshState: GitHubCommitAuthorIdentityLookup["refreshState"],
    onBackgroundUpdate?: (lookup: GitHubCommitAuthorIdentityLookup) => void,
    readCurrent: (key: string) => CacheEntry | undefined = (key) =>
      this.readCache(key)
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
          onBackgroundUpdate,
          readCurrent
        );
      }
      return toLookup(entry, now, refreshState, identity, avatarCache);
    } catch {
      // A damaged/missing local thumbnail must not hide a proven login.
    }
    return toLookup(entry, now, refreshState, identity);
  }

  private lookupFromAuthorAccount(
    entry: CacheEntry,
    now: number,
    refreshState: GitHubCommitAuthorIdentityLookup["refreshState"],
    onBackgroundUpdate?: (lookup: GitHubCommitAuthorIdentityLookup) => void
  ): Promise<GitHubCommitAuthorIdentityLookup> {
    return this.lookupFromCache(
      entry,
      now,
      refreshState,
      onBackgroundUpdate,
      (key) => this.readAuthorAccount(key)
    );
  }

  private async lookupBestAvailable(
    authorKey: string | undefined,
    exact: CacheEntry | undefined,
    now: number,
    refreshState: GitHubCommitAuthorIdentityLookup["refreshState"],
    onBackgroundUpdate?: (lookup: GitHubCommitAuthorIdentityLookup) => void
  ): Promise<GitHubCommitAuthorIdentityLookup> {
    // Exact positive and negative results both outrank the reusable account.
    // Only a true miss or transient unavailable row may fall back to it.
    if (exact?.status === "resolved" || exact?.status === "negative") {
      return await this.lookupFromCache(exact, now, refreshState, onBackgroundUpdate);
    }
    const account = authorKey === undefined
      ? undefined
      : this.readAuthorAccount(authorKey);
    return account === undefined
      ? await this.lookupFromCache(exact, now, refreshState, onBackgroundUpdate)
      : await this.lookupFromAuthorAccount(
          account,
          now,
          isFresh(account, now) ? "idle" : refreshState,
          onBackgroundUpdate
        );
  }

  private scheduleThumbnailRefresh(
    entry: CacheEntry,
    sourceUrl: string,
    now: number,
    refreshState: GitHubCommitAuthorIdentityLookup["refreshState"],
    previousAvatarUrl: string | undefined,
    onBackgroundUpdate?: (lookup: GitHubCommitAuthorIdentityLookup) => void,
    readCurrent: (key: string) => CacheEntry | undefined = (key) =>
      this.readCache(key)
  ): void {
    void this.thumbnails
      .refresh(sourceUrl, now)
      .then((thumbnail) => {
        if (onBackgroundUpdate === undefined) return;
        const current = readCurrent(entry.identityKey);
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

  /** `null` is a remote no forge claims; `undefined` is a transient Git failure. */
  private originRemote(
    worktreePath: string
  ): Promise<ForgeRepo | null | undefined> {
    const existing = this.originLookupsInFlight.get(worktreePath);
    if (existing !== undefined) return existing;

    const completion = Promise.resolve()
      .then(async () => {
        const result = await this.git(["remote", "get-url", "origin"], worktreePath);
        if (!result.ok || result.value.exitCode !== 0) return undefined;
        const repo = resolveForgeRepo(result.value.stdout);
        // Trust this instance to serve its own users' avatars. Needed for a
        // self-managed host, whose name is only knowable at runtime.
        if (repo !== null) rememberForgeAvatarHost(repo.host);
        return repo;
      })
      .finally(() => {
        if (this.originLookupsInFlight.get(worktreePath) === completion) {
          this.originLookupsInFlight.delete(worktreePath);
        }
      });
    this.originLookupsInFlight.set(worktreePath, completion);
    return completion;
  }

  private readCache(identityKey: string): CacheEntry | undefined {
    try {
      const row = this.db
        .prepare(
          `SELECT identity_key, status, github_user_id, github_login, avatar_url, fetched_at,
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

  private readAuthorAccount(authorKey: string): CacheEntry | undefined {
    try {
      const row = this.db
        .prepare(
          `SELECT author_key, status, github_user_id, github_login, avatar_url,
                  fetched_at, expires_at, last_accessed_at, updated_at
             FROM github_commit_author_account_cache
            WHERE author_key = ?`
        )
        .get(authorKey) as AccountRow | undefined;
      if (
        row === undefined ||
        row.status !== "resolved" ||
        !isTimestamp(row.fetched_at) ||
        !isTimestamp(row.expires_at) ||
        !isTimestamp(row.last_accessed_at) ||
        !isTimestamp(row.updated_at)
      ) {
        return undefined;
      }
      const login = safeText(row.github_login, 255);
      if (login === undefined) return undefined;
      const userId = readSafeInteger(row.github_user_id);
      const avatarSourceUrl = normalizeAvatarUrl(row.avatar_url);
      return {
        identityKey: row.author_key,
        status: "resolved",
        identity: {
          ...(userId === undefined ? {} : { userId }),
          login,
          ...(avatarSourceUrl === undefined ? {} : { avatarSourceUrl })
        },
        fetchedAt: row.fetched_at,
        expiresAt: row.expires_at,
        lastAccessedAt: row.last_accessed_at,
        failureCount: 0,
        updatedAt: row.updated_at
      };
    } catch {
      return undefined;
    }
  }

  private writeAuthorAccount(
    authorKey: string,
    identity: CachedIdentity,
    fetchedAt: number,
    expiresAt: number
  ): void {
    try {
      this.db.prepare(
        `INSERT INTO github_commit_author_account_cache(
           author_key, status, github_user_id, github_login, avatar_url,
           fetched_at, expires_at, last_accessed_at, updated_at
         ) VALUES (?, 'resolved', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(author_key) DO UPDATE SET
           status = CASE
             WHEN github_commit_author_account_cache.status = 'resolved'
              AND (
                (github_commit_author_account_cache.github_user_id IS NOT NULL
                 AND excluded.github_user_id IS NOT NULL
                 AND github_commit_author_account_cache.github_user_id = excluded.github_user_id)
                OR ((github_commit_author_account_cache.github_user_id IS NULL
                     OR excluded.github_user_id IS NULL)
                    AND lower(github_commit_author_account_cache.github_login) = lower(excluded.github_login))
              )
             THEN 'resolved' ELSE 'ambiguous' END,
           github_user_id = CASE
             WHEN github_commit_author_account_cache.status = 'resolved'
              AND (
                (github_commit_author_account_cache.github_user_id IS NOT NULL
                 AND excluded.github_user_id IS NOT NULL
                 AND github_commit_author_account_cache.github_user_id = excluded.github_user_id)
                OR ((github_commit_author_account_cache.github_user_id IS NULL
                     OR excluded.github_user_id IS NULL)
                    AND lower(github_commit_author_account_cache.github_login) = lower(excluded.github_login))
              )
             THEN COALESCE(github_commit_author_account_cache.github_user_id, excluded.github_user_id)
             ELSE NULL END,
           github_login = CASE
             WHEN github_commit_author_account_cache.status = 'resolved'
              AND (
                (github_commit_author_account_cache.github_user_id IS NOT NULL
                 AND excluded.github_user_id IS NOT NULL
                 AND github_commit_author_account_cache.github_user_id = excluded.github_user_id)
                OR ((github_commit_author_account_cache.github_user_id IS NULL
                     OR excluded.github_user_id IS NULL)
                    AND lower(github_commit_author_account_cache.github_login) = lower(excluded.github_login))
              )
             THEN CASE
               WHEN excluded.updated_at >= github_commit_author_account_cache.updated_at
               THEN excluded.github_login
               ELSE github_commit_author_account_cache.github_login
             END ELSE NULL END,
           avatar_url = CASE
             WHEN github_commit_author_account_cache.status = 'resolved'
              AND (
                (github_commit_author_account_cache.github_user_id IS NOT NULL
                 AND excluded.github_user_id IS NOT NULL
                 AND github_commit_author_account_cache.github_user_id = excluded.github_user_id)
                OR ((github_commit_author_account_cache.github_user_id IS NULL
                     OR excluded.github_user_id IS NULL)
                    AND lower(github_commit_author_account_cache.github_login) = lower(excluded.github_login))
              )
             THEN CASE
               WHEN excluded.updated_at >= github_commit_author_account_cache.updated_at
               THEN COALESCE(excluded.avatar_url, github_commit_author_account_cache.avatar_url)
               ELSE github_commit_author_account_cache.avatar_url
             END ELSE NULL END,
           fetched_at = MAX(github_commit_author_account_cache.fetched_at, excluded.fetched_at),
           expires_at = MAX(github_commit_author_account_cache.expires_at, excluded.expires_at),
           last_accessed_at = MAX(
             github_commit_author_account_cache.last_accessed_at,
             excluded.last_accessed_at
           ),
           updated_at = MAX(github_commit_author_account_cache.updated_at, excluded.updated_at)`
      ).run(
        authorKey,
        identity.userId ?? null,
        identity.login,
        identity.avatarSourceUrl ?? null,
        fetchedAt,
        expiresAt,
        fetchedAt,
        fetchedAt
      );
    } catch {
      // A reusable author optimization must never affect exact verification.
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
           identity_key, status, github_user_id, github_login, avatar_url, fetched_at,
           expires_at, last_accessed_at, failure_count, next_retry_at, updated_at
         ) VALUES (?, 'resolved', ?, ?, ?, ?, ?, ?, 0, NULL, ?)
         ON CONFLICT(identity_key) DO UPDATE SET
           status = excluded.status,
           github_user_id = excluded.github_user_id,
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
        params.identity.userId ?? null,
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
           github_user_id = NULL,
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

  private touchAuthorAccount(entry: CacheEntry, now: number): void {
    if (now - entry.lastAccessedAt < ACCESS_TOUCH_INTERVAL_MS) return;
    try {
      this.db
        .prepare(
          `UPDATE github_commit_author_account_cache
              SET last_accessed_at = ?
            WHERE author_key = ? AND last_accessed_at <= ?`
        )
        .run(now, entry.identityKey, now - ACCESS_TOUCH_INTERVAL_MS);
    } catch {
      // The local identity remains reusable if access bookkeeping cannot write.
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
      this.db
        .prepare(
          `DELETE FROM github_commit_author_account_cache
            WHERE last_accessed_at < ?`
        )
        .run(now - ACCOUNT_RETENTION_MS);
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
      `pwrgit-forge-commit-author-identity:v3\0${normalizedProof.repo.kind}\0${normalizedProof.repo.host}\0${normalizedProof.repo.path}\0${normalizedProof.commitSha}\0${normalized.email}\0${normalized.name}`
    )
    .digest("hex");
}

/**
 * Opaque key for a forge's author-email account association. Git author names
 * may vary (`huntharo` vs `Harold Hunt`), while the normalized email is the
 * field both forges use to associate command-line commits.
 *
 * Scoped per forge instance on purpose: the same email is a different account
 * on github.com than on a GitLab instance, so a global key would paint one
 * forge's avatar onto the other's commits.
 */
export function buildGitHubCommitAuthorAccountCacheKey(
  author: { name: string; email: string },
  repo: Pick<ForgeRepo, "kind" | "host">
): string | undefined {
  const normalized = normalizeAuthor(author);
  const host = safeText(repo.host, 255)?.toLowerCase();
  if (normalized === undefined || host === undefined) return undefined;
  return createHash("sha256")
    .update(
      `pwrgit-forge-commit-author-account:v2\0${repo.kind}\0${host}\0${normalized.email}`
    )
    .digest("hex");
}

function buildRequestKey(prepared: PreparedRequest): string {
  return createHash("sha256")
    .update(
      `pwrgit-github-commit-author-request:v2\0${prepared.cacheOnly ? "cache-only" : "lookup"}\0${prepared.worktreeId}\0${prepared.commitSha}\0${prepared.author.email}\0${prepared.author.name}`
    )
    .digest("hex");
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
  if (response.account === null) return { kind: "negative" };
  const identity = normalizeForgeIdentity(response.account, expectedProof.repo);
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
    const userId = readSafeInteger(row.github_user_id);
    const avatarSourceUrl = normalizeAvatarUrl(row.avatar_url);
    return {
      identityKey: row.identity_key,
      status: row.status,
      identity: {
        ...(userId === undefined ? {} : { userId }),
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

function normalizeProof(value: unknown): CommitAuthorProof | undefined {
  if (!isRecord(value)) return undefined;
  const repo = normalizeForgeRepo(value.repo);
  const commitSha = normalizeCommitSha(value.commitSha);
  return repo === undefined || commitSha === undefined
    ? undefined
    : { repo, commitSha };
}

/**
 * A GitLab project can sit at any depth, so the path is validated per segment
 * rather than as a single one. Every segment still has to look like a namespace
 * segment, which keeps traversal and query fragments out of an API endpoint.
 */
function normalizeForgeRepo(value: unknown): ForgeRepo | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (kind !== "github" && kind !== "gitlab") return undefined;
  const host = safeText(value.host, 255)?.toLowerCase();
  const path = safeText(value.path, 1_024);
  if (host === undefined || path === undefined) return undefined;
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return undefined;
  const port = readSafeInteger(value.port);
  const segments = path.split("/");
  if (segments.length < 2) return undefined;
  if (kind === "github" && segments.length !== 2) return undefined;
  if (!segments.every((segment) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(segment))) {
    return undefined;
  }
  return { kind, host, ...(port === undefined ? {} : { port }), path };
}

function normalizeForgeIdentity(
  value: ForgeAccountProfile | undefined,
  repo: ForgeRepo
): CachedIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const login = safeText(value.login, 255);
  if (login === undefined) return undefined;
  const userId = readSafeInteger(value.id);
  const avatarSourceUrl = normalizeAvatarUrl(value.avatarUrl, repo);
  return {
    ...(userId === undefined ? {} : { userId }),
    login,
    ...(avatarSourceUrl === undefined ? {} : { avatarSourceUrl })
  };
}

/**
 * `repo` supplies the base for a relative avatar path, which GitLab returns for
 * an uploaded picture. Cached rows already hold an absolute, normalized URL.
 */
function normalizeAvatarUrl(value: unknown, repo?: ForgeRepo): string | undefined {
  const raw = safeText(value, 2_048);
  if (raw === undefined) return undefined;
  return normalizeForgeAvatarSourceUrl(
    raw,
    repo === undefined ? undefined : forgeOrigin(repo)
  );
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





function readSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
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
