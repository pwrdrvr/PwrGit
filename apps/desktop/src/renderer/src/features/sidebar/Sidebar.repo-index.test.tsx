// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, Repo, Worktree } from "@pwrgit/shared";
import { Sidebar } from "./Sidebar";

const PROFILE = {
  id: "p1",
  name: "Demo",
  email: "demo@example.com",
  mono: "D",
  roots: ["/code"],
  onboardingCompleted: true,
  showInMenu: true
} as Profile;

function worktree(repoId: string, i: number): Worktree {
  return {
    id: `${repoId}:wt${i}`,
    repoId,
    branch: i === 0 ? "main" : `feat/${i}`,
    path: `/code/${repoId}${i === 0 ? "" : `-wt${i}`}`,
    dirty: 0,
    ahead: 0,
    behind: 0,
    behindDefault: 0,
    defaultBranch: "main",
    mergedIntoDefault: false,
    divergedFromDefault: false,
    isDefaultBranch: i === 0,
    pinned: false,
    isPrimary: i === 0
  } as Worktree;
}

const REPOS: Repo[] = ["atlas", "beacon", "cinder"].map(
  (name) =>
    ({
      id: name,
      name,
      path: `/code/${name}`,
      profileId: "p1",
      pinned: false,
      worktrees: [worktree(name, 0), worktree(name, 1)]
    }) as Repo
);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.setItem("pwrgit.lens", "All");
  (window as unknown as { pwrgit: unknown }).pwrgit = {
    profileId: "p1",
    platform: "darwin",
    appearance: { theme: "light", resolvedTheme: "light" },
    // Nothing answers: the index needs no reply, and a reply landing after
    // the test's act() would be an unowned update.
    dispatch: () => new Promise(() => undefined),
    on: () => () => undefined
  };
  // jsdom does no layout: give the sidebar room for the index past its floor,
  // and the probe the width of the index's shortest truncation.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const width = this.matches('[data-testid="sidebar"]')
        ? 400
        : this.matches(".repo-index__probe")
          ? 70
          : 0;
      return { top: 0, bottom: 0, left: 0, right: width, width, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    }
  );
  // jsdom has no scrollIntoView; the selection reveal calls it.
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function render(selected: string, onSelect: (repo: Repo, w: Worktree) => void): void {
  const noop = () => undefined;
  act(() => {
    root.render(
      <Sidebar
        profiles={[PROFILE]}
        activeProfile={PROFILE}
        profileLoadState={{ status: "ready" }}
        onRetryProfiles={noop}
        onSwitchProfile={noop}
        repos={REPOS}
        repoLoadState={{ status: "ready" }}
        onRetryRepos={noop}
        selectedWorktreeId={selected}
        onSelectWorktree={onSelect}
        onSetRepoPin={noop}
        onSetWorktreePin={noop}
        onSetBranchPin={noop}
        onRemoveWorktree={noop}
        onRemoveWorktrees={() => Promise.resolve({ removed: [], failed: [] } as never)}
        onCreateWorktree={() => Promise.resolve(null)}
        onPersistOrder={noop}
        onPersistRepoOrder={noop}
        refreshingRepoIds={new Set()}
        onRefreshRepo={noop}
        onRefreshPullRequest={noop}
        onCloneRepo={noop}
        onForkRepo={noop}
        onForkCheckout={noop}
        onAddFolder={noop}
        onExpandRepo={noop}
        onNewProfile={noop}
        onManageProfile={noop}
        platform="darwin"
      />
    );
  });
}

const indexItem = (name: string): HTMLButtonElement =>
  [...container.querySelectorAll<HTMLButtonElement>(".repo-index__item")].find(
    (b) => b.textContent === name
  )!;

describe("Sidebar's repository index", () => {
  it("is drawn beside the tree, outside it, when the sidebar has room", () => {
    render("atlas:wt0", () => undefined);
    const nav = container.querySelector('nav[aria-label="Repository index"]');
    expect(nav).not.toBeNull();
    expect(container.querySelector('[role="tree"]')!.contains(nav)).toBe(false);
  });

  it("selects a picked repository the way its row does, so only one reads as selected", () => {
    const onSelect = vi.fn();
    render("atlas:wt0", onSelect);
    expect(indexItem("atlas").className).toContain("is-selected");

    act(() => indexItem("cinder").click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![1].id).toBe("cinder:wt0");
    // And it opens, like the row.
    const row = container.querySelector('.repo-row[data-repo-id="cinder"]')!;
    expect(row.getAttribute("aria-expanded")).toBe("true");

    render("cinder:wt0", onSelect);
    expect(container.querySelectorAll(".repo-index__item.is-selected")).toHaveLength(1);
    expect(indexItem("cinder").className).toContain("is-selected");
  });

  it("keeps a selection that is already in the picked repository", () => {
    const onSelect = vi.fn();
    render("beacon:wt1", onSelect);
    act(() => indexItem("beacon").click());
    expect(onSelect).not.toHaveBeenCalled();
  });
});
