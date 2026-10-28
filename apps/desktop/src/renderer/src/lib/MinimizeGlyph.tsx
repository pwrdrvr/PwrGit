import type { ReactElement } from "react";

/**
 * "Shrink this to the corner" — Lucide `minimize-2`. The bulk-sync dialog's
 * Minimise button, which sends a running Fetch all or Pull all to its toast.
 * `ExpandGlyph` is its pair, on the toast.
 */
export function MinimizeGlyph({ size = 13 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={(2 * 13) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m14 10 7-7" />
      <path d="M20 10h-6V4" />
      <path d="m3 21 7-7" />
      <path d="M4 14h6v6" />
    </svg>
  );
}
