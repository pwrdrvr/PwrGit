import { beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import {
  fetchNamedRemote,
  inspectRemoteReset,
  planPushRefs,
  pullFastForward,
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
    pullFastForward: vi.fn(),
    pushPlannedRefs: vi.fn(),
    resetToRemote: vi.fn()
  };
});

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));

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
    vi.mocked(pullFastForward).mockResolvedValue(
      ok({
        fastForwarded: true,
        stashed: false,
        reappliedWithConflicts: false
      })
    );
    vi.mocked(pushPlannedRefs).mockResolvedValue(ok([]));
    vi.mocked(resetToRemote).mockResolvedValue(ok(undefined));
  });

  it("streams pull phases and waits for the finishing refresh", async () => {
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    let finishRefresh: (() => void) | undefined;
    const refreshWorktree = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        })
    );
    const refresher = {
      refreshWorktree,
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    vi.mocked(pullFastForward).mockImplementationOnce(
      async (_git, _path, onProgress) => {
        onProgress?.("fetch");
        onProgress?.("prepare");
        onProgress?.("fast_forward");
        onProgress?.("reapply");
        return ok({
          fastForwarded: true,
          stashed: true,
          reappliedWithConflicts: false
        });
      }
    );
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher);

    const pull = bus.dispatch("remote:pull", { worktreeId: "worktree-1" });
    await vi.waitFor(() => expect(refreshWorktree).toHaveBeenCalledOnce());

    expect(emitEvent).toHaveBeenNthCalledWith(1, "worktree:pullProgress", {
      worktreeId: "worktree-1",
      phase: "fetch"
    });
    expect(emitEvent).toHaveBeenNthCalledWith(2, "worktree:pullProgress", {
      worktreeId: "worktree-1",
      phase: "prepare"
    });
    expect(emitEvent).toHaveBeenNthCalledWith(3, "worktree:pullProgress", {
      worktreeId: "worktree-1",
      phase: "fast_forward"
    });
    expect(emitEvent).toHaveBeenNthCalledWith(4, "worktree:pullProgress", {
      worktreeId: "worktree-1",
      phase: "reapply"
    });
    expect(emitEvent).toHaveBeenNthCalledWith(5, "worktree:pullProgress", {
      worktreeId: "worktree-1",
      phase: "refresh"
    });

    let settled = false;
    void pull.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishRefresh?.();
    await expect(pull).resolves.toEqual(
      ok({
        fastForwarded: true,
        stashed: true,
        reappliedWithConflicts: false
      })
    );
  });

  it("preserves a successful pull when the finishing refresh fails", async () => {
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    const refreshFailure = new Error("database unavailable");
    const refresher = {
      refreshWorktree: vi.fn(async () => Promise.reject(refreshFailure)),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher);

    await expect(
      bus.dispatch("remote:pull", { worktreeId: "worktree-1" })
    ).resolves.toEqual(
      ok({
        fastForwarded: true,
        stashed: false,
        reappliedWithConflicts: false
      })
    );
    expect(refresher.refreshWorktree).toHaveBeenCalledExactlyOnceWith(
      "worktree-1"
    );
    expect(logMain).toHaveBeenCalledWith(
      "warn",
      "remote",
      "could not refresh /repos/project after pull:",
      refreshFailure
    );
  });

  it("refreshes repo worktree state after repo-scoped ref operations", async () => {
    const db = {
      prepare: vi.fn(() => ({ get: vi.fn(() => ({ path: "/repos/project" })) }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(async () => undefined),
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

  it("inspects without refreshing and refreshes every repo worktree once after reset", async () => {
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(async () => undefined),
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
    expect(refresher.refreshRepoWorktrees).not.toHaveBeenCalled();

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
    expect(refresher.refreshWorktree).not.toHaveBeenCalled();
    expect(refresher.refreshRepoWorktrees).toHaveBeenCalledOnce();
    expect(refresher.refreshRepoWorktrees).toHaveBeenCalledWith("repo-1");

    vi.mocked(resetToRemote).mockResolvedValueOnce(
      err({
        kind: "remote",
        code: "reset_failed",
        message: "reset stopped after changing checkout state"
      })
    );
    refresher.refreshRepoWorktrees.mockClear();
    const failed = await bus.dispatch("remote:resetToRemote", {
      worktreeId: "worktree-1",
      mode: "hard",
      ...snapshot
    });
    expect(failed.ok).toBe(false);
    expect(refresher.refreshWorktree).not.toHaveBeenCalled();
    expect(refresher.refreshRepoWorktrees).toHaveBeenCalledOnce();
    expect(refresher.refreshRepoWorktrees).toHaveBeenCalledWith("repo-1");
  });
});
