import { beforeEach, describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { switchBranch } from "./git-service";
import { registerBranchHandlers } from "./branch-handlers";
import type { RepoIndexer } from "./repo-indexer";
import type { WorktreeRefresher } from "./worktree-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("./git-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-service")>();
  return { ...actual, switchBranch: vi.fn() };
});

describe("branch handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(switchBranch).mockResolvedValue(ok(undefined));
  });

  it("holds the shared worktree queue for the complete branch switch", async () => {
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({
          path: "/repos/project",
          repo_id: "repo-1",
          profile_id: "profile-1"
        }))
      }))
    } as unknown as DB;
    const indexer = {
      refreshRepoWorktrees: vi.fn().mockResolvedValue(undefined)
    } as unknown as RepoIndexer;
    const refresher = {
      refreshWorktree: vi.fn(),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    const operations = new WorktreeOperationQueue();
    let finishSwitch!: () => void;
    vi.mocked(switchBranch).mockReturnValueOnce(
      new Promise((resolve) => {
        finishSwitch = () => resolve(ok(undefined));
      })
    );
    const bus = new CommandBus();
    registerBranchHandlers(bus, db, indexer, refresher, operations);

    const switching = bus.dispatch("branch:switch", {
      worktreeId: "worktree-1",
      branch: "feature"
    });
    await vi.waitFor(() => expect(switchBranch).toHaveBeenCalledOnce());
    let statusStarted = false;
    const status = operations.run("worktree-1", async () => {
      statusStarted = true;
    });
    await Promise.resolve();
    expect(statusStarted).toBe(false);

    finishSwitch();
    await expect(switching).resolves.toEqual(ok(null));
    await status;
    expect(statusStarted).toBe(true);
    expect(indexer.refreshRepoWorktrees).toHaveBeenCalledExactlyOnceWith(
      "repo-1"
    );
    expect(refresher.refreshWorktree).toHaveBeenCalledExactlyOnceWith(
      "worktree-1"
    );
  });
});
