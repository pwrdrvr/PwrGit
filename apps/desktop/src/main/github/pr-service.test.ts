import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ok, type PrSummary } from "@pwrgit/shared";
import { openDatabase, type DB } from "../persistence/db";
import type { GitExec } from "../git/dugite";
import type { ResolvedForge } from "../forge/providers";
import type { ForgeProvider, ForgeRepo } from "../forge/types";
import { PrService } from "./pr-service";

const REMOTE = "git@github.com:pwrdrvr/PwrGit.git\n";

const git: GitExec = async (args) =>
  ok({
    stdout: args[0] === "for-each-ref" ? "feature/pr-state\n" : REMOTE,
    stderr: "",
    exitCode: 0
  });

const GITHUB_ORIGIN: ForgeRepo = {
  kind: "github",
  host: "github.com",
  path: "pwrdrvr/PwrGit"
};

/**
 * A provider the service cannot tell from a real one. Only the methods a test
 * cares about are supplied; the rest answer with nothing, so a test that starts
 * exercising a new path fails loudly rather than hitting the network.
 */
function fakeForge(
  overrides: Partial<Omit<ForgeProvider, "kind">> = {},
  repo: ForgeRepo = GITHUB_ORIGIN
): () => ResolvedForge {
  const provider: ForgeProvider = {
    kind: repo.kind,
    getToken: async () => "token",
    fetchPrsForBranches: async () => new Map(),
    fetchPrsForCommits: async () => new Map(),
    fetchPrsByNumbers: async () => new Map(),
    ...overrides
  };
  return () => ({ provider, repo });
}

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    number: 42,
    url: "https://github.com/pwrdrvr/PwrGit/pull/42",
    title: "Keep PR state fresh",
    state: "open",
    isDraft: true,
    ...overrides
  };
}

describe("PrService", () => {
  let db: DB;
  let now: number;
  let response: Map<string, PrSummary | null>;
  let fetches: string[][];
  let commitResponse: Map<string, PrSummary | null>;
  let commitFetches: string[][];
  let statusResponse: Map<number, PrSummary | null>;
  let statusFetches: number[][];
  let service: PrService;

  beforeEach(() => {
    db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO profiles (id, name, email) VALUES ('profile', 'Profile', 'profile@example.com')"
    ).run();
    db.prepare(
      "INSERT INTO repos (id, profile_id, name, path) VALUES ('repo', 'profile', 'PwrGit', '/repo')"
    ).run();
    db.prepare(
      "INSERT INTO worktrees (id, repo_id, branch, path) VALUES ('wt', 'repo', 'feature/pr-state', '/repo/wt')"
    ).run();

    now = 1_000_000;
    response = new Map([["feature/pr-state", pr()]]);
    fetches = [];
    commitResponse = new Map();
    commitFetches = [];
    statusResponse = new Map();
    statusFetches = [];
    service = new PrService(db, git, {
      resolveForge: fakeForge({
        fetchPrsForBranches: async (_token, _repo, branches) => {
          fetches.push(branches);
          return response;
        },
        fetchPrsForCommits: async (_token, _repo, commitHashes) => {
          commitFetches.push(commitHashes);
          return new Map(commitHashes.map((hash) => [
            hash,
            commitResponse.get(hash) ?? null
          ]));
        },
        fetchPrsByNumbers: async (_token, _repo, numbers) => {
          statusFetches.push(numbers);
          return new Map(numbers.map((number) => [
            number,
            statusResponse.get(number) ?? null
          ]));
        }
      }),
      now: () => now
    });
  });

  afterEach(() => {
    if (db) db.close();
  });

  it("broadcasts a draft-to-ready change even when the lifecycle stays open", async () => {
    const first = await service.refreshRepo("repo", {
      branches: ["feature/pr-state"],
      trigger: "user"
    });
    expect(first.get("feature/pr-state")).toMatchObject({
      state: "open",
      isDraft: true
    });

    now += 10_000;
    response = new Map([["feature/pr-state", pr({ isDraft: false })]]);
    const changed = await service.refreshRepo("repo", {
      branches: ["feature/pr-state"],
      trigger: "user"
    });

    expect(changed.get("feature/pr-state")).toMatchObject({
      state: "open",
      isDraft: false
    });
    expect(
      db
        .prepare("SELECT state, is_draft FROM branch_pr WHERE repo_id = 'repo'")
        .get()
    ).toEqual({ state: "open", is_draft: 0 });
  });

  it("limits hover refreshes to one branch and ten-second user cooldown", async () => {
    await service.refreshRepo("repo", {
      branches: ["feature/pr-state"],
      trigger: "user"
    });
    await service.refreshRepo("repo", {
      branches: ["feature/pr-state"],
      trigger: "user"
    });

    expect(fetches).toEqual([["feature/pr-state"]]);

    now += 10_000;
    await service.refreshRepo("repo", {
      branches: ["feature/pr-state"],
      trigger: "user"
    });
    expect(fetches).toEqual([
      ["feature/pr-state"],
      ["feature/pr-state"]
    ]);
  });

  it("coalesces a focused refresh into an in-flight bulk refresh", async () => {
    db.prepare(
      "INSERT INTO worktrees (id, repo_id, branch, path) VALUES ('wt-other', 'repo', 'feature/other', '/repo/other')"
    ).run();

    let fetchStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    let resolveFetch: ((value: Map<string, PrSummary | null>) => void) | undefined;
    const fetchResult = new Promise<Map<string, PrSummary | null>>((resolve) => {
      resolveFetch = resolve;
    });
    fetches = [];
    service = new PrService(db, git, {
      resolveForge: fakeForge({
        fetchPrsForBranches: async (_token, _repo, branches) => {
          fetches.push(branches);
          fetchStarted?.();
          return await fetchResult;
        }
      }),
      now: () => now
    });

    const bulk = service.refreshRepo("repo");
    await started;
    const focused = service.refreshRepo("repo", {
      branches: ["feature/pr-state"],
      trigger: "user"
    });

    expect(fetches).toEqual([["feature/pr-state", "feature/other"]]);

    const latest = new Map<string, PrSummary | null>([
      ["feature/pr-state", pr({ state: "merged", isDraft: false })],
      ["feature/other", null]
    ]);
    resolveFetch?.(latest);

    await expect(bulk).resolves.toEqual(latest);
    await expect(focused).resolves.toEqual(new Map());
    expect(fetches).toHaveLength(1);
  });

  it("discovers PRs for local branches that are not checked out in worktrees", async () => {
    const localGit: GitExec = async (args) =>
      ok({
        stdout:
          args[0] === "for-each-ref"
            ? "feature/pr-state\nfeature/squashed\n"
            : REMOTE,
        stderr: "",
        exitCode: 0
      });
    response = new Map([
      ["feature/pr-state", pr()],
      ["feature/squashed", pr({ state: "merged", isDraft: false })]
    ]);
    service = new PrService(db, localGit, {
      resolveForge: fakeForge({
        fetchPrsForBranches: async (_token, _repo, branches) => {
          fetches.push(branches);
          return new Map(
            branches.map((branch) => [branch, response.get(branch) ?? null])
          );
        }
      }),
      now: () => now
    });

    await service.refreshRepo("repo");

    expect(fetches).toEqual([["feature/pr-state", "feature/squashed"]]);
    expect(service.cachedBranchPr("repo", "feature/squashed")?.state).toBe(
      "merged"
    );
  });

  it("looks up and caches only the exact visible commit set", async () => {
    const first = "0123456789abcdef0123456789abcdef01234567";
    const second = "fedcba9876543210fedcba9876543210fedcba98";
    const neverVisible = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    commitResponse = new Map([[first, pr({ number: 84 })]]);

    const changed = await service.refreshCommits("repo", [first, second], {
      trigger: "scheduled"
    });

    expect(commitFetches).toEqual([[first, second]]);
    expect(changed.get(first)?.number).toBe(84);
    expect(changed.get(second)).toBeNull();
    expect(service.cachedCommitPrs("repo", [first, second, neverVisible])).toEqual(
      new Map([
        [first, pr({ number: 84 })],
        [second, null]
      ])
    );
  });

  it("debounces repeated hover lookups with the focused refresh TTL", async () => {
    const hash = "0123456789abcdef0123456789abcdef01234567";
    commitResponse = new Map([[hash, pr()]]);

    await service.refreshCommits("repo", [hash], { trigger: "user" });
    await service.refreshCommits("repo", [hash], { trigger: "user" });
    expect(commitFetches).toEqual([[hash]]);

    now += 10_000;
    await service.refreshCommits("repo", [hash], { trigger: "user" });
    expect(commitFetches).toEqual([[hash], [hash]]);
  });

  it("polls a discovered PR once and fans status changes to branch and commit caches", async () => {
    const hash = "0123456789abcdef0123456789abcdef01234567";
    commitResponse = new Map([[hash, pr()]]);
    await service.refreshRepo("repo", {
      branches: ["feature/pr-state"],
      trigger: "scheduled"
    });
    await service.refreshCommits("repo", [hash], { trigger: "scheduled" });

    statusResponse = new Map([[42, pr({ state: "merged", isDraft: false })]]);
    const changed = await service.refreshPrNumbers("repo", [42, 42]);

    expect(statusFetches).toEqual([[42]]);
    expect(changed.branches.get("feature/pr-state")).toMatchObject({
      number: 42,
      state: "merged"
    });
    expect(changed.commits.get(hash)).toMatchObject({
      number: 42,
      state: "merged"
    });
    expect(service.cachedBranchPr("repo", "feature/pr-state")?.state).toBe("merged");
    expect(service.cachedCommitPrs("repo", [hash]).get(hash)?.state).toBe("merged");
  });

  it("does not let terminal status polls hide a later PR on a reused branch", async () => {
    response = new Map([[
      "feature/pr-state",
      pr({ state: "merged", isDraft: false })
    ]]);
    await service.refreshRepo("repo", {
      branches: ["feature/pr-state"],
      trigger: "scheduled"
    });
    const associationFetchedAt = (
      db.prepare(
        "SELECT fetched_at FROM branch_pr WHERE repo_id = 'repo' AND branch = 'feature/pr-state'"
      ).get() as { fetched_at: string }
    ).fetched_at;

    now += 60_000;
    statusResponse = new Map([[
      42,
      pr({ state: "merged", isDraft: false, title: "Updated old PR" })
    ]]);
    await service.refreshPrNumbers("repo", [42]);
    expect((
      db.prepare(
        "SELECT fetched_at FROM branch_pr WHERE repo_id = 'repo' AND branch = 'feature/pr-state'"
      ).get() as { fetched_at: string }
    ).fetched_at).toBe(associationFetchedAt);

    response = new Map([[
      "feature/pr-state",
      pr({ number: 43, state: "open", isDraft: false })
    ]]);
    await service.refreshRepo("repo", {
      branches: ["feature/pr-state"],
      trigger: "scheduled"
    });

    expect(fetches).toEqual([
      ["feature/pr-state"],
      ["feature/pr-state"]
    ]);
    expect(service.cachedBranchPr("repo", "feature/pr-state")?.number).toBe(43);
  });
});

describe("PrService across forges", () => {
  const GITLAB_REMOTE = "git@gitlab.com:pwrdrvr/qa/forge/PwrGit-Test.git\n";
  const gitlabGit: GitExec = async (args) =>
    ok({
      stdout: args[0] === "for-each-ref" ? "feat-merged\n" : GITLAB_REMOTE,
      stderr: "",
      exitCode: 0
    });

  let db: DB;

  beforeEach(() => {
    db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO profiles (id, name, email) VALUES ('profile', 'Profile', 'profile@example.com')"
    ).run();
    db.prepare(
      "INSERT INTO repos (id, profile_id, name, path) VALUES ('repo', 'profile', 'PwrGit-Test', '/repo')"
    ).run();
    db.prepare(
      "INSERT INTO worktrees (id, repo_id, branch, path) VALUES ('wt', 'repo', 'feat-merged', '/repo/wt')"
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  /**
   * The whole point of the abstraction: a merge request lands in the same
   * branch_pr cache, with the same delta semantics, as a pull request. Nothing
   * below mentions GitLab except the origin URL and the provider behind it.
   */
  it("caches a GitLab merge request through the same path as a PR", async () => {
    const seen: { host: string; path: string; branches: string[] }[] = [];
    const service = new PrService(db, gitlabGit, {
      resolveForge: fakeForge(
        {
          getToken: async (host) => `token-for-${host}`,
          fetchPrsForBranches: async (_token, repo, branches) => {
            seen.push({ host: repo.host, path: repo.path, branches });
            return new Map([
              [
                "feat-merged",
                pr({
                  number: 4,
                  state: "merged",
                  isDraft: false,
                  url: "https://gitlab.com/pwrdrvr/qa/forge/PwrGit-Test/-/merge_requests/4"
                })
              ]
            ]);
          }
        },
        {
          kind: "gitlab",
          host: "gitlab.com",
          path: "pwrdrvr/qa/forge/PwrGit-Test"
        }
      ),
      now: () => 1_000_000
    });

    const changed = await service.refreshRepo("repo");

    // The nested group path must survive intact — a two-field owner/repo
    // shape could not have carried it.
    expect(seen).toEqual([
      {
        host: "gitlab.com",
        path: "pwrdrvr/qa/forge/PwrGit-Test",
        branches: ["feat-merged"]
      }
    ]);
    expect(changed.get("feat-merged")).toMatchObject({ number: 4 });
    expect(service.cachedBranchPr("repo", "feat-merged")).toMatchObject({
      number: 4,
      state: "merged",
      isDraft: false
    });
  });

  it("no-ops when origin is on a host no provider claims", async () => {
    const unknownGit: GitExec = async (args) =>
      ok({
        stdout:
          args[0] === "for-each-ref"
            ? "feat-merged\n"
            : "git@bitbucket.org:team/repo.git\n",
        stderr: "",
        exitCode: 0
      });
    const service = new PrService(db, unknownGit, { now: () => 1_000_000 });

    await expect(service.refreshRepo("repo")).resolves.toEqual(new Map());
    expect(service.cachedBranchPr("repo", "feat-merged")).toBeUndefined();
  });

  it("asks the provider for a token per host", async () => {
    const hosts: string[] = [];
    const service = new PrService(db, gitlabGit, {
      resolveForge: fakeForge(
        {
          getToken: async (host) => {
            hosts.push(host);
            return null; // logged out — the refresh must simply do nothing
          }
        },
        { kind: "gitlab", host: "gitlab.example.com", path: "g/s/p" }
      ),
      now: () => 1_000_000
    });

    await expect(service.refreshRepo("repo")).resolves.toEqual(new Map());
    expect(hosts).toEqual(["gitlab.example.com"]);
  });
});
