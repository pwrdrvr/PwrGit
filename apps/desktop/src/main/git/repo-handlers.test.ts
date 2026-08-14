import { beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type Repo } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { ProfileService } from "../profiles/profile-service";
import type { RepoIndexer } from "./repo-indexer";
import { registerRepoHandlers } from "./repo-handlers";
import type { WorktreeRefresher } from "./worktree-handlers";

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

const canonicalRepo: Repo = {
  id: "canonical-repo",
  name: "canonical",
  path: "/repos/canonical",
  profileId: "profile-1",
  pinned: false,
  worktrees: []
};

describe("repo handlers", () => {
  const refresher = {
    refreshWorktree: vi.fn(async () => undefined),
    refreshRepoWorktrees: vi.fn(async () => undefined)
  } satisfies WorktreeRefresher;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes a deindexed fossil repo back as a success and refreshes the tree", async () => {
    const getRepo = vi.fn(() => fossilRepo);
    const indexer = {
      getRepo,
      refreshRepoWorktrees: vi.fn(async () =>
        ok({
          outcome: "deindexed" as const,
          profileId: fossilRepo.profileId,
          ownerPath: canonicalRepo.path
        })
      )
    } as unknown as RepoIndexer;
    const bus = new CommandBus();
    registerRepoHandlers(bus, indexer, {} as ProfileService, refresher);

    const result = await bus.dispatch("repo:refreshWorktrees", {
      repoId: fossilRepo.id
    });

    // The row is gone and that is the correct outcome — the renderer must not
    // be handed an error it would render as "Couldn't refresh …".
    expect(result).toEqual(
      ok({
        outcome: "deindexed",
        profileId: fossilRepo.profileId,
        ownerPath: canonicalRepo.path
      })
    );
    expect(emitEvent).toHaveBeenCalledExactlyOnceWith("repo:changed", {
      profileId: fossilRepo.profileId
    });
    // profileId rides on the outcome, so the handler no longer has to read the
    // repo before deleting it just to learn where to send the event.
    expect(getRepo).not.toHaveBeenCalled();
    expect(refresher.refreshRepoWorktrees).not.toHaveBeenCalled();
  });

  it("refreshes reconciled worktree state before completing", async () => {
    const indexer = {
      getRepo: vi.fn(() => canonicalRepo),
      refreshRepoWorktrees: vi.fn(async () =>
        ok({
          outcome: "reconciled" as const,
          repo: canonicalRepo,
          added: 1,
          removed: 0,
          updated: 0
        })
      )
    } as unknown as RepoIndexer;
    const bus = new CommandBus();
    registerRepoHandlers(bus, indexer, {} as ProfileService, refresher);

    const result = await bus.dispatch("repo:refreshWorktrees", {
      repoId: canonicalRepo.id
    });

    expect(result.ok).toBe(true);
    expect(refresher.refreshRepoWorktrees).toHaveBeenCalledExactlyOnceWith(
      canonicalRepo.id
    );
    // The real refresher emits only after its state probes finish; the handler
    // must not also publish the stale pre-probe tree.
    expect(emitEvent).not.toHaveBeenCalled();
  });
});
