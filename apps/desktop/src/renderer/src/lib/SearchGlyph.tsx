import type { ReactElement } from "react";

/**
 * The search field's lens — Lucide `search`, with the ⌘K palette's r7 lens
 * rather than Lucide's r8, so the two search fields draw the same mark.
 *
 * The refs browser's filter drew `⌕` U+2315, which is in neither bundled face
 * (see `styles/AGENTS.md`): it came from an OS fallback, and on macOS that is
 * Menlo's lens with its handle pointing down-left, the mirror of every other
 * search mark in the app.
 */
export function SearchGlyph({ size = 17 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={(1.8 * 17) / size}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
