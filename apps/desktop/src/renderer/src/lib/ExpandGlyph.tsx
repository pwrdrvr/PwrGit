import type { ReactElement } from "react";

/**
 * "Open this back up" — Lucide `maximize-2`. The bulk-sync toast's Show
 * details button, which returns the run to its dialog. `MinimizeGlyph` is
 * its pair, in the dialog.
 */
export function ExpandGlyph({ size = 13 }: { size?: number }): ReactElement {
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
      <path d="M15 3h6v6" />
      <path d="m21 3-7 7" />
      <path d="m3 21 7-7" />
      <path d="M9 21H3v-6" />
    </svg>
  );
}
