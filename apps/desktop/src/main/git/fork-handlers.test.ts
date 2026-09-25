import { beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, type ForkProgress } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import type { IdentityService } from "../forge/identity-service";
import { emitEvent } from "../ipc";
import type { RepoIndexer } from "./repo-indexer";
import { registerForkHandlers } from "./fork-handlers";
import type { ForkService } from "./fork-service";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));

describe("fork handlers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forces only the requested repository within its profile and publishes the delta", async () => {
    const repo = { id: "repo-1" };
    const changed = [{ repoId: "repo-1", identity: { visibility: "public" } }];
    const outcomes = [{ repoId: "repo-1", status: "resolved" }];
    const refreshWithOutcomes = vi.fn(async () => ({ changes: changed, outcomes }));
    const listRepos = vi.fn(() => [repo, { id: "repo-2" }]);
    const bus = new CommandBus();
    registerForkHandlers(bus, {} as ForkService,
      { refreshWithOutcomes } as unknown as IdentityService,
      { listRepos } as unknown as RepoIndexer);
    expect(await bus.dispatch("repo:refreshIdentities", {
      profileId: "profile-1", repoId: "repo-1", force: true
    })).toEqual(ok({ changed: 1, outcomes }));
    expect(listRepos).toHaveBeenCalledWith("profile-1");
    expect(refreshWithOutcomes).toHaveBeenCalledExactlyOnceWith([repo], { force: true });
    expect(emitEvent).toHaveBeenCalledWith("repo:identityChanged", {
      profileId: "profile-1", identities: changed
    });
  });

  it("asks about exactly the listed repositories, unforced, and stays quiet when nothing moved", async () => {
    const added = [{ id: "repo-2" }, { id: "repo-3" }];
    const refreshWithOutcomes = vi.fn(async () => ({ changes: [], outcomes: [] }));
    const listRepos = vi.fn(() => [{ id: "repo-1" }, ...added]);
    const bus = new CommandBus();
    registerForkHandlers(bus, {} as ForkService,
      { refreshWithOutcomes } as unknown as IdentityService,
      { listRepos } as unknown as RepoIndexer);
    expect(await bus.dispatch("repo:refreshIdentities", {
      profileId: "profile-1", repoIds: ["repo-3", "repo-2", "gone"]
    })).toEqual(ok({ changed: 0, outcomes: [] }));
    // The profile's own order, and an id that no longer lists is dropped
    // rather than looked up.
    expect(refreshWithOutcomes).toHaveBeenCalledExactlyOnceWith(added, {});
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("cancels the matching fork without publishing a repo change", async () => {
    const fork = vi.fn(
      async (
        _input: unknown,
        _onProgress: (progress: ForkProgress) => void,
        signal: AbortSignal
      ) =>
        await new Promise<ReturnType<typeof err>>((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve(err(signal.reason)),
            { once: true }
          );
        })
    );
    const bus = new CommandBus();
    registerForkHandlers(
      bus,
      { fork } as unknown as ForkService,
      {} as IdentityService,
      {} as RepoIndexer
    );

    const forking = bus.dispatch("repo:fork", {
      operationId: "cancel-fork",
      profileId: "profile-id",
      source: "upstream/repository",
      host: "github",
      hostname: "github.com",
      targetOwner: "tester",
      targetOwnerKind: "user",
      targetName: "repository",
      protocol: "cli",
      parentPath: "/projects",
      defaultBranchOnly: false,
      upstream: "upstream/repository"
    });
    await expect(
      bus.dispatch("repo:cancelFork", { operationId: "cancel-fork" })
    ).resolves.toEqual(ok(null));
    await expect(forking).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" }
    });
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("re-reads the branch index, the tree and the identity after a rewire", async () => {
    // `repo:fork` needs none of this — its repository did not exist a moment
    // ago. This one changed three things about a repository already on screen,
    // and each has its own reader.
    const repo = { id: "repo-1", profileId: "profile-1" };
    const refreshRepoRemoteBranches = vi.fn(async () => ok(undefined));
    const refresh = vi.fn(async () => [{ repoId: "repo-1", identity: {} }]);
    const refreshRepoWorktrees = vi.fn();
    const bus = new CommandBus();
    registerForkHandlers(
      bus,
      { forkCheckout: async () => ok(repo) } as unknown as ForkService,
      { refresh } as unknown as IdentityService,
      { refreshRepoRemoteBranches } as unknown as RepoIndexer,
      { refreshRepoWorktrees }
    );

    await bus.dispatch("repo:forkCheckout", {
      operationId: "rewire-1",
      profileId: "profile-1",
      repoId: "repo-1",
      targetOwner: "huntharo",
      targetOwnerKind: "user",
      targetName: "dugite",
      upstream: "desktop/dugite"
    });

    expect(refreshRepoRemoteBranches).toHaveBeenCalledExactlyOnceWith("repo-1");
    expect(refreshRepoWorktrees).toHaveBeenCalledExactlyOnceWith("repo-1");
    expect(refresh).toHaveBeenCalledExactlyOnceWith([repo], { force: true });
    expect(emitEvent).toHaveBeenCalledWith("repo:changed", {
      profileId: "profile-1"
    });
  });

  it("touches nothing when the rewire failed", async () => {
    const refreshRepoRemoteBranches = vi.fn(async () => ok(undefined));
    const bus = new CommandBus();
    registerForkHandlers(
      bus,
      {
        forkCheckout: async () =>
          err({ kind: "remote", code: "fork_failed", message: "no" })
      } as unknown as ForkService,
      {} as IdentityService,
      { refreshRepoRemoteBranches } as unknown as RepoIndexer
    );

    const result = await bus.dispatch("repo:forkCheckout", {
      operationId: "rewire-2",
      profileId: "profile-1",
      repoId: "repo-1",
      targetOwner: "huntharo",
      targetOwnerKind: "user",
      targetName: "dugite",
      upstream: null
    });

    expect(result.ok).toBe(false);
    expect(refreshRepoRemoteBranches).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });
});
