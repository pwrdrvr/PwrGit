import type { ReactElement } from "react";

/**
 * The "this opens" mark — Lucide `chevron-down`, flipped for `up`. It sits in
 * the agent chip's caret well, where the direction says whether the menu is
 * open.
 *
 * It replaced a `▾` / `▴` pair. U+25BE and U+25B4 are in neither bundled face,
 * so both resolved through an OS fallback (see `styles/AGENTS.md`) — and the
 * two characters are not drawn as a matched pair by every fallback, so the
 * caret could change shape as well as direction on the click that opened it.
 *
 * `up` is drawn rather than a `transform: rotate(180deg)`: a rotated stroke
 * picks up the rounded cap at the other end, and at 10px that reads as a
 * different weight.
 */
export function ChevronGlyph({
  size = 10,
  up = false
}: {
  size?: number;
  up?: boolean;
}): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      /* Scaled like its siblings: the viewBox shrinks with `size`, and a fixed
         stroke would thin the smaller instance into a lighter icon. */
      strokeWidth={(2 * 13) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={up ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6"} />
    </svg>
  );
}
