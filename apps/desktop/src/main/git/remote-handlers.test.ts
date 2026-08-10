import { beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import {
  fetchNamedRemote,
  inspectRemoteReset,
  planPushRefs,
  pushPlannedRefs,
  resetToRemote
} from "./git-service";
import { registerRemoteHandlers } from "./remote-handlers";
import type { WorktreeRefresher } from "./worktree-handlers";

vi.mock("./git-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-service")>();
  return {
    ...actual,
    fetchNamedRemote: vi.fn(),
    inspectRemoteReset: vi.fn(),
    planPushRefs: vi.fn(),
    pushPlannedRefs: vi.fn(),
    resetToRemote: vi.fn()
  };
});

describe("remote handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchNamedRemote).mockResolvedValue(ok(undefined));
    vi.mocked(inspectRemoteReset).mockResolvedValue(
      ok({
        branch: "main",
        head: "1".repeat(40),
        remoteRef: "refs/remotes/origin/main",
        remoteHead: "2".repeat(40)
      })
    );
    vi.mocked(planPushRefs).mockResolvedValue(ok([]));
    vi.mocked(pushPlannedRefs).mockResolvedValue(ok([]));
    vi.mocked(resetToRemote).mockResolvedValue(ok(undefined));
  });

  it("refreshes repo worktree state after repo-scoped ref operations", async () => {
    const db = {
      prepare: vi.fn(() => ({ get: vi.fn(() => ({ path: "/repos/project" })) }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher);

    const fetched = await bus.dispatch("remote:fetchRepo", {
      repoId: "repo-1",
      remote: "origin"
    });
    expect(fetched.ok).toBe(true);
    expect(refresher.refreshRepoWorktrees).toHaveBeenLastCalledWith("repo-1");

    const planned = await bus.dispatch("remote:planPushRefs", {
      repoId: "repo-1",
      sourceRef: "refs/heads/main",
      destinations: [{ remote: "origin", branch: "main" }]
    });
    expect(planned.ok).toBe(true);
    expect(refresher.refreshRepoWorktrees).toHaveBeenCalledTimes(2);

    const pushed = await bus.dispatch("remote:pushRefs", {
      repoId: "repo-1",
      plans: []
    });
    expect(pushed.ok).toBe(true);
    expect(refresher.refreshRepoWorktrees).toHaveBeenCalledTimes(3);
  });

  it("inspects without refreshing and refreshes exactly once after reset", async () => {
    const db = {
      prepare: vi.fn(() => ({ get: vi.fn(() => ({ path: "/repos/project" })) }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher);

    const snapshot = {
      branch: "main",
      head: "1".repeat(40),
      remoteRef: "refs/remotes/upstream/release",
      remoteHead: "2".repeat(40)
    };
    const inspected = await bus.dispatch("remote:inspectReset", {
      worktreeId: "worktree-1",
      remoteRef: snapshot.remoteRef
    });
    expect(inspected.ok).toBe(true);
    expect(inspectRemoteReset).toHaveBeenCalledWith(
      expect.any(Function),
      "/repos/project",
      snapshot.remoteRef
    );
    expect(refresher.refreshWorktree).not.toHaveBeenCalled();

    const reset = await bus.dispatch("remote:resetToRemote", {
      worktreeId: "worktree-1",
      mode: "hard",
      ...snapshot
    });
    expect(reset.ok).toBe(true);
    expect(resetToRemote).toHaveBeenCalledWith(
      expect.any(Function),
      "/repos/project",
      expect.objectContaining({ mode: "hard", ...snapshot }),
      "hard"
    );
    expect(refresher.refreshWorktree).toHaveBeenCalledOnce();
    expect(refresher.refreshWorktree).toHaveBeenCalledWith("worktree-1");
    expect(refresher.refreshRepoWorktrees).not.toHaveBeenCalled();

    vi.mocked(resetToRemote).mockResolvedValueOnce(
      err({
        kind: "remote",
        code: "reset_failed",
        message: "reset stopped after changing checkout state"
      })
    );
    refresher.refreshWorktree.mockClear();
    const failed = await bus.dispatch("remote:resetToRemote", {
      worktreeId: "worktree-1",
      mode: "hard",
      ...snapshot
    });
    expect(failed.ok).toBe(false);
    expect(refresher.refreshWorktree).toHaveBeenCalledOnce();
  });
});
