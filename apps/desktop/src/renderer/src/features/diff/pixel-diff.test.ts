import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import pixelmatch from "pixelmatch";
import {
  DIFF_AA_COLOR,
  DIFF_COLOR,
  DIFF_OPTIONS,
  planDiff
} from "./pixel-diff";

const RETINA = { w: 3104, h: 2024 };
const ONE_X = { w: 1552, h: 1012 };

describe("planDiff", () => {
  it("compares equal revisions as they are", () => {
    const plan = planDiff(RETINA, RETINA);
    expect(plan.size).toEqual(RETINA);
    expect(plan.mismatch).toBeNull();
  });

  it("scales a 2x export onto its 1x twin, at the larger size", () => {
    const plan = planDiff(RETINA, ONE_X);
    expect(plan.canStretch).toBe(true);
    expect(plan.fit).toBe("stretch");
    // Downscaling the bigger revision would resample the differences away —
    // which is the one thing this view exists not to do.
    expect(plan.size).toEqual(RETINA);
    expect(plan.mismatch).toEqual({ before: RETINA, after: ONE_X });
  });

  it("anchors two different shapes instead of distorting one into the other", () => {
    const plan = planDiff({ w: 800, h: 600 }, { w: 800, h: 400 });
    expect(plan.canStretch).toBe(false);
    expect(plan.fit).toBe("anchor");
    // The union box: what one revision does not cover compares as changed,
    // which is the truth about a crop.
    expect(plan.size).toEqual({ w: 800, h: 600 });
  });

  it("lets the caller override the shape's default either way", () => {
    expect(planDiff(RETINA, ONE_X, false).fit).toBe("anchor");
    expect(planDiff({ w: 800, h: 600 }, { w: 800, h: 400 }, true).fit).toBe(
      "stretch"
    );
  });

  it("treats a rounding-error aspect ratio as the same shape", () => {
    // 1553x1012 is not exactly half of 3104x2024, but it is the same picture.
    expect(planDiff(RETINA, { w: 1553, h: 1012 }).canStretch).toBe(true);
  });

  it("offers no toggle for a pair that is already the same size", () => {
    expect(planDiff(RETINA, RETINA).canStretch).toBe(false);
  });
});

describe("diff colors", () => {
  it("matches the tokens the legend swatches paint with", () => {
    // The worker bakes these numbers into the PNG while the swatches beside it
    // read CSS. Nothing else keeps the two in step, so this does.
    const here = dirname(fileURLToPath(import.meta.url));
    const tokens = readFileSync(
      resolve(here, "../../styles/tokens.css"),
      "utf8"
    );
    const rgbOf = (token: string): [number, number, number] => {
      const hex = tokens.match(
        new RegExp(`^\\s+${token}\\s*:\\s*#([0-9a-f]{6});`, "m")
      );
      if (hex === null) throw new Error(`missing token: ${token}`);
      const value = hex[1]!;
      return [
        parseInt(value.slice(0, 2), 16),
        parseInt(value.slice(2, 4), 16),
        parseInt(value.slice(4, 6), 16)
      ];
    };
    expect(DIFF_COLOR).toEqual(rgbOf("--diff-changed"));
    expect(DIFF_AA_COLOR).toEqual(rgbOf("--diff-aa"));
  });
});

/** An `w`x`h` RGBA buffer of one opaque colour. */
function fill(
  w: number,
  h: number,
  [r, g, b]: [number, number, number]
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    data.set([r, g, b, 255], i * 4);
  }
  return data;
}

const pixelAt = (
  data: Uint8ClampedArray,
  w: number,
  x: number,
  y: number
): number[] => Array.from(data.slice((y * w + x) * 4, (y * w + x) * 4 + 3));

describe("the comparison itself", () => {
  // The worker's other half needs OffscreenCanvas, so it cannot run here. This
  // half can, and it is the half where a renamed option would go unnoticed:
  // pixelmatch ignores keys it does not know and quietly uses its own defaults,
  // which would paint the deltas in ITS red instead of ours.
  const W = 8;
  const H = 8;

  it("counts only the pixels that changed", () => {
    const before = fill(W, H, [10, 10, 10]);
    const after = fill(W, H, [10, 10, 10]);
    after.set([255, 255, 255, 255], (2 * W + 3) * 4);
    after.set([255, 255, 255, 255], (5 * W + 6) * 4);

    const out = new Uint8ClampedArray(W * H * 4);
    expect(pixelmatch(before, after, out, W, H, DIFF_OPTIONS)).toBe(2);
  });

  it("paints the deltas in our colour, not pixelmatch's default red", () => {
    const before = fill(W, H, [10, 10, 10]);
    const after = fill(W, H, [10, 10, 10]);
    after.set([255, 255, 255, 255], (2 * W + 3) * 4);

    const out = new Uint8ClampedArray(W * H * 4);
    pixelmatch(before, after, out, W, H, DIFF_OPTIONS);

    expect(pixelAt(out, W, 3, 2)).toEqual(DIFF_COLOR);
    // Everything else is the original, faded — present enough to place the
    // change on the page, dim enough that the magenta wins the eye.
    const untouched = pixelAt(out, W, 0, 0);
    expect(untouched).not.toEqual(DIFF_COLOR);
    expect(Math.max(...untouched)).toBeLessThan(255);
  });

  it("reports a pair that did not change at all", () => {
    const same = fill(W, H, [200, 120, 40]);
    const out = new Uint8ClampedArray(W * H * 4);
    expect(pixelmatch(same, same.slice(), out, W, H, DIFF_OPTIONS)).toBe(0);
  });

  it("counts a smaller revision's missing corner as changed", () => {
    // What `anchor` produces: the overhang of the larger revision compares
    // against transparency, which is the truth about a crop.
    const before = fill(W, H, [200, 200, 200]);
    const after = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        after.set([200, 200, 200, 255], (y * W + x) * 4);
      }
    }
    const out = new Uint8ClampedArray(W * H * 4);
    expect(pixelmatch(before, after, out, W, H, DIFF_OPTIONS)).toBe(
      W * H - 4 * 4
    );
  });
});
