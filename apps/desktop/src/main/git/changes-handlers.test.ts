import { beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { discardAllChanges, readChanges } from "./git-service";
import { registerChangesHandlers } from "./changes-handlers";
import type { WorktreeRefresher } from "./worktree-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

vi.mock("./git-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-service")>();
  return { ...actual, discardAllChanges: vi.fn(), readChanges: vi.fn() };
});

function setup(operations?: WorktreeOperationQueue) {
  const db = {
    prepare: vi.fn(() => ({ get: vi.fn(() => ({ path: "/repos/project" })) }))
  } as unknown as DB;
  const refresher = {
    refreshWorktree: vi.fn(async () => undefined),
    refreshRepoWorktrees: vi.fn()
  } satisfies WorktreeRefresher;
  const bus = new CommandBus();
  registerChangesHandlers(
    bus,
    db,
    refresher,
    operations ?? new WorktreeOperationQueue()
  );
  return { bus, refresher };
}

describe("changes:discardAll handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(discardAllChanges).mockResolvedValue(ok(undefined));
  });

  it("runs one bulk service operation and refreshes the worktree once", async () => {
    const { bus, refresher } = setup();

    await expect(
      bus.dispatch("changes:discardAll", { worktreeId: "worktree-1" })
    ).resolves.toEqual(ok(null));

    expect(discardAllChanges).toHaveBeenCalledOnce();
    expect(discardAllChanges).toHaveBeenCalledWith(
      expect.any(Function),
      "/repos/project"
    );
    expect(refresher.refreshWorktree).toHaveBeenCalledExactlyOnceWith(
      "worktree-1"
    );
  });

  it("returns the service error without refreshing", async () => {
    const failure = err({
      kind: "git" as const,
      code: "exit_1",
      message: "restore failed"
    });
    vi.mocked(discardAllChanges).mockResolvedValueOnce(failure);
    const { bus, refresher } = setup();

    await expect(
      bus.dispatch("changes:discardAll", { worktreeId: "worktree-1" })
    ).resolves.toEqual(failure);
    expect(refresher.refreshWorktree).not.toHaveBeenCalled();
  });
});

describe("changes:list handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readChanges).mockResolvedValue(ok({ staged: [], unstaged: [] }));
  });

  it("waits for an active worktree mutation before reading status", async () => {
    const operations = new WorktreeOperationQueue();
    let finishMutation!: () => void;
    const mutation = operations.run(
      "worktree-1",
      () =>
        new Promise<void>((resolve) => {
          finishMutation = resolve;
        })
    );
    await vi.waitFor(() => expect(finishMutation).toBeTypeOf("function"));
    const { bus } = setup(operations);

    const changes = bus.dispatch("changes:list", { worktreeId: "worktree-1" });
    await Promise.resolve();
    expect(readChanges).not.toHaveBeenCalled();

    finishMutation();
    await mutation;
    await expect(changes).resolves.toEqual(ok({ staged: [], unstaged: [] }));
    expect(readChanges).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      "/repos/project"
    );
  });
});
