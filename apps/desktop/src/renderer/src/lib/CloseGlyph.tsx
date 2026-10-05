import type { ReactElement } from "react";

/**
 * The "close / dismiss / remove this" mark — Lucide `x`. Every dialog close,
 * toast dismiss and remove-this-row button draws it.
 *
 * It replaced two text characters that drew two different marks. `✕` U+2715
 * is in neither bundled face, so it resolved through an OS fallback (see
 * `styles/AGENTS.md`); `×` U+00D7 is in Geist, but it is the multiplication
 * sign — drawn at x-height and sized to sit between digits, so a 19px one in a
 * 28px button drew a small cross beside the 14px SVG closes the palette,
 * the diff pane and the image lightbox already drew. Those three now use this
 * component too, and at 14px it is the drawing they had.
 *
 * Stroke is pinned to 2 at 14px and scales from there, like its siblings.
 */
export function CloseGlyph({ size = 14 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={(2 * 14) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
