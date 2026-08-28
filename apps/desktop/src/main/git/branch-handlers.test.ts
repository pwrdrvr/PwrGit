import { beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { DB } from "../persistence/db";
import type { SettingsService } from "../settings/settings-service";
import {
  checkoutNewBranchAt,
  createBranchAt,
  readCheckoutDirtyCount,
  switchBranch,
  worktreeAdd
} from "./git-service";
import { deleteLocalBranch, renameLocalBranch } from "./branch-lifecycle";
import { registerBranchHandlers } from "./branch-handlers";
import type { RepoIndexer } from "./repo-indexer";
import type { WorktreeRefresher } from "./worktree-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("./branch-lifecycle", () => ({
  renameLocalBranch: vi.fn(),
  deleteLocalBranch: vi.fn()
}));
vi.mock("./git-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-service")>();
  return {
    ...actual,
    switchBranch: vi.fn(),
    createBranchAt: vi.fn(),
    checkoutNewBranchAt: vi.fn(),
    worktreeAdd: vi.fn(),
    readCheckoutDirtyCount: vi.fn()
  };
});

const worktreeRow = {
  path: "/repos/project",
  repo_id: "repo-1",
  repo_name: "project",
  repo_path: "/repos/project",
  profile_id: "profile-1"
};

/** A db whose reply depends on which statement was prepared. */
function fakeDb(addedWorktreeId: string | null = "worktree-2"): DB {
  return {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (sql.includes("SELECT path, profile_id FROM repos")) {
          return { path: "/repos/project", profile_id: "profile-1" };
        }
        if (sql.includes("FROM worktrees WHERE repo_id")) {
          return addedWorktreeId === null
            ? undefined
            : { id: addedWorktreeId };
        }
        return worktreeRow;
      }),
      all: vi.fn(() => [{ id: "worktree-1" }, { id: "worktree-2" }])
    }))
  } as unknown as DB;
}

const fakeSettings = {
  get: () => ({ worktreeRoot: "/wt" })
} as unknown as SettingsService;

function harness(db: DB = fakeDb()): {
  bus: CommandBus;
  indexer: RepoIndexer;
  refresher: WorktreeRefresher;
  operations: WorktreeOperationQueue;
} {
  const indexer = {
    refreshRepoWorktrees: vi.fn().mockResolvedValue(undefined)
  } as unknown as RepoIndexer;
  const refresher = {
    refreshWorktree: vi.fn(),
    refreshRepoWorktrees: vi.fn()
  } satisfies WorktreeRefresher;
  const operations = new WorktreeOperationQueue();
  const bus = new CommandBus();
  registerBranchHandlers(bus, db, indexer, refresher, operations, fakeSettings);
  return { bus, indexer, refresher, operations };
}

const clean = ok(0);

describe("branch handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(switchBranch).mockResolvedValue(ok(undefined));
    vi.mocked(createBranchAt).mockResolvedValue(ok(undefined));
    vi.mocked(checkoutNewBranchAt).mockResolvedValue(ok(undefined));
    vi.mocked(worktreeAdd).mockResolvedValue(ok(undefined));
    vi.mocked(readCheckoutDirtyCount).mockResolvedValue(clean);
    vi.mocked(renameLocalBranch).mockResolvedValue(ok(undefined));
    vi.mocked(deleteLocalBranch).mockResolvedValue(ok(undefined));
  });

  it("serves a live child-aware dirty probe for switch confirmation", async () => {
    const { bus } = harness();
    vi.mocked(readCheckoutDirtyCount).mockResolvedValueOnce(ok(2));

    await expect(
      bus.dispatch("worktree:readDirty", { worktreeId: "worktree-1" })
    ).resolves.toEqual(ok({ dirty: 2 }));
    expect(readCheckoutDirtyCount).toHaveBeenCalledWith(
      expect.anything(),
      "/repos/project"
    );
  });

  it("holds the shared worktree queue for the complete branch switch", async () => {
    const { bus, indexer, refresher, operations } = harness();
    let finishSwitch!: () => void;
    vi.mocked(switchBranch).mockReturnValueOnce(
      new Promise((resolve) => {
        finishSwitch = () => resolve(ok(undefined));
      })
    );

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

  describe("branch:create", () => {
    const request = {
      worktreeId: "worktree-1",
      branch: "fix/accounting",
      startPoint: "466c894"
    } as const;

    it("creates the ref alone and touches no working copy", async () => {
      const { bus, indexer } = harness();

      const result = await bus.dispatch("branch:create", {
        ...request,
        checkout: "none"
      });

      expect(result).toEqual(
        ok({ checkedOutWorktreeId: null, worktreePath: null })
      );
      expect(createBranchAt).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        "/repos/project",
        "fix/accounting",
        "466c894"
      );
      expect(worktreeAdd).not.toHaveBeenCalled();
      expect(checkoutNewBranchAt).not.toHaveBeenCalled();
      expect(indexer.refreshRepoWorktrees).toHaveBeenCalledExactlyOnceWith(
        "repo-1"
      );
    });

    it("adds a worktree at the commit and reports the indexed row", async () => {
      const { bus } = harness();

      const result = await bus.dispatch("branch:create", {
        ...request,
        checkout: "new-worktree"
      });

      expect(worktreeAdd).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        "/repos/project",
        expect.stringContaining("fix-accounting"),
        "fix/accounting",
        { newBranch: true, startPoint: "466c894" }
      );
      expect(createBranchAt).not.toHaveBeenCalled();
      expect(result.ok && result.value.checkedOutWorktreeId).toBe("worktree-2");
      expect(result.ok && result.value.worktreePath).toContain("fix-accounting");
    });

    it("reports no checkout target when the added worktree is not indexed yet", async () => {
      const { bus } = harness(fakeDb(null));

      const result = await bus.dispatch("branch:create", {
        ...request,
        checkout: "new-worktree"
      });

      expect(result.ok && result.value.checkedOutWorktreeId).toBeNull();
      expect(result.ok && result.value.worktreePath).toContain("fix-accounting");
    });

    it("checks out in place once the worktree is clean", async () => {
      const { bus, refresher } = harness();

      const result = await bus.dispatch("branch:create", {
        ...request,
        checkout: "here"
      });

      expect(checkoutNewBranchAt).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        "/repos/project",
        "fix/accounting",
        "466c894"
      );
      expect(result).toEqual(
        ok({ checkedOutWorktreeId: "worktree-1", worktreePath: null })
      );
      expect(refresher.refreshWorktree).toHaveBeenCalledExactlyOnceWith(
        "worktree-1"
      );
    });

    it("holds the queue across the dirty check and the checkout", async () => {
      const { bus, operations } = harness();
      let finishStatus!: () => void;
      vi.mocked(readCheckoutDirtyCount).mockReturnValueOnce(
        new Promise((resolve) => {
          finishStatus = () => resolve(clean);
        })
      );

      const creating = bus.dispatch("branch:create", {
        ...request,
        checkout: "here"
      });
      await vi.waitFor(() =>
        expect(readCheckoutDirtyCount).toHaveBeenCalledOnce()
      );
      // Anything that could dirty the tree between the check and the checkout —
      // a pull reapplying its auto-stash — must wait for both.
      let intervened = false;
      const other = operations.run("worktree-1", async () => {
        intervened = true;
      });
      await Promise.resolve();
      expect(intervened).toBe(false);

      finishStatus();
      await creating;
      await other;
      expect(intervened).toBe(true);
      expect(checkoutNewBranchAt).toHaveBeenCalledOnce();
    });

    it("refuses an in-place checkout while the worktree is dirty", async () => {
      const { bus } = harness();
      vi.mocked(readCheckoutDirtyCount).mockResolvedValue(ok(1));

      const result = await bus.dispatch("branch:create", {
        ...request,
        checkout: "here"
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe("dirty");
      expect(checkoutNewBranchAt).not.toHaveBeenCalled();
    });

    it("surfaces a failed creation without re-indexing", async () => {
      const { bus, indexer } = harness();
      vi.mocked(createBranchAt).mockResolvedValue(
        err({
          kind: "repo",
          code: "already_exists",
          message: "fatal: a branch named 'fix/accounting' already exists"
        })
      );

      const result = await bus.dispatch("branch:create", {
        ...request,
        checkout: "none"
      });

      expect(!result.ok && result.error.code).toBe("already_exists");
      expect(indexer.refreshRepoWorktrees).not.toHaveBeenCalled();
    });
  });

  describe("local branch lifecycle", () => {
    it("renames through the repository queue and refreshes every branch surface", async () => {
      const { bus, indexer } = harness();

      const result = await bus.dispatch("branch:rename", {
        repoId: "repo-1",
        branch: "feature/old",
        newBranch: "feature/new",
        expectedHead: "a".repeat(40)
      });

      expect(result).toEqual(ok(null));
      expect(renameLocalBranch).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        "/repos/project",
        { branch: "feature/old", expectedHead: "a".repeat(40) },
        "feature/new"
      );
      expect(indexer.refreshRepoWorktrees).toHaveBeenCalledExactlyOnceWith(
        "repo-1"
      );
      expect(emitEvent).toHaveBeenCalledWith("worktree:changed", {
        worktreeId: "worktree-1"
      });
      expect(emitEvent).toHaveBeenCalledWith("worktree:changed", {
        worktreeId: "worktree-2"
      });
      expect(emitEvent).toHaveBeenCalledWith("repo:changed", {
        profileId: "profile-1"
      });
    });

    it("passes force only on an explicitly forced delete request", async () => {
      const { bus } = harness();
      const request = {
        repoId: "repo-1",
        branch: "feature/old",
        expectedHead: "b".repeat(40)
      } as const;

      await bus.dispatch("branch:delete", request);
      await bus.dispatch("branch:delete", { ...request, force: true });

      expect(deleteLocalBranch).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        "/repos/project",
        { branch: "feature/old", expectedHead: "b".repeat(40) },
        false
      );
      expect(deleteLocalBranch).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        "/repos/project",
        { branch: "feature/old", expectedHead: "b".repeat(40) },
        true
      );
    });

    it("does not refresh when the live Git safety check rejects deletion", async () => {
      const { bus, indexer } = harness();
      vi.mocked(deleteLocalBranch).mockResolvedValueOnce(
        err({
          kind: "repo",
          code: "branch_checked_out",
          message: "checked out elsewhere"
        })
      );

      const result = await bus.dispatch("branch:delete", {
        repoId: "repo-1",
        branch: "feature/held",
        expectedHead: "c".repeat(40)
      });

      expect(!result.ok && result.error.code).toBe("branch_checked_out");
      expect(indexer.refreshRepoWorktrees).not.toHaveBeenCalled();
    });

    it("refreshes every branch surface after a partial rename failure", async () => {
      const { bus, indexer } = harness();
      vi.mocked(renameLocalBranch).mockResolvedValueOnce(
        err({
          kind: "repo",
          code: "branch_rename_partial",
          message: "branch is renamed, but update of config-file failed"
        })
      );

      const result = await bus.dispatch("branch:rename", {
        repoId: "repo-1",
        branch: "feature/old",
        newBranch: "feature/new",
        expectedHead: "d".repeat(40)
      });

      expect(!result.ok && result.error.code).toBe("branch_rename_partial");
      expect(indexer.refreshRepoWorktrees).toHaveBeenCalledExactlyOnceWith(
        "repo-1"
      );
      expect(emitEvent).toHaveBeenCalledWith("worktree:changed", {
        worktreeId: "worktree-1"
      });
      expect(emitEvent).toHaveBeenCalledWith("worktree:changed", {
        worktreeId: "worktree-2"
      });
      expect(emitEvent).toHaveBeenCalledWith("repo:changed", {
        profileId: "profile-1"
      });
    });
  });
});
