import type { Extent } from "./image-layout";

/**
 * Deciding what a pixel diff of two revisions even means. pixelmatch compares
 * two buffers of the SAME dimensions and has no opinion when they differ —
 * Playwright's answer is to fail the comparison outright. A repository is not
 * a test suite: re-exporting a screenshot at 1x is an ordinary commit, and
 * refusing to diff it is refusing the commonest case there is.
 */

/** Aspect ratios this close count as the same shape — a 2x export rounds. */
const ASPECT_TOLERANCE = 0.005;

export type DiffPlan = {
  /** The canvas both revisions are rendered into before comparing. */
  size: Extent;
  /**
   * `stretch` scales each revision to fill the canvas — right when the two are
   * the same shape, because then the only difference is resolution.
   * `anchor` draws each at its natural size in the canvas's top-left corner,
   * so the overhang of the larger one compares against transparency and is
   * counted as changed. That is the honest answer for two different shapes:
   * the pixels really are not there in one of them.
   */
  fit: "stretch" | "anchor";
  /** Set when the two revisions are not the same size, for the banner. */
  mismatch: { before: Extent; after: Extent } | null;
  /** Whether `stretch` is a sane reading of this pair, for the toggle default. */
  canStretch: boolean;
};

function sameSize(a: Extent, b: Extent): boolean {
  return a.w === b.w && a.h === b.h;
}

function sameShape(a: Extent, b: Extent): boolean {
  if (a.h === 0 || b.h === 0) return false;
  const ratio = a.w / a.h / (b.w / b.h);
  return Math.abs(ratio - 1) <= ASPECT_TOLERANCE;
}

/**
 * `stretch` is the caller's override — the lightbox's "Scale to match" toggle.
 * Left undefined it follows the shapes, which is what the toggle is seeded
 * with; it only becomes a real choice once the user disagrees.
 */
export function planDiff(
  before: Extent,
  after: Extent,
  stretch?: boolean
): DiffPlan {
  const canStretch = sameShape(before, after);
  if (sameSize(before, after)) {
    return { size: before, fit: "anchor", mismatch: null, canStretch: false };
  }
  const useStretch = stretch ?? canStretch;
  return {
    // Always the larger box. Downscaling the bigger revision to meet the
    // smaller one would hide differences by resampling them away, and the
    // whole point of the third item is to not do that.
    size: {
      w: Math.max(before.w, after.w),
      h: Math.max(before.h, after.h)
    },
    fit: useStretch ? "stretch" : "anchor",
    mismatch: { before, after },
    canStretch
  };
}

/** How sensitive the comparison is, mapped onto pixelmatch's `threshold`. */
export const DIFF_THRESHOLD = 0.1;

/**
 * Diff colors, deliberately NOT pixelmatch's defaults. Its red sits inside the
 * palette of the screenshots this repository actually stores — dark UI with
 * red error text — so a red delta reads as part of the picture. Magenta
 * appears nowhere in the Tangerine Terminal theme or in what it photographs.
 */
export const DIFF_COLOR: [number, number, number] = [255, 45, 155];
export const DIFF_AA_COLOR: [number, number, number] = [255, 225, 77];

/**
 * The options the worker hands pixelmatch. Exported so the test can drive the
 * real library through the same settings: the canvas half of the worker needs
 * a browser, but this half — the half where a renamed option would silently
 * fall back to a default — does not.
 */
export const DIFF_OPTIONS = {
  threshold: DIFF_THRESHOLD,
  diffColor: DIFF_COLOR,
  aaColor: DIFF_AA_COLOR,
  /** How much of the original shows through under the deltas. Enough to place
   *  a change on the page, dim enough that magenta wins the eye. */
  alpha: 0.12
} as const;

/** Request and reply crossing the worker boundary. */
export type DiffRequest = {
  id: number;
  before: string;
  after: string;
  width: number;
  height: number;
  fit: DiffPlan["fit"];
};

export type DiffReply =
  | { id: number; ok: true; png: Blob; changed: number; total: number }
  | { id: number; ok: false; error: string };
