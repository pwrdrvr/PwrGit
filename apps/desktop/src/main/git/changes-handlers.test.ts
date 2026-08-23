import { beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { emitEvent } from "../ipc";
import {
  discardAllChanges,
  discardPaths,
  readChanges,
  stagePaths,
  unstagePaths
} from "./git-service";
import { registerChangesHandlers } from "./changes-handlers";
import { applyPartialSelection, partialFileDiff } from "./partial-staging";
import type { WorktreeRefresher } from "./worktree-handlers";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("./git-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-service")>();
  return {
    ...actual,
    discardAllChanges: vi.fn(),
    discardPaths: vi.fn(),
    readChanges: vi.fn(),
    stagePaths: vi.fn(),
    unstagePaths: vi.fn()
  };
});
vi.mock("./partial-staging", () => ({
  applyPartialSelection: vi.fn(),
  partialFileDiff: vi.fn()
}));

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

/**
 * Staging one file moves the index but nothing the worktree refresher compares:
 * `git status` still prints the same number of entry lines (the path just moves
 * from the unstaged column to the staged one), and head/ahead/behind are
 * untouched. `refreshWorktree` is deliberately silent in that case, so before
 * `changes:changed` existed the Changes list never reloaded and the row's "+"
 * looked broken — you could stage a whole untracked folder (which *does* change
 * the line count) and then nothing else in the list would respond.
 */
describe("changes mutation events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(stagePaths).mockResolvedValue(ok(undefined));
    vi.mocked(unstagePaths).mockResolvedValue(ok(undefined));
    vi.mocked(discardPaths).mockResolvedValue(ok(undefined));
    vi.mocked(discardAllChanges).mockResolvedValue(ok(undefined));
  });

  it.each([
    ["changes:stage", { worktreeId: "worktree-1", paths: ["notes.txt"] }],
    ["changes:unstage", { worktreeId: "worktree-1", paths: ["notes.txt"] }],
    ["changes:discard", { worktreeId: "worktree-1", paths: ["notes.txt"] }],
    ["changes:discardAll", { worktreeId: "worktree-1" }]
  ] as const)(
    "%s tells the renderer to re-read the change set",
    async (command, req) => {
      const { bus } = setup();

      await expect(bus.dispatch(command, req)).resolves.toEqual(ok(null));

      expect(emitEvent).toHaveBeenCalledWith("changes:changed", {
        worktreeId: "worktree-1"
      });
    }
  );

  // A failed stage still announces. Git validates a whole pathspec list before
  // touching the index, so one run is atomic — but `stagePaths` splits a long
  // list across runs, and a failure in a later one leaves the earlier ones
  // applied. Going quiet there would show staged files as unstaged.
  it("still announces when a batched mutation failed part-way", async () => {
    const failure = err({
      kind: "git" as const,
      code: "exit_128",
      message: "pathspec did not match"
    });
    vi.mocked(stagePaths).mockResolvedValueOnce(failure);
    const { bus } = setup();

    await expect(
      bus.dispatch("changes:stage", {
        worktreeId: "worktree-1",
        paths: ["staged.txt", "missing.txt"]
      })
    ).resolves.toEqual(failure);
    expect(emitEvent).toHaveBeenCalledWith("changes:changed", {
      worktreeId: "worktree-1"
    });
  });

  it("stays quiet when a single-command mutation failed", async () => {
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
    expect(emitEvent).not.toHaveBeenCalled();
    expect(refresher.refreshWorktree).not.toHaveBeenCalled();
  });
});

describe("partial staging handlers", () => {
  const snapshot = {
    path: "notes.txt",
    staged: false,
    patch: "patch",
    fingerprint: "snapshot-1",
    capability: { available: true as const },
    hunks: []
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(partialFileDiff).mockResolvedValue(ok(snapshot));
    vi.mocked(applyPartialSelection).mockResolvedValue(ok(undefined));
  });

  it("reads a typed selection snapshot through the worktree queue", async () => {
    const { bus } = setup();
    await expect(
      bus.dispatch("diff:fileSelection", {
        worktreeId: "worktree-1",
        path: "notes.txt",
        staged: false
      })
    ).resolves.toEqual(ok(snapshot));
    expect(partialFileDiff).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      expect.any(Function),
      "/repos/project",
      "notes.txt",
      false
    );
  });

  it("applies trusted line IDs and announces the index move", async () => {
    const { bus } = setup();
    await expect(
      bus.dispatch("changes:applySelection", {
        worktreeId: "worktree-1",
        path: "notes.txt",
        staged: false,
        fingerprint: "snapshot-1",
        lineIds: ["line-1"]
      })
    ).resolves.toEqual(ok(null));
    expect(applyPartialSelection).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      expect.any(Function),
      "/repos/project",
      "notes.txt",
      false,
      "snapshot-1",
      ["line-1"]
    );
    expect(emitEvent).toHaveBeenCalledWith("changes:changed", {
      worktreeId: "worktree-1"
    });
  });

  it("announces a stale external edit so every surface refreshes", async () => {
    const failure = err({
      kind: "validation" as const,
      code: "stale_diff",
      message: "changed"
    });
    vi.mocked(applyPartialSelection).mockResolvedValueOnce(failure);
    const { bus } = setup();
    await expect(
      bus.dispatch("changes:applySelection", {
        worktreeId: "worktree-1",
        path: "notes.txt",
        staged: true,
        fingerprint: "snapshot-1",
        lineIds: ["line-1"]
      })
    ).resolves.toEqual(failure);
    expect(emitEvent).toHaveBeenCalledWith("changes:changed", {
      worktreeId: "worktree-1"
    });
  });
});
