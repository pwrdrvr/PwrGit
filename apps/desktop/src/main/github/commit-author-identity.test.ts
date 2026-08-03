import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ok } from "@pwrgit/shared";
import type { GitExec } from "../git/dugite";
import { openDatabase, type DB } from "../persistence/db";
import {
  associatedPullAuthorMatches,
  buildGitHubCommitAuthorAccountCacheKey,
  buildGitHubCommitAuthorIdentityCacheKey,
  GhCliCommitAuthorIdentityTransport,
  GitHubCommitAuthorIdentityService,
  type GitHubCommitAuthorProof,
  type GitHubCommitAuthorRemoteCommit,
  type GitHubCommitAuthorIdentityTransport
} from "./commit-author-identity";
import type { GitHubAvatarThumbnailStore } from "./avatar-thumbnail-cache";

const AUTHOR = {
  name: "Ada Lovelace",
  email: "ada@example.test"
};
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const CACHED_AVATAR_URL =
  "pwrgit-avatar://thumbnail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?v=1000000";
const PROOF = {
  owner: "octo-org",
  repo: "example-repo",
  commitSha: COMMIT_SHA
};
const INPUT = {
  worktreeId: "worktree-1",
  commitHash: COMMIT_SHA,
  authorName: AUTHOR.name,
  authorEmail: AUTHOR.email
};

let db: DB;
let now: number;
let fetchCalls: number;
let gitCalls: number;
let remoteUrl: string;
let fetchImpl: (proof: GitHubCommitAuthorProof) => Promise<GitHubCommitAuthorRemoteCommit>;
let requestedProofs: GitHubCommitAuthorProof[];
let thumbnailSources: string[];
let thumbnailReads: number;
let thumbnailRefreshes: number;
let thumbnailDataUrl: string | undefined;
let thumbnailNeedsRefresh: boolean;
let refreshThumbnailImpl: () => Promise<string | undefined>;
let service: GitHubCommitAuthorIdentityService;

beforeEach(() => {
  db = openDatabase(":memory:");
  seedWorktree(db);
  now = 1_000_000;
  fetchCalls = 0;
  gitCalls = 0;
  remoteUrl = "git@github.com:octo-org/example-repo.git\n";
  fetchImpl = async () => resolvedRemoteCommit();
  requestedProofs = [];
  thumbnailSources = [];
  thumbnailReads = 0;
  thumbnailRefreshes = 0;
  thumbnailDataUrl = CACHED_AVATAR_URL;
  thumbnailNeedsRefresh = false;
  refreshThumbnailImpl = async () => thumbnailDataUrl;
  service = createService();
});

afterEach(() => {
  if (db !== undefined) db.close();
});

describe("GitHubCommitAuthorIdentityService", () => {
  it("returns immediately, then persists a proof-backed identity without raw author data", async () => {
    const request = service.request(INPUT);

    expect(request.lookup).toEqual({
      cacheState: "miss",
      refreshState: "in-flight"
    });
    expect(await requireCompletion(request.completion)).toEqual({
      identity: {
        login: "ada",
        avatarUrl: CACHED_AVATAR_URL
      },
      cacheState: "fresh",
      refreshState: "idle",
      refreshedAt: now
    });
    expect(fetchCalls).toBe(1);
    expect(gitCalls).toBe(1);

    const identityKey = buildGitHubCommitAuthorIdentityCacheKey(AUTHOR, PROOF)!;
    const row = db
      .prepare(
        "SELECT * FROM github_commit_author_identity_cache WHERE identity_key = ?"
      )
      .get(identityKey) as Record<string, unknown>;
    expect(row).toMatchObject({
      status: "resolved",
      github_user_id: 1,
      github_login: "ada",
      fetched_at: now,
      expires_at: now + 7 * 24 * 60 * 60 * 1000,
      last_accessed_at: now
    });
    expect(JSON.stringify(row)).not.toContain(AUTHOR.name);
    expect(JSON.stringify(row)).not.toContain(AUTHOR.email);
    expect(JSON.stringify(row)).not.toContain("gho_");
    expect(JSON.stringify(row)).toContain("https://avatars.githubusercontent.com/u/1?v=4");

    const authorKey = buildGitHubCommitAuthorAccountCacheKey(AUTHOR)!;
    const account = db
      .prepare("SELECT * FROM github_commit_author_account_cache WHERE author_key = ?")
      .get(authorKey) as Record<string, unknown>;
    expect(account).toMatchObject({
      status: "resolved",
      github_user_id: 1,
      github_login: "ada",
      fetched_at: now,
      expires_at: now + 30 * 24 * 60 * 60 * 1000
    });
    expect(JSON.stringify(account)).not.toContain(AUTHOR.name);
    expect(JSON.stringify(account)).not.toContain(AUTHOR.email);

    const cached = service.request(INPUT);
    expect(cached).toEqual({
      lookup: {
        cacheState: "miss",
        refreshState: "in-flight"
      },
      completion: expect.any(Promise)
    });
    expect(await requireCompletion(cached.completion)).toEqual({
      identity: {
        login: "ada",
        avatarUrl: CACHED_AVATAR_URL
      },
      cacheState: "fresh",
      refreshState: "idle",
      refreshedAt: now
    });
    expect(fetchCalls).toBe(1);
    expect(thumbnailReads).toBe(2);
    expect(thumbnailRefreshes).toBe(0);
  });

  it("records cache access without re-fetching a fresh exact proof", async () => {
    await requireCompletion(service.request(INPUT).completion);
    const fetchedAt = cachedRow().fetched_at;

    now += 60 * 60 * 1000;
    expect(await requireCompletion(service.request(INPUT).completion)).toEqual({
      identity: { login: "ada", avatarUrl: CACHED_AVATAR_URL },
      cacheState: "fresh",
      refreshState: "idle",
      refreshedAt: fetchedAt
    });

    expect(fetchCalls).toBe(1);
    expect(cachedRow()).toMatchObject({
      fetched_at: fetchedAt,
      last_accessed_at: now
    });
  });

  it("warms new SHAs from an already-proven author account", async () => {
    await requireCompletion(service.request(INPUT).completion);
    fetchCalls = 0;

    expect(
      await requireCompletion(
        service.request({ ...INPUT, cacheOnly: true }).completion
      )
    ).toEqual({
      identity: { login: "ada", avatarUrl: CACHED_AVATAR_URL },
      cacheState: "fresh",
      refreshState: "idle",
      refreshedAt: now
    });
    expect(fetchCalls).toBe(0);

    const unseen = {
      ...INPUT,
      commitHash: "1111111111111111111111111111111111111111"
    };
    expect(
      await requireCompletion(service.request({ ...unseen, cacheOnly: true }).completion)
    ).toEqual({
      identity: { login: "ada", avatarUrl: CACHED_AVATAR_URL },
      cacheState: "fresh",
      refreshState: "idle",
      refreshedAt: now
    });
    expect(fetchCalls).toBe(0);

    const renamed = {
      ...unseen,
      commitHash: "2222222222222222222222222222222222222222",
      authorName: "A. Lovelace",
      cacheOnly: true
    };
    expect(await requireCompletion(service.request(renamed).completion)).toEqual({
      identity: { login: "ada", avatarUrl: CACHED_AVATAR_URL },
      cacheState: "fresh",
      refreshState: "idle",
      refreshedAt: now
    });
    expect(fetchCalls).toBe(0);
  });

  it("coalesces origin validation when a graph hydrates cached commits as one batch", async () => {
    const completions = Array.from({ length: 40 }, (_, index) =>
      requireCompletion(
        service.request({
          ...INPUT,
          commitHash: index.toString(16).padStart(40, "0"),
          cacheOnly: true
        }).completion
      )
    );

    await expect(Promise.all(completions)).resolves.toEqual(
      Array.from({ length: 40 }, () => ({
        cacheState: "miss",
        refreshState: "idle"
      }))
    );
    expect(gitCalls).toBe(1);
    expect(fetchCalls).toBe(0);
  });

  it("repaints with a local thumbnail after the identity has already settled", async () => {
    thumbnailDataUrl = undefined;
    thumbnailNeedsRefresh = true;
    let releaseThumbnail: ((avatarUrl: string) => void) | undefined;
    let signalThumbnailStarted: (() => void) | undefined;
    const thumbnailStarted = new Promise<void>((resolve) => {
      signalThumbnailStarted = resolve;
    });
    refreshThumbnailImpl = async () =>
      await new Promise<string>((resolve) => {
        signalThumbnailStarted?.();
        releaseThumbnail = resolve;
      });

    let resolveUpdated: ((lookup: unknown) => void) | undefined;
    const updated = new Promise<unknown>((resolve) => {
      resolveUpdated = resolve;
    });
    const request = service.request(INPUT, (lookup) => resolveUpdated?.(lookup));

    expect(await requireCompletion(request.completion)).toEqual({
      identity: { login: "ada" },
      cacheState: "fresh",
      refreshState: "idle",
      refreshedAt: now,
      avatarCache: { cacheState: "miss", refreshState: "in-flight" }
    });
    await thumbnailStarted;
    releaseThumbnail?.(CACHED_AVATAR_URL);

    expect(await updated).toEqual({
      identity: { login: "ada", avatarUrl: CACHED_AVATAR_URL },
      cacheState: "fresh",
      refreshState: "idle",
      refreshedAt: now
    });
    expect(thumbnailRefreshes).toBe(1);
    expect(thumbnailSources).toContain("https://avatars.githubusercontent.com/u/1?v=4&s=64");
  });

  it("requires exact SHA, name, and email matches before accepting an identity", async () => {
    fetchImpl = async () => ({
      ...resolvedRemoteCommit(),
      author: { name: AUTHOR.name, email: "other@example.test" }
    });

    const request = service.request(INPUT);
    expect(await requireCompletion(request.completion)).toEqual({
      cacheState: "miss",
      refreshState: "backing-off",
      nextRetryAt: now + 60_000
    });

    const row = cachedRow();
    expect(row).toMatchObject({
      status: "unavailable",
      failure_count: 1,
      next_retry_at: now + 60_000
    });
    expect(row.github_login).toBeNull();

    const retryGated = service.request(INPUT);
    expect(retryGated.lookup).toEqual({
      cacheState: "miss",
      refreshState: "in-flight"
    });
    expect(await requireCompletion(retryGated.completion)).toEqual({
      cacheState: "miss",
      refreshState: "backing-off",
      nextRetryAt: now + 60_000
    });
    expect(fetchCalls).toBe(1);
  });

  it("negative-caches an exact commit that GitHub associates with no account", async () => {
    fetchImpl = async () => ({
      sha: COMMIT_SHA,
      author: AUTHOR,
      githubAuthor: null
    });

    expect(await requireCompletion(service.request(INPUT).completion)).toEqual({
      cacheState: "fresh",
      refreshState: "idle",
      refreshedAt: now
    });
    expect(cachedRow().status).toBe("negative");

    expect(await requireCompletion(service.request(INPUT).completion)).toEqual({
      cacheState: "fresh",
      refreshState: "idle",
      refreshedAt: now
    });
    expect(fetchCalls).toBe(1);
  });

  it("serves a stale local identity, then deduplicates its exact-commit refresh", async () => {
    await requireCompletion(service.request(INPUT).completion);

    let releaseFetch:
      | ((value: GitHubCommitAuthorRemoteCommit) => void)
      | undefined;
    let signalFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      signalFetchStarted = resolve;
    });
    fetchImpl = async () =>
      await new Promise<GitHubCommitAuthorRemoteCommit>((resolve) => {
        signalFetchStarted?.();
        releaseFetch = resolve;
      });
    now += 7 * 24 * 60 * 60 * 1000 + 1;

    let resolveUpdated: ((lookup: unknown) => void) | undefined;
    const updated = new Promise<unknown>((resolve) => {
      resolveUpdated = resolve;
    });
    const first = service.request(INPUT, (lookup) => resolveUpdated?.(lookup));
    const duplicate = service.request(INPUT);
    expect(first.lookup).toEqual({ cacheState: "miss", refreshState: "in-flight" });
    expect(duplicate.lookup.refreshState).toBe("in-flight");
    expect(first.completion).toBe(duplicate.completion);

    expect(await requireCompletion(first.completion)).toEqual({
      identity: { login: "ada", avatarUrl: CACHED_AVATAR_URL },
      cacheState: "stale",
      refreshState: "in-flight",
      refreshedAt: 1_000_000
    });

    await fetchStarted;
    expect(fetchCalls).toBe(2);
    releaseFetch?.({
      ...resolvedRemoteCommit(),
      githubAuthor: {
        id: 1,
        login: "ada-lovelace",
        avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4"
      }
    });

    expect(await updated).toEqual({
      identity: {
        login: "ada-lovelace",
        avatarUrl: CACHED_AVATAR_URL
      },
      cacheState: "fresh",
      refreshState: "idle",
      refreshedAt: now
    });
  });

  it("marks a reused author ambiguous when a later exact proof identifies another account", async () => {
    await requireCompletion(service.request(INPUT).completion);
    now += 30 * 24 * 60 * 60 * 1000 + 1;

    const conflictingHash = "1111111111111111111111111111111111111111";
    fetchImpl = async () => ({
      ...resolvedRemoteCommit(),
      sha: conflictingHash,
      githubAuthor: {
        id: 2,
        login: "different-account",
        avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4"
      }
    });
    let resolveUpdated: ((lookup: unknown) => void) | undefined;
    const updated = new Promise<unknown>((resolve) => {
      resolveUpdated = resolve;
    });
    const request = service.request(
      { ...INPUT, commitHash: conflictingHash },
      (lookup) => resolveUpdated?.(lookup)
    );

    expect(await requireCompletion(request.completion)).toMatchObject({
      identity: { login: "ada" },
      cacheState: "stale",
      refreshState: "in-flight"
    });
    expect(await updated).toMatchObject({
      identity: { login: "different-account" },
      cacheState: "fresh"
    });

    const authorKey = buildGitHubCommitAuthorAccountCacheKey(AUTHOR)!;
    expect(db.prepare(
      "SELECT status, github_user_id, github_login FROM github_commit_author_account_cache WHERE author_key = ?"
    ).get(authorKey)).toEqual({
      status: "ambiguous",
      github_user_id: null,
      github_login: null
    });
    expect(await requireCompletion(service.request({
      ...INPUT,
      commitHash: "2222222222222222222222222222222222222222",
      cacheOnly: true
    }).completion)).toEqual({ cacheState: "miss", refreshState: "idle" });
  });

  it("marks an older conflicting exact proof ambiguous regardless of hydration order", async () => {
    now = 2_000_000;
    await requireCompletion(service.request(INPUT).completion);

    const conflictingHash = "1111111111111111111111111111111111111111";
    const conflictingProof = { ...PROOF, commitSha: conflictingHash };
    const conflictingKey = buildGitHubCommitAuthorIdentityCacheKey(
      AUTHOR,
      conflictingProof
    )!;
    db.prepare(
      `INSERT INTO github_commit_author_identity_cache(
         identity_key, status, github_user_id, github_login, avatar_url,
         fetched_at, expires_at, last_accessed_at, failure_count,
         next_retry_at, updated_at
       ) VALUES (?, 'resolved', 2, 'different-account', NULL, ?, ?, ?, 0, NULL, ?)`
    ).run(conflictingKey, 1_000_000, 3_000_000, 1_000_000, 1_000_000);

    expect(await requireCompletion(service.request({
      ...INPUT,
      commitHash: conflictingHash,
      cacheOnly: true
    }).completion)).toMatchObject({
      identity: { login: "different-account" },
      cacheState: "fresh"
    });

    const authorKey = buildGitHubCommitAuthorAccountCacheKey(AUTHOR)!;
    expect(db.prepare(
      "SELECT status, github_user_id, github_login FROM github_commit_author_account_cache WHERE author_key = ?"
    ).get(authorKey)).toEqual({
      status: "ambiguous",
      github_user_id: null,
      github_login: null
    });
  });

  it("queues exact-proof refreshes two at a time", async () => {
    const commitHashes = [
      COMMIT_SHA,
      "1111111111111111111111111111111111111111",
      "2222222222222222222222222222222222222222"
    ];
    let activeFetches = 0;
    let maxActiveFetches = 0;
    const releases: Array<() => void> = [];
    let signalTwoStarted: (() => void) | undefined;
    let signalThirdStarted: (() => void) | undefined;
    const twoStarted = new Promise<void>((resolve) => {
      signalTwoStarted = resolve;
    });
    const thirdStarted = new Promise<void>((resolve) => {
      signalThirdStarted = resolve;
    });
    fetchImpl = async (proof) => {
      activeFetches += 1;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      if (activeFetches === 2) signalTwoStarted?.();
      if (fetchCalls === 3) signalThirdStarted?.();
      await new Promise<void>((resolve) => releases.push(resolve));
      activeFetches -= 1;
      return { ...resolvedRemoteCommit(), sha: proof.commitSha };
    };

    const requests = commitHashes.map((commitHash) =>
      service.request({ ...INPUT, commitHash })
    );
    await twoStarted;
    expect(fetchCalls).toBe(2);
    expect(maxActiveFetches).toBe(2);

    releases.shift()?.();
    await thirdStarted;
    expect(fetchCalls).toBe(3);
    expect(maxActiveFetches).toBe(2);

    for (const release of releases) release();
    await Promise.all(requests.map((request) => requireCompletion(request.completion)));
  });

  it("backs off transport failures without rejecting the UI caller", async () => {
    fetchImpl = async () => {
      throw new Error("offline");
    };
    service = createService({ initialBackoffMs: 1_000, maxBackoffMs: 8_000 });

    expect(await requireCompletion(service.request(INPUT).completion)).toEqual({
      cacheState: "miss",
      refreshState: "backing-off",
      nextRetryAt: now + 1_000
    });
    expect(cachedRow().next_retry_at).toBe(now + 1_000);

    now += 999;
    const retryGated = service.request(INPUT);
    expect(await requireCompletion(retryGated.completion)).toEqual({
      cacheState: "miss",
      refreshState: "backing-off",
      nextRetryAt: 1_001_000
    });
    expect(fetchCalls).toBe(1);

    now += 1;
    await requireCompletion(service.request(INPUT).completion);
    expect(fetchCalls).toBe(2);
    expect(cachedRow().next_retry_at).toBe(now + 2_000);
  });

  it("reuses a proven author across GitHub repos but never on a non-GitHub remote", async () => {
    await requireCompletion(service.request(INPUT).completion);
    expect(fetchCalls).toBe(1);

    expect(service.request({ ...INPUT, commitHash: COMMIT_SHA.slice(0, 12) })).toEqual({
      lookup: { cacheState: "miss", refreshState: "not-eligible" }
    });
    expect(fetchCalls).toBe(1);

    remoteUrl = "git@gitlab.com:octo-org/example-repo.git\n";
    const nonGitHub = service.request(INPUT);
    expect(nonGitHub.lookup).toEqual({
      cacheState: "miss",
      refreshState: "in-flight"
    });
    expect(await requireCompletion(nonGitHub.completion)).toEqual({
      cacheState: "miss",
      refreshState: "not-eligible"
    });
    expect(fetchCalls).toBe(1);

    const otherProof = {
      owner: "other-org",
      repo: "other-repo",
      commitSha: COMMIT_SHA
    };
    remoteUrl = "git@github.com:other-org/other-repo.git\n";
    const otherRepository = service.request(INPUT);
    expect(otherRepository.lookup).toEqual({
      cacheState: "miss",
      refreshState: "in-flight"
    });
    expect(await requireCompletion(otherRepository.completion)).toEqual({
      identity: {
        login: "ada",
        avatarUrl: CACHED_AVATAR_URL
      },
      cacheState: "fresh",
      refreshState: "idle",
      refreshedAt: now
    });
    expect(fetchCalls).toBe(1);
    expect(requestedProofs).toEqual([PROOF]);
    expect(cachedRow(PROOF)).toBeDefined();
    expect(cachedRowOrUndefined(otherProof)).toBeUndefined();
    expect(cacheRowCount()).toBe(1);
  });
});

describe("GhCliCommitAuthorIdentityTransport", () => {
  it("uses gh api without token extraction or a credential parameter", async () => {
    const calls: string[][] = [];
    const transport = new GhCliCommitAuthorIdentityTransport({
      run: async (args) => {
        calls.push(args);
        return JSON.stringify({
          sha: COMMIT_SHA,
          commit: { author: AUTHOR },
          author: {
            id: 1,
            login: "ada",
            avatar_url: "https://avatars.githubusercontent.com/u/1?v=4"
          }
        });
      }
    });

    await expect(
      transport.fetchCommit({
        owner: "octo-org",
        repo: "example-repo",
        commitSha: COMMIT_SHA
      })
    ).resolves.toEqual(resolvedRemoteCommit());
    expect(calls).toEqual([
      [
        "api",
        "--hostname",
        "github.com",
        `repos/octo-org/example-repo/commits/${COMMIT_SHA}`,
        "--method",
        "GET",
        "--header",
        "Accept: application/vnd.github+json",
        "--header",
        "X-GitHub-Api-Version: 2022-11-28"
      ]
    ]);
    expect(calls[0]).not.toContain("auth");
    expect(calls[0]).not.toContain("token");
  });

  it("corroborates a unique associated-PR author when GitHub leaves author null", async () => {
    const calls: string[][] = [];
    const transport = new GhCliCommitAuthorIdentityTransport({
      run: async (args) => {
        calls.push(args);
        const endpoint = args[3];
        if (endpoint === `repos/openclaw/openclaw/commits/${COMMIT_SHA}`) {
          return JSON.stringify({
            sha: COMMIT_SHA,
            commit: {
              author: { name: "Peter Steinberger", email: "steipete@macos.shared" }
            },
            author: null
          });
        }
        if (endpoint === `repos/openclaw/openclaw/commits/${COMMIT_SHA}/pulls`) {
          return JSON.stringify([{ user: {
            id: 58493,
            login: "steipete",
            avatar_url: "https://avatars.githubusercontent.com/u/58493?v=4"
          } }]);
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }
    });

    await expect(transport.fetchCommit({
      owner: "openclaw",
      repo: "openclaw",
      commitSha: COMMIT_SHA
    })).resolves.toEqual({
      sha: COMMIT_SHA,
      author: { name: "Peter Steinberger", email: "steipete@macos.shared" },
      githubAuthor: {
        id: 58493,
        login: "steipete",
        avatarUrl: "https://avatars.githubusercontent.com/u/58493?v=4"
      }
    });
    expect(calls).toHaveLength(2);
    expect(calls.flat()).not.toContain("token");
  });
});

describe("associatedPullAuthorMatches", () => {
  it("requires the Git name or email local part to match the PR login", () => {
    expect(associatedPullAuthorMatches(
      { login: "steipete", name: "Peter Steinberger" },
      { name: "Peter Steinberger", email: "steipete@macos.shared" }
    )).toBe(true);
    expect(associatedPullAuthorMatches(
      { login: "somebody-else", name: "Peter Steinberger" },
      { name: "Peter Steinberger", email: "steipete@macos.shared" }
    )).toBe(false);
    expect(associatedPullAuthorMatches(
      { login: "steipete", name: "Different Person" },
      { name: "Peter Steinberger", email: "different@macos.shared" }
    )).toBe(false);
    expect(associatedPullAuthorMatches(
      { login: "steipete" },
      { name: "steipete", email: "different@macos.shared" }
    )).toBe(true);
  });
});

function createService(options?: {
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}): GitHubCommitAuthorIdentityService {
  const git: GitExec = async () => {
    gitCalls += 1;
    return ok({ stdout: remoteUrl, stderr: "", exitCode: 0 });
  };
  const transport: GitHubCommitAuthorIdentityTransport = {
    fetchCommit: async (proof) => {
      fetchCalls += 1;
      requestedProofs.push(proof);
      return await fetchImpl(proof);
    }
  };
  const thumbnailStore: GitHubAvatarThumbnailStore = {
    read: async (sourceUrl) => {
      thumbnailSources.push(sourceUrl);
      thumbnailReads += 1;
      return {
        ...(thumbnailDataUrl === undefined ? {} : { avatarUrl: thumbnailDataUrl }),
        cacheState: thumbnailDataUrl === undefined ? "miss" : "fresh",
        refreshState: "idle",
        ...(thumbnailDataUrl === undefined ? {} : { refreshedAt: now }),
        needsRefresh: thumbnailNeedsRefresh
      };
    },
    refresh: async (sourceUrl) => {
      thumbnailSources.push(sourceUrl);
      thumbnailRefreshes += 1;
      const avatarUrl = await refreshThumbnailImpl();
      thumbnailDataUrl = avatarUrl;
      thumbnailNeedsRefresh = false;
      return {
        ...(avatarUrl === undefined ? {} : { avatarUrl }),
        cacheState: avatarUrl === undefined ? "miss" : "fresh",
        refreshState: "idle",
        ...(avatarUrl === undefined ? {} : { refreshedAt: now }),
        needsRefresh: false
      };
    },
    pruneIfDue: async () => {}
  };
  return new GitHubCommitAuthorIdentityService(db, git, {
    transport,
    thumbnailStore,
    now: () => now,
    ...options
  });
}

function seedWorktree(database: DB): void {
  database
    .prepare("INSERT INTO profiles (id, name, email, roots) VALUES (?, ?, ?, ?)")
    .run("profile-1", "Personal", "ada@example.test", "[]");
  database
    .prepare("INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)")
    .run("repo-1", "profile-1", "example-repo", "/example/repo");
  database
    .prepare("INSERT INTO worktrees (id, repo_id, branch, path) VALUES (?, ?, ?, ?)")
    .run("worktree-1", "repo-1", "main", "/example/repo");
}

function resolvedRemoteCommit(): GitHubCommitAuthorRemoteCommit {
  return {
    sha: COMMIT_SHA,
    author: AUTHOR,
    githubAuthor: {
      id: 1,
      login: "ada",
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4"
    }
  };
}

function cachedRow(proof: GitHubCommitAuthorProof = PROOF): Record<string, unknown> {
  const row = cachedRowOrUndefined(proof);
  expect(row).toBeDefined();
  return row!;
}

function cachedRowOrUndefined(
  proof: GitHubCommitAuthorProof = PROOF
): Record<string, unknown> | undefined {
  const identityKey = buildGitHubCommitAuthorIdentityCacheKey(AUTHOR, proof)!;
  return db
    .prepare(
      "SELECT * FROM github_commit_author_identity_cache WHERE identity_key = ?"
    )
    .get(identityKey) as Record<string, unknown> | undefined;
}

function cacheRowCount(): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS count FROM github_commit_author_identity_cache")
      .get() as { count: number }
  ).count;
}

async function requireCompletion(
  completion: Promise<unknown> | undefined
): Promise<unknown> {
  expect(completion).toBeDefined();
  return await completion!;
}
