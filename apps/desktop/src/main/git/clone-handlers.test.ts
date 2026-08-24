import { beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, type CloneProgress, type Repo } from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { registerCloneHandlers } from "./clone-handlers";
import type { CloneService } from "./clone-service";

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));

const repo: Repo = {
  id: "repo-id",
  name: "new-service",
  path: "/projects/services/new-service",
  profileId: "profile-id",
  pinned: false,
  worktrees: []
};

describe("clone handlers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refreshes the profile tree after a successful clone", async () => {
    const clone = vi.fn(
      async (
        _input: unknown,
        onProgress: (progress: CloneProgress) => void
      ) => {
        onProgress({ phase: "receiving", percent: 42 });
        return ok(repo);
      }
    );
    const service = { clone } as unknown as CloneService;
    const bus = new CommandBus();
    registerCloneHandlers(bus, service);

    const result = await bus.dispatch("repo:clone", {
      operationId: "clone-operation",
      profileId: "profile-id",
      nameWithOwner: "pwrdrvr/new-service",
      protocol: "ssh",
      parentPath: "/projects/services"
    });

    expect(result).toEqual(ok(repo));
    expect(emitEvent).toHaveBeenCalledWith("repo:cloneProgress", {
      operationId: "clone-operation",
      profileId: "profile-id",
      progress: { phase: "receiving", percent: 42 }
    });
    expect(emitEvent).toHaveBeenCalledWith("repo:changed", {
      profileId: "profile-id"
    });
    expect(emitEvent).toHaveBeenCalledTimes(2);
  });

  it("cancels the matching operation without refreshing the tree", async () => {
    const clone = vi.fn(
      async (
        _input: unknown,
        _onProgress: (progress: CloneProgress) => void,
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
    registerCloneHandlers(bus, { clone } as unknown as CloneService);

    const cloning = bus.dispatch("repo:clone", {
      operationId: "cancel-me",
      profileId: "profile-id",
      nameWithOwner: "pwrdrvr/new-service",
      protocol: "ssh",
      parentPath: "/projects/services"
    });
    await expect(
      bus.dispatch("repo:cancelClone", { operationId: "cancel-me" })
    ).resolves.toEqual(ok(null));
    await expect(cloning).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" }
    });
    expect(emitEvent).not.toHaveBeenCalled();
  });
});
