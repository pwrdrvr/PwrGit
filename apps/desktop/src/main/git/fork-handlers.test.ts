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
    const refresh = vi.fn(async () => changed);
    const listRepos = vi.fn(() => [repo, { id: "repo-2" }]);
    const bus = new CommandBus();
    registerForkHandlers(bus, {} as ForkService,
      { refresh } as unknown as IdentityService,
      { listRepos } as unknown as RepoIndexer);
    expect(await bus.dispatch("repo:refreshIdentities", {
      profileId: "profile-1", repoId: "repo-1", force: true
    })).toEqual(ok({ changed: 1 }));
    expect(listRepos).toHaveBeenCalledWith("profile-1");
    expect(refresh).toHaveBeenCalledExactlyOnceWith([repo], { force: true });
    expect(emitEvent).toHaveBeenCalledWith("repo:identityChanged", {
      profileId: "profile-1", identities: changed
    });
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
});
