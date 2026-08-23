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

    await act(async () => {
      bulk.resolve({ ok: true, value: summary([safeResult, partialResult]) });
      await bulk.promise;
    });
    expect(container.textContent).toContain("1 safely skipped");
    expect(container.textContent).toContain("feature/local-work");
    expect(container.textContent).toContain("uncommitted changes");
    expect(container.querySelector(".bulk-sync__repo.is-partial")).not.toBeNull();
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
  });
});
