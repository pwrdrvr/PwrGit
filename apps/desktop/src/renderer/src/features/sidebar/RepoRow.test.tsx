// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type Repo, type RepoRefs, type Worktree } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  dispatch: dispatchMock,
  subscribe: () => () => undefined
}));
vi.mock("../../lib/toast", () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn()
}));

import { RepoRow } from "./RepoRow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-10-05T12:00:00Z");
const OPEN_KEY = "pwrgit.unpinnedWorktreesOpen.repo-1";

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
    ...partial
  };
}

// Eight in flight, newest first, and three finished whose upstream is gone.
const worktrees = [
  wt({ id: "primary", branch: "main", isPrimary: true, isDefaultBranch: true }),
  ...Array.from({ length: 8 }, (_, i) =>
    wt({
      id: `live-${i}`,
      branch: `feat/live-${i}`,
      ahead: 1,
      lastActivityAt: new Date(NOW - (i + 1) * 60_000).toISOString()
    })
  ),
  ...Array.from({ length: 3 }, (_, i) =>
    wt({
      id: `done-${i}`,
      branch: `chore/done-${i}`,
      tracking: "upstream_missing",
      lastActivityAt: new Date(NOW - i * 1000).toISOString()
    })
  )
];
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

beforeEach(() => {
  dispatchMock.mockImplementation((channel: string) => {
    if (channel === "repo:refs") return Promise.resolve(ok(refs));
    if (channel === "forge:hosts") return Promise.resolve(ok({ hosts: [], overrides: {} }));
    if (channel === "pr:openList") {
      return Promise.resolve(ok({ forge: null, fetchedAt: null, truncated: false, entries: [], remotes: [] }));
    }
    return Promise.resolve(ok({ rows: [], total: 0 }));
  });
  Element.prototype.scrollIntoView = vi.fn();
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  vi.resetAllMocks();
});

async function render(selectedWorktreeId: string | null): Promise<void> {
  const noop = () => undefined;
  await act(async () => {
    root.render(
      <RepoRow
        repo={repo}
        expanded
        containsSelection={selectedWorktreeId !== null}
        selectedWorktreeId={selectedWorktreeId}
        selectedIds={new Set()}
        sort="recent"
        customOrder={undefined}
        now={NOW}
        focused={false}
        focusContext={{ selectedWorktreeId, visits: {} }}
        onToggleExpand={noop}
        onToggleRepoPin={noop}
        refreshing={false}
        onRefreshWorktrees={noop}
        onSelectWorktree={noop}
        onContextWorktree={noop}
        onToggleWorktreePin={noop}
        onToggleBranchPin={noop}
        onRemoveWorktree={noop}
        onRefreshPullRequest={noop}
        onRemoveSelected={noop}
        onClearSelected={noop}
        onCycleSort={noop}
        onReorder={noop}
        onNewWorktree={noop}
        onRevealWorktree={noop}
        onCreateWorktreeFromRef={noop}
        onForkRepo={noop}
        arrangeable={false}
        dragProps={{ draggable: false }}
        dragging={false}
        dropPosition={null}
        focusable
        onRowKeyDown={noop}
        onRowFocus={noop}
        isPostDragClick={() => false}
        posinset={1}
        setsize={1}
        platform="darwin"
      />
    );
  });
}

const branches = (selector: string): string[] =>
  [...container.querySelectorAll(`${selector} .wt-row__branch`)].map(
    (el) => el.textContent ?? ""
  );
const ghost = (): HTMLElement | null =>
  container.querySelector<HTMLElement>(".wt-row.is-ghost");

describe("RepoRow's Other worktrees past the cap", () => {
  it("draws six in-flight rows, then Finished and View all", async () => {
    window.localStorage.setItem(OPEN_KEY, "1");
    await render(null);
    expect(branches(".wt-section__body")).toEqual(
      Array.from({ length: 6 }, (_, i) => `feat/live-${i}`)
    );
    // The heading still counts everything it holds.
    expect(container.querySelector(".wt-section__toggle")?.textContent).toBe(
      "Worktrees11"
    );
    expect(container.querySelector(".wt-finished")?.textContent).toBe(
      "Finished3review…"
    );
    expect(container.querySelector(".wt-view-all")?.textContent).toBe(
      "View all 11 worktrees…"
    );
    expect(ghost()).toBeNull();
  });

  it("ghosts the row you are on below the six, tagged with its bucket", async () => {
    window.localStorage.setItem(OPEN_KEY, "1");
    await render("done-1");
    const row = ghost()!;
    expect(row.textContent).toContain("chore/done-1");
    expect(row.querySelector(".wt-tag--ghost")?.textContent).toBe("Finished");
    expect(row.previousElementSibling?.className).toBe("wt-ghost-sep");
    // In the arrow-key walk where it is drawn: primary, the six, then it.
    expect(row.getAttribute("aria-posinset")).toBe("8");
    expect(row.getAttribute("aria-setsize")).toBe("8");
    expect(row.getAttribute("draggable")).not.toBe("true");

    await render("live-7");
    expect(ghost()?.querySelector(".wt-tag--ghost")?.textContent).toBe("In flight");
    // A row inside the six is selected in place.
    await render("live-2");
    expect(ghost()).toBeNull();
  });

  it("keeps a closed disclosure closed, and ghosts above it", async () => {
    await render("live-3");
    const toggle = container.querySelector(".wt-section__toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".wt-section__body")).toBeNull();
    const row = ghost()!;
    expect(row.closest(".wt-section__elevated")).not.toBeNull();
    expect(row.querySelector(".wt-tag--ghost")?.textContent).toBe("↓ Other");
    expect(window.localStorage.getItem(OPEN_KEY)).toBe("0");
  });
});
