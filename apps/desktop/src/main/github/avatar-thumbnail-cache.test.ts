import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "../persistence/db";
import {
  buildGitHubAvatarThumbnailCacheKey,
  buildGitHubAvatarThumbnailUrl,
  GitHubAvatarThumbnailCache,
  normalizeGitHubAvatarSourceUrl,
  parseGitHubAvatarThumbnailUrl,
  type GitHubAvatarThumbnailTransport
} from "./avatar-thumbnail-cache";

const SOURCE_URL = "https://avatars.githubusercontent.com/u/1?v=4";
const FIRST_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const SECOND_BYTES = new Uint8Array([137, 80, 78, 71, 99, 97, 99, 104, 101]);

let db: DB;
let cacheDir: string;
let now: number;
let calls: string[];
let response: { contentType: string; bytes: Uint8Array };
let failFetch = false;
let cache: GitHubAvatarThumbnailCache;

beforeEach(() => {
  db = openDatabase(":memory:");
  cacheDir = mkdtempSync(join(tmpdir(), "pwrgit-github-avatar-cache-"));
  now = 1_000_000;
  calls = [];
  response = { contentType: "image/png", bytes: FIRST_BYTES };
  failFetch = false;
  const transport: GitHubAvatarThumbnailTransport = {
    fetchAvatar: async (sourceUrl) => {
      calls.push(sourceUrl);
      if (failFetch) throw new Error("offline");
      return response;
    }
  };
  cache = new GitHubAvatarThumbnailCache(db, {
    cacheDir,
    transport,
    ttlMs: 1_000,
    retentionMs: 2_000,
    initialBackoffMs: 100,
    maxBackoffMs: 400
  });
});

afterEach(() => {
  db.close();
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("GitHubAvatarThumbnailCache", () => {
  it("persists a compact local thumbnail and records refresh/access metadata", async () => {
    expect(await cache.read(SOURCE_URL, now)).toEqual({
      cacheState: "miss",
      refreshState: "idle",
      needsRefresh: true
    });

    const refreshed = await cache.refresh(SOURCE_URL, now);
    const avatarUrl = buildGitHubAvatarThumbnailUrl(
      buildGitHubAvatarThumbnailCacheKey(SOURCE_URL)!,
      now
    )!;
    expect(refreshed).toEqual({
      avatarUrl,
      cacheState: "fresh",
      refreshState: "idle",
      refreshedAt: now,
      needsRefresh: false
    });

    const source = normalizeGitHubAvatarSourceUrl(SOURCE_URL)!;
    const key = buildGitHubAvatarThumbnailCacheKey(SOURCE_URL)!;
    expect(calls).toEqual([source]);
    expect(existsSync(join(cacheDir, key))).toBe(true);
    expect(avatarRow(key)).toMatchObject({
      source_url: source,
      mime_type: "image/png",
      byte_length: FIRST_BYTES.byteLength,
      fetched_at: now,
      expires_at: now + 1_000,
      last_accessed_at: now,
      failure_count: 0,
      next_retry_at: null
    });

    now += 60 * 60 * 1000;
    expect(await cache.read(SOURCE_URL, now)).toEqual({
      avatarUrl,
      cacheState: "stale",
      refreshState: "idle",
      refreshedAt: 1_000_000,
      needsRefresh: true
    });
    // It is stale after its short test TTL but remains instantly usable while
    // a hover-triggered refresh runs in the background.
    expect(avatarRow(key)).toMatchObject({
      fetched_at: 1_000_000,
      last_accessed_at: now
    });
  });

  it("keeps a stale file visible while refreshing it once", async () => {
    const first = (await cache.refresh(SOURCE_URL, now)).avatarUrl;
    response = { contentType: "image/png", bytes: SECOND_BYTES };
    now += 1_001;

    expect(await cache.read(SOURCE_URL, now)).toEqual({
      avatarUrl: first,
      cacheState: "stale",
      refreshState: "idle",
      refreshedAt: 1_000_000,
      needsRefresh: true
    });
    const refreshed = await cache.refresh(SOURCE_URL, now);

    expect(refreshed).toEqual({
      avatarUrl: buildGitHubAvatarThumbnailUrl(
        buildGitHubAvatarThumbnailCacheKey(SOURCE_URL)!,
        now
      ),
      cacheState: "fresh",
      refreshState: "idle",
      refreshedAt: now,
      needsRefresh: false
    });
    expect(calls).toHaveLength(2);
    expect(avatarRow(buildGitHubAvatarThumbnailCacheKey(SOURCE_URL)!)).toMatchObject({
      fetched_at: now,
      expires_at: now + 1_000,
      failure_count: 0
    });
  });

  it("queues thumbnail downloads two at a time", async () => {
    let activeDownloads = 0;
    let maxActiveDownloads = 0;
    let downloadCalls = 0;
    const releases: Array<() => void> = [];
    let signalTwoStarted: (() => void) | undefined;
    let signalThirdStarted: (() => void) | undefined;
    const twoStarted = new Promise<void>((resolve) => {
      signalTwoStarted = resolve;
    });
    const thirdStarted = new Promise<void>((resolve) => {
      signalThirdStarted = resolve;
    });
    const limitedCache = new GitHubAvatarThumbnailCache(db, {
      cacheDir,
      transport: {
        fetchAvatar: async () => {
          downloadCalls += 1;
          activeDownloads += 1;
          maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
          if (activeDownloads === 2) signalTwoStarted?.();
          if (downloadCalls === 3) signalThirdStarted?.();
          await new Promise<void>((resolve) => releases.push(resolve));
          activeDownloads -= 1;
          return { contentType: "image/png", bytes: FIRST_BYTES };
        }
      }
    });

    const refreshes = [1, 2, 3].map((id) =>
      limitedCache.refresh(`https://avatars.githubusercontent.com/u/${id}?v=4`, now)
    );
    await twoStarted;
    expect(downloadCalls).toBe(2);
    expect(maxActiveDownloads).toBe(2);

    releases.shift()?.();
    await thirdStarted;
    expect(downloadCalls).toBe(3);
    expect(maxActiveDownloads).toBe(2);

    for (const release of releases) release();
    await expect(Promise.all(refreshes)).resolves.toHaveLength(3);
  });

  it("serves only a known opaque thumbnail URL as a cacheable local image", async () => {
    const avatarUrl = (await cache.refresh(SOURCE_URL, now)).avatarUrl!;
    const key = buildGitHubAvatarThumbnailCacheKey(SOURCE_URL)!;

    expect(parseGitHubAvatarThumbnailUrl(avatarUrl)).toBe(key);
    const response = await cache.respondToRendererUrl(avatarUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(FIRST_BYTES);

    expect(
      await cache.respondToRendererUrl(
        "https://avatars.githubusercontent.com/u/1?v=4"
      )
    ).toMatchObject({ status: 404 });
    expect(
      await cache.respondToRendererUrl(
        `pwrgit-avatar://thumbnail/${key}?v=${now}&unexpected=1`
      )
    ).toMatchObject({ status: 404 });
  });

  it("persists a retry gate for offline fetches without throwing", async () => {
    failFetch = true;

    await expect(cache.refresh(SOURCE_URL, now)).resolves.toEqual({
      cacheState: "miss",
      refreshState: "backing-off",
      nextRetryAt: now + 100,
      needsRefresh: false
    });
    const key = buildGitHubAvatarThumbnailCacheKey(SOURCE_URL)!;
    expect(avatarRow(key)).toMatchObject({
      failure_count: 1,
      next_retry_at: now + 100
    });
    expect(await cache.read(SOURCE_URL, now)).toEqual({
      cacheState: "miss",
      refreshState: "backing-off",
      nextRetryAt: now + 100,
      needsRefresh: false
    });
    await cache.refresh(SOURCE_URL, now);
    expect(calls).toHaveLength(1);

    now += 100;
    await cache.refresh(SOURCE_URL, now);
    expect(calls).toHaveLength(2);
    expect(avatarRow(key)).toMatchObject({
      failure_count: 2,
      next_retry_at: now + 200
    });
  });

  it("prunes unaccessed thumbnail files and rejects arbitrary image hosts", async () => {
    await cache.refresh(SOURCE_URL, now);
    const key = buildGitHubAvatarThumbnailCacheKey(SOURCE_URL)!;
    now += 2_001;
    await cache.pruneIfDue(now);

    expect(avatarRowOrUndefined(key)).toBeUndefined();
    expect(existsSync(join(cacheDir, key))).toBe(false);
    expect(
      normalizeGitHubAvatarSourceUrl(
        "https://avatars.githubusercontent.com/u/1?v=4&token=should-not-persist"
      )
    ).toBe("https://avatars.githubusercontent.com/u/1?v=4&s=64");
    expect(normalizeGitHubAvatarSourceUrl("https://example.com/avatar.png")).toBeUndefined();
    expect(normalizeGitHubAvatarSourceUrl("http://avatars.githubusercontent.com/u/1")).toBeUndefined();
  });
});

function avatarRow(key: string): Record<string, unknown> {
  const row = avatarRowOrUndefined(key);
  expect(row).toBeDefined();
  return row!;
}

function avatarRowOrUndefined(key: string): Record<string, unknown> | undefined {
  return db
    .prepare("SELECT * FROM github_avatar_thumbnail_cache WHERE avatar_key = ?")
    .get(key) as Record<string, unknown> | undefined;
}
