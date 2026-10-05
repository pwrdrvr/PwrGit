import type { ReactElement } from "react";

/**
 * The branch mark: Lucide's `git-branch`, as the lineage graph's ref chips
 * have always drawn it. Every branch row and chip draws this one drawing — the
 * sidebar's and the refs browser's rows used a `⑂` text character (U+2442,
 * which neither bundled face carries, so an OS fallback drew it), and the ⌘K
 * palette a custom variant. See `design/Worktree Chip Glyphs - UX Review.dc.html`.
 *
 * `strokeWidth` defaults to the 1.8 the 12–15px rows use; the graph's 8px chip
 * passes its own heavier stroke so its weight is unchanged.
 */
export function BranchGlyph({
  size = 12,
  strokeWidth = 1.8
}: {
  size?: number;
  strokeWidth?: number;
} = {}): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3v12" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9c0 6-6 6-6 12" />
    </svg>
  );
}
