import { describe, expect, it } from "vitest";
import { NO_DRAG_ENDED, isPostDragClickAt } from "./useListReorder";

describe("isPostDragClickAt", () => {
  // The regression: `endedAt` was seeded with 0, and `performance.now()` counts
  // from the document's load — so for the window's first 250ms every repo and
  // worktree row click was thrown away as a phantom post-drag click. Expanding
  // a repo the moment the sidebar lists it lands squarely in that window, and
  // the click simply vanished with nothing to show for it.
  it("suppresses nothing before any drag has ended", () => {
    for (const now of [0, 1, 100, 249, 250, 5_000]) {
      expect(isPostDragClickAt(now, NO_DRAG_ENDED)).toBe(false);
    }
  });

  it("suppresses the synthetic click a drag release fires", () => {
    expect(isPostDragClickAt(1_000, 1_000)).toBe(true);
    expect(isPostDragClickAt(1_100, 1_000)).toBe(true);
    expect(isPostDragClickAt(1_249, 1_000)).toBe(true);
  });

  it("expires on its own, so a missing dragend can't wedge clicks off", () => {
    expect(isPostDragClickAt(1_250, 1_000)).toBe(false);
    expect(isPostDragClickAt(9_000, 1_000)).toBe(false);
  });
});
