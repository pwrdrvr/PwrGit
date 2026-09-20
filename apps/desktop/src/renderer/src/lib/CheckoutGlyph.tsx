import type { ReactElement } from "react";

/**
 * "Checked out in a worktree" — the house the lineage graph's ref chips
 * already draw for that state, and the refs list's remote rows now draw
 * instead of a `●` character. Both open the worktree, so they wear one mark.
 *
 * Its stroke is a flat 2 rather than the `(2 * 13) / size` the other glyphs
 * scale by: the two call sites (10px in the graph, 12px in the refs list) were
 * hand-drawn at a flat 2 before this was a component, and scaling would have
 * re-weighted the graph's chips as a side effect of sharing the file.
 */
export function CheckoutGlyph({ size = 12 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20h14V9.5" />
    </svg>
  );
}
