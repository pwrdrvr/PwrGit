import { describe, expect, it } from "vitest";
import { buildSequence, stepStop } from "./lightbox-sequence";
import {
  MIN_SIDE_HEIGHT,
  MIN_SIDE_WIDTH,
  referenceExtent,
  shouldStack
} from "./image-layout";

/** The pane width at which each side of a pair gets exactly `each` pixels. */
const paneFor = (each: number): number => each * 2 + 12;

describe("shouldStack", () => {
  it("keeps a pair side by side while both sides clear the width floor", () => {
    const shot = { w: 3104, h: 2024 };
    expect(shouldStack(paneFor(MIN_SIDE_WIDTH + 10), [shot, shot])).toBe(false);
  });

  it("stacks once a side would be squeezed under the width floor", () => {
    const shot = { w: 3104, h: 2024 };
    expect(shouldStack(paneFor(MIN_SIDE_WIDTH - 10), [shot, shot])).toBe(true);
  });

  it("stacks a wide banner that clears the width floor but not the height one", () => {
    // 32:9 at 400px wide renders 112px tall — a legible width, an illegible
    // strip. Width alone cannot see this; the aspect ratio is what decides it.
    const banner = { w: 3200, h: 900 };
    const pane = paneFor(400);
    expect(400).toBeGreaterThan(MIN_SIDE_WIDTH);
    expect((400 * banner.h) / banner.w).toBeLessThan(MIN_SIDE_HEIGHT);
    expect(shouldStack(pane, [banner, banner])).toBe(true);
  });

  it("leaves small assets alone — the floors are about squeezing", () => {
    // A 48px icon in a 200px side is not being shrunk by anything, so stacking
    // it would only make the row taller without making the icon any bigger.
    const icon = { w: 48, h: 48 };
    expect(shouldStack(paneFor(200), [icon, icon])).toBe(false);
  });

  it("stacks when either side alone fails, not only when both do", () => {
    const icon = { w: 48, h: 48 };
    const shot = { w: 3104, h: 2024 };
    expect(shouldStack(paneFor(MIN_SIDE_WIDTH - 10), [icon, shot])).toBe(true);
  });

  it("waits for both measurements rather than guessing from one", () => {
    const shot = { w: 3104, h: 2024 };
    expect(shouldStack(paneFor(100), [shot, null])).toBe(false);
    expect(shouldStack(paneFor(100), [null, null])).toBe(false);
  });

  it("says nothing before the row has been measured", () => {
    const shot = { w: 3104, h: 2024 };
    expect(shouldStack(0, [shot, shot])).toBe(false);
  });
});

describe("referenceExtent", () => {
  it("takes the larger box on each axis so both revisions fit inside it", () => {
    expect(
      referenceExtent([
        { w: 3104, h: 2024 },
        { w: 1552, h: 1012 }
      ])
    ).toEqual({ w: 3104, h: 2024 });
  });

  it("mixes axes when neither revision is larger on both", () => {
    expect(
      referenceExtent([
        { w: 800, h: 200 },
        { w: 200, h: 800 }
      ])
    ).toEqual({ w: 800, h: 800 });
  });

  it("falls back to whichever side has been measured", () => {
    expect(referenceExtent([null, { w: 64, h: 64 }])).toEqual({ w: 64, h: 64 });
    expect(referenceExtent([null, null])).toBeNull();
  });
});

describe("stepStop", () => {
  const sequence = buildSequence([]);

  it("never returns a position that is not one", () => {
    // The clamp used to run upper-bound-first, so an empty walk produced -1 —
    // a value every caller then feeds straight back in as a position.
    expect(stepStop(sequence, 0, 1)).toBe(0);
    expect(stepStop(sequence, 0, -1)).toBe(0);
  });
});
