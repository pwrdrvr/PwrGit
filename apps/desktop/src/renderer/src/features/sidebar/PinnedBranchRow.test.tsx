// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LocalBranchSummary } from "@pwrgit/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PinnedBranchRow, pinnedBranchRowId } from "./PinnedBranchRow";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
let container: HTMLDivElement;
let root: Root;
const onOpen = vi.fn();
const onUnpin = vi.fn();
const onKeyDown = vi.fn();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <PinnedBranchRow
        branch="main"
        now={NOW}
        posinset={2}
        setsize={3}
        focusable
        onOpen={onOpen}
        onUnpin={onUnpin}
        onKeyDown={onKeyDown}
        onFocus={() => undefined}
      />
    )
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const row = (): HTMLElement =>
  container.querySelector<HTMLElement>('[role="treeitem"]')!;

describe("PinnedBranchRow", () => {
  it("is a level-2 treeitem in the repo's list, saying it has no worktree", () => {
    expect(row().getAttribute("aria-level")).toBe("2");
    expect(row().getAttribute("aria-posinset")).toBe("2");
    expect(row().getAttribute("aria-setsize")).toBe("3");
    expect(row().getAttribute("data-wt-id")).toBe(pinnedBranchRowId("main"));
    expect(row().textContent).toContain("main");
    // Until the ref listing answers, the meta line says only what is known.
    expect(container.querySelector(".wt-row__meta")?.textContent).toBe("no worktree");
    expect(container.querySelector(".wt-tag")).toBeNull();
  });

  // Post-ship 3a: no drag, no kebab — so no grip cursor and no empty lane.
  it("draws neither a drag grip nor a kebab", () => {
    expect(container.querySelector(".wt-row__handle")).toBeNull();
    expect(container.querySelector(".wt-row__lead")).not.toBeNull();
    expect(container.querySelector(".kebab")).toBeNull();
  });

  it("reads its count and age from the ref listing", () => {
    const summary = (over: Partial<LocalBranchSummary>): LocalBranchSummary => ({
      name: "main",
      fullName: "refs/heads/main",
      head: "a".repeat(40),
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      tracking: "up_to_date",
      checkedOutWorktreeIds: [],
      lastCommitAt: "2026-08-25T12:00:00.000Z",
      ...over
    });
    const meta = (over: Partial<LocalBranchSummary>): string | undefined => {
      act(() =>
        root.render(
          <PinnedBranchRow
            branch="main"
            summary={summary(over)}
            now={NOW}
            posinset={2}
            setsize={3}
            focusable
            onOpen={onOpen}
            onUnpin={onUnpin}
            onKeyDown={onKeyDown}
            onFocus={() => undefined}
          />
        )
      );
      return container.querySelector(".wt-row__meta")?.textContent ?? undefined;
    };
    expect(meta({ tracking: "behind", behind: 41 })).toBe("no worktree · ↓41 · 1mo");
    expect(container.querySelector(".wt-row__meta-behind")?.textContent).toBe("↓41");
    // The line is drawn aria-hidden; the row's name says the count in words.
    expect(container.querySelector('[role="treeitem"]')?.getAttribute("aria-label")).toBe(
      "main, pinned branch, no worktree, 41 behind. Enter opens a worktree for it."
    );
    expect(meta({})).toBe("no worktree · up to date · 1mo");
    expect(meta({ tracking: "unpublished" })).toBe(
      "no worktree · local only · 1mo"
    );
    expect(meta({ tracking: "upstream_missing" })).toBe("no worktree · gone · 1mo");
  });

  it("opens a worktree on click, and unpinning does not also open one", () => {
    act(() => row().click());
    expect(onOpen).toHaveBeenCalledOnce();
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Unpin branch main"]')!
        .click()
    );
    expect(onUnpin).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("hands its keys to the repo's roving list", () => {
    act(() => {
      row().dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      );
    });
    expect(onKeyDown).toHaveBeenCalledOnce();
  });
});
