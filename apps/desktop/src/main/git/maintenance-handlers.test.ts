import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  err,
  ok,
  type MaintenanceAction,
  type MaintenanceSummary,
  type Result
} from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { openDatabase, type DB } from "../persistence/db";
import type { GitExec } from "./dugite";
import type { RepoIndexer } from "./repo-indexer";
import * as maintenance from "./repository-maintenance";
import {
  branchPrEvidence,
  maintenanceRepos,
  registerMaintenanceHandlers
} from "./maintenance-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: vi.fn(() => 2)
}));
vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

let root: string;
let db: DB;
let bus: CommandBus;
let git: ReturnType<typeof vi.fn<GitExec>>;
let handlers: ReturnType<typeof registerMaintenanceHandlers>;
let operations: WorktreeOperationQueue;
let refreshRepoWorktrees: ReturnType<
  typeof vi.fn<RepoIndexer["refreshRepoWorktrees"]>
>;
const gc: MaintenanceAction = { kind: "gc", mode: "standard" };
const output = (stdout = "", exitCode = 0) =>
  ok({ stdout, stderr: "", exitCode });

beforeEach(() => {
  vi.mocked(availableParallelism).mockReturnValue(2);
  root = mkdtempSync(join(tmpdir(), "pwrgit-maintenance-handlers-"));
  db = openDatabase(":memory:");
  db.prepare("INSERT INTO profiles (id, name, email) VALUES (?, ?, ?)").run(
    "one",
    "One",
    "one@example.test"
  );
  db.prepare("INSERT INTO profiles (id, name, email) VALUES (?, ?, ?)").run(
    "two",
    "Two",
    "two@example.test"
  );
  for (const [id, profile] of [
    ["a", "one"],
    ["b", "one"],
    ["c", "two"]
  ]) {
    const path = join(root, id!);
    mkdirSync(join(path, ".git"), { recursive: true });
    db.prepare(
      "INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)"
    ).run(id, profile, id, path);
  }
  git = vi.fn<GitExec>(async (args, cwd) => {
    if (args[0] === "rev-parse") return output(join(cwd, ".git"));
    if (args[0] === "count-objects") return output("size: 32\nsize-pack: 64\n");
    return output();
  });
  bus = new CommandBus();
  operations = new WorktreeOperationQueue();
  refreshRepoWorktrees = vi.fn<RepoIndexer["refreshRepoWorktrees"]>();
  handlers = registerMaintenanceHandlers(bus, db, git, operations, {
    refreshRepoWorktrees
  });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function value(result: Result<MaintenanceSummary>): MaintenanceSummary {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("maintenance lifecycle and profile scope", () => {
  it("limits runs to this profile unless all profiles is requested", async () => {
    expect(
      maintenanceRepos(db, { profileId: "one" })?.map((repo) => repo.id)
    ).toEqual(["a", "b"]);
    const first = value(
      await bus.dispatch("maintenance:run", {
        profileId: "one",
        operationId: "first",
        action: gc
      })
    );
    expect(first.results.map((result) => result.repo.id)).toEqual(["a", "b"]);
    expect(git.mock.calls.some(([, cwd]) => cwd === join(root, "c"))).toBe(
      false
    );
    const second = value(
      await bus.dispatch("maintenance:run", {
        profileId: "one",
        allProfiles: true,
        operationId: "second",
        action: gc
      })
    );
    expect(second.results.map((result) => result.repo.id)).toEqual([
      "a",
      "b",
      "c"
    ]);
    expect(emitEvent).toHaveBeenCalledWith(
      "maintenance:progress",
      expect.objectContaining({
        operationId: "first",
        profileId: "one",
        phase: "starting"
      })
    );
  });

  it("reports a failed repository and continues, de-duplicating shared object stores", async () => {
    git.mockImplementation(async (args, cwd) => {
      if (args[0] === "rev-parse")
        return output(join(root, cwd.endsWith("b") ? "b" : "a", ".git"));
      if (args.includes("gc") && cwd.endsWith("b")) return output("", 1);
      return output();
    });
    const summary = value(
      await bus.dispatch("maintenance:run", {
        profileId: "one",
        allProfiles: true,
        operationId: "run",
        action: gc
      })
    );
    expect(summary.results.map((result) => result.outcome)).toEqual([
      "success",
      "failed",
      "skipped"
    ]);
    expect(git.mock.calls.filter(([args]) => args.includes("gc"))).toHaveLength(
      2
    );
  });

  it("bounds runs across windows and waits for active GC before honouring owner cancellation", async () => {
    let finish!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const original = git.getMockImplementation()!;
    git.mockImplementation(async (args, cwd, opts) => {
      if (args.includes("gc")) {
        started();
        await gate;
      }
      return original(args, cwd, opts);
    });
    const pending = bus.dispatch(
      "maintenance:run",
      { profileId: "one", operationId: "run", action: gc },
      { webContentsId: 1 }
    );
    await began;
    expect(
      (
        await bus.dispatch(
          "maintenance:run",
          { profileId: "two", operationId: "other", action: gc },
          { webContentsId: 2 }
        )
      ).ok
    ).toBe(false);
    expect(
      await bus.dispatch(
        "maintenance:cancel",
        { operationId: "run" },
        { webContentsId: 2 }
      )
    ).toEqual(ok({ cancelled: false }));
    expect(
      await bus.dispatch(
        "maintenance:cancel",
        { operationId: "run" },
        { webContentsId: 1 }
      )
    ).toEqual(ok({ cancelled: true }));
    finish();
    const summary = value(await pending);
    expect(summary.cancelled).toBe(true);
    expect(summary.results.map((result) => result.outcome)).toEqual([
      "success",
      "cancelled"
    ]);
    expect(git.mock.calls.filter(([args]) => args.includes("gc"))).toHaveLength(
      1
    );
    expect(
      (
        await bus.dispatch("maintenance:run", {
          profileId: "two",
          operationId: "next",
          action: gc
        })
      ).ok
    ).toBe(true);
  });

  it("does not launch Git after the owning window closes while waiting for the repository lock", async () => {
    let release!: () => void;
    const locked = operations.runRepository(
      "a",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    await Promise.resolve();
    const pending = bus.dispatch(
      "maintenance:run",
      { profileId: "one", operationId: "run", action: gc },
      { webContentsId: 7 }
    );
    handlers.releaseWebContents(7);
    release();
    await locked;
    expect(
      value(await pending).results.every(
        (result) => result.outcome === "cancelled"
      )
    ).toBe(true);
    expect(git).not.toHaveBeenCalled();
  });

  it.each([
    [1, 1],
    [2, 1],
    [4, 2],
    [6, 3],
    [8, 4],
    [32, 4]
  ])(
    "uses %i available cores to run at most %i repositories and drains active GC on cancellation",
    async (cores, limit) => {
      vi.mocked(availableParallelism).mockReturnValue(cores);
      for (const id of ["d", "e", "f", "g", "h"]) {
        const path = join(root, id);
        mkdirSync(join(path, ".git"), { recursive: true });
        db.prepare(
          "INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)"
        ).run(id, "one", id, path);
      }
      const releases: Array<() => void> = [];
      let inFlight = 0;
      let peak = 0;
      const original = git.getMockImplementation()!;
      git.mockImplementation(async (args, cwd, opts) => {
        if (args.includes("gc")) {
          peak = Math.max(peak, ++inFlight);
          await new Promise<void>((resolve) => releases.push(resolve));
          inFlight--;
        }
        return original(args, cwd, opts);
      });
      let ended = false;
      const pending = bus
        .dispatch("maintenance:run", {
          profileId: "one",
          operationId: "parallel",
          action: gc
        })
        .then((result) => {
          ended = true;
          return result;
        });
      await vi.waitFor(() => expect(releases).toHaveLength(limit));
      // A completed worker must refill even if the first worker is still busy.
      releases[limit - 1]!();
      await vi.waitFor(() => expect(releases).toHaveLength(limit + 1));
      await bus.dispatch("maintenance:cancel", { operationId: "parallel" });
      expect(ended).toBe(false);
      for (const release of releases) release();
      const summary = value(await pending);
      expect(peak).toBe(limit);
      expect(summary.cancelled).toBe(true);
      expect(
        summary.results.filter((r) => r.outcome === "success")
      ).toHaveLength(limit + 1);
      expect(
        summary.results.filter((r) => r.outcome === "cancelled")
      ).toHaveLength(7 - limit - 1);
      expect(summary.results.map((r) => r.repo.id)).toEqual([
        "a",
        "b",
        "d",
        "e",
        "f",
        "g",
        "h"
      ]);
      expect(
        git.mock.calls.filter(([args]) => args.includes("gc"))
      ).toHaveLength(limit + 1);
    }
  );

  it("claims a shared object store before parallel collection starts", async () => {
    vi.mocked(availableParallelism).mockReturnValue(8);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    git.mockImplementation(async (args) => {
      if (args[0] === "rev-parse") return output(join(root, "a", ".git"));
      if (args.includes("gc")) await gate;
      return output();
    });
    const pending = bus.dispatch("maintenance:run", {
      profileId: "one",
      operationId: "shared",
      action: gc
    });
    await vi.waitFor(() =>
      expect(emitEvent).toHaveBeenCalledWith(
        "maintenance:progress",
        expect.objectContaining({
          phase: "repo_completed",
          result: expect.objectContaining({ outcome: "skipped" })
        })
      )
    );
    finish();
    const summary = value(await pending);
    expect(summary.results.map((r) => r.outcome).sort()).toEqual([
      "skipped",
      "success"
    ]);
    expect(git.mock.calls.filter(([args]) => args.includes("gc"))).toHaveLength(
      1
    );
  });

  it.each(["error result", "exception"])(
    "reports partial success after deletion when refresh fails with an %s",
    async (failure) => {
      vi.spyOn(maintenance, "deleteStaleBranch").mockResolvedValue(
        ok(undefined)
      );
      const message = "Could not list worktrees";
      if (failure === "error result") {
        refreshRepoWorktrees.mockResolvedValue(
          err({
            kind: "repo",
            code: "refresh_failed",
            message
          })
        );
      } else {
        refreshRepoWorktrees.mockRejectedValue(new Error(message));
      }
      const branch = {
        repoId: "a",
        branch: "finished",
        expectedHead: "abc123",
        upstream: "refs/remotes/origin/finished",
        evidence: "ancestry" as const
      };
      const summary = value(
        await bus.dispatch("maintenance:run", {
          profileId: "one",
          operationId: "delete",
          action: {
            kind: "delete-branches",
            branches: [branch]
          }
        })
      );
      // Against one fresh review for the batch, not a review per branch.
      expect(maintenance.deleteStaleBranch).toHaveBeenCalledWith(
        git,
        join(root, "a"),
        branch,
        { candidates: [], kept: [] }
      );
      expect(refreshRepoWorktrees).toHaveBeenCalledExactlyOnceWith("a");
      expect(summary.results).toHaveLength(1);
      expect(summary.results[0]).toMatchObject({
        outcome: "partial",
        message:
          "1 local branch deleted; 0 retained. Refresh failed: Could not list worktrees",
        branches: [
          {
            branch: "finished",
            head: "abc123",
            deleted: true,
            message: "Deleted local branch."
          }
        ]
      });
      expect(emitEvent).toHaveBeenCalledWith(
        "maintenance:progress",
        expect.objectContaining({
          phase: "repo_completed",
          result: summary.results[0]
        })
      );
      expect(emitEvent).toHaveBeenCalledWith("graph:changed", { repoId: "a" });
      expect(emitEvent).toHaveBeenCalledWith("repo:changed", {
        profileId: "one"
      });
    }
  );

  it("refuses branch deletion outside the chosen profile and invalid options before Git runs", async () => {
    const branch = {
      repoId: "c",
      branch: "old",
      expectedHead: "abc",
      upstream: "refs/remotes/origin/old",
      evidence: "ancestry" as const
    };
    expect(
      (
        await bus.dispatch("maintenance:run", {
          profileId: "one",
          operationId: "run",
          action: { kind: "delete-branches", branches: [branch] }
        })
      ).ok
    ).toBe(false);
    expect(
      (
        await bus.dispatch("maintenance:run", {
          profileId: "one",
          operationId: "run",
          action: { kind: "gc", mode: "bad" } as unknown as MaintenanceAction
        })
      ).ok
    ).toBe(false);
    expect(
      (
        await bus.dispatch("maintenance:run", {
          profileId: "unknown",
          operationId: "run",
          action: gc
        })
      ).ok
    ).toBe(false);
    expect(git).not.toHaveBeenCalled();
  });
});

describe("finished-branch review", () => {
  const review = { candidates: [], kept: [] };
  const finished = {
    repoId: "a",
    branch: "fix/tooltip",
    expectedHead: "a".repeat(40),
    upstream: "refs/remotes/origin/fix/tooltip",
    evidence: "pr" as const
  };
  function insertPr(repoId: string, branch: string, headOid: string | null) {
    db.prepare(
      `INSERT INTO branch_pr (repo_id, branch, number, url, title, state, is_draft, merged_at, head_oid, fetched_at)
       VALUES (?, ?, 412, 'https://example.test/pull/412', 't', 'merged', 0, 1756684800000, ?, '2026-09-27T00:00:00.000Z')`
    ).run(repoId, branch, headOid);
  }

  it("narrows the scope to named repositories, never past the profile", () => {
    expect(
      maintenanceRepos(db, { profileId: "one", repoIds: ["b", "c"] })?.map(
        (repo) => repo.id
      )
    ).toEqual(["b"]);
  });

  it("reads PR evidence for one repository, not another profile's branch of the same name", () => {
    insertPr("a", "fix/tooltip", "a".repeat(40));
    insertPr("c", "fix/tooltip", "c".repeat(40));
    db.prepare(
      `INSERT INTO branch_pr (repo_id, branch, number, state, is_draft, fetched_at)
       VALUES ('a', 'no-pr', NULL, NULL, 0, '2026-09-27T00:00:00.000Z')`
    ).run();
    const evidence = branchPrEvidence(db, "a");
    expect([...evidence.keys()]).toEqual(["fix/tooltip"]);
    expect(evidence.get("fix/tooltip")).toEqual({
      number: 412,
      url: "https://example.test/pull/412",
      state: "merged",
      mergedAt: 1756684800000,
      headOid: "a".repeat(40)
    });
  });

  it("refreshes pull requests before a review that counts them, and not otherwise", async () => {
    const refreshRepo = vi.fn(async () => new Map());
    const spy = vi
      .spyOn(maintenance, "reviewStaleBranches")
      .mockResolvedValue(ok({ candidates: [finished], kept: [] }));
    const scoped = new CommandBus();
    registerMaintenanceHandlers(
      scoped,
      db,
      git,
      operations,
      { refreshRepoWorktrees },
      { refreshRepo },
      () => 1_000
    );
    const summary = value(
      await scoped.dispatch("maintenance:run", {
        profileId: "one",
        repoIds: ["a"],
        operationId: "review",
        action: {
          kind: "scan-branches",
          options: { prProof: true, keepDays: 30 }
        }
      })
    );
    expect(refreshRepo).toHaveBeenCalledExactlyOnceWith("a", {
      trigger: "user"
    });
    expect(spy).toHaveBeenCalledWith(git, join(root, "a"), "a", {
      options: { prProof: true, keepDays: 30 },
      prs: expect.any(Map),
      now: 1_000
    });
    expect(summary.results).toEqual([
      expect.objectContaining({
        candidates: [finished],
        kept: [],
        message: "1 finished branch · 0 kept."
      })
    ]);
    refreshRepo.mockClear();
    await scoped.dispatch("maintenance:run", {
      profileId: "one",
      repoIds: ["a"],
      operationId: "review-off",
      action: {
        kind: "scan-branches",
        options: { prProof: false, keepDays: null }
      }
    });
    expect(refreshRepo).not.toHaveBeenCalled();
  });

  it("reviews on the cached rows when the pull request refresh throws", async () => {
    const refreshRepo = vi.fn(async (): Promise<Map<string, null>> => {
      throw new Error("forge unreachable");
    });
    vi.spyOn(maintenance, "reviewStaleBranches").mockResolvedValue(
      ok({ candidates: [finished], kept: [] })
    );
    const scoped = new CommandBus();
    registerMaintenanceHandlers(
      scoped,
      db,
      git,
      operations,
      { refreshRepoWorktrees },
      { refreshRepo },
      () => 1_000
    );
    const summary = value(
      await scoped.dispatch("maintenance:run", {
        profileId: "one",
        repoIds: ["a"],
        operationId: "offline",
        action: {
          kind: "scan-branches",
          options: { prProof: true, keepDays: null }
        }
      })
    );
    expect(refreshRepo).toHaveBeenCalledOnce();
    expect(summary.results).toEqual([
      expect.objectContaining({ outcome: "success", candidates: [finished] })
    ]);
  });

  it("falls back to the default rules when options arrive malformed", async () => {
    const spy = vi
      .spyOn(maintenance, "reviewStaleBranches")
      .mockResolvedValue(ok(review));
    await bus.dispatch("maintenance:run", {
      profileId: "one",
      repoIds: ["a"],
      operationId: "bad",
      action: {
        kind: "scan-branches",
        options: { prProof: true, keepDays: 5 }
      } as unknown as MaintenanceAction
    });
    expect(spy.mock.calls[0]![3].options).toEqual({
      prProof: true,
      keepDays: 7
    });
  });

  it("counts finished branches after a collection so the receipt can offer them", async () => {
    vi.spyOn(maintenance, "reviewStaleBranches").mockResolvedValue(
      ok({ candidates: [finished], kept: [] })
    );
    const summary = value(
      await bus.dispatch("maintenance:run", {
        profileId: "one",
        repoIds: ["a"],
        operationId: "gc",
        action: {
          ...gc,
          branchOptions: { prProof: true, keepDays: 7 }
        }
      })
    );
    expect(summary.results[0]).toMatchObject({
      outcome: "success",
      message: "Garbage collection completed.",
      candidates: [finished]
    });
    // No count requested, no review run.
    vi.mocked(maintenance.reviewStaleBranches).mockClear();
    await bus.dispatch("maintenance:run", {
      profileId: "one",
      repoIds: ["a"],
      operationId: "gc-plain",
      action: gc
    });
    expect(maintenance.reviewStaleBranches).not.toHaveBeenCalled();
  });

  it("restores a deleted branch under the repository lock and announces it", async () => {
    const restore = vi
      .spyOn(maintenance, "restoreStaleBranch")
      .mockResolvedValue(ok(undefined));
    expect(
      await bus.dispatch("maintenance:restoreBranch", {
        repoId: "a",
        branch: "fix/tooltip",
        head: "a".repeat(40)
      })
    ).toEqual(ok(null));
    expect(restore).toHaveBeenCalledWith(
      git,
      join(root, "a"),
      "fix/tooltip",
      "a".repeat(40)
    );
    expect(refreshRepoWorktrees).toHaveBeenCalledWith("a");
    expect(emitEvent).toHaveBeenCalledWith("graph:changed", { repoId: "a" });
    expect(
      (
        await bus.dispatch("maintenance:restoreBranch", {
          repoId: "a",
          branch: "fix/tooltip",
          head: "HEAD~1"
        })
      ).ok
    ).toBe(false);
    expect(restore).toHaveBeenCalledTimes(1);
  });
});
