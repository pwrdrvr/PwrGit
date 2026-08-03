import { beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type Repo } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { ProfileService } from "../profiles/profile-service";
import type { RepoIndexer } from "./repo-indexer";
import { registerRepoHandlers } from "./repo-handlers";

vi.mock("../ipc", () => ({
  registerIpc: vi.fn(),
  emitEvent: vi.fn()
}));

const fossilRepo: Repo = {
  id: "fossil-repo",
  name: "linked-worktree",
  path: "/repos/linked-worktree",
  profileId: "profile-1",
  pinned: false,
  worktrees: []
};

describe("repo handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes a deindexed fossil repo back as a success and refreshes the tree", async () => {
    const indexer = {
      getRepo: vi.fn(() => fossilRepo),
      refreshRepoWorktrees: vi.fn(async () =>
        ok({ outcome: "deindexed" as const, profileId: fossilRepo.profileId })
      )
    } as unknown as RepoIndexer;
    const bus = new CommandBus();
    registerRepoHandlers(bus, indexer, {} as ProfileService);

    const result = await bus.dispatch("repo:refreshWorktrees", {
      repoId: fossilRepo.id
    });

    // The row is gone and that is the correct outcome — the renderer must not
    // be handed an error it would render as "Couldn't refresh …".
    expect(result).toEqual(
      ok({ outcome: "deindexed", profileId: fossilRepo.profileId })
    );
    expect(emitEvent).toHaveBeenCalledExactlyOnceWith("repo:changed", {
      profileId: fossilRepo.profileId
    });
  });

  it("refreshes the tree after an ordinary reconcile", async () => {
    const indexer = {
      getRepo: vi.fn(() => fossilRepo),
      refreshRepoWorktrees: vi.fn(async () =>
        ok({
          outcome: "reconciled" as const,
          repo: fossilRepo,
          added: 1,
          removed: 0,
          updated: 0
        })
      )
    } as unknown as RepoIndexer;
    const bus = new CommandBus();
    registerRepoHandlers(bus, indexer, {} as ProfileService);

    const result = await bus.dispatch("repo:refreshWorktrees", {
      repoId: fossilRepo.id
    });

    expect(result.ok).toBe(true);
    expect(emitEvent).toHaveBeenCalledExactlyOnceWith("repo:changed", {
      profileId: fossilRepo.profileId
    });
  });
});
