import { describe, expect, it, vi } from "vitest";
import type { PruneScanProgress, Repo, Worktree } from "@pwrgit/shared";
import {
  candidatesForRepo,
  needsStateCompute,
  PRUNE_SCAN_CONCURRENCY,
  PRUNE_STATE_FRESH_MS,
  sweepPrunableWorktrees,
  type PruneScanRepoInput
} from "./worktree-prune";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-13T00:00:00.000Z");
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString();

function wt(partial: Partial<Worktree> & { id: string; branch: string }): Worktree {
  return {
    repoId: "r",
    path: `/w/${partial.id}`,
    dirty: 0,
    ahead: 0,
    behind: 0,
    behindDefault: 0,
    defaultBranch: "main",
    mergedIntoDefault: false,
    divergedFromDefault: false,
    isDefaultBranch: false,
    pinned: false,
    isPrimary: false,
    ...partial
  };
}

function repo(id: string, worktrees: Worktree[]): Repo {
  return {
    id,
    name: id,
    path: `/repos/${id}`,
    profileId: "p",
    pinned: false,
    worktrees: worktrees.map((worktree) => ({ ...worktree, repoId: id }))
  };
}

function input(
  id: string,
  worktreeIds: string[],
  stateComputedAt: number | null = null
): PruneScanRepoInput {
  return { id, name: id, path: `/repos/${id}`, worktreeIds, stateComputedAt };
}

const stale = (id: string): Worktree =>
  wt({ id, branch: id, mergedIntoDefault: true, lastActivityAt: ago(60) });

describe("needsStateCompute", () => {
  it("computes a repo that has never been computed", () => {
    expect(needsStateCompute(input("a", ["w1"], null), NOW)).toBe(true);
  });

  it("reuses a snapshot inside the freshness window", () => {
    const fresh = input("a", ["w1"], NOW - PRUNE_STATE_FRESH_MS / 2);
    expect(needsStateCompute(fresh, NOW)).toBe(false);
  });

  it("recomputes a snapshot past the window", () => {
    const old = input("a", ["w1"], NOW - PRUNE_STATE_FRESH_MS - 1);
    expect(needsStateCompute(old, NOW)).toBe(true);
  });

  it("recomputes anything when forced", () => {
    const fresh = input("a", ["w1"], NOW);
    expect(needsStateCompute(fresh, NOW, undefined, true)).toBe(true);
  });

  it("never computes a repo with no linked worktrees to judge", () => {
    // Forced or not: there is nothing here the predicate could say yes to.
    expect(needsStateCompute(input("a", []), NOW)).toBe(false);
    expect(needsStateCompute(input("a", []), NOW, undefined, true)).toBe(false);
  });
});

describe("candidatesForRepo", () => {
  it("carries the reason, age, lock flag and repo identity onto each row", () => {
    const candidates = candidatesForRepo(
      repo("svc", [
        wt({ id: "primary", branch: "main", isPrimary: true, isDefaultBranch: true }),
        wt({
          id: "done",
          branch: "feat/done",
          mergedIntoDefault: true,
          lastActivityAt: ago(40),
          locked: true
        }),
        wt({ id: "busy", branch: "feat/busy", dirty: 2 })
      ]),
      NOW
    );
    expect(candidates).toEqual([
      {
        worktreeId: "done",
        repoId: "svc",
        repoName: "svc",
        branch: "feat/done",
        path: "/w/done",
        reason: { kind: "merged_into_default", defaultBranch: "main" },
        lastActivityAt: ago(40),
        locked: true,
        sizeBytes: null
      }
    ]);
  });

  it("returns nothing for a repo with only its primary checkout", () => {
    const only = repo("solo", [
      wt({ id: "p", branch: "main", isPrimary: true, isDefaultBranch: true })
    ]);
    expect(candidatesForRepo(only, NOW)).toEqual([]);
  });
});

describe("sweepPrunableWorktrees", () => {
  const options = (
    repos: Record<string, Repo>,
    overrides: Partial<Parameters<typeof sweepPrunableWorktrees>[1]> = {}
  ): Parameters<typeof sweepPrunableWorktrees>[1] => ({
    operationId: "op",
    now: () => new Date(NOW),
    computeRepoState: async () => undefined,
    readRepo: (repoId) => repos[repoId] ?? null,
    ...overrides
  });

  it("computes cold repos, reuses fresh ones, and reports which is which", async () => {
    const computed: string[] = [];
    const summary = await sweepPrunableWorktrees(
      [
        input("cold", ["w1"], null),
        input("warm", ["w2"], NOW - 1000),
        input("empty", [])
      ],
      options(
        {
          cold: repo("cold", [stale("w1")]),
          warm: repo("warm", [stale("w2")]),
          empty: repo("empty", [])
        },
        {
          computeRepoState: async (repoId) => {
            computed.push(repoId);
          }
        }
      )
    );
    expect(computed).toEqual(["cold"]);
    expect(summary.counts.repos).toEqual({
      scanned: 1,
      cached: 1,
      skipped: 1,
      failed: 0,
      cancelled: 0
    });
    expect(summary.counts.candidates).toBe(2);
    expect(summary.counts.worktreesConsidered).toBe(2);
    expect(summary.cancelled).toBe(false);
  });

  it("reads the repo AFTER computing, so the sweep sees fresh state", async () => {
    // The whole reason the sweep exists: on a profile nobody has browsed there
    // is no state to filter, so reading the tree first reports "nothing to
    // prune" on a disk full of finished worktrees.
    const empty = repo("late", [wt({ id: "w1", branch: "feat/x" })]);
    const filled = repo("late", [stale("w1")]);
    let computedYet = false;
    const summary = await sweepPrunableWorktrees(
      [input("late", ["w1"], null)],
      options({}, {
        computeRepoState: async () => {
          computedYet = true;
        },
        readRepo: () => (computedYet ? filled : empty)
      })
    );
    expect(summary.counts.candidates).toBe(1);
  });

  it("keeps a repo whose row vanished mid-sweep as a failure, not a crash", async () => {
    const summary = await sweepPrunableWorktrees(
      [input("gone", ["w1"], null)],
      options({}, { readRepo: () => null })
    );
    expect(summary.counts.repos.failed).toBe(1);
    expect(summary.results[0]?.message).toMatch(/no longer indexed/);
  });

  it("survives a compute that throws, and keeps sweeping the rest", async () => {
    const summary = await sweepPrunableWorktrees(
      [input("bad", ["w1"], null), input("good", ["w2"], null)],
      options(
        { bad: repo("bad", [stale("w1")]), good: repo("good", [stale("w2")]) },
        {
          concurrency: 1,
          computeRepoState: async (repoId) => {
            if (repoId === "bad") throw new Error("index lock");
          }
        }
      )
    );
    expect(summary.counts.repos).toMatchObject({ failed: 1, scanned: 1 });
    expect(summary.counts.candidates).toBe(1);
  });

  it("bounds concurrency and takes the repository lock for each repo", async () => {
    let live = 0;
    let peak = 0;
    const locked: string[] = [];
    const repos = Object.fromEntries(
      Array.from({ length: 12 }, (_, at) => [
        `r${at}`,
        repo(`r${at}`, [stale(`w${at}`)])
      ])
    );
    await sweepPrunableWorktrees(
      Array.from({ length: 12 }, (_, at) => input(`r${at}`, [`w${at}`], null)),
      options(repos, {
        runRepository: async (repoId, operation) => {
          locked.push(repoId);
          return operation();
        },
        computeRepoState: async () => {
          live += 1;
          peak = Math.max(peak, live);
          await new Promise((resolve) => setTimeout(resolve, 1));
          live -= 1;
        }
      })
    );
    expect(peak).toBeLessThanOrEqual(PRUNE_SCAN_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
    expect(locked).toHaveLength(12);
  });

  it("measures candidates in a second phase and reports sizing progress", async () => {
    const phases: PruneScanProgress["phase"][] = [];
    const summary = await sweepPrunableWorktrees(
      [input("a", ["w1"], null), input("b", ["w2"], null)],
      options(
        { a: repo("a", [stale("w1")]), b: repo("b", [stale("w2")]) },
        {
          sizeOf: async (path) => ({
            bytes: path === "/w/w1" ? 4096 : 128,
            partial: path === "/w/w2"
          }),
          onProgress: (progress) => phases.push(progress.phase)
        }
      )
    );
    expect(phases).toContain("starting");
    expect(phases).toContain("sizing");
    const sized = summary.results.flatMap((result) => result.candidates);
    expect(sized.find((c) => c.worktreeId === "w1")?.sizeBytes).toBe(4096);
    expect(sized.find((c) => c.worktreeId === "w2")?.sizePartial).toBe(true);
    expect(summary.counts.sizeBytes).toBe(4224);
  });

  it("leaves sizes null when a measurement throws", async () => {
    const summary = await sweepPrunableWorktrees(
      [input("a", ["w1"], null)],
      options(
        { a: repo("a", [stale("w1")]) },
        {
          sizeOf: async () => {
            throw new Error("EACCES");
          }
        }
      )
    );
    expect(summary.results[0]?.candidates[0]?.sizeBytes).toBeNull();
    expect(summary.counts.sizeBytes).toBe(0);
  });

  it("cancels without discarding the repos it already swept", async () => {
    // This is the half that makes the sweep resumable from the user's side:
    // stopping early still answers for everything it reached.
    const controller = new AbortController();
    const repos = {
      a: repo("a", [stale("w1")]),
      b: repo("b", [stale("w2")]),
      c: repo("c", [stale("w3")])
    };
    const summary = await sweepPrunableWorktrees(
      [input("a", ["w1"], null), input("b", ["w2"], null), input("c", ["w3"], null)],
      options(repos, {
        concurrency: 1,
        signal: controller.signal,
        computeRepoState: async (repoId) => {
          if (repoId === "a") controller.abort();
        }
      })
    );
    expect(summary.cancelled).toBe(true);
    expect(summary.counts.repos.scanned).toBe(1);
    expect(summary.counts.repos.cancelled).toBe(2);
    expect(summary.counts.candidates).toBe(1);
    expect(summary.results.map((result) => result.repoId)).toEqual(["a", "b", "c"]);
  });

  it("reports every repo exactly once, in input order", async () => {
    const onProgress = vi.fn();
    const repos = {
      z: repo("z", []),
      a: repo("a", [stale("w1")])
    };
    const summary = await sweepPrunableWorktrees(
      [input("z", []), input("a", ["w1"], null)],
      options(repos, { onProgress })
    );
    expect(summary.results.map((result) => result.repoId)).toEqual(["z", "a"]);
    const completions = onProgress.mock.calls
      .map((call) => call[0] as PruneScanProgress)
      .filter((progress) => progress.phase === "repo_completed");
    expect(completions).toHaveLength(2);
    expect(completions.at(-1)?.completedRepos).toBe(2);
  });
});
