// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PinnedBranchRow, pinnedBranchRowId } from "./PinnedBranchRow";

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
  it("is a level-2 treeitem in the repo's list, tagged as a branch", () => {
    expect(row().getAttribute("aria-level")).toBe("2");
    expect(row().getAttribute("aria-posinset")).toBe("2");
    expect(row().getAttribute("aria-setsize")).toBe("3");
    expect(row().getAttribute("data-wt-id")).toBe(pinnedBranchRowId("main"));
    expect(row().textContent).toContain("main");
    expect(row().textContent).toContain("branch");
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
