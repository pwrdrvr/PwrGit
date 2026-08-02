import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ok } from "@pwrgit/shared";
import type { GitExec } from "../git/dugite";
import { openDatabase, type DB } from "../persistence/db";
import {
  buildGitHubCommitAuthorIdentityCacheKey,
  GhCliCommitAuthorIdentityTransport,
  GitHubCommitAuthorIdentityService,
  type GitHubCommitAuthorProof,
  type GitHubCommitAuthorRemoteCommit,
  type GitHubCommitAuthorIdentityTransport
} from "./commit-author-identity";

const AUTHOR = {
  name: "Ada Lovelace",
  email: "ada@example.test"
};
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
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
let fetchImpl: () => Promise<GitHubCommitAuthorRemoteCommit>;
let requestedProofs: GitHubCommitAuthorProof[];
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
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4"
      },
      cacheState: "fresh",
      refreshState: "idle"
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
      github_login: "ada",
      fetched_at: now,
      expires_at: now + 7 * 24 * 60 * 60 * 1000
    });
    expect(JSON.stringify(row)).not.toContain(AUTHOR.name);
    expect(JSON.stringify(row)).not.toContain(AUTHOR.email);
    expect(JSON.stringify(row)).not.toContain("gho_");

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
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4"
      },
      cacheState: "fresh",
      refreshState: "idle"
    });
    expect(fetchCalls).toBe(1);
  });

  it("requires exact SHA, name, and email matches before accepting an identity", async () => {
    fetchImpl = async () => ({
      ...resolvedRemoteCommit(),
      author: { name: AUTHOR.name, email: "other@example.test" }
    });

    const request = service.request(INPUT);
    expect(await requireCompletion(request.completion)).toEqual({
      cacheState: "miss",
      refreshState: "backing-off"
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
      refreshState: "backing-off"
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
      refreshState: "idle"
    });
    expect(cachedRow().status).toBe("negative");

    expect(await requireCompletion(service.request(INPUT).completion)).toEqual({
      cacheState: "fresh",
      refreshState: "idle"
    });
    expect(fetchCalls).toBe(1);
  });

  it("deduplicates a stale exact-commit refresh", async () => {
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

    const first = service.request(INPUT);
    const duplicate = service.request(INPUT);
    expect(first.lookup).toEqual({ cacheState: "miss", refreshState: "in-flight" });
    expect(duplicate.lookup.refreshState).toBe("in-flight");
    expect(first.completion).toBe(duplicate.completion);

    await fetchStarted;
    expect(fetchCalls).toBe(2);
    releaseFetch?.({
      ...resolvedRemoteCommit(),
      githubAuthor: {
        login: "ada-lovelace",
        avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4"
      }
    });

    expect(await requireCompletion(first.completion)).toEqual({
      identity: {
        login: "ada-lovelace",
        avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4"
      },
      cacheState: "fresh",
      refreshState: "idle"
    });
  });

  it("backs off transport failures without rejecting the UI caller", async () => {
    fetchImpl = async () => {
      throw new Error("offline");
    };
    service = createService({ initialBackoffMs: 1_000, maxBackoffMs: 8_000 });

    expect(await requireCompletion(service.request(INPUT).completion)).toEqual({
      cacheState: "miss",
      refreshState: "backing-off"
    });
    expect(cachedRow().next_retry_at).toBe(now + 1_000);

    now += 999;
    const retryGated = service.request(INPUT);
    expect(await requireCompletion(retryGated.completion)).toEqual({
      cacheState: "miss",
      refreshState: "backing-off"
    });
    expect(fetchCalls).toBe(1);

    now += 1;
    await requireCompletion(service.request(INPUT).completion);
    expect(fetchCalls).toBe(2);
    expect(cachedRow().next_retry_at).toBe(now + 2_000);
  });

  it("does not serve a proven mapping outside its exact GitHub commit proof", async () => {
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
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4"
      },
      cacheState: "fresh",
      refreshState: "idle"
    });
    expect(fetchCalls).toBe(2);
    expect(requestedProofs).toEqual([PROOF, otherProof]);
    expect(cachedRow(PROOF)).toBeDefined();
    expect(cachedRow(otherProof)).toBeDefined();
    expect(cacheRowCount()).toBe(2);
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
      return await fetchImpl();
    }
  };
  return new GitHubCommitAuthorIdentityService(db, git, {
    transport,
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
