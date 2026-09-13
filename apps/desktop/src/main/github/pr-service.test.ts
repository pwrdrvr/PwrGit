import { createGitCafeProvider } from "../forge/gitcafe/provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ok, type PrSummary } from "@pwrgit/shared";
import { openDatabase, type DB } from "../persistence/db";
import type { GitExec } from "../git/dugite";
import type { ResolvedForge } from "../forge/providers";
import type { TokenForgeProvider, ForgeRepo } from "../forge/types";
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
  overrides: Partial<Omit<TokenForgeProvider, "kind">> = {},
  repo: ForgeRepo = GITHUB_ORIGIN
): () => ResolvedForge {
  const provider: TokenForgeProvider = {
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

  it("caches CLI-only GitCafe status without a token method", async () => {
    const provider = createGitCafeProvider(async () => JSON.stringify({ schemaVersion: 1, data: {
      items: [{ number: 7, title: "Fixture", state: "merged", draft: false, crossFork: false, sourceBranch: "feature/pr-state", targetBranch: "main" }],
      page: { nextCursor: null, truncated: false }
    }}));
    const cafe = new PrService(db, git, {
      resolveForge: () => ({ provider, repo: { kind: "gitcafe", host: "git.cafe", path: "sample/demo" } }),
      now: () => now
    });
    const result = await cafe.refreshRepo("repo", { branches: ["feature/pr-state"], trigger: "user" });
    expect(result.get("feature/pr-state")).toMatchObject({ number: 7, state: "merged", forge: "gitcafe" });
    expect(db.prepare("SELECT number FROM branch_pr WHERE repo_id = ?").get("repo")).toMatchObject({ number: 7 });
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

  it("persists and broadcasts CI-only changes to branch and commit caches", async () => {
    const hash = "a".repeat(40);
    const pending = pr({ checkState: "pending", checksStillRunning: true, mergeState: "mergeable" });
    response = new Map([["feature/pr-state", pending]]);
    commitResponse = new Map([[hash, pending]]);
    await service.refreshRepo("repo", { branches: ["feature/pr-state"], trigger: "user" });
    await service.refreshCommits("repo", [hash]);
    statusResponse = new Map([[42, pr({ checkState: "failing", checksStillRunning: false, mergeState: "conflicting" })]]);
    const changed = await service.refreshPrNumbers("repo", [42]);
    for (const summary of [changed.branches.get("feature/pr-state"), changed.commits.get(hash)]) {
      expect(summary).toMatchObject({ checkState: "failing", checksStillRunning: false, mergeState: "conflicting" });
    }
    for (const table of ["branch_pr", "commit_pr"]) {
      expect(db.prepare(`SELECT check_state, checks_still_running, merge_state FROM ${table}`).get()).toMatchObject({
        check_state: "failing", checks_still_running: 0, merge_state: "conflicting"
      });
    }
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

  it("does not let an invalidated refresh write into reused repository ids", async () => {
    let announceFetch = (): void => undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      announceFetch = resolve;
    });
    let releaseFetch = (_value: Map<string, PrSummary | null>): void => undefined;
    const fetchResult = new Promise<Map<string, PrSummary | null>>((resolve) => {
      releaseFetch = resolve;
    });
    service = new PrService(db, git, {
      resolveForge: fakeForge({
        fetchPrsForBranches: async () => {
          announceFetch();
          return await fetchResult;
        }
      }),
      now: () => now
    });

    const refresh = service.refreshRepo("repo", {
      branches: ["feature/pr-state"],
      force: true
    });
    await fetchStarted;

    // Profile deletion cascades the old repo, then invalidates async writes.
    // A new profile and index pass may immediately reuse both stable ids.
    db.prepare("DELETE FROM profiles WHERE id = 'profile'").run();
    service.invalidatePendingWrites();
    db.prepare(
      "INSERT INTO profiles (id, name, email) VALUES ('profile', 'Replacement', 'replacement@example.com')"
    ).run();
    db.prepare(
      "INSERT INTO repos (id, profile_id, name, path) VALUES ('repo', 'profile', 'Replacement', '/replacement')"
    ).run();

    releaseFetch(new Map([["feature/pr-state", pr()]]));

    await expect(refresh).resolves.toEqual(new Map());
    expect(
      db.prepare("SELECT 1 FROM branch_pr WHERE repo_id = 'repo'").get()
    ).toBeUndefined();
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

  /**
   * A refused query throws rather than answering "no PR" on every branch (see
   * "A refusal is not an answer" in ../forge/AGENTS.md). Nothing is written, so
   * `isFresh` cannot throttle the retry — that is what these four pin.
   */
  describe("when the forge refuses", () => {
    /** Rejects until `answer` is set, recording every branch list it was sent. */
    function refusingService(): {
      service: PrService;
      sent: string[][];
      setAnswer: (answer: Map<string, PrSummary | null>) => void;
    } {
      const sent: string[][] = [];
      let answer: Map<string, PrSummary | null> | undefined;
      const service = new PrService(db, git, {
        resolveForge: fakeForge({
          fetchPrsForBranches: async (_token, _repo, branches) => {
            sent.push(branches);
            if (answer === undefined) throw new Error("422 query is not valid");
            return answer;
          }
        }),
        now: () => now
      });
      return {
        service,
        sent,
        setAnswer: (next) => {
          answer = next;
        }
      };
    }

    it("writes no branch_pr row, so nothing is cached as 'no PR'", async () => {
      db.prepare(
        `INSERT INTO branch_pr (repo_id, branch, number, url, title, state, is_draft, fetched_at)
         VALUES ('repo', 'feature/pr-state', 7, 'u', 't', 'open', 0, '1970-01-01T00:00:00.000Z')`
      ).run();
      const { service } = refusingService();

      await expect(service.refreshRepo("repo")).resolves.toEqual(new Map());

      // The stale row survives untouched — including its fetched_at, which a
      // salvage path that wrote rows would have stamped forward.
      expect(
        db
          .prepare(
            "SELECT branch, number, fetched_at FROM branch_pr WHERE repo_id = 'repo'"
          )
          .all()
      ).toEqual([
        {
          branch: "feature/pr-state",
          number: 7,
          fetched_at: "1970-01-01T00:00:00.000Z"
        }
      ]);
    });

    it("throttles the retry for the TTL a successful refresh would have earned", async () => {
      const { service, sent } = refusingService();

      await service.refreshRepo("repo");
      expect(sent).toHaveLength(1);

      // A whole-repo sweep earns the 10-minute TTL, so every repo-row expand
      // inside it must stay off the network rather than re-sending the query.
      now += 9 * 60_000;
      await service.refreshRepo("repo");
      expect(sent).toHaveLength(1);

      now += 2 * 60_000;
      await service.refreshRepo("repo");
      expect(sent).toHaveLength(2);
    });

    it("backs a hover off on its own scope, and never on the sweep's", async () => {
      const { service, sent } = refusingService();

      const hover = async (): Promise<void> => {
        await service.refreshRepo("repo", {
          branches: ["feature/pr-state"],
          trigger: "user"
        });
      };

      // A refused sweep says nothing about a one-branch query — a complexity
      // cap refuses the first and answers the second — so the hover is not
      // held back by it at all.
      await service.refreshRepo("repo");
      await hover();
      expect(sent).toEqual([["feature/pr-state"], ["feature/pr-state"]]);

      // It is held back by its own previous failure, for its own ten seconds.
      now += 9_000;
      await hover();
      expect(sent).toHaveLength(2);
      now += 1_001;
      await hover();
      expect(sent).toHaveLength(3);

      // An explicit force is never held back, exactly as it is never held back
      // by `isFresh`.
      await service.refreshRepo("repo", { force: true });
      expect(sent).toHaveLength(4);
    });

    it("does not let a failing hover starve the whole-repo sweep", async () => {
      const { service, sent } = refusingService();

      // The damaging shape: the user keeps hovering a repo whose forge is
      // refusing. Each hover failure used to re-stamp the one shared mark, so
      // the sweep's ten-minute window never elapsed and the only refresh that
      // covers every branch never ran again.
      await service.refreshRepo("repo");
      for (let i = 0; i < 110; i += 1) {
        now += 11_000;
        await service.refreshRepo("repo", {
          branches: ["feature/pr-state"],
          trigger: "user"
        });
      }
      // Twenty minutes have passed; the sweep is due regardless of the hovers.
      const before = sent.length;
      await service.refreshRepo("repo");
      expect(sent.length).toBe(before + 1);
    });

    it("lets a one-branch success stand without clearing the sweep's backoff", async () => {
      // A complexity cap refuses the wide query and answers a narrow one. The
      // narrow success must not be read as evidence that the wide query works.
      const sent: string[][] = [];
      db.prepare(
        "INSERT INTO worktrees (id, repo_id, branch, path) VALUES ('wt-b', 'repo', 'feature/other', '/repo/other')"
      ).run();
      const service = new PrService(db, git, {
        resolveForge: fakeForge({
          fetchPrsForBranches: async (_token, _repo, branches) => {
            sent.push(branches);
            if (branches.length > 1) throw new Error("query is too complex");
            return new Map(branches.map((branch) => [branch, pr()]));
          }
        }),
        now: () => now
      });

      await service.refreshRepo("repo");
      expect(sent).toHaveLength(1);

      now += 11_000;
      await service.refreshRepo("repo", {
        branches: ["feature/pr-state"],
        trigger: "user"
      });
      expect(sent).toHaveLength(2);

      // The sweep is still inside the ten minutes its own failure earned.
      now += 1_000;
      await service.refreshRepo("repo");
      expect(sent).toHaveLength(2);
    });

    it("spawns no ref listing while the sweep is throttled", async () => {
      const gitCalls: string[][] = [];
      const countingGit: GitExec = async (args, cwd) => {
        gitCalls.push(args);
        return await git(args, cwd);
      };
      const sent: string[][] = [];
      const service = new PrService(db, countingGit, {
        resolveForge: fakeForge({
          fetchPrsForBranches: async (_token, _repo, branches) => {
            sent.push(branches);
            throw new Error("422 query is not valid");
          }
        }),
        now: () => now
      });

      await service.refreshRepo("repo");
      gitCalls.length = 0;

      // Three overlapping expands behind one mark. The throttle sits above
      // `branchesToCheck`, so none of them costs a `git for-each-ref` either —
      // the recursion would otherwise spawn two per queued caller.
      await Promise.all([
        service.refreshRepo("repo"),
        service.refreshRepo("repo"),
        service.refreshRepo("repo")
      ]);

      expect(sent).toHaveLength(1);
      expect(gitCalls).toEqual([]);
    });

    it("ignores a mark from the future, so a clock step cannot wedge refreshes", async () => {
      const { service, sent, setAnswer } = refusingService();

      await service.refreshRepo("repo");
      expect(sent).toHaveLength(1);

      // NTP corrects a machine that was an hour fast. Without the upper bound
      // the mark stays "inside the window" for the whole hour, and no renderer
      // dispatch sends `force` to escape it.
      now -= 60 * 60_000;
      setAnswer(new Map([["feature/pr-state", pr()]]));
      await service.refreshRepo("repo");

      expect(sent).toHaveLength(2);
      expect(service.cachedBranchPr("repo", "feature/pr-state")).toMatchObject({
        number: 42
      });
    });

    it("does not let a rejection land a backoff on a recreated repository", async () => {
      let releaseFetch = (): void => undefined;
      const blocked = new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      let announce = (): void => undefined;
      const started = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const sent: string[][] = [];
      const service = new PrService(db, git, {
        resolveForge: fakeForge({
          fetchPrsForBranches: async (_token, _repo, branches) => {
            sent.push(branches);
            announce();
            await blocked;
            throw new Error("token revoked");
          }
        }),
        now: () => now
      });

      const inFlight = service.refreshRepo("repo");
      await started;
      // Profile deletion: the generation moves and the backoff is cleared.
      service.invalidatePendingWrites();
      releaseFetch();
      await inFlight;

      // The rejection landed after the clear; it must not have re-armed it.
      await service.refreshRepo("repo");
      expect(sent).toHaveLength(2);
    });

    it("drops every backoff when pending writes are invalidated", async () => {
      const { service, sent } = refusingService();

      await service.refreshRepo("repo");
      expect(sent).toHaveLength(1);

      // Profile deletion. A profile recreated with the same ids must get a
      // fresh attempt, so this must clear inside the window, not wait it out.
      service.invalidatePendingWrites();
      now += 1_000;
      await service.refreshRepo("repo");
      expect(sent).toHaveLength(2);
    });

    it("clears the commit mark on a success, inside its own window", async () => {
      const sha = "a".repeat(40);
      const commitSent: string[][] = [];
      let answering = false;
      const service = new PrService(db, git, {
        resolveForge: fakeForge({
          fetchPrsForCommits: async (_token, _repo, hashes) => {
            commitSent.push(hashes);
            if (!answering) throw new Error("422 query is not valid");
            return new Map(hashes.map((hash) => [hash, null]));
          }
        }),
        now: () => now
      });

      await service.refreshCommits("repo", [sha], { trigger: "scheduled" });
      expect(commitSent).toHaveLength(1);

      answering = true;
      await service.refreshCommits("repo", [sha], { force: true });
      expect(commitSent).toHaveLength(2);

      // Inside the 60s the failure had earned. Drop the row so freshness is
      // not what lets this through — only the cleared mark can be.
      db.prepare("DELETE FROM commit_pr WHERE repo_id = 'repo'").run();
      now += 30_000;
      await service.refreshCommits("repo", [sha], { trigger: "scheduled" });
      expect(commitSent).toHaveLength(3);
    });

    it("forgets a removed repository's backoff", async () => {
      const { service, sent } = refusingService();

      await service.refreshRepo("repo");
      expect(sent).toHaveLength(1);

      // Repo ids are derived from the path, so a pruned-and-reindexed checkout
      // reuses this one and must not inherit its throttle.
      service.forget("repo");
      await service.refreshRepo("repo");
      expect(sent).toHaveLength(2);
    });

    it("does not let each queued caller start an attempt of its own", async () => {
      const { service, sent } = refusingService();

      // Three overlapping triggers — a repo-row expand, a worktree monitor and
      // a poll. The two that join the in-flight refresh recurse when it settles
      // and would otherwise each re-enter the network path.
      await Promise.all([
        service.refreshRepo("repo"),
        service.refreshRepo("repo"),
        service.refreshRepo("repo")
      ]);

      expect(sent).toHaveLength(1);
    });

    it("recovers on the next trigger once the forge answers again", async () => {
      const { service, sent, setAnswer } = refusingService();

      await service.refreshRepo("repo");
      now += 11 * 60_000;
      setAnswer(new Map([["feature/pr-state", pr()]]));
      const changed = await service.refreshRepo("repo");

      expect(sent).toHaveLength(2);
      expect(changed.get("feature/pr-state")).toMatchObject({ number: 42 });

      // And the mark is cleared, so the next refresh is throttled by the row's
      // own fetched_at rather than by a failure that is no longer true.
      now += 11 * 60_000;
      await service.refreshRepo("repo");
      expect(sent).toHaveLength(3);
    });

    it("clears the mark on a full success, inside the window it had earned", async () => {
      // Pins the `delete` itself: every assertion here sits *inside* the ten
      // minutes the failure earned, so a no-op delete changes the result.
      const { service, sent, setAnswer } = refusingService();

      await service.refreshRepo("repo");
      expect(sent).toHaveLength(1);

      now += 30_000;
      await service.refreshRepo("repo");
      expect(sent).toHaveLength(1); // still throttled

      setAnswer(new Map([["feature/pr-state", pr()]]));
      await service.refreshRepo("repo", { force: true });
      expect(sent).toHaveLength(2);

      // The row is now fresh, so drop it to isolate the mark: `isFresh` must
      // not be what lets the next call through.
      db.prepare("DELETE FROM branch_pr WHERE repo_id = 'repo'").run();
      now += 30_000;
      await service.refreshRepo("repo");
      expect(sent).toHaveLength(3);
    });

    it("keeps commit associations and throttles that retry separately", async () => {
      const sha = "a".repeat(40);
      const commitSent: string[][] = [];
      const service = new PrService(db, git, {
        resolveForge: fakeForge({
          fetchPrsForCommits: async (_token, _repo, hashes) => {
            commitSent.push(hashes);
            throw new Error("422 query is not valid");
          }
        }),
        now: () => now
      });

      await expect(service.refreshCommits("repo", [sha])).resolves.toEqual(
        new Map()
      );
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM commit_pr").get()
      ).toEqual({ n: 0 });

      // A scheduled poll inside the 60s window does not re-dispatch.
      now += 30_000;
      await service.refreshCommits("repo", [sha], { trigger: "scheduled" });
      expect(commitSent).toHaveLength(1);

      now += 31_000;
      await service.refreshCommits("repo", [sha], { trigger: "scheduled" });
      expect(commitSent).toHaveLength(2);
    });
  });

  /**
   * A batched client answers the chunks it reached and omits the rest rather
   * than discarding everything (see `fetchPrsForRepo`). The service must keep
   * what arrived and still treat the gap as an unfinished attempt.
   */
  describe("when only some batches resolved", () => {
    beforeEach(() => {
      db.prepare(
        "INSERT INTO worktrees (id, repo_id, branch, path) VALUES ('wt-other', 'repo', 'feature/other', '/repo/other')"
      ).run();
    });

    it("writes the branches that resolved and leaves the rest uncached", async () => {
      const sent: string[][] = [];
      const service = new PrService(db, git, {
        resolveForge: fakeForge({
          fetchPrsForBranches: async (_token, _repo, branches) => {
            sent.push(branches);
            return new Map([["feature/pr-state", pr()]]); // "feature/other" never reached
          }
        }),
        now: () => now
      });

      const changed = await service.refreshRepo("repo");

      expect(sent).toEqual([["feature/pr-state", "feature/other"]]);
      expect(changed.get("feature/pr-state")).toMatchObject({ number: 42 });
      expect(service.cachedBranchPr("repo", "feature/pr-state")).toMatchObject({
        number: 42
      });
      // Absent, not null: an omitted key has never been looked up, and caching
      // it as null is exactly the negative-cache this must not produce.
      expect(service.cachedBranchPr("repo", "feature/other")).toBeUndefined();
    });

    it("throttles the next attempt, because one gap leaves the repo stale", async () => {
      const sent: string[][] = [];
      const service = new PrService(db, git, {
        resolveForge: fakeForge({
          fetchPrsForBranches: async (_token, _repo, branches) => {
            sent.push(branches);
            return new Map([["feature/pr-state", pr()]]);
          }
        }),
        now: () => now
      });

      await service.refreshRepo("repo");
      // `isFresh` is all-or-nothing, so "feature/other" alone keeps the repo
      // stale and every expand would re-send both batches without the mark.
      now += 60_000;
      await service.refreshRepo("repo");
      expect(sent).toHaveLength(1);

      now += 10 * 60_000;
      await service.refreshRepo("repo");
      expect(sent).toHaveLength(2);
    });

    it("keeps the commit associations that resolved and refetches only the gap", async () => {
      const hashes = ["a".repeat(40), "b".repeat(40)];
      const commitSent: string[][] = [];
      const service = new PrService(db, git, {
        resolveForge: fakeForge({
          fetchPrsForCommits: async (_token, _repo, requested) => {
            commitSent.push(requested);
            return new Map([[hashes[0]!, pr({ number: 4 })]]);
          }
        }),
        now: () => now
      });

      await service.refreshCommits("repo", hashes);
      expect(
        service.cachedCommitPrs("repo", hashes).get(hashes[0]!)
      ).toMatchObject({ number: 4 });

      // Commit freshness is per hash, so the answered one is now fresh and the
      // gap shrinks the next request by itself — real forward progress, and
      // why a partial commit batch needs no repo-wide throttle.
      now += 30_000;
      await service.refreshCommits("repo", hashes, { trigger: "scheduled" });
      expect(commitSent).toEqual([hashes, [hashes[1]!]]);
    });
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

describe("PrService change-request detail", () => {
  const REMOTE = "git@github.com:pwrdrvr/PwrGit.git\n";
  const detailGit: GitExec = async (args) =>
    ok({
      stdout: args[0] === "for-each-ref" ? "feat\n" : REMOTE,
      stderr: "",
      exitCode: 0
    });

  const DETAILED: PrSummary = {
    number: 42,
    url: "https://github.com/pwrdrvr/PwrGit/pull/42",
    title: "Detailed",
    state: "open",
    isDraft: false,
    forge: "github",
    host: "github.com",
    repoPath: "pwrdrvr/PwrGit",
    headRefName: "feat",
    baseRefName: "main",
    additions: 10,
    deletions: 3,
    changedFiles: 2,
    commitCount: 4,
    createdAt: 1_000
  };

  let db: DB;

  beforeEach(() => {
    db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO profiles (id, name, email) VALUES ('p', 'P', 'p@example.com')"
    ).run();
    db.prepare(
      "INSERT INTO repos (id, profile_id, name, path) VALUES ('r', 'p', 'R', '/r')"
    ).run();
    db.prepare(
      "INSERT INTO worktrees (id, repo_id, branch, path) VALUES ('w', 'r', 'feat', '/r/w')"
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it("round-trips every detail column through the branch cache", async () => {
    const service = new PrService(db, detailGit, {
      resolveForge: fakeForge({
        fetchPrsForBranches: async () => new Map([["feat", DETAILED]])
      }),
      now: () => 1_000_000
    });

    await service.refreshRepo("r");

    expect(service.cachedBranchPr("r", "feat")).toMatchObject({
      forge: "github",
      host: "github.com",
      repoPath: "pwrdrvr/PwrGit",
      headRefName: "feat",
      baseRefName: "main",
      additions: 10,
      deletions: 3,
      changedFiles: 2,
      commitCount: 4,
      createdAt: 1_000
    });
  });

  it("keeps detail absent rather than zero when the forge did not report it", async () => {
    const service = new PrService(db, detailGit, {
      resolveForge: fakeForge({
        fetchPrsForBranches: async () =>
          new Map([
            [
              "feat",
              {
                number: 7,
                url: "u",
                title: "t",
                state: "open" as const,
                isDraft: false
              }
            ]
          ])
      }),
      now: () => 1_000_000
    });

    await service.refreshRepo("r");

    const cached = service.cachedBranchPr("r", "feat");
    // "Not known" must survive the round trip as absent, never as 0.
    for (const key of ["additions", "deletions", "changedFiles", "commitCount"]) {
      expect(cached).not.toHaveProperty(key);
    }
  });

  it("refreshes detail through the by-number update path", async () => {
    // This path UPDATEs rather than upserts, so it needs its own coverage:
    // a merged PR must carry its new diff size and mergedAt onto the branch row.
    const merged: PrSummary = {
      ...DETAILED,
      state: "merged",
      additions: 99,
      mergedAt: 2_000
    };
    const service = new PrService(db, detailGit, {
      resolveForge: fakeForge({
        fetchPrsForBranches: async () => new Map([["feat", DETAILED]]),
        fetchPrsByNumbers: async () => new Map([[42, merged]])
      }),
      now: () => 1_000_000
    });

    await service.refreshRepo("r");
    const deltas = await service.refreshPrNumbers("r", [42]);

    expect(deltas.branches.get("feat")).toMatchObject({ state: "merged" });
    expect(service.cachedBranchPr("r", "feat")).toMatchObject({
      state: "merged",
      additions: 99,
      mergedAt: 2_000
    });
  });
});
