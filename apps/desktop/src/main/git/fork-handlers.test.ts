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
