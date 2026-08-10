import { beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { discardAllChanges } from "./git-service";
import { registerChangesHandlers } from "./changes-handlers";
import type { WorktreeRefresher } from "./worktree-handlers";

vi.mock("./git-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-service")>();
  return { ...actual, discardAllChanges: vi.fn() };
});

function setup() {
  const db = {
    prepare: vi.fn(() => ({ get: vi.fn(() => ({ path: "/repos/project" })) }))
  } as unknown as DB;
  const refresher = {
    refreshWorktree: vi.fn(),
    refreshRepoWorktrees: vi.fn()
  } satisfies WorktreeRefresher;
  const bus = new CommandBus();
  registerChangesHandlers(bus, db, refresher);
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
