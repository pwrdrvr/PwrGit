import { beforeEach, describe, expect, it, vi } from "vitest";
import { err, type Repo } from "@pwrgit/shared";
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

  it("notifies the renderer when refresh deletes a non-canonical repo", async () => {
    const indexer = {
      getRepo: vi.fn(() => fossilRepo),
      refreshRepoWorktrees: vi.fn(async () =>
        err({
          kind: "repo",
          code: "not_canonical",
          message: "repo path is a linked worktree of another repository"
        })
      )
    } as unknown as RepoIndexer;
    const bus = new CommandBus();
    registerRepoHandlers(bus, indexer, {} as ProfileService);

    const result = await bus.dispatch("repo:refreshWorktrees", {
      repoId: fossilRepo.id
    });

    expect(result.ok).toBe(false);
    expect(emitEvent).toHaveBeenCalledExactlyOnceWith("repo:changed", {
      profileId: fossilRepo.profileId
    });
  });
});
