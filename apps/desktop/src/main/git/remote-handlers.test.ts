import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  err,
  ok,
  type PwrGitError,
  type SshRemoteRecovery
} from "@pwrgit/shared";
import { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import { logMain } from "../logs";
import type { DB } from "../persistence/db";
import {
  fetchAllRemotes,
  fetchNamedRemote,
  fetchRemote,
  inspectRemoteReset,
  planPushRefs,
  pullFastForward,
  pushPlannedRefs,
  resetToRemote
} from "./git-service";
import {
  PULL_REFRESH_WAIT_LIMIT_MS,
  registerRemoteHandlers
} from "./remote-handlers";
import {
  PULL_RECOVERY_STALL_TIMEOUT_MS,
  PULL_STALL_TIMEOUT_MS,
  PULL_STALL_WARNING_MS
} from "./pull-watchdog";
import {
  applySshRemoteRecovery,
  inspectSshRemoteRecovery,
  testSshRemoteRecovery
} from "./ssh-remote-recovery";
import type { WorktreeRefresher } from "./worktree-handlers";
import type { RepoIndexer } from "./repo-indexer";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

vi.mock("./git-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-service")>();
  return {
    ...actual,
    fetchAllRemotes: vi.fn(),
    fetchNamedRemote: vi.fn(),
    fetchRemote: vi.fn(),
    inspectRemoteReset: vi.fn(),
    planPushRefs: vi.fn(),
    pullFastForward: vi.fn(),
    pushPlannedRefs: vi.fn(),
    resetToRemote: vi.fn()
  };
});

vi.mock("../ipc", () => ({ emitEvent: vi.fn() }));
vi.mock("../logs", () => ({ logMain: vi.fn() }));
vi.mock("./ssh-remote-recovery", () => ({
  applySshRemoteRecovery: vi.fn(),
  inspectSshRemoteRecovery: vi.fn(),
  testSshRemoteRecovery: vi.fn()
}));

/** Distinct phases one worktree's activity passed through, in order. */
function phasesFrom(
  emit: ReturnType<typeof vi.mocked<typeof emitEvent>>,
  worktreeId: string
): string[] {
  const seen: string[] = [];
  for (const [channel, payload] of emit.mock.calls) {
    if (channel !== "remote:activity") continue;
    const activity = (
      payload as { activities: { worktreeId: string | null; phase: string }[] }
    ).activities.find((entry) => entry.worktreeId === worktreeId);
    if (activity === undefined) continue;
    if (seen.at(-1) !== activity.phase) seen.push(activity.phase);
  }
  return seen;
}

/** The live activity records as of the most recent broadcast. */
function liveActivities(
  emit: ReturnType<typeof vi.mocked<typeof emitEvent>>
): { id: string; kind: string; phase: string; worktreeId: string | null }[] {
  for (let i = emit.mock.calls.length - 1; i >= 0; i -= 1) {
    const [channel, payload] = emit.mock.calls[i]!;
    if (channel !== "remote:activity") continue;
    return (payload as { activities: never[] }).activities;
  }
  return [];
}

describe("remote handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchAllRemotes).mockResolvedValue(ok(undefined));
    vi.mocked(fetchNamedRemote).mockResolvedValue(ok(undefined));
    vi.mocked(fetchRemote).mockResolvedValue(ok(undefined));
    vi.mocked(inspectRemoteReset).mockResolvedValue(
      ok({
        snapshot: {
          branch: "main",
          head: "1".repeat(40),
          remoteRef: "refs/remotes/origin/main",
          remoteHead: "2".repeat(40)
        },
        leaving: [],
        arriving: [],
        alignedCommits: [],
        dirty: 0
      })
    );
    vi.mocked(planPushRefs).mockResolvedValue(ok([]));
    vi.mocked(pullFastForward).mockResolvedValue(
      ok({
        fastForwarded: true,
        stashed: false,
        reappliedWithConflicts: false
      })
    );
    vi.mocked(pushPlannedRefs).mockResolvedValue(ok([]));
    vi.mocked(resetToRemote).mockResolvedValue(ok(undefined));
    vi.mocked(inspectSshRemoteRecovery).mockResolvedValue(ok(null));
    vi.mocked(testSshRemoteRecovery).mockResolvedValue(ok(undefined));
    vi.mocked(applySshRemoteRecovery).mockResolvedValue(ok(undefined));
  });

  afterEach(() => vi.useRealTimers());

  it.each(["worktree", "repo", "all-remotes", "pull"] as const)(
    "refreshes identity after a successful %s fetch, but not a failed fetch",
    async (scope) => {
      const db = {
        prepare: vi.fn(() => ({
          get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
        }))
      } as unknown as DB;
      const refresher = {
        refreshWorktree: vi.fn(async () => undefined),
        refreshRepoWorktrees: vi.fn()
      } satisfies WorktreeRefresher;
      const refreshIdentity = vi.fn();
      const bus = new CommandBus();
      registerRemoteHandlers(
        bus,
        db,
        refresher,
        new WorktreeOperationQueue(),
        undefined,
        refreshIdentity
      );
      const fetch = () => {
        if (scope === "worktree") {
          return bus.dispatch("remote:fetch", { worktreeId: "wt-1" });
        }
        if (scope === "pull") {
          return bus.dispatch("remote:pull", { worktreeId: "wt-1" });
        }
        return bus.dispatch("remote:fetchRepo", {
          repoId: "repo-1",
          ...(scope === "repo" ? { remote: "origin" } : {})
        });
      };

      expect((await fetch()).ok).toBe(true);
      expect(refreshIdentity).toHaveBeenCalledExactlyOnceWith("repo-1");
      refreshIdentity.mockClear();
      const offline = err({ kind: "git" as const, code: "failed", message: "offline" });
      vi.mocked(fetchRemote).mockResolvedValue(offline);
      vi.mocked(fetchAllRemotes).mockResolvedValue(offline);
      vi.mocked(fetchNamedRemote).mockResolvedValue(offline);
      vi.mocked(pullFastForward).mockResolvedValue(offline);
      expect((await fetch()).ok).toBe(false);
      expect(refreshIdentity).not.toHaveBeenCalled();
    }
  );

  it("refuses to fetch a worktree whose directory is gone, without running git", async () => {
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({
          path: "/repos/project/wt/gone",
          repoId: "repo-1",
          missing: 1
        }))
      }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(async () => undefined),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue());

    const result = await bus.dispatch("remote:fetch", { worktreeId: "wt-gone" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      kind: "repo",
      code: "worktree_missing"
    });
    expect(result.error.message).toContain("/repos/project/wt/gone");
    expect(fetchRemote).not.toHaveBeenCalled();
    expect(refresher.refreshWorktree).not.toHaveBeenCalled();
  });

  it("logs pull start and every phase immediately with path and elapsed time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(async () => undefined),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    vi.mocked(pullFastForward).mockImplementationOnce(
      async (_git, _path, onProgress) => {
        onProgress?.("fetch");
        vi.advanceTimersByTime(1_000);
        onProgress?.("prepare");
        vi.advanceTimersByTime(1_000);
        onProgress?.("fast_forward");
        vi.advanceTimersByTime(1_000);
        onProgress?.("reapply");
        vi.advanceTimersByTime(1_000);
        return ok({
          fastForwarded: true,
          stashed: true,
          reappliedWithConflicts: false
        });
      }
    );
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue());

    await expect(
      bus.dispatch("remote:pull", { worktreeId: "worktree-1" })
    ).resolves.toMatchObject({ ok: true });

    const messages = vi.mocked(logMain).mock.calls.map((call) => call[2]);
    expect(messages).toEqual(
      expect.arrayContaining([
        "pull started /repos/project (0.0s)",
        "pull phase fetching /repos/project (0.0s)",
        "pull phase inspecting/preparing local changes /repos/project (1.0s)",
        "pull phase fast-forward/checkout /repos/project (2.0s)",
        "pull phase reapplying local changes /repos/project (3.0s)",
        "pull phase refreshing/finish /repos/project (4.0s)",
        "pull finished /repos/project: fast-forwarded, stashed changes reapplied (4.0s)"
      ])
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(emitEvent).toHaveBeenCalledWith("stash:changed", {
      repoId: "repo-1"
    });
  });

  it("refreshes the stash stack when pull leaves an auto-stash for recovery", async () => {
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(async () => undefined),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    vi.mocked(pullFastForward).mockResolvedValueOnce(
      err({
        kind: "git",
        code: "stash_reapply_failed",
        message: "the auto-stash was kept"
      })
    );
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue());

    await expect(
      bus.dispatch("remote:pull", { worktreeId: "worktree-1" })
    ).resolves.toMatchObject({ ok: false, error: { code: "stash_reapply_failed" } });
    expect(emitEvent).toHaveBeenCalledWith("stash:changed", {
      repoId: "repo-1"
    });
  });

  it("leaves the network phase before rebuilding the branch index", async () => {
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(async () => undefined),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    let releaseIndex!: () => void;
    const indexer = {
      refreshRepoRemoteBranches: vi.fn(
        () =>
          new Promise((resolve) => {
            releaseIndex = () => resolve(ok(true));
          })
      )
    } as unknown as RepoIndexer;
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue(), indexer);

    const fetch = bus.dispatch("remote:fetch", { worktreeId: "worktree-1" });
    // Git is done; the index rebuild is not. Reporting that as `fetch` makes
    // the card cry "no Git output for 30s" about a transfer that succeeded —
    // silence is only evidence while --progress obliges Git to speak.
    await vi.waitFor(() =>
      expect(liveActivities(vi.mocked(emitEvent))[0]?.phase).toBe("refresh")
    );

    releaseIndex();
    await expect(fetch).resolves.toMatchObject({ ok: true });
  });

  it("stops a running pull when its live activity is canceled", async () => {
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(async () => undefined),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    vi.mocked(pullFastForward).mockImplementationOnce(
      async (_git, _path, onProgress, control) => {
        onProgress?.("fetch");
        await new Promise<void>((resolve) => {
          control?.signal?.addEventListener("abort", () => resolve());
        });
        return err(control?.signal?.reason as PwrGitError);
      }
    );
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue());

    const pull = bus.dispatch("remote:pull", { worktreeId: "worktree-1" });
    await vi.waitFor(() =>
      expect(liveActivities(vi.mocked(emitEvent))[0]?.phase).toBe("fetch")
    );
    const operationId = liveActivities(vi.mocked(emitEvent))[0]!.id;

    await expect(
      bus.dispatch("remote:cancelActivity", { operationId })
    ).resolves.toEqual(ok({ canceled: true }));

    // The user chose this, so it reads as an outcome rather than a fault —
    // and it names where the pull was when it stopped.
    await expect(pull).resolves.toMatchObject({
      ok: false,
      error: {
        code: "canceled",
        message: "Pull canceled during fetching after 0s."
      }
    });
    // Retired once Git is gone, so no stale card outlives the operation.
    expect(liveActivities(vi.mocked(emitEvent))).toEqual([]);
    await expect(
      bus.dispatch("remote:cancelActivity", { operationId })
    ).resolves.toEqual(ok({ canceled: false }));
  });

  it("reports the wait behind another repository operation as queued", async () => {
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(async () => undefined),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    let releaseFetch!: () => void;
    vi.mocked(fetchRemote).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFetch = () => resolve(ok(undefined));
        })
    );
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue());

    const fetch = bus.dispatch("remote:fetch", { worktreeId: "worktree-1" });
    const pull = bus.dispatch("remote:pull", { worktreeId: "worktree-1" });

    // Time spent behind another operation's lock is not Git being slow, and a
    // spinner that cannot say so is the whole reason this record exists.
    await vi.waitFor(() => {
      const live = liveActivities(vi.mocked(emitEvent));
      expect(live.map((entry) => [entry.kind, entry.phase])).toEqual([
        ["fetch", "fetch"],
        ["pull", "queued"]
      ]);
    });

    releaseFetch();
    await expect(fetch).resolves.toMatchObject({ ok: true });
    await expect(pull).resolves.toMatchObject({ ok: true });
  });

  it("logs stalled warnings and returns a typed phase timeout without timer leaks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(async () => undefined),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    vi.mocked(pullFastForward).mockImplementationOnce(
      (_git, _path, onProgress, control) =>
        new Promise((resolve) => {
          onProgress?.("fetch");
          control?.signal?.addEventListener(
            "abort",
            () =>
              resolve(err(control.signal?.reason as PwrGitError)),
            { once: true }
          );
        })
    );
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue());

    const pull = bus.dispatch("remote:pull", { worktreeId: "worktree-1" });
    await vi.advanceTimersByTimeAsync(PULL_STALL_WARNING_MS);
    expect(logMain).toHaveBeenCalledWith(
      "warn",
      "remote",
      expect.stringContaining(
        "pull still waiting /repos/project during fetching"
      )
    );
    await vi.advanceTimersByTimeAsync(
      PULL_STALL_TIMEOUT_MS - PULL_STALL_WARNING_MS
    );

    await expect(pull).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "remote",
        code: "pull_stalled",
        message: expect.stringContaining("during fetching after 15m 0s")
      }
    });
    expect(logMain).toHaveBeenCalledWith(
      "error",
      "remote",
      expect.stringContaining(
        "pull timeout /repos/project during fetching after 15m 0s"
      )
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds recovery with a fresh watchdog after the primary merge times out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(async () => undefined),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    vi.mocked(pullFastForward).mockImplementationOnce(
      (_git, _path, onProgress, control) =>
        new Promise((resolve) => {
          onProgress?.("fast_forward");
          control?.signal?.addEventListener(
            "abort",
            () => {
              const recovery = control.startRecovery?.();
              recovery?.signal?.addEventListener(
                "abort",
                () => {
                  recovery.finish?.(false);
                  resolve(err(recovery.signal?.reason as PwrGitError));
                },
                { once: true }
              );
            },
            { once: true }
          );
        })
    );
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue());

    const pull = bus.dispatch("remote:pull", { worktreeId: "worktree-1" });
    await vi.advanceTimersByTimeAsync(PULL_STALL_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(PULL_RECOVERY_STALL_TIMEOUT_MS);

    await expect(pull).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "remote",
        code: "pull_stalled",
        message: expect.stringContaining("during rollback/recovery after 5m 0s")
      }
    });
    expect(logMain).toHaveBeenCalledWith(
      "info",
      "remote",
      expect.stringContaining("pull phase rollback/recovery /repos/project")
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops waiting for a hung finishing refresh and returns pull success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(() => new Promise<void>(() => undefined)),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue());

    const pull = bus.dispatch("remote:pull", { worktreeId: "worktree-1" });
    await vi.advanceTimersByTimeAsync(PULL_REFRESH_WAIT_LIMIT_MS);

    await expect(pull).resolves.toMatchObject({ ok: true });
    expect(logMain).toHaveBeenCalledWith(
      "warn",
      "remote",
      expect.stringContaining(
        "pull refresh still running for /repos/project after 2m 0s"
      )
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns immediately with typed auth guidance and sanitized Git detail", async () => {
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(async () => undefined),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    vi.mocked(pullFastForward).mockImplementationOnce(
      async (_git, _path, onProgress) => {
        onProgress?.("fetch");
        return err({
          kind: "git",
          code: "exit_128",
          message:
            "fatal: Authentication failed for 'https://harold:secret@example.com/repo?token=abc123'\nterminal prompts disabled"
        });
      }
    );
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue());

    const result = await bus.dispatch("remote:pull", {
      worktreeId: "worktree-1"
    });

    expect(result).toEqual(
      err({
        kind: "remote",
        code: "authentication_required",
        message:
          "Pull needs authentication during fetching after 0s. Configure a credential manager, authenticated remote, or SSH key, then retry. PwrGit does not open terminal credential prompts. See Logs for details."
      })
    );
    const failureLog = vi
      .mocked(logMain)
      .mock.calls.find((call) => String(call[2]).startsWith("pull failed"));
    expect(failureLog?.[2]).toContain(
      "https://[redacted]@example.com/repo?token=[redacted]"
    );
    expect(failureLog?.[2]).toContain("terminal prompts disabled");
    expect(failureLog?.[2]).not.toContain("secret");
    expect(failureLog?.[2]).not.toContain("abc123");
  });

  it("classifies Git LFS smudge authentication as SSH-recoverable pull auth", async () => {
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(async () => undefined),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    vi.mocked(pullFastForward).mockImplementationOnce(
      async (_git, _path, onProgress) => {
        onProgress?.("fast_forward");
        return err({
          kind: "git",
          code: "exit_128",
          message: [
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
            "Error downloading object: screenshot.png: Smudge error: batch response: Git credentials for https://github.com/pwrdrvr/PwrAgent.git not found.",
            "error: external filter 'git-lfs filter-process' failed",
            "fatal: screenshot.png: smudge filter lfs failed"
          ].join("\n")
        });
      }
    );
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue());

    await expect(
      bus.dispatch("remote:pull", { worktreeId: "worktree-1" })
    ).resolves.toEqual(
      err({
        kind: "remote",
        code: "authentication_required",
        message:
          "Pull needs authentication during fast-forward/checkout after 0s. Configure a credential manager, authenticated remote, or SSH key, then retry. PwrGit does not open terminal credential prompts. See Logs for details."
      })
    );
  });

  it("streams pull phases and waits for the finishing refresh", async () => {
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    let finishRefresh: (() => void) | undefined;
    const refreshWorktree = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        })
    );
    const refresher = {
      refreshWorktree,
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    vi.mocked(pullFastForward).mockImplementationOnce(
      async (_git, _path, onProgress) => {
        onProgress?.("fetch");
        onProgress?.("prepare");
        onProgress?.("fast_forward");
        onProgress?.("reapply");
        return ok({
          fastForwarded: true,
          stashed: true,
          reappliedWithConflicts: false
        });
      }
    );
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue());

    const pull = bus.dispatch("remote:pull", { worktreeId: "worktree-1" });
    await vi.waitFor(() => expect(refreshWorktree).toHaveBeenCalledOnce());

    // Phases reach the renderer as live activity, not as a separate channel:
    // the queued wait, the phase, and the Git output are one record.
    expect(phasesFrom(vi.mocked(emitEvent), "worktree-1")).toEqual([
      "queued",
      "fetch",
      "prepare",
      "fast_forward",
      "reapply",
      "refresh"
    ]);

    let settled = false;
    void pull.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishRefresh?.();
    await expect(pull).resolves.toEqual(
      ok({
        fastForwarded: true,
        stashed: true,
        reappliedWithConflicts: false
      })
    );
  });

  it("preserves a successful pull when the finishing refresh fails", async () => {
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    const refreshFailure = new Error("database unavailable");
    const refresher = {
      refreshWorktree: vi.fn(async () => Promise.reject(refreshFailure)),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue());

    await expect(
      bus.dispatch("remote:pull", { worktreeId: "worktree-1" })
    ).resolves.toEqual(
      ok({
        fastForwarded: true,
        stashed: false,
        reappliedWithConflicts: false
      })
    );
    expect(refresher.refreshWorktree).toHaveBeenCalledExactlyOnceWith(
      "worktree-1"
    );
    expect(logMain).toHaveBeenCalledWith(
      "warn",
      "remote",
      "pull refresh failed /repos/project during refreshing/finish after 0.0s: database unavailable"
    );
  });

  it("refreshes repo worktree state after repo-scoped ref operations", async () => {
    const db = {
      prepare: vi.fn(() => ({ get: vi.fn(() => ({ path: "/repos/project" })) }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(async () => undefined),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue());

    const fetched = await bus.dispatch("remote:fetchRepo", {
      repoId: "repo-1",
      remote: "origin"
    });
    expect(fetched.ok).toBe(true);
    expect(refresher.refreshRepoWorktrees).toHaveBeenLastCalledWith("repo-1");

    const planned = await bus.dispatch("remote:planPushRefs", {
      repoId: "repo-1",
      sourceRef: "refs/heads/main",
      destinations: [{ remote: "origin", branch: "main" }]
    });
    expect(planned.ok).toBe(true);
    expect(refresher.refreshRepoWorktrees).toHaveBeenCalledTimes(2);

    const pushed = await bus.dispatch("remote:pushRefs", {
      repoId: "repo-1",
      plans: []
    });
    expect(pushed.ok).toBe(true);
    expect(refresher.refreshRepoWorktrees).toHaveBeenCalledTimes(3);
  });

  it("serializes worktree and repo fetches that update the same repository refs", async () => {
    let finishWorktreeFetch!: () => void;
    const worktreeFetch = new Promise<void>((resolve) => {
      finishWorktreeFetch = resolve;
    });
    const started: string[] = [];
    vi.mocked(fetchRemote).mockImplementationOnce(async () => {
      started.push("worktree");
      await worktreeFetch;
      return ok(undefined);
    });
    vi.mocked(fetchNamedRemote).mockImplementationOnce(async () => {
      started.push("repo");
      return ok(undefined);
    });
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(async () => undefined),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue());

    const fromWorktree = bus.dispatch("remote:fetch", {
      worktreeId: "worktree-1"
    });
    const fromRepo = bus.dispatch("remote:fetchRepo", {
      repoId: "repo-1",
      remote: "origin"
    });

    await Promise.resolve();
    expect(started).toEqual(["worktree"]);

    finishWorktreeFetch();
    await expect(Promise.all([fromWorktree, fromRepo])).resolves.toEqual([
      ok(null),
      ok(null)
    ]);
    expect(started).toEqual(["worktree", "repo"]);
  });

  it("keeps remote-branch replacement inside the repository fetch lock", async () => {
    let finishFirstRefresh!: () => void;
    const firstRefresh = new Promise<void>((resolve) => {
      finishFirstRefresh = resolve;
    });
    let signalFirstRefresh!: () => void;
    const firstRefreshStarted = new Promise<void>((resolve) => {
      signalFirstRefresh = resolve;
    });
    const started: string[] = [];
    vi.mocked(fetchRemote).mockImplementationOnce(async () => {
      started.push("worktree-fetch");
      return ok(undefined);
    });
    vi.mocked(fetchNamedRemote).mockImplementationOnce(async () => {
      started.push("repo-fetch");
      return ok(undefined);
    });
    let refreshCount = 0;
    const indexer = {
      refreshRepoRemoteBranches: vi.fn(async () => {
        refreshCount += 1;
        started.push(`refresh-${refreshCount}`);
        if (refreshCount === 1) {
          signalFirstRefresh();
          await firstRefresh;
        }
        return ok(undefined);
      })
    } as unknown as RepoIndexer;
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(async () => undefined),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    const bus = new CommandBus();
    registerRemoteHandlers(
      bus,
      db,
      refresher,
      new WorktreeOperationQueue(),
      indexer
    );

    const fromWorktree = bus.dispatch("remote:fetch", {
      worktreeId: "worktree-1"
    });
    const fromRepo = bus.dispatch("remote:fetchRepo", {
      repoId: "repo-1",
      remote: "origin"
    });

    await firstRefreshStarted;
    expect(started).toEqual(["worktree-fetch", "refresh-1"]);

    finishFirstRefresh();
    await expect(Promise.all([fromWorktree, fromRepo])).resolves.toEqual([
      ok(null),
      ok(null)
    ]);
    expect(started).toEqual([
      "worktree-fetch",
      "refresh-1",
      "repo-fetch",
      "refresh-2"
    ]);
  });

  it("refreshes remote-branch search after fetching repository refs", async () => {
    const db = {
      prepare: vi.fn(() => ({ get: vi.fn(() => ({ path: "/repos/project" })) }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(async () => undefined),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    const indexer = {
      refreshRepoRemoteBranches: vi.fn(async () => ok(undefined))
    } as unknown as RepoIndexer;
    const bus = new CommandBus();
    registerRemoteHandlers(
      bus,
      db,
      refresher,
      new WorktreeOperationQueue(),
      indexer
    );

    await expect(
      bus.dispatch("remote:fetchRepo", { repoId: "repo-1", remote: "origin" })
    ).resolves.toMatchObject({ ok: true });

    expect(indexer.refreshRepoRemoteBranches).toHaveBeenCalledExactlyOnceWith(
      "repo-1"
    );

    vi.mocked(indexer.refreshRepoRemoteBranches).mockClear();
    await expect(
      bus.dispatch("remote:planPushRefs", {
        repoId: "repo-1",
        sourceRef: "refs/heads/main",
        destinations: [{ remote: "origin", branch: "main" }]
      })
    ).resolves.toMatchObject({ ok: true });
    expect(indexer.refreshRepoRemoteBranches).toHaveBeenCalledExactlyOnceWith(
      "repo-1"
    );
  });

  it("inspects without refreshing and refreshes every repo worktree once after reset", async () => {
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(async () => undefined),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue());

    const snapshot = {
      branch: "main",
      head: "1".repeat(40),
      remoteRef: "refs/remotes/upstream/release",
      remoteHead: "2".repeat(40)
    };
    const inspected = await bus.dispatch("remote:inspectReset", {
      worktreeId: "worktree-1",
      remoteRef: snapshot.remoteRef
    });
    expect(inspected.ok).toBe(true);
    expect(inspectRemoteReset).toHaveBeenCalledWith(
      expect.any(Function),
      "/repos/project",
      snapshot.remoteRef
    );
    expect(refresher.refreshWorktree).not.toHaveBeenCalled();
    expect(refresher.refreshRepoWorktrees).not.toHaveBeenCalled();

    const reset = await bus.dispatch("remote:resetToRemote", {
      worktreeId: "worktree-1",
      mode: "hard",
      ...snapshot
    });
    expect(reset.ok).toBe(true);
    expect(resetToRemote).toHaveBeenCalledWith(
      expect.any(Function),
      "/repos/project",
      expect.objectContaining({ mode: "hard", ...snapshot }),
      "hard"
    );
    expect(refresher.refreshWorktree).not.toHaveBeenCalled();
    expect(refresher.refreshRepoWorktrees).toHaveBeenCalledOnce();
    expect(refresher.refreshRepoWorktrees).toHaveBeenCalledWith("repo-1");

    vi.mocked(resetToRemote).mockResolvedValueOnce(
      err({
        kind: "remote",
        code: "reset_failed",
        message: "reset stopped after changing checkout state"
      })
    );
    refresher.refreshRepoWorktrees.mockClear();
    const failed = await bus.dispatch("remote:resetToRemote", {
      worktreeId: "worktree-1",
      mode: "hard",
      ...snapshot
    });
    expect(failed.ok).toBe(false);
    expect(refresher.refreshWorktree).not.toHaveBeenCalled();
    expect(refresher.refreshRepoWorktrees).toHaveBeenCalledOnce();
    expect(refresher.refreshRepoWorktrees).toHaveBeenCalledWith("repo-1");
  });

  it("inspects, tests, and explicitly applies an SSH remote recovery", async () => {
    const recovery: SshRemoteRecovery = {
      remote: "origin",
      httpsUrl: "https://github.com/pwrdrvr/PwrAgent.git",
      sshUrl: "git@github.com:pwrdrvr/PwrAgent.git",
      pushUrlWillAlsoChange: true
    };
    vi.mocked(inspectSshRemoteRecovery).mockResolvedValueOnce(ok(recovery));
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ path: "/repos/project", repoId: "repo-1" }))
      }))
    } as unknown as DB;
    const refresher = {
      refreshWorktree: vi.fn(async () => undefined),
      refreshRepoWorktrees: vi.fn()
    } satisfies WorktreeRefresher;
    const bus = new CommandBus();
    registerRemoteHandlers(bus, db, refresher, new WorktreeOperationQueue());

    await expect(
      bus.dispatch("remote:inspectSshRecovery", { worktreeId: "worktree-1" })
    ).resolves.toEqual(ok(recovery));
    await expect(
      bus.dispatch("remote:testSshRecovery", {
        worktreeId: "worktree-1",
        recovery
      })
    ).resolves.toEqual(ok(null));
    expect(testSshRemoteRecovery).toHaveBeenCalledWith(
      expect.any(Function),
      "/repos/project",
      recovery
    );
    expect(refresher.refreshRepoWorktrees).not.toHaveBeenCalled();

    await expect(
      bus.dispatch("remote:applySshRecovery", {
        worktreeId: "worktree-1",
        recovery
      })
    ).resolves.toEqual(ok(null));
    expect(applySshRemoteRecovery).toHaveBeenCalledWith(
      expect.any(Function),
      "/repos/project",
      recovery
    );
    expect(refresher.refreshRepoWorktrees).toHaveBeenCalledOnce();
    expect(refresher.refreshRepoWorktrees).toHaveBeenCalledWith("repo-1");
  });
});
