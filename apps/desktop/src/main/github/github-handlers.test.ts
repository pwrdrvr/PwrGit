import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandBus } from "../command-bus";
import type { GitHubCommitAuthorIdentityService } from "./commit-author-identity";
import { registerGitHubHandlers } from "./github-handlers";
import type { PrService } from "./pr-service";

const { emitEvent } = vi.hoisted(() => ({ emitEvent: vi.fn() }));
vi.mock("../ipc", () => ({ emitEvent }));

const request = {
  worktreeId: "worktree-1",
  commitHash: "0123456789abcdef0123456789abcdef01234567",
  authorName: "Ada Lovelace",
  authorEmail: "ada@example.test"
};

beforeEach(() => {
  emitEvent.mockClear();
});

describe("github:commitAuthorIdentity handler", () => {
  it("waits for a cache-only local read so the graph worker limit is real", async () => {
    let complete:
      | ((value: { cacheState: "fresh"; refreshState: "idle" }) => void)
      | undefined;
    const completion = new Promise<{ cacheState: "fresh"; refreshState: "idle" }>(
      (resolve) => {
        complete = resolve;
      }
    );
    const identities = {
      request: vi.fn(() => ({
        lookup: { cacheState: "miss" as const, refreshState: "in-flight" as const },
        completion
      }))
    } as unknown as GitHubCommitAuthorIdentityService;
    const bus = new CommandBus();
    registerGitHubHandlers(bus, {} as PrService, identities);

    let settled = false;
    const dispatched = bus
      .dispatch("github:commitAuthorIdentity", { ...request, cacheOnly: true })
      .then((result) => {
        settled = true;
        return result;
      });
    await Promise.resolve();
    expect(settled).toBe(false);

    complete?.({ cacheState: "fresh", refreshState: "idle" });
    await expect(dispatched).resolves.toEqual({
      ok: true,
      value: { cacheState: "fresh", refreshState: "idle" }
    });
    expect(emitEvent).toHaveBeenCalledWith("github:commitAuthorIdentityChanged", {
      worktreeId: request.worktreeId,
      commitHash: request.commitHash,
      lookup: { cacheState: "fresh", refreshState: "idle" }
    });
  });

  it("returns the normal hover placeholder without waiting for completion", async () => {
    let complete:
      | ((value: { cacheState: "fresh"; refreshState: "idle" }) => void)
      | undefined;
    const completion = new Promise<{ cacheState: "fresh"; refreshState: "idle" }>(
      (resolve) => {
        complete = resolve;
      }
    );
    const identities = {
      request: vi.fn(() => ({
        lookup: { cacheState: "miss" as const, refreshState: "in-flight" as const },
        completion
      }))
    } as unknown as GitHubCommitAuthorIdentityService;
    const bus = new CommandBus();
    registerGitHubHandlers(bus, {} as PrService, identities);

    await expect(bus.dispatch("github:commitAuthorIdentity", request)).resolves.toEqual({
      ok: true,
      value: { cacheState: "miss", refreshState: "in-flight" }
    });

    complete?.({ cacheState: "fresh", refreshState: "idle" });
    await vi.waitFor(() => {
      expect(emitEvent).toHaveBeenCalledWith("github:commitAuthorIdentityChanged", {
        worktreeId: request.worktreeId,
        commitHash: request.commitHash,
        lookup: { cacheState: "fresh", refreshState: "idle" }
      });
    });
  });
});
