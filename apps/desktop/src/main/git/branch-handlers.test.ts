import { beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import type { SettingsService } from "../settings/settings-service";
import {
  checkoutNewBranchAt,
  createBranchAt,
  readChanges,
  switchBranch,
  worktreeAdd
} from "./git-service";
import { registerBranchHandlers } from "./branch-handlers";
import type { RepoIndexer } from "./repo-indexer";
import type { WorktreeRefresher } from "./worktree-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("./git-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-service")>();
  return {
    ...actual,
    switchBranch: vi.fn(),
    createBranchAt: vi.fn(),
    checkoutNewBranchAt: vi.fn(),
    worktreeAdd: vi.fn(),
    readChanges: vi.fn()
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
      get: vi.fn(() =>
        sql.includes("FROM worktrees WHERE repo_id")
          ? addedWorktreeId === null
            ? undefined
            : { id: addedWorktreeId }
          : worktreeRow
      )
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

const clean = ok({ staged: [], unstaged: [] });

describe("branch handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(switchBranch).mockResolvedValue(ok(undefined));
    vi.mocked(createBranchAt).mockResolvedValue(ok(undefined));
    vi.mocked(checkoutNewBranchAt).mockResolvedValue(ok(undefined));
    vi.mocked(worktreeAdd).mockResolvedValue(ok(undefined));
    vi.mocked(readChanges).mockResolvedValue(clean);
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

    it("refuses an in-place checkout while the worktree is dirty", async () => {
      const { bus } = harness();
      vi.mocked(readChanges).mockResolvedValue(
        ok({
          staged: [],
          unstaged: [{ path: "a.ts", status: "M", staged: false }]
        })
      );

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
});
