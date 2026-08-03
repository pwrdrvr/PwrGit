import { beforeEach, describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import {
  fetchNamedRemote,
  planPushRefs,
  pushPlannedRefs
} from "./git-service";
import { registerRemoteHandlers } from "./remote-handlers";
import type { WorktreeRefresher } from "./worktree-handlers";

vi.mock("./git-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-service")>();
  return {
    ...actual,
    fetchNamedRemote: vi.fn(),
    planPushRefs: vi.fn(),
    pushPlannedRefs: vi.fn()
  };
});

describe("remote handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchNamedRemote).mockResolvedValue(ok(undefined));
    vi.mocked(planPushRefs).mockResolvedValue(ok([]));
    vi.mocked(pushPlannedRefs).mockResolvedValue(ok([]));
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
});
