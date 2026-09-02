import { describe, expect, it } from "vitest";
import { clampView, fitScaleFor } from "./use-zoom-pan";

const STAGE = { w: 900, h: 600 };

describe("fitScaleFor", () => {
  it("fits the constraining axis", () => {
    // 3104x2024 into 900x600: width binds (900/3104 < 600/2024).
    expect(fitScaleFor(STAGE, { w: 3104, h: 2024 })).toBeCloseTo(900 / 3104, 5);
  });

  it("enlarges something far smaller than the stage, but not without limit", () => {
    // A favicon at 100% is a speck in a full-screen viewer, so fit grows it —
    // past 8x it is more blur than icon.
    expect(fitScaleFor(STAGE, { w: 16, h: 16 })).toBe(8);
    expect(fitScaleFor(STAGE, { w: 300, h: 200 })).toBe(3);
  });

  it("survives a stage or an image that has not been measured", () => {
    expect(fitScaleFor({ w: 0, h: 0 }, { w: 100, h: 100 })).toBe(1);
    expect(fitScaleFor(STAGE, { w: 0, h: 0 })).toBe(1);
  });
});

describe("clampView", () => {
  const content = { w: 1000, h: 1000 };

  it("centres content smaller than the stage — there is nothing to pan to", () => {
    const view = clampView({ scale: 0.1, x: -400, y: 900 }, STAGE, content);
    expect(view.x).toBe((900 - 100) / 2);
    expect(view.y).toBe((600 - 100) / 2);
  });

  it("stops an edge being dragged inside the frame", () => {
    // Content drawn at 2000px in a 900px stage: x may run from -1100 to 0.
    const scale = 2;
    expect(clampView({ scale, x: 200, y: 0 }, STAGE, content).x).toBe(0);
    expect(clampView({ scale, x: -5000, y: 0 }, STAGE, content).x).toBe(-1100);
    expect(clampView({ scale, x: -400, y: 0 }, STAGE, content).x).toBe(-400);
  });

  it("clamps the scale itself, so a runaway pinch cannot break the view", () => {
    expect(clampView({ scale: 900, x: 0, y: 0 }, STAGE, content).scale).toBe(16);
    expect(
      clampView({ scale: 0.00001, x: 0, y: 0 }, STAGE, content).scale
    ).toBe(0.02);
  });
});
