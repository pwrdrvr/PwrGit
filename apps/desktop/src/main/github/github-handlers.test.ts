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
  it("starts a whole cache hydration batch before awaiting any commit", async () => {
    const completions = new Map<
      string,
      (value: { identity: { login: string }; cacheState: "fresh"; refreshState: "idle" }) => void
    >();
    const identities = {
      request: vi.fn((input: { commitHash: string; cacheOnly?: boolean }) => ({
        lookup: { cacheState: "miss" as const, refreshState: "in-flight" as const },
        completion: new Promise<{
          identity: { login: string };
          cacheState: "fresh";
          refreshState: "idle";
        }>((resolve) => completions.set(input.commitHash, resolve))
      }))
    } as unknown as GitHubCommitAuthorIdentityService;
    const bus = new CommandBus();
    registerGitHubHandlers(bus, {} as PrService, identities);

    const secondHash = "fedcba9876543210fedcba9876543210fedcba98";
    const dispatched = bus.dispatch("github:hydrateCommitAuthorIdentities", {
      worktreeId: request.worktreeId,
      commits: [
        {
          commitHash: request.commitHash,
          authorName: request.authorName,
          authorEmail: request.authorEmail
        },
        {
          commitHash: secondHash,
          authorName: "Grace Hopper",
          authorEmail: "grace@example.test"
        }
      ]
    });

    await vi.waitFor(() => expect(identities.request).toHaveBeenCalledTimes(2));
    expect(identities.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ cacheOnly: true, commitHash: request.commitHash }),
      expect.any(Function)
    );
    expect(identities.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cacheOnly: true, commitHash: secondHash }),
      expect.any(Function)
    );

    completions.get(request.commitHash)?.({
      identity: { login: "ada" },
      cacheState: "fresh",
      refreshState: "idle"
    });
    await Promise.resolve();
    let settled = false;
    void dispatched.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    completions.get(secondHash)?.({
      identity: { login: "grace" },
      cacheState: "fresh",
      refreshState: "idle"
    });
    await expect(dispatched).resolves.toEqual({
      ok: true,
      value: {
        [request.commitHash]: {
          identity: { login: "ada" },
          cacheState: "fresh",
          refreshState: "idle"
        },
        [secondHash]: {
          identity: { login: "grace" },
          cacheState: "fresh",
          refreshState: "idle"
        }
      }
    });
  });

  it("retries local misses after exact rows seed reusable author accounts", async () => {
    const secondHash = "fedcba9876543210fedcba9876543210fedcba98";
    let secondReads = 0;
    const identities = {
      request: vi.fn((input: { commitHash: string }) => {
        if (input.commitHash === request.commitHash) {
          return {
            lookup: { cacheState: "miss" as const, refreshState: "in-flight" as const },
            completion: Promise.resolve({
              identity: { login: "ada" },
              cacheState: "fresh" as const,
              refreshState: "idle" as const
            })
          };
        }
        secondReads += 1;
        return {
          lookup: { cacheState: "miss" as const, refreshState: "in-flight" as const },
          completion: Promise.resolve(secondReads === 1
            ? { cacheState: "miss" as const, refreshState: "idle" as const }
            : {
                identity: { login: "ada" },
                cacheState: "fresh" as const,
                refreshState: "idle" as const
              })
        };
      })
    } as unknown as GitHubCommitAuthorIdentityService;
    const bus = new CommandBus();
    registerGitHubHandlers(bus, {} as PrService, identities);

    await expect(bus.dispatch("github:hydrateCommitAuthorIdentities", {
      worktreeId: request.worktreeId,
      commits: [
        {
          commitHash: request.commitHash,
          authorName: request.authorName,
          authorEmail: request.authorEmail
        },
        {
          commitHash: secondHash,
          authorName: "A. Lovelace",
          authorEmail: request.authorEmail
        }
      ]
    })).resolves.toEqual({
      ok: true,
      value: {
        [request.commitHash]: {
          identity: { login: "ada" },
          cacheState: "fresh",
          refreshState: "idle"
        },
        [secondHash]: {
          identity: { login: "ada" },
          cacheState: "fresh",
          refreshState: "idle"
        }
      }
    });
    expect(identities.request).toHaveBeenCalledTimes(3);
    expect(secondReads).toBe(2);
  });

  it("waits for a cache-only local read", async () => {
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
