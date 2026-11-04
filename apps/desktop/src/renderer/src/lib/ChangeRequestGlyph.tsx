import type { ReactElement } from "react";

/**
 * The change request mark: Lucide's `git-pull-request`, as the ⌘K palette
 * has drawn a pull or merge request hit since it learned that kind. The
 * sidebar's PR heading draws the same mark when its label steps down to a
 * glyph (`section-fit.tsx`), so one noun keeps one drawing.
 */
export function ChangeRequestGlyph({
  size = 15
}: { size?: number } = {}): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <path d="M6 9v12" />
    </svg>
  );
}
