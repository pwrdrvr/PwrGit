import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DB } from "../persistence/db";

/** A small, renderer-safe GitHub avatar is revalidated at most monthly. */
export const GITHUB_AVATAR_THUMBNAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Keep rarely used avatar files long enough to make large-repository revisits cheap. */
export const GITHUB_AVATAR_THUMBNAIL_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
export const GITHUB_AVATAR_THUMBNAIL_INITIAL_BACKOFF_MS = 60 * 1000;
export const GITHUB_AVATAR_THUMBNAIL_MAX_BACKOFF_MS = 60 * 60 * 1000;
export const GITHUB_AVATAR_THUMBNAIL_MAX_BYTES = 512 * 1024;
/** Keep stale identity warming from opening many simultaneous image downloads. */
export const GITHUB_AVATAR_THUMBNAIL_MAX_CONCURRENT_DOWNLOADS = 2;
/** Opaque local resource scheme; the GitHub source URL never reaches Chromium. */
export const GITHUB_AVATAR_THUMBNAIL_PROTOCOL_SCHEME = "pwrgit-avatar";

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ACCESS_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12 * 1000;
const PROTOCOL_HOST = "thumbnail";
// The fetched-at query makes a background refresh a new immutable Chromium
// resource. A card can keep showing the old local bytes until the refresh
// finishes, then swap to the newly versioned resource without a network image.
const BROWSER_CACHE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

type AvatarMimeType = "image/avif" | "image/jpeg" | "image/png" | "image/webp";

type AvatarSource = {
  key: string;
  url: string;
};

type AvatarCacheRow = {
  avatar_key: string;
  source_url: string;
  mime_type: string | null;
  byte_length: number;
  fetched_at: number;
  expires_at: number;
  last_accessed_at: number;
  failure_count: number;
  next_retry_at: number | null;
  updated_at: number;
};

type AvatarCacheEntry = {
  key: string;
  sourceUrl: string;
  mimeType?: AvatarMimeType;
  byteLength: number;
  fetchedAt: number;
  expiresAt: number;
  lastAccessedAt: number;
  failureCount: number;
  nextRetryAt?: number;
  updatedAt: number;
};

export type GitHubAvatarThumbnailRead = {
  /**
   * Stable local `pwrgit-avatar://` resource backed by an opaque on-disk key.
   * It never contains the remote source URL, filesystem path, or credentials.
   */
  avatarUrl?: string;
  cacheState: "fresh" | "stale" | "miss";
  refreshState: "idle" | "backing-off";
  /** Epoch milliseconds of the last successful thumbnail download. */
  refreshedAt?: number;
  /** Epoch milliseconds before this thumbnail can retry an offline failure. */
  nextRetryAt?: number;
  /** A caller may start a best-effort refresh without waiting for it. */
  needsRefresh: boolean;
};

/** Minimal seam so identity verification can stay credential-opaque and testable. */
export type GitHubAvatarThumbnailStore = {
  read(sourceUrl: string, now: number): Promise<GitHubAvatarThumbnailRead>;
  refresh(sourceUrl: string, now: number): Promise<GitHubAvatarThumbnailRead>;
  pruneIfDue(now: number): Promise<void>;
};

export type GitHubAvatarThumbnailTransport = {
  fetchAvatar(sourceUrl: string): Promise<{ contentType: string; bytes: Uint8Array }>;
};

export type GitHubAvatarThumbnailCacheOptions = {
  cacheDir: string;
  transport?: GitHubAvatarThumbnailTransport;
  ttlMs?: number;
  retentionMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  maxBytes?: number;
};

/**
 * Downloads public GitHub avatar thumbnails without credentials. The source
 * URL never reaches the renderer: cached bytes are served through an opaque,
 * versioned local protocol URL that Chromium can retain between card mounts.
 */
export class GitHubAvatarThumbnailCache implements GitHubAvatarThumbnailStore {
  private readonly transport: GitHubAvatarThumbnailTransport;
  private readonly ttlMs: number;
  private readonly retentionMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxBytes: number;
  private readonly inFlight = new Map<string, Promise<GitHubAvatarThumbnailRead>>();
  private readonly queuedDownloads: Array<() => void> = [];
  private activeDownloads = 0;
  private lastPrunedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly db: DB,
    private readonly options: GitHubAvatarThumbnailCacheOptions
  ) {
    this.transport = options.transport ?? new FetchGitHubAvatarThumbnailTransport();
    this.ttlMs = positiveDuration(options.ttlMs, GITHUB_AVATAR_THUMBNAIL_TTL_MS);
    this.retentionMs = positiveDuration(
      options.retentionMs,
      GITHUB_AVATAR_THUMBNAIL_RETENTION_MS
    );
    this.initialBackoffMs = positiveDuration(
      options.initialBackoffMs,
      GITHUB_AVATAR_THUMBNAIL_INITIAL_BACKOFF_MS
    );
    this.maxBackoffMs = Math.max(
      this.initialBackoffMs,
      positiveDuration(options.maxBackoffMs, GITHUB_AVATAR_THUMBNAIL_MAX_BACKOFF_MS)
    );
    this.maxBytes = positiveInteger(options.maxBytes, GITHUB_AVATAR_THUMBNAIL_MAX_BYTES);
  }

  async read(sourceUrl: string, now: number): Promise<GitHubAvatarThumbnailRead> {
    const source = prepareAvatarSource(sourceUrl);
    if (source === undefined) {
      return { cacheState: "miss", refreshState: "idle", needsRefresh: false };
    }

    const entry = this.readEntry(source);
    if (entry === undefined) {
      return { cacheState: "miss", refreshState: "idle", needsRefresh: true };
    }

    this.touch(entry, now);
    const avatarUrl = await this.readLocalUrl(entry);
    const retryGated = entry.nextRetryAt !== undefined && entry.nextRetryAt > now;
    const cacheState =
      avatarUrl === undefined ? "miss" : entry.expiresAt > now ? "fresh" : "stale";
    return {
      ...(avatarUrl === undefined ? {} : { avatarUrl }),
      cacheState,
      refreshState: retryGated ? "backing-off" : "idle",
      ...(entry.fetchedAt > 0 ? { refreshedAt: entry.fetchedAt } : {}),
      ...(entry.nextRetryAt === undefined ? {} : { nextRetryAt: entry.nextRetryAt }),
      needsRefresh: !retryGated && (avatarUrl === undefined || entry.expiresAt <= now)
    };
  }

  async refresh(sourceUrl: string, now: number): Promise<GitHubAvatarThumbnailRead> {
    const source = prepareAvatarSource(sourceUrl);
    if (source === undefined) {
      return { cacheState: "miss", refreshState: "idle", needsRefresh: false };
    }

    const current = await this.read(source.url, now);
    if (!current.needsRefresh) return current;

    const existing = this.inFlight.get(source.key);
    if (existing !== undefined) return await existing;

    const completion = this.enqueueDownload(async () => {
      try {
        await this.fetchAndStore(source, now);
        return await this.read(source.url, now);
      } catch {
        this.recordFailure(source, now);
        return await this.read(source.url, now);
      }
    })
      .finally(() => {
        if (this.inFlight.get(source.key) === completion) {
          this.inFlight.delete(source.key);
        }
      });
    this.inFlight.set(source.key, completion);
    return await completion;
  }

  private enqueueDownload<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queuedDownloads.push(() => {
        this.activeDownloads += 1;
        void Promise.resolve()
          .then(work)
          .then(resolve, reject)
          .finally(() => {
            this.activeDownloads -= 1;
            this.startQueuedDownloads();
          });
      });
      this.startQueuedDownloads();
    });
  }

  private startQueuedDownloads(): void {
    while (this.activeDownloads < GITHUB_AVATAR_THUMBNAIL_MAX_CONCURRENT_DOWNLOADS) {
      const next = this.queuedDownloads.shift();
      if (next === undefined) return;
      next();
    }
  }

  async pruneIfDue(now: number): Promise<void> {
    if (now - this.lastPrunedAt < PRUNE_INTERVAL_MS) return;
    this.lastPrunedAt = now;

    try {
      const keys = (
        this.db
          .prepare(
            `SELECT avatar_key
               FROM github_avatar_thumbnail_cache
              WHERE last_accessed_at < ?`
          )
          .all(now - this.retentionMs) as Array<{ avatar_key: string }>
      )
        .map((row) => validCacheKey(row.avatar_key))
        .filter((key): key is string => key !== undefined);

      const remove = this.db.prepare(
        "DELETE FROM github_avatar_thumbnail_cache WHERE avatar_key = ?"
      );
      for (const key of keys) remove.run(key);
      await Promise.all(
        keys.map(async (key) => {
          await unlink(this.thumbnailPath(key)).catch(() => undefined);
        })
      );
    } catch {
      // Cache cleanup must never affect the commit context card.
    }
  }

  /**
   * Resolve a renderer request without exposing a cache path or forwarding it
   * to the network. Only a known opaque key with a complete local DB row can
   * read a file, and the byte count/mime type are checked again at the edge.
   */
  async respondToRendererUrl(url: string): Promise<Response> {
    const key = parseGitHubAvatarThumbnailUrl(url);
    if (key === undefined) return notFoundResponse();

    const entry = this.readEntryByKey(key);
    if (
      entry === undefined ||
      entry.mimeType === undefined ||
      entry.byteLength <= 0 ||
      entry.byteLength > this.maxBytes ||
      buildGitHubAvatarThumbnailUrl(entry.key, entry.fetchedAt) !== url
    ) {
      return notFoundResponse();
    }

    try {
      const bytes = await readFile(this.thumbnailPath(entry.key));
      if (bytes.byteLength !== entry.byteLength || bytes.byteLength > this.maxBytes) {
        return notFoundResponse();
      }
      this.touch(entry, Date.now());
      return new Response(bytes, {
        headers: {
          "Content-Type": entry.mimeType,
          "Content-Length": String(entry.byteLength),
          "Cache-Control": `public, max-age=${BROWSER_CACHE_MAX_AGE_SECONDS}, immutable`,
          "X-Content-Type-Options": "nosniff"
        }
      });
    } catch {
      return notFoundResponse();
    }
  }

  private async fetchAndStore(source: AvatarSource, now: number): Promise<void> {
    const response = await this.transport.fetchAvatar(source.url);
    const mimeType = normalizeAvatarMimeType(response.contentType);
    if (mimeType === undefined || response.bytes.byteLength === 0) {
      throw new Error("GitHub returned an unsupported avatar image");
    }
    if (response.bytes.byteLength > this.maxBytes) {
      throw new Error("GitHub avatar thumbnail exceeds the cache size limit");
    }

    await mkdir(this.options.cacheDir, { recursive: true });
    const target = this.thumbnailPath(source.key);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, response.bytes);
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }

    this.db
      .prepare(
        `INSERT INTO github_avatar_thumbnail_cache(
           avatar_key, source_url, mime_type, byte_length, fetched_at,
           expires_at, last_accessed_at, failure_count, next_retry_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
         ON CONFLICT(avatar_key) DO UPDATE SET
           source_url = excluded.source_url,
           mime_type = excluded.mime_type,
           byte_length = excluded.byte_length,
           fetched_at = excluded.fetched_at,
           expires_at = excluded.expires_at,
           last_accessed_at = excluded.last_accessed_at,
           failure_count = 0,
           next_retry_at = NULL,
           updated_at = excluded.updated_at`
      )
      .run(
        source.key,
        source.url,
        mimeType,
        response.bytes.byteLength,
        now,
        now + this.ttlMs,
        now,
        now
      );
  }

  private readEntry(source: AvatarSource): AvatarCacheEntry | undefined {
    try {
      const row = this.db
        .prepare(
          `SELECT avatar_key, source_url, mime_type, byte_length, fetched_at,
                  expires_at, last_accessed_at, failure_count, next_retry_at, updated_at
             FROM github_avatar_thumbnail_cache
            WHERE avatar_key = ?`
        )
        .get(source.key) as AvatarCacheRow | undefined;
      return row === undefined ? undefined : parseCacheRow(row, source);
    } catch {
      return undefined;
    }
  }

  private readEntryByKey(key: string): AvatarCacheEntry | undefined {
    try {
      const row = this.db
        .prepare(
          `SELECT avatar_key, source_url, mime_type, byte_length, fetched_at,
                  expires_at, last_accessed_at, failure_count, next_retry_at, updated_at
             FROM github_avatar_thumbnail_cache
            WHERE avatar_key = ?`
        )
        .get(key) as AvatarCacheRow | undefined;
      if (row === undefined) return undefined;
      const source = prepareAvatarSource(row.source_url);
      return source === undefined || source.key !== key
        ? undefined
        : parseCacheRow(row, source);
    } catch {
      return undefined;
    }
  }

  private async readLocalUrl(entry: AvatarCacheEntry): Promise<string | undefined> {
    if (entry.mimeType === undefined || entry.byteLength <= 0 || entry.byteLength > this.maxBytes) {
      return undefined;
    }
    try {
      const file = await stat(this.thumbnailPath(entry.key));
      if (!file.isFile() || file.size !== entry.byteLength) {
        return undefined;
      }
      return buildGitHubAvatarThumbnailUrl(entry.key, entry.fetchedAt);
    } catch {
      return undefined;
    }
  }

  private touch(entry: AvatarCacheEntry, now: number): void {
    if (now - entry.lastAccessedAt < ACCESS_TOUCH_INTERVAL_MS) return;
    try {
      this.db
        .prepare(
          `UPDATE github_avatar_thumbnail_cache
              SET last_accessed_at = ?
            WHERE avatar_key = ? AND last_accessed_at <= ?`
        )
        .run(now, entry.key, now - ACCESS_TOUCH_INTERVAL_MS);
    } catch {
      // Read-only use of a thumbnail should still work when cache writes fail.
    }
  }

  private recordFailure(source: AvatarSource, now: number): void {
    const failureCount = Math.min(
      16,
      (this.readEntry(source)?.failureCount ?? 0) + 1
    );
    const retryAt = now + backoffMs(failureCount, this.initialBackoffMs, this.maxBackoffMs);
    try {
      this.db
        .prepare(
          `INSERT INTO github_avatar_thumbnail_cache(
             avatar_key, source_url, mime_type, byte_length, fetched_at,
             expires_at, last_accessed_at, failure_count, next_retry_at, updated_at
           ) VALUES (?, ?, NULL, 0, 0, 0, ?, ?, ?, ?)
           ON CONFLICT(avatar_key) DO UPDATE SET
             source_url = excluded.source_url,
             failure_count = excluded.failure_count,
             next_retry_at = excluded.next_retry_at,
             updated_at = excluded.updated_at`
        )
        .run(source.key, source.url, now, failureCount, retryAt, now);
    } catch {
      // Offline/no-network avatar fetches remain silent best-effort failures.
    }
  }

  private thumbnailPath(key: string): string {
    return join(this.options.cacheDir, key);
  }
}

/** Public avatar fetcher: no auth header, token, cookie, or IPC data involved. */
export class FetchGitHubAvatarThumbnailTransport implements GitHubAvatarThumbnailTransport {
  async fetchAvatar(sourceUrl: string): Promise<{ contentType: string; bytes: Uint8Array }> {
    const initial = normalizeGitHubAvatarSourceUrl(sourceUrl);
    if (initial === undefined) throw new Error("Unsupported GitHub avatar URL");
    let current: string = initial;

    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response: Response = await fetch(current, {
        redirect: "manual",
        credentials: "omit",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          Accept: "image/avif,image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.1"
        }
      });
      if (response.status >= 300 && response.status < 400) {
        const location: string | null = response.headers.get("location");
        const redirected =
          location === null
            ? undefined
            : normalizeGitHubAvatarSourceUrl(new URL(location, current).toString());
        if (redirected === undefined) throw new Error("Unsupported GitHub avatar redirect");
        current = redirected;
        continue;
      }
      if (!response.ok) throw new Error(`GitHub avatar request failed (${response.status})`);

      const contentType = response.headers.get("content-type") ?? "";
      const declaredBytes = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredBytes) && declaredBytes > GITHUB_AVATAR_THUMBNAIL_MAX_BYTES) {
        throw new Error("GitHub avatar thumbnail exceeds the cache size limit");
      }
      return { contentType, bytes: await readLimitedBody(response, GITHUB_AVATAR_THUMBNAIL_MAX_BYTES) };
    }
    throw new Error("GitHub avatar redirected too many times");
  }
}

/** A test/default seam when no persistent thumbnail root is configured. */
export class NoopGitHubAvatarThumbnailStore implements GitHubAvatarThumbnailStore {
  async read(): Promise<GitHubAvatarThumbnailRead> {
    return { cacheState: "miss", refreshState: "idle", needsRefresh: false };
  }

  async refresh(): Promise<GitHubAvatarThumbnailRead> {
    return { cacheState: "miss", refreshState: "idle", needsRefresh: false };
  }

  async pruneIfDue(): Promise<void> {}
}

/** Stable opaque filename/key for one normalized, size-bounded avatar source. */
export function buildGitHubAvatarThumbnailCacheKey(sourceUrl: string): string | undefined {
  const normalized = normalizeGitHubAvatarSourceUrl(sourceUrl);
  return normalized === undefined
    ? undefined
    : createHash("sha256")
        .update(`pwrgit-github-avatar-thumbnail:v1\0${normalized}`)
        .digest("hex");
}

/**
 * Renderer-safe local URL for a cached thumbnail. `fetchedAt` versions the
 * resource so Chromium keeps a fresh in-memory/disk cache entry per refresh.
 */
export function buildGitHubAvatarThumbnailUrl(
  avatarKey: string,
  fetchedAt: number
): string | undefined {
  if (validCacheKey(avatarKey) === undefined || !isTimestamp(fetchedAt) || fetchedAt === 0) {
    return undefined;
  }
  return `${GITHUB_AVATAR_THUMBNAIL_PROTOCOL_SCHEME}://${PROTOCOL_HOST}/${avatarKey}?v=${fetchedAt}`;
}

/** Parse only PwrGit-generated local thumbnail URLs; arbitrary paths are rejected. */
export function parseGitHubAvatarThumbnailUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== `${GITHUB_AVATAR_THUMBNAIL_PROTOCOL_SCHEME}:` ||
      parsed.hostname !== PROTOCOL_HOST ||
      parsed.port !== "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== "" ||
      parsed.searchParams.getAll("v").length !== 1 ||
      [...parsed.searchParams.keys()].some((key) => key !== "v")
    ) {
      return undefined;
    }
    const version = parsed.searchParams.get("v");
    if (version === null || !/^\d{1,16}$/.test(version)) return undefined;
    const fetchedAt = Number(version);
    const key = parsed.pathname.slice(1);
    return isTimestamp(fetchedAt) && fetchedAt > 0 && validCacheKey(key) !== undefined
      ? key
      : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeGitHubAvatarSourceUrl(sourceUrl: string): string | undefined {
  try {
    const url = new URL(sourceUrl);
    const hostname = url.hostname.toLowerCase();
    const trustedHost =
      hostname === "avatars.githubusercontent.com" || hostname.endsWith(".githubusercontent.com");
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      !trustedHost
    ) {
      return undefined;
    }
    url.hash = "";
    // GitHub's public REST avatar URLs use `v` for a cache-busting revision.
    // Drop every other query parameter so a surprising signed/tokenized URL
    // can never enter SQLite, the on-disk cache, or a later image request.
    const version = url.searchParams.get("v");
    url.search = "";
    if (version !== null && /^[A-Za-z0-9._-]{1,64}$/.test(version)) {
      url.searchParams.set("v", version);
    }
    // GitHub's avatar endpoint accepts `s`; keeping this tiny makes thousands
    // of cache files genuinely cheap while preserving a crisp 28px UI image.
    url.searchParams.set("s", "64");
    return url.toString();
  } catch {
    return undefined;
  }
}

function prepareAvatarSource(sourceUrl: string): AvatarSource | undefined {
  const url = normalizeGitHubAvatarSourceUrl(sourceUrl);
  const key = url === undefined ? undefined : buildGitHubAvatarThumbnailCacheKey(url);
  return url === undefined || key === undefined ? undefined : { key, url };
}

function parseCacheRow(row: AvatarCacheRow, source: AvatarSource): AvatarCacheEntry | undefined {
  if (
    validCacheKey(row.avatar_key) !== source.key ||
    normalizeGitHubAvatarSourceUrl(row.source_url) !== source.url ||
    !isTimestamp(row.fetched_at) ||
    !isTimestamp(row.expires_at) ||
    !isTimestamp(row.last_accessed_at) ||
    !isTimestamp(row.updated_at) ||
    !Number.isSafeInteger(row.byte_length) ||
    row.byte_length < 0 ||
    !Number.isSafeInteger(row.failure_count) ||
    row.failure_count < 0
  ) {
    return undefined;
  }
  const mimeType = row.mime_type === null ? undefined : normalizeAvatarMimeType(row.mime_type);
  if (row.mime_type !== null && mimeType === undefined) return undefined;
  const nextRetryAt = isTimestamp(row.next_retry_at) ? row.next_retry_at : undefined;
  return {
    key: source.key,
    sourceUrl: source.url,
    ...(mimeType === undefined ? {} : { mimeType }),
    byteLength: row.byte_length,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
    lastAccessedAt: row.last_accessed_at,
    failureCount: row.failure_count,
    ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
    updatedAt: row.updated_at
  };
}

function normalizeAvatarMimeType(value: string): AvatarMimeType | undefined {
  const mimeType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mimeType === "image/avif" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/png" ||
    mimeType === "image/webp"
    ? mimeType
    : undefined;
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("GitHub avatar response had no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error("GitHub avatar thumbnail exceeds the cache size limit");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function notFoundResponse(): Response {
  return new Response(null, {
    status: 404,
    headers: { "Cache-Control": "no-store" }
  });
}

function validCacheKey(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function backoffMs(failureCount: number, initialBackoffMs: number, maxBackoffMs: number): number {
  return Math.min(maxBackoffMs, initialBackoffMs * 2 ** Math.max(0, failureCount - 1));
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}
