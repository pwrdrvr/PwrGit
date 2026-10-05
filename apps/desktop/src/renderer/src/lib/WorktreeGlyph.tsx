import type { ReactElement } from "react";

/**
 * The worktree mark: a ref given a home — the branch's stem and node entering
 * a box. Closed and left-weighted, so at 10–15px it separates by silhouette
 * from the open `BranchGlyph` beside it and from the repository's folder
 * (styles/AGENTS.md, "A 15px glyph separates by silhouette"). The primary
 * checkout wears `CheckoutGlyph` instead.
 *
 * Drawn in `design/Palette Kind Glyphs - UX Review.dc.html` (3a) and chosen in
 * `design/Worktree Chip Glyphs - UX Review.dc.html` (2c).
 */
export function WorktreeGlyph({ size = 12 }: { size?: number } = {}): ReactElement {
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
      <rect x="9" y="4.5" width="11.5" height="15" rx="3" />
      <path d="M3.6 12h5.4" />
      <circle cx="3.4" cy="12" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  );
}
