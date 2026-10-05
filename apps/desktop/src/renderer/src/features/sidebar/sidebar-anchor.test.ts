// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySidebarAnchor,
  keepSidebarAnchorForSelection,
  restoreSidebarAnchor,
  resetSidebarAnchorForTests,
  sidebarAnchorHeld,
  snapshotSidebarAnchor,
  trackSidebarAnchors
} from "./sidebar-anchor";

/**
 * jsdom does no layout, so the list here does its own: each row sits at a
 * fixed y in the content, and its rect is that y less the list's scrollTop.
 * Inserting a row above another is modelled by moving the rows below it.
 */
function fakeList(rows: Array<{ attr: [string, string]; y: number }>) {
  const list = document.createElement("div");
  let scrollTop = 0;
  Object.defineProperty(list, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    }
  });
  list.getBoundingClientRect = () => ({ top: 100, bottom: 600 }) as DOMRect;
  const ys = new Map<HTMLElement, number>();
  for (const { attr, y } of rows) {
    const el = document.createElement("div");
    el.setAttribute(attr[0], attr[1]);
    el.tabIndex = -1;
    ys.set(el, y);
    el.getBoundingClientRect = () => {
      const top = 100 + (ys.get(el) ?? 0) - scrollTop;
      return { top, bottom: top + 26 } as DOMRect;
    };
    list.append(el);
  }
  document.body.append(list);
  const row = (selector: string) => list.querySelector<HTMLElement>(selector)!;
  return {
    list,
    row,
    /** Everything at or below `y` moves down by `by` — a row inserted above. */
    insertAbove: (y: number, by: number) => {
      for (const [el, top] of ys) if (top >= y) ys.set(el, top + by);
    },
    offsetOf: (selector: string) =>
      row(selector).getBoundingClientRect().top - 100
  };
}

describe("sidebar-anchor", () => {
  beforeEach(() => resetSidebarAnchorForTests());
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("holds the pressed row still when the jump it made inserts a row above it", () => {
    const view = fakeList([
      { attr: ["data-wt-id", "wt-1"], y: 0 },
      { attr: ["data-nav-anchor", "cr:r:2525"], y: 300 }
    ]);
    const stop = trackSidebarAnchors(view.list);
    view.row('[data-nav-anchor="cr:r:2525"]').dispatchEvent(
      new Event("pointerdown", { bubbles: true })
    );
    expect(snapshotSidebarAnchor()).toEqual({ key: "nav:cr:r:2525", offset: 300 });

    // The selection changes; a ghost row lands above the PR row.
    keepSidebarAnchorForSelection();
    view.insertAbove(100, 26);
    applySidebarAnchor(view.list);
    expect(view.offsetOf('[data-nav-anchor="cr:r:2525"]')).toBe(300);
    expect(view.list.scrollTop).toBe(26);
    // The reveal-the-selection scroll must stand down while the row is held.
    expect(sidebarAnchorHeld()).toBe(true);
    stop();
  });

  it("does not hold the last sidebar row for a jump made from somewhere else", () => {
    const view = fakeList([
      { attr: ["data-wt-id", "wt-1"], y: 0 },
      { attr: ["data-nav-anchor", "cr:r:2525"], y: 300 }
    ]);
    const stop = trackSidebarAnchors(view.list);
    const pr = view.row('[data-nav-anchor="cr:r:2525"]');
    pr.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    // ⌘F with the row still focused opens the palette; it is not a press.
    pr.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true })
    );
    // Typing and Enter in the palette happen outside the list.
    const search = document.createElement("input");
    document.body.append(search);
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    keepSidebarAnchorForSelection();
    view.insertAbove(100, 26);
    applySidebarAnchor(view.list);
    expect(view.list.scrollTop).toBe(0);
    // So the sidebar's own reveal of the new selection is free to scroll.
    expect(sidebarAnchorHeld()).toBe(false);
    stop();
  });

  it("holds the row for Enter pressed on it", () => {
    const view = fakeList([{ attr: ["data-wt-id", "wt-1"], y: 300 }]);
    const stop = trackSidebarAnchors(view.list);
    view
      .row('[data-wt-id="wt-1"]')
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    keepSidebarAnchorForSelection();
    view.insertAbove(0, 26);
    applySidebarAnchor(view.list);
    expect(view.list.scrollTop).toBe(26);
    stop();
  });

  it("does not hold anything when no press caused the selection change", () => {
    const view = fakeList([{ attr: ["data-wt-id", "wt-1"], y: 300 }]);
    keepSidebarAnchorForSelection();
    view.insertAbove(0, 50);
    applySidebarAnchor(view.list);
    expect(view.list.scrollTop).toBe(0);
    expect(sidebarAnchorHeld()).toBe(false);
  });

  it("puts a restored anchor back at its offset, by key, and focuses it", () => {
    const view = fakeList([
      { attr: ["data-repo-id", "r"], y: 0 },
      { attr: ["data-nav-anchor", "cr:r:2525"], y: 1_200 }
    ]);
    restoreSidebarAnchor({ key: "nav:cr:r:2525", offset: 225 });
    applySidebarAnchor(view.list);
    expect(view.offsetOf('[data-nav-anchor="cr:r:2525"]')).toBe(225);
    expect(document.activeElement).toBe(
      view.row('[data-nav-anchor="cr:r:2525"]')
    );
  });

  it("waits for a restored row that has not rendered yet", () => {
    const view = fakeList([{ attr: ["data-repo-id", "r"], y: 0 }]);
    restoreSidebarAnchor({ key: "wt:later", offset: 80 });
    applySidebarAnchor(view.list);
    expect(sidebarAnchorHeld()).toBe(false);
    expect(view.list.scrollTop).toBe(0);
  });

  it("lets go when the reader scrolls with the wheel", () => {
    const view = fakeList([{ attr: ["data-wt-id", "wt-1"], y: 400 }]);
    const stop = trackSidebarAnchors(view.list);
    restoreSidebarAnchor({ key: "wt:wt-1", offset: 100 });
    applySidebarAnchor(view.list);
    expect(view.list.scrollTop).toBe(300);
    view.list.dispatchEvent(new Event("wheel"));
    view.list.scrollTop = 0;
    applySidebarAnchor(view.list);
    expect(view.list.scrollTop).toBe(0);
    stop();
  });
});
