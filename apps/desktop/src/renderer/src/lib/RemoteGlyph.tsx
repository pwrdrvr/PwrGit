import type { ReactElement } from "react";

/**
 * The remote mark: Lucide's `cloud`, for a Git remote — a place the
 * repository's refs also live, not a ref of its own. A closed, wide shape, so
 * at 12–15px it separates by silhouette from the open branch and pull request
 * marks and from the pointed tag beside it in the sidebar's section headings
 * (styles/AGENTS.md, "A 15px glyph separates by silhouette").
 *
 * Drawn for `design/Sidebar Section Headings - UX Review.dc.html` (3a); the
 * cloud was the decisive option in `design/Palette Kind Glyphs - UX
 * Review.dc.html` (4d).
 */
export function RemoteGlyph({ size = 12 }: { size?: number } = {}): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  );
}
