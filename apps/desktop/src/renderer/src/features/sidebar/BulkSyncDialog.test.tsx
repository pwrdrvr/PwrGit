// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BulkSyncProgress,
  BulkSyncRepoResult,
  BulkSyncSummary,
  Repo
} from "@pwrgit/shared";

const { dispatch, subscribe } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn()
}));
vi.mock("../../lib/pwrgit", () => ({ dispatch, subscribe }));

import { BulkSyncDialog } from "./BulkSyncDialog";

const repos: Repo[] = [
  {
    id: "repo-safe",
    name: "safe",
    path: "/repos/safe",
    profileId: "profile-1",
    pinned: false,
    worktrees: []
  },
  {
    id: "repo-partial",
    name: "partial",
    path: "/repos/partial",
    profileId: "profile-1",
    pinned: false,
    worktrees: []
  }
];

function counts(results: BulkSyncRepoResult[]): BulkSyncSummary["counts"] {
  return {
    repos: {
      success: results.filter((repo) => repo.outcome === "success").length,
      partial: results.filter((repo) => repo.outcome === "partial").length,
      skipped: 0,
      failed: 0,
      cancelled: 0
    },
    remotes: { fetched: 2, skipped: 0, failed: 0, cancelled: 0 },
    worktrees: {
      updated: 1,
      upToDate: 0,
      skipped: 1,
      failed: 0,
      cancelled: 0
    }
  };
}

function summary(results: BulkSyncRepoResult[]): BulkSyncSummary {
  return {
    operationId: "operation-1",
    mode: "soft-pull",
    cancelled: false,
    startedAt: "2026-08-23T12:00:00.000Z",
    finishedAt: "2026-08-23T12:00:01.000Z",
    counts: counts(results),
    results
  };
}

const safeResult: BulkSyncRepoResult = {
  repoId: "repo-safe",
  name: "safe",
  path: "/repos/safe",
  outcome: "success",
  remotes: [{ remote: "origin", outcome: "fetched" }],
  worktrees: [
    {
      worktreeId: "wt-safe",
      branch: "main",
      path: "/repos/safe",
      outcome: "updated",
      beforeHead: "a",
      afterHead: "b"
    }
  ]
};

const partialResult: BulkSyncRepoResult = {
  repoId: "repo-partial",
  name: "partial",
  path: "/repos/partial",
  outcome: "partial",
  remotes: [{ remote: "origin", outcome: "fetched" }],
  worktrees: [
    {
      worktreeId: "wt-dirty",
      branch: "feature/local-work",
      path: "/repos/partial",
      outcome: "skipped",
      reason: "dirty",
      message: "The worktree has uncommitted or untracked changes."
    }
  ]
};

const failedResult: BulkSyncRepoResult = {
  repoId: "repo-safe",
  name: "safe",
  path: "/repos/safe",
  outcome: "failed",
  message: "Git could not fetch this repository.",
  remotes: [
    {
      remote: "origin",
      outcome: "failed",
      message: "The remote did not respond."
    }
  ],
  worktrees: []
};

let container: HTMLDivElement;
let root: Root;
let progressHandler: ((event: BulkSyncProgress) => void) | undefined;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  progressHandler = undefined;
  subscribe.mockImplementation(
    (_channel: string, handler: (event: BulkSyncProgress) => void) => {
      progressHandler = handler;
      return vi.fn();
    }
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  dispatch.mockReset();
  subscribe.mockReset();
});

describe("BulkSyncDialog", () => {
  it("shows native Windows paths while keeping Git paths in the results", async () => {
    const bulk = deferred<{ ok: true; value: BulkSyncSummary }>();
    dispatch.mockReturnValue(bulk.promise);
    const windowsRepo = { ...repos[0]!, path: "C:/PwrLab/repos/PwrGit" };
    await act(async () => {
      root.render(
        <BulkSyncDialog
          profileId="profile-1"
          repos={[windowsRepo]}
          mode="soft-pull"
          platform="win32"
          onClose={vi.fn()}
        />
      );
    });

    const operationId = dispatch.mock.calls[0]?.[1].operationId as string;
    await act(async () => {
      progressHandler?.({
        operationId,
        mode: "soft-pull",
        phase: "repo_started",
        totalRepos: 1,
        completedRepos: 0,
        repoId: windowsRepo.id,
        repoName: windowsRepo.name
      });
    });
    expect(
      container.querySelector(".bulk-sync__status-copy")?.textContent
    ).toContain("C:\\PwrLab\\repos\\PwrGit");
    expect(container.querySelector(".bulk-sync__repo small")?.textContent).toBe(
      "C:\\PwrLab\\repos\\PwrGit"
    );

    await act(async () => {
      bulk.resolve({
        ok: true,
        value: summary([{ ...safeResult, path: windowsRepo.path }])
      });
      await bulk.promise;
    });
    expect(container.querySelector(".bulk-sync__repo small")?.textContent).toBe(
      "C:\\PwrLab\\repos\\PwrGit"
    );
  });

  it("starts only one Git operation through the app's StrictMode mount cycle", async () => {
    const empty = summary([]);
    dispatch.mockResolvedValue({ ok: true, value: empty });
    await act(async () => {
      root.render(
        <StrictMode>
          <BulkSyncDialog
            profileId="profile-1"
            repos={[]}
            mode="fetch"
            platform="darwin"
            onClose={vi.fn()}
          />
        </StrictMode>
      );
    });

    expect(
      dispatch.mock.calls.filter(([command]) => command === "remote:bulkSync")
    ).toHaveLength(1);
    expect(
      dispatch.mock.calls.filter(
        ([command]) => command === "remote:cancelBulkSync"
      )
    ).toHaveLength(0);
  });

  it("streams per-repository progress and explains conservative skips", async () => {
    const bulk = deferred<{ ok: true; value: BulkSyncSummary }>();
    dispatch.mockImplementation((command: string) =>
      command === "remote:bulkSync"
        ? bulk.promise
        : Promise.resolve({ ok: true, value: { cancelled: true } })
    );
    await act(async () => {
      root.render(
        <BulkSyncDialog
          profileId="profile-1"
          repos={repos}
          mode="soft-pull"
          platform="darwin"
          onClose={vi.fn()}
        />
      );
    });

    expect(container.textContent).toContain("Try to pull all safely");
    expect(container.textContent).toContain("never stashes");
    expect(dispatch).toHaveBeenCalledWith(
      "remote:bulkSync",
      expect.objectContaining({ profileId: "profile-1", mode: "soft-pull" })
    );
    const operationId = dispatch.mock.calls[0]?.[1].operationId as string;
    await act(async () => {
      progressHandler?.({
        operationId,
        mode: "soft-pull",
        phase: "repo_started",
        totalRepos: 2,
        completedRepos: 0,
        repoId: "repo-safe",
        repoName: "safe"
      });
    });
    const status = container.querySelector(".bulk-sync__status");
    expect(status?.classList).toContain("is-live");
    expect(status?.textContent).toContain("Checking safe");
    expect(status?.textContent).toContain("/repos/safe");
    expect(status?.textContent).toContain("0 of 2 repositories");
    expect(status?.textContent).toContain("1 in flight · 1 queued");
    expect(status?.hasAttribute("aria-busy")).toBe(false);
    expect(
      status?.querySelector(".bulk-sync__status-copy > span")?.classList
    ).toContain("selectable");
    expect(container.querySelector(".bulk-sync__repos")?.contains(status)).toBe(
      false
    );
    // The live region is the words; a clock inside an atomic region would be
    // re-announced every second.
    const live = status?.querySelector('[role="status"]');
    expect(live?.getAttribute("aria-atomic")).toBe("true");
    expect(live?.textContent).toContain("Checking safe");
    expect(live?.querySelector(".bulk-sync__time")).toBeNull();
    expect(status?.querySelector(".bulk-sync__time")?.textContent).toContain(
      "elapsed"
    );
    const bar = status?.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuemax")).toBe("2");
    expect(bar?.getAttribute("aria-valuenow")).toBe("0");
    expect(bar?.querySelector(".is-in-flight")?.classList).not.toContain(
      "is-empty"
    );
    expect(bar?.querySelector(".is-success")?.classList).toContain("is-empty");
    expect(
      container.querySelector(".bulk-sync__repo-status.is-running")?.textContent
    ).toBe("Checking…");

    const update: BulkSyncProgress = {
      operationId,
      mode: "soft-pull",
      phase: "repo_progress",
      totalRepos: 2,
      completedRepos: 0,
      repoId: "repo-safe",
      totalWorktrees: 40,
      detail: "feature/next: Checking for uncommitted changes…",
      worktreePath: "/repos/safe-next"
    };
    await act(async () => {
      progressHandler?.({ ...update, remoteResult: safeResult.remotes[0]! });
      progressHandler?.({ ...update, worktreeResult: safeResult.worktrees[0]! });
      // Duplicate deliveries do not inflate the count, and another window's
      // operation must not replace this repository's current step.
      progressHandler?.({ ...update, worktreeResult: safeResult.worktrees[0]! });
      progressHandler?.({ ...update, operationId: "elsewhere", detail: "Wrong operation" });
    });
    const runningRepo = container.querySelector(".bulk-sync__repo.is-running");
    expect(runningRepo?.textContent).toContain(update.detail);
    expect(runningRepo?.textContent).toContain("/repos/safe-next");
    expect(runningRepo?.textContent).toContain("1 of 40 worktrees checked");
    expect(runningRepo?.textContent).toContain("Completed tasks (2)");
    expect(runningRepo?.textContent).toContain("origin: fetched");
    expect(runningRepo?.textContent).toContain("main: fast-forwarded");
    expect(container.textContent).not.toContain("Wrong operation");
    expect(status?.textContent).toContain("0 of 2 repositories");

    await act(async () => {
      progressHandler?.({
        operationId,
        mode: "soft-pull",
        phase: "repo_completed",
        totalRepos: 2,
        completedRepos: 1,
        repoId: "repo-safe",
        repoName: "safe",
        result: safeResult
      });
    });
    expect(container.textContent).toContain("1 / 2");
    expect(container.textContent).toContain("1 updated");
    expect(container.textContent).toContain("1 of 2 repositories");
    expect(container.textContent).toContain("0 in flight · 1 queued");
    expect(
      container.querySelector(".bulk-sync__legend-item.is-success")?.textContent
    ).toBe("1 success");
    expect(
      container
        .querySelector('.bulk-sync__bar[role="progressbar"]')
        ?.getAttribute("aria-valuetext")
    ).toBe("1 of 2 repositories finished");
    expect(
      container.querySelector(".bulk-sync__repo-status.is-success")?.textContent
    ).toBe("success");

    await act(async () => {
      bulk.resolve({ ok: true, value: summary([safeResult, partialResult]) });
      await bulk.promise;
    });
    expect(container.textContent).toContain("1 safely skipped");
    expect(container.textContent).toContain("feature/local-work");
    expect(container.textContent).toContain("uncommitted changes");
    expect(container.querySelector(".bulk-sync__repo.is-partial")).not.toBeNull();
    // The same card is now the receipt: the bar stays, the live parts go.
    const receipt = container.querySelector(".bulk-sync__status");
    expect(receipt?.classList).not.toContain("is-live");
    expect(receipt?.querySelector("strong")?.textContent).toBe("Finished");
    expect(receipt?.querySelector(".bulk-sync__spinner")).toBeNull();
    expect(receipt?.querySelector(".bulk-sync__mark.is-ok")).not.toBeNull();
    expect(receipt?.querySelector(".bulk-sync__time")?.textContent).toBe(
      "took 1s"
    );
    expect(
      receipt?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")
    ).toBe("2");
    expect(receipt?.textContent).toContain("2 repositories");
    expect(receipt?.textContent).not.toContain("in flight");
    expect(
      container.querySelector(".bulk-sync__repo-status.is-partial")?.textContent
    ).toBe("partial");
  });

  it("requests cooperative cancellation and keeps results visible until close", async () => {
    const bulk = deferred<{ ok: true; value: BulkSyncSummary }>();
    dispatch.mockImplementation((command: string) =>
      command === "remote:bulkSync"
        ? bulk.promise
        : Promise.resolve({ ok: true, value: { cancelled: true } })
    );
    await act(async () => {
      root.render(
        <BulkSyncDialog
          profileId="profile-1"
          repos={repos}
          mode="fetch"
          platform="darwin"
          onClose={vi.fn()}
        />
      );
    });
    const cancel = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel"
    );
    expect(cancel).toBeDefined();
    expect(document.activeElement).toBe(cancel);
    await act(async () => cancel!.click());

    expect(dispatch).toHaveBeenCalledWith(
      "remote:cancelBulkSync",
      expect.objectContaining({ operationId: expect.any(String) })
    );
    expect(container.textContent).toContain("Cancelling…");
    const status = container.querySelector(".bulk-sync__status");
    expect(status?.textContent).toContain(
      "Cancelling after the current Git command…"
    );
    expect(status?.textContent).toContain("0 stopping · 2 won't start");
    // Nothing is left to estimate once the run is winding down.
    expect(status?.querySelector(".bulk-sync__time")?.textContent).not.toContain(
      "left"
    );
  });

  it("offers an estimate once three repositories and five seconds are in", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval"],
      now: new Date("2026-09-25T12:00:00.000Z")
    });
    try {
      const four: Repo[] = ["a", "b", "c", "d"].map((name) => ({
        ...repos[0]!,
        id: `repo-${name}`,
        name,
        path: `/repos/${name}`
      }));
      dispatch.mockImplementation((command: string) =>
        command === "remote:bulkSync"
          ? new Promise(() => {})
          : Promise.resolve({ ok: true, value: { cancelled: true } })
      );
      await act(async () => {
        root.render(
          <BulkSyncDialog
            profileId="profile-1"
            repos={four}
            mode="soft-pull"
            platform="darwin"
            onClose={vi.fn()}
          />
        );
      });
      const operationId = dispatch.mock.calls[0]?.[1].operationId as string;
      const time = () =>
        container.querySelector(".bulk-sync__time")?.textContent ?? "";

      await act(async () => {
        for (const [index, repo] of four.slice(0, 2).entries()) {
          progressHandler?.({
            operationId,
            mode: "soft-pull",
            phase: "repo_completed",
            totalRepos: 4,
            completedRepos: index + 1,
            repoId: repo.id,
            repoName: repo.name,
            result: { ...safeResult, repoId: repo.id, name: repo.name }
          });
        }
        vi.advanceTimersByTime(6_000);
      });
      // Two finished is not enough evidence, however long it has taken.
      expect(time()).toBe("6s elapsed");

      await act(async () => {
        progressHandler?.({
          operationId,
          mode: "soft-pull",
          phase: "repo_completed",
          totalRepos: 4,
          completedRepos: 3,
          repoId: "repo-c",
          repoName: "c",
          result: { ...safeResult, repoId: "repo-c", name: "c" }
        });
        vi.advanceTimersByTime(1_000);
      });
      // 3 finished in 7s leaves one more at the same rate: ~2.3s.
      expect(time()).toBe("7s elapsed · a few seconds left");

      const cancel = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel"
      );
      await act(async () => cancel!.click());
      expect(time()).toBe("7s elapsed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a cancelled run with the undone repositories in the bar", async () => {
    const cancelledResult: BulkSyncRepoResult = {
      ...partialResult,
      outcome: "cancelled",
      remotes: [],
      worktrees: []
    };
    dispatch.mockResolvedValue({
      ok: true,
      value: {
        ...summary([safeResult, cancelledResult]),
        cancelled: true
      }
    });
    await act(async () => {
      root.render(
        <BulkSyncDialog
          profileId="profile-1"
          repos={repos}
          mode="soft-pull"
          platform="darwin"
          onClose={vi.fn()}
        />
      );
    });

    const status = container.querySelector(".bulk-sync__status");
    expect(status?.querySelector("strong")?.textContent).toBe("Cancelled");
    expect(status?.querySelector(".bulk-sync__mark.is-cancelled")).not.toBeNull();
    expect(
      status?.querySelector(".bulk-sync__legend-item.is-cancelled")?.textContent
    ).toBe("1 cancelled");
    const bar = status?.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe("2");
    expect(bar?.getAttribute("aria-valuetext")).toBe(
      "2 of 2 repositories finished, 1 cancelled"
    );
    expect(
      (bar?.querySelector(".is-cancelled") as HTMLElement | null)?.style.flexGrow
    ).toBe("1");
  });

  it("marks a finished fetch with a broken remote as failed", async () => {
    // Fetch reports a broken remote inside a `partial` repository, so the
    // repository outcomes alone would draw a green mark beside "1 failed".
    const brokenRemote: BulkSyncRepoResult = {
      ...partialResult,
      remotes: [
        { remote: "origin", outcome: "fetched" },
        { remote: "broken", outcome: "failed", message: "No such remote." }
      ],
      worktrees: []
    };
    const fetchSummary = summary([brokenRemote]);
    dispatch.mockResolvedValue({
      ok: true,
      value: {
        ...fetchSummary,
        mode: "fetch",
        counts: {
          ...fetchSummary.counts,
          remotes: { fetched: 1, skipped: 0, failed: 1, cancelled: 0 }
        }
      }
    });
    await act(async () => {
      root.render(
        <BulkSyncDialog
          profileId="profile-1"
          repos={[repos[1]!]}
          mode="fetch"
          platform="darwin"
          onClose={vi.fn()}
        />
      );
    });

    const status = container.querySelector(".bulk-sync__status");
    expect(status?.textContent).toContain("1 remote fetched · 1 failed");
    expect(status?.querySelector(".bulk-sync__mark.is-failed")).not.toBeNull();
    expect(
      status?.querySelector(".bulk-sync__legend-item.is-partial")?.textContent
    ).toBe("1 partial");
  });

  it("keeps terminal failures distinct while another repository is active", async () => {
    const bulk = deferred<{ ok: true; value: BulkSyncSummary }>();
    dispatch.mockImplementation((command: string) =>
      command === "remote:bulkSync"
        ? bulk.promise
        : Promise.resolve({ ok: true, value: { cancelled: true } })
    );
    await act(async () => {
      root.render(
        <BulkSyncDialog
          profileId="profile-1"
          repos={repos}
          mode="fetch"
          platform="darwin"
          onClose={vi.fn()}
        />
      );
    });
    const operationId = dispatch.mock.calls[0]?.[1].operationId as string;

    await act(async () => {
      progressHandler?.({
        operationId,
        mode: "fetch",
        phase: "repo_completed",
        totalRepos: 2,
        completedRepos: 1,
        repoId: "repo-safe",
        repoName: "safe",
        result: failedResult
      });
      progressHandler?.({
        operationId,
        mode: "fetch",
        phase: "repo_started",
        totalRepos: 2,
        completedRepos: 1,
        repoId: "repo-partial",
        repoName: "partial"
      });
    });

    expect(container.querySelector(".bulk-sync__status")?.textContent).toContain(
      "Fetching partial"
    );
    expect(container.textContent).toContain("1 of 2 repositories");
    expect(container.textContent).toContain("1 in flight · 0 queued");
    expect(
      container.querySelector(".bulk-sync__legend-item.is-failed")?.textContent
    ).toBe("1 failed");
    expect(
      container
        .querySelector('.bulk-sync__bar[role="progressbar"]')
        ?.getAttribute("aria-valuetext")
    ).toBe("1 of 2 repositories finished, 1 failed");
    expect(
      container.querySelector(".bulk-sync__repo-status.is-failed")?.textContent
    ).toBe("failed");
    expect(
      container.querySelector(".bulk-sync__repo-status.is-running")?.textContent
    ).toBe("Fetching…");
  });
});
