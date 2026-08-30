import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, type Result, type WorktreeState } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { openDatabase, type DB } from "../persistence/db";
import type { GitExec, GitOutput } from "./dugite";
import {
  createWorktreeRefresher,
  registerWorktreeHandlers,
  type WorktreeRefresher
} from "./worktree-handlers";
import type { WorktreeStateService } from "./worktree-state";

vi.mock("../ipc", () => ({
  registerIpc: vi.fn(),
  emitEvent: vi.fn()
}));

function snapshot(
  worktreeId: string,
  overrides: Partial<WorktreeState> = {}
): WorktreeState {
  return {
    worktreeId,
    branch: "main",
    head: "head-1",
    hasUpstream: true,
    ahead: 0,
    behind: 0,
    dirty: 0,
    behindDefault: 0,
    defaultBranch: "main",
    mergedIntoDefault: false,
    divergedFromDefault: false,
    isDefaultBranch: true,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("repo worktree refresh events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [
      "upstream presence",
      { hasUpstream: false },
      { hasUpstream: true }
    ],
    [
      "resolved default branch",
      { defaultBranch: "main" },
      { defaultBranch: "trunk" }
    ],
    [
      "default-branch identity",
      { isDefaultBranch: false },
      { isDefaultBranch: true }
    ]
  ] satisfies [string, Partial<WorktreeState>, Partial<WorktreeState>][])(
    "treats %s as a rendered state change",
    async (_label, beforeOverrides, afterOverrides) => {
      const before = snapshot("wt-1", beforeOverrides);
      const fresh = snapshot("wt-1", afterOverrides);
      const state = {
        getCached: vi.fn(() => before),
        compute: vi.fn(async () => fresh)
      } as unknown as WorktreeStateService;
      const db = {
        prepare: () => ({
          get: () => ({ repo_id: "repo-1", profile_id: "profile-1" })
        })
      } as unknown as DB;

      await createWorktreeRefresher(state, db).refreshWorktree("wt-1");

      expect(emitEvent).toHaveBeenNthCalledWith(1, "worktree:changed", {
        worktreeId: "wt-1"
      });
      expect(emitEvent).toHaveBeenNthCalledWith(2, "graph:changed", {
        repoId: "repo-1"
      });
      expect(emitEvent).toHaveBeenNthCalledWith(3, "repo:changed", {
        profileId: "profile-1"
      });
    }
  );

  it("announces upstream-only changes and invalidates the shared repo graph", async () => {
    const current = new Map([
      ["wt-changed", snapshot("wt-changed", { hasUpstream: false })],
      ["wt-same", snapshot("wt-same")]
    ]);
    const state = {
      getCached: vi.fn((id: string) => current.get(id) ?? null),
      refreshMany: vi.fn(async () => {
        current.set("wt-changed", snapshot("wt-changed"));
      })
    } as unknown as WorktreeStateService;
    const db = {
      prepare: (sql: string) => ({
        all: () => [{ id: "wt-changed" }, { id: "wt-same" }],
        get: () => ({ profile_id: "profile-1" })
      })
    } as unknown as DB;

    await createWorktreeRefresher(state, db).refreshRepoWorktrees("repo-1");

    expect(state.refreshMany).toHaveBeenCalledExactlyOnceWith([
      "wt-changed",
      "wt-same"
    ]);
    expect(emitEvent).toHaveBeenNthCalledWith(1, "worktree:changed", {
      worktreeId: "wt-changed"
    });
    expect(emitEvent).toHaveBeenNthCalledWith(2, "graph:changed", {
      repoId: "repo-1"
    });
    expect(emitEvent).toHaveBeenNthCalledWith(3, "repo:changed", {
      profileId: "profile-1"
    });
    expect(emitEvent).not.toHaveBeenCalledWith("worktree:changed", {
      worktreeId: "wt-same"
    });
    expect(emitEvent).toHaveBeenCalledTimes(3);
  });
});

// The seam the LFS surfaces ride on: the {status, announceReady} envelope, the
// error passthrough, and the fact that this read records an outcome — none of
// which the chip test (mocked dispatch) or the recordLfsOutcome test (bare DB)
// can see.
describe("repo:getGitLfsStatus", () => {
  const exit0 = (stdout: string): Result<GitOutput> =>
    ok({ stdout, stderr: "", exitCode: 0 });
  const FILTERS = [
    "filter.lfs.required true",
    "filter.lfs.process git-lfs filter-process",
    "filter.lfs.clean git-lfs clean -- %f",
    "filter.lfs.smudge git-lfs smudge -- %f"
  ].join("\n");

  let db: DB;
  let bus: CommandBus;
  let git: GitExec;

  beforeEach(() => {
    db = openDatabase(":memory:");
    const checkout = mkdtempSync(join(tmpdir(), "pwrgit-lfs-handler-"));
    writeFileSync(join(checkout, ".gitattributes"), "*.bin filter=lfs\n");
    db.prepare(
      "INSERT INTO profiles (id, name, email) VALUES ('p1', 'P', 'p@x.com')"
    ).run();
    db.prepare(
      `INSERT INTO repos (id, profile_id, name, path)
       VALUES ('repo-1', 'p1', 'proj', ?)`
    ).run(checkout);
    db.prepare(
      `INSERT INTO worktrees (id, repo_id, branch, path, is_primary)
       VALUES ('wt-1', 'repo-1', 'main', ?, 1)`
    ).run(checkout);

    git = vi.fn(async (args: string[]) => {
      if (args[0] === "ls-files") return exit0(".gitattributes\u0000");
      if (args[0] === "lfs") return exit0("git-lfs/3.7.1\n");
      if (args[0] === "config") return exit0(FILTERS);
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    });

    bus = new CommandBus();
    registerWorktreeHandlers(
      bus,
      { getCached: () => null } as unknown as WorktreeStateService,
      db,
      {
        refreshWorktree: async () => undefined,
        refreshRepoWorktrees: () => undefined
      } satisfies WorktreeRefresher,
      (args, cwd) => git(args, cwd),
      () => undefined
    );
  });

  afterEach(() => {
    db.close();
  });

  const getStatus = () =>
    bus.dispatch("repo:getGitLfsStatus", {
      repoId: "repo-1",
      worktreeId: "wt-1"
    });

  it("answers the envelope and spends the announcement on the first ready check", async () => {
    const first = await getStatus();
    expect(first).toEqual(
      ok({
        status: {
          required: true,
          installed: true,
          configured: true,
          version: "git-lfs/3.7.1"
        },
        announceReady: true
      })
    );

    const second = await getStatus();
    expect(second.ok && second.value.announceReady).toBe(false);
  });

  it("passes a probe failure through without recording an outcome", async () => {
    vi.mocked(git).mockResolvedValueOnce(
      err({ kind: "git", code: "spawn_failed", message: "no git" })
    );

    const result = await getStatus();
    expect(result.ok).toBe(false);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM repo_lfs_notice").get()
    ).toEqual({ n: 0 });
  });

  it("still answers the probe when the repo row vanished mid-probe", async () => {
    // The bookkeeping INSERT hits a missing repos(id) under foreign_keys=ON;
    // that must cost the announcement, never the status.
    vi.mocked(git).mockImplementationOnce(async () => {
      db.prepare("DELETE FROM repos WHERE id = 'repo-1'").run();
      return exit0(".gitattributes\u0000");
    });

    const result = await getStatus();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toMatchObject({
        required: true,
        installed: true,
        configured: true
      });
      expect(result.value.announceReady).toBe(false);
    }
  });
});
