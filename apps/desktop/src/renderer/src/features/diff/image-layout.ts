/**
 * Which way an image diff lays its two sides out, and how large the frames may
 * grow. Kept apart from the component so the thresholds are readable in one
 * place and testable without a DOM.
 */

/** Gap between the two sides — mirrors `.diff-image`'s `gap` in app.css. */
export const SIDE_GAP = 12;

/** `.diff-image`'s inline padding, subtracted to get the space the sides share.
 *  Both numbers live in app.css too; they are restated here because the layout
 *  decision is arithmetic, and arithmetic cannot read a stylesheet. */
export const ROW_PADDING = 12;

/**
 * Floors a side-by-side pair has to clear. Below either one the pair is two
 * thumbnails, and two unreadable pictures compare worse than one readable one.
 *
 * The width floor alone is not enough: a 32:9 banner squeezed to 400px is
 * 112px tall and still useless, while a phone screenshot at the same width is
 * fine. Both are measured on the RENDERED size, so an icon smaller than its
 * frame — which is not being squeezed by anything — never forces a stack.
 */
export const MIN_SIDE_WIDTH = 320;
export const MIN_SIDE_HEIGHT = 160;

/** A decoded image's natural size. */
export type Extent = { w: number; h: number };

/**
 * Whether the pair should stack. `contentWidth` is the space inside
 * `.diff-image`'s padding; sides with no measurement yet are skipped, so the
 * answer only sharpens as the images decode — the CSS container query is what
 * gets the first paint right.
 */
export function shouldStack(
  contentWidth: number,
  sides: readonly (Extent | null)[]
): boolean {
  const measured = sides.filter((side): side is Extent => side !== null);
  if (measured.length < 2 || contentWidth <= 0) return false;
  const sideWidth = (contentWidth - SIDE_GAP) / 2;
  return measured.some((side) => {
    const scale = Math.min(1, sideWidth / side.w);
    // Not being shrunk means the frame is not the constraint; the floors are
    // about squeezing, not about small assets.
    if (scale >= 1) return false;
    return side.w * scale < MIN_SIDE_WIDTH || side.h * scale < MIN_SIDE_HEIGHT;
  });
}

/**
 * The reference box every revision is drawn into: the larger of the two, so a
 * 2x asset and its downscale share one coordinate space. That shared space is
 * what lets zoom and pan carry across before/after/diff — without it, "100%"
 * would mean a different region on each item.
 */
export function referenceExtent(sides: readonly (Extent | null)[]): Extent | null {
  const measured = sides.filter((side): side is Extent => side !== null);
  if (measured.length === 0) return null;
  return {
    w: Math.max(...measured.map((side) => side.w)),
    h: Math.max(...measured.map((side) => side.h))
  };
}
