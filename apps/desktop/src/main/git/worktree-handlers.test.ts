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

  it("announces each changed worktree before repainting the repo tree", async () => {
    const current = new Map([
      ["wt-changed", snapshot("wt-changed")],
      ["wt-same", snapshot("wt-same")]
    ]);
    const state = {
      getCached: vi.fn((id: string) => current.get(id) ?? null),
      refreshMany: vi.fn(async () => {
        current.set("wt-changed", snapshot("wt-changed", { dirty: 1 }));
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
    expect(emitEvent).toHaveBeenNthCalledWith(2, "repo:changed", {
      profileId: "profile-1"
    });
    expect(emitEvent).toHaveBeenCalledTimes(2);
  });
});
