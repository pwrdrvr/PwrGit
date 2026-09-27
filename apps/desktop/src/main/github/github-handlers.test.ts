import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandBus } from "../command-bus";
import type { GitHubCommitAuthorIdentityService } from "./commit-author-identity";
import { registerGitHubHandlers } from "./github-handlers";
import { PR_STATUS_POLL_INTERVAL_MS } from "./pr-status-monitor";
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
  vi.useRealTimers();
});

describe("github:hydrateCommitAuthorIdentities handler", () => {
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
      expect.objectContaining({ cacheOnly: true, commitHash: request.commitHash })
    );
    expect(identities.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cacheOnly: true, commitHash: secondHash })
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

  it("is only ever a local read, and announces nothing", async () => {
    const identities = {
      request: vi.fn(() => ({
        lookup: { cacheState: "miss" as const, refreshState: "in-flight" as const },
        completion: Promise.resolve({ cacheState: "stale" as const, refreshState: "idle" as const })
      }))
    } as unknown as GitHubCommitAuthorIdentityService;
    const bus = new CommandBus();
    registerGitHubHandlers(bus, {} as PrService, identities);

    await expect(bus.dispatch("github:hydrateCommitAuthorIdentities", {
      worktreeId: request.worktreeId,
      commits: [{
        commitHash: request.commitHash,
        authorName: request.authorName,
        authorEmail: request.authorEmail
      }]
    })).resolves.toEqual({
      ok: true,
      value: { [request.commitHash]: { cacheState: "stale", refreshState: "idle" } }
    });
    expect(identities.request).toHaveBeenCalledWith(
      expect.objectContaining({ cacheOnly: true })
    );
    expect(emitEvent).not.toHaveBeenCalled();
  });
});

describe("people:replaceInterest handler", () => {
  const author = {
    name: request.authorName,
    email: request.authorEmail,
    commitHashes: [request.commitHash]
  };

  const peopleIdentities = (): GitHubCommitAuthorIdentityService => ({
    request: vi.fn(() => ({
      lookup: { cacheState: "miss" as const, refreshState: "in-flight" as const },
      completion: Promise.resolve({ cacheState: "miss" as const, refreshState: "idle" as const })
    })),
    worktreeForge: vi.fn(async () => ({
      kind: "github" as const,
      host: "github.com",
      path: "octo-org/example"
    }))
  } as unknown as GitHubCommitAuthorIdentityService);

  it("answers a window from cache, and asks the forge only on the store's clock", async () => {
    vi.useFakeTimers();
    const identities = peopleIdentities();
    const bus = new CommandBus();
    const handlers = registerGitHubHandlers(bus, {} as PrService, identities);

    await expect(bus.dispatch(
      "people:replaceInterest",
      { worktreeId: request.worktreeId, monitorId: "graph", authors: [author] },
      { webContentsId: 11 }
    )).resolves.toEqual({
      ok: true,
      value: { "ada@example.test": { state: "pending", forge: "github" } }
    });
    const network = (): unknown[] =>
      vi.mocked(identities.request).mock.calls.filter(([input]) => input.cacheOnly !== true);
    expect(network()).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(network()).toHaveLength(1);
    handlers.stop();
  });

  it("needs a window to own the interest", async () => {
    const identities = peopleIdentities();
    const bus = new CommandBus();
    const handlers = registerGitHubHandlers(bus, {} as PrService, identities);

    await expect(bus.dispatch("people:replaceInterest", {
      worktreeId: request.worktreeId,
      monitorId: "graph",
      authors: [author]
    })).resolves.toEqual({ ok: true, value: {} });
    expect(identities.request).not.toHaveBeenCalled();
    handlers.stop();
  });

  it("stops looking after a closed window's authors", async () => {
    vi.useFakeTimers();
    const identities = peopleIdentities();
    const bus = new CommandBus();
    const handlers = registerGitHubHandlers(bus, {} as PrService, identities);

    await bus.dispatch(
      "people:replaceInterest",
      { worktreeId: request.worktreeId, monitorId: "graph", authors: [author] },
      { webContentsId: 11 }
    );
    handlers.releaseWebContents(11);
    vi.mocked(identities.request).mockClear();

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(identities.request).not.toHaveBeenCalled();
    handlers.stop();
  });
});

describe("PR monitor renderer ownership", () => {
  it("returns cached visible PRs before a background association refresh", async () => {
    const hash = "0123456789abcdef0123456789abcdef01234567";
    const pullRequest = {
      number: 44,
      url: "https://github.com/pwrdrvr/PwrGit/pull/44",
      title: "Show rewritten PR landings",
      state: "merged" as const,
      isDraft: false
    };
    let finishRefresh: ((value: Map<string, typeof pullRequest>) => void) | undefined;
    const refresh = new Promise<Map<string, typeof pullRequest>>((resolve) => {
      finishRefresh = resolve;
    });
    const prs = {
      ownsWorktree: () => true,
      cachedCommitPrs: (_repoId: string, hashes: string[]) =>
        new Map(hashes.map((commitHash) => [commitHash, pullRequest])),
      refreshCommits: vi.fn(() => refresh)
    } as unknown as PrService;
    const identities = { request: vi.fn() } as unknown as
      GitHubCommitAuthorIdentityService;
    const bus = new CommandBus();
    const handlers = registerGitHubHandlers(bus, prs, identities);

    await expect(
      bus.dispatch(
        "pr:replaceVisibleCommits",
        {
          repoId: "repo",
          worktreeId: "worktree",
          monitorId: "visible",
          commitHashes: [hash]
        },
        { webContentsId: 11 }
      )
    ).resolves.toEqual({ ok: true, value: { [hash]: pullRequest } });

    finishRefresh?.(new Map());
    await refresh;
    handlers.stop();
  });

  it("keeps another window's reason and releases the final reason on destruction", async () => {
    vi.useFakeTimers();
    const hash = "0123456789abcdef0123456789abcdef01234567";
    const pullRequest = {
      number: 30,
      url: "https://github.com/pwrdrvr/PwrGit/pull/30",
      title: "Visible commit PRs",
      state: "open" as const,
      isDraft: true
    };
    const refreshPrNumbers = vi.fn(async () => ({
      branches: new Map(),
      commits: new Map()
    }));
    const prs = {
      ownsWorktree: () => true,
      cachedCommitPrs: (_repoId: string, hashes: string[]) =>
        new Map(hashes.map((commitHash) => [commitHash, pullRequest])),
      refreshCommits: async () => new Map(),
      refreshPrNumbers
    } as unknown as PrService;
    const identities = { request: vi.fn() } as unknown as
      GitHubCommitAuthorIdentityService;
    const bus = new CommandBus();
    const handlers = registerGitHubHandlers(bus, prs, identities);
    const request = {
      repoId: "repo",
      worktreeId: "worktree",
      monitorId: "same-renderer-monitor-id",
      commitHashes: [hash]
    };

    await bus.dispatch("pr:replaceVisibleCommits", request, { webContentsId: 11 });
    await bus.dispatch("pr:replaceVisibleCommits", request, { webContentsId: 22 });
    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect(refreshPrNumbers).toHaveBeenCalledOnce();

    handlers.releaseWebContents(11);
    refreshPrNumbers.mockClear();
    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect(refreshPrNumbers).toHaveBeenCalledOnce();

    handlers.releaseWebContents(22);
    refreshPrNumbers.mockClear();
    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect(refreshPrNumbers).not.toHaveBeenCalled();
    handlers.stop();
  });
});
