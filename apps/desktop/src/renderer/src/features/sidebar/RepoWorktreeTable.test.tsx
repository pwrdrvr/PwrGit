// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type RepoRefs, type Repo, type Worktree } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  dispatch: dispatchMock,
  subscribe: () => () => undefined
}));
vi.mock("../../lib/toast", () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));
vi.mock("../../lib/copyText", () => ({ copyText: vi.fn() }));

import { RepoRefsModal } from "./RepoRefsModal";
import {
  filterWorktrees,
  worktreeStatusCounts,
  worktreeStatusText
} from "./RepoWorktreeTable";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-10-05T12:00:00Z");

function wt(partial: Partial<Worktree> & { id: string; branch: string }): Worktree {
  return {
    repoId: "repo-1",
    path: `/repos/widget-${partial.id}`,
    dirty: 0,
    ahead: 0,
    behind: 0,
    behindDefault: 0,
    defaultBranch: "main",
    mergedIntoDefault: false,
    divergedFromDefault: false,
    isDefaultBranch: false,
    pinned: false,
    isPrimary: false,
    lastActivityAt: "2026-10-04T12:00:00Z",
    ...partial
  };
}

const merged = {
  number: 803,
  url: "https://example.test/pr/803",
  title: "feat: lightbox",
  state: "merged" as const,
  isDraft: false
};

const worktrees = [
  wt({ id: "primary", branch: "main", isPrimary: true, isDefaultBranch: true }),
  wt({ id: "live", branch: "feat/live", ahead: 2 }),
  wt({ id: "edits", branch: "fix/edits", dirty: 3, tracking: "upstream_missing" }),
  wt({ id: "landed", branch: "codex/lightbox", tracking: "upstream_missing", pr: merged }),
  wt({ id: "gone", branch: "chore/old", tracking: "upstream_missing" })
];
const linked = worktrees.filter((w) => !w.isPrimary);

describe("the Worktrees tab's buckets", () => {
  it("counts the same buckets the sidebar's cap draws", () => {
    expect(worktreeStatusCounts(linked, NOW)).toEqual({
      inFlight: 2,
      finished: 2,
      all: 4
    });
  });

  it("filters by bucket, then by branch, folder, or change request", () => {
    const ids = (status: "inFlight" | "finished" | "all", query = "") =>
      filterWorktrees(linked, status, query, NOW).map((w) => w.id);
    expect(ids("finished")).toEqual(["landed", "gone"]);
    expect(ids("inFlight")).toEqual(["live", "edits"]);
    expect(ids("all", "widget-gone")).toEqual(["gone"]);
    expect(ids("all", "803")).toEqual(["landed"]);
    expect(ids("finished", "feat/live")).toEqual([]);
  });

  // Changes on disk keep a gone branch in flight, and the cell says why.
  it("names what keeps a row in flight", () => {
    expect(worktreeStatusText(linked[1]!, NOW)).toEqual({ label: "●3", tone: "dirty" });
    expect(worktreeStatusText(linked[0]!, NOW)).toEqual({ label: "↑2", tone: "ahead" });
    expect(worktreeStatusText(linked[2]!, NOW).label).toBe("Finished");
  });
});

describe("RepoRefsModal on Worktrees", () => {
  const repo: Repo = {
    id: "repo-1",
    name: "widget",
    path: "/repos/widget",
    profileId: "profile-1",
    pinned: false,
    worktrees
  };
  const refs: RepoRefs = { branches: [], previewTags: [], tagCount: 0, remotes: [] };
  let container: HTMLDivElement;
  let root: Root;
  const onRevealWorktree = vi.fn();
  const onPruneWorktrees = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    dispatchMock.mockImplementation((channel: string) => {
      if (channel === "forge:hosts") return Promise.resolve(ok({ hosts: [], overrides: {} }));
      if (channel === "pr:openList") {
        return Promise.resolve(ok({ forge: null, fetchedAt: null, truncated: false, entries: [], remotes: [] }));
      }
      return Promise.resolve(ok({ rows: [], total: 0 }));
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.resetAllMocks();
  });

  async function open(): Promise<void> {
    await act(async () => {
      root.render(
        <RepoRefsModal
          repo={repo}
          refs={refs}
          focusedWorktree={null}
          now={NOW}
          initialTab="worktrees"
          initialWorktreeStatus="finished"
          onRefresh={() => undefined}
          onRevealWorktree={onRevealWorktree}
          onPruneWorktrees={onPruneWorktrees}
          onCreateWorktree={() => undefined}
          onClose={onClose}
        />
      );
    });
  }

  const text = (selector: string): string[] =>
    [...container.querySelectorAll(selector)].map((el) => el.textContent ?? "");
  const button = (label: string): HTMLButtonElement =>
    [...container.querySelectorAll("button")].find((el) =>
      el.textContent?.startsWith(label)
    )!;

  it("lands on Finished from the sidebar, with the bucket counts and Prune", async () => {
    await open();
    expect(text(".refs-tabs button")[0]).toBe("Worktrees 2");
    expect(text(".refs-status-chip")).toEqual(["In flight 2", "Finished 2", "All 4"]);
    expect(text(".refs-worktree-table .refs-copyable-name strong")).toEqual([
      "codex/lightbox",
      "chore/old"
    ]);
    // Push is a branch verb; this tab has no refs to push.
    expect(button("Push to remotes")).toBeUndefined();
    await act(async () => button("Prune worktrees").click());
    expect(onPruneWorktrees).toHaveBeenCalledOnce();
  });

  it("shows a worktree by selecting it in the sidebar, and closes", async () => {
    await open();
    await act(async () => button("All").click());
    expect(text(".refs-worktree-table .refs-copyable-name strong")).toHaveLength(4);
    // Prune belongs to the Finished view alone.
    expect(button("Prune worktrees")).toBeUndefined();
    const live = [...container.querySelectorAll(".refs-table__row")].find((row) =>
      row.textContent?.includes("feat/live")
    )!;
    await act(async () =>
      [...live.querySelectorAll("button")]
        .find((el) => el.textContent === "Show worktree")!
        .click()
    );
    expect(onRevealWorktree).toHaveBeenCalledWith("live");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
