import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@pwrgit/shared";
import { emitEvent } from "../ipc";
import type { DB } from "../persistence/db";
import { createWorktreeRefresher } from "./worktree-handlers";
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
