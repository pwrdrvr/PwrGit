import type { ReactElement } from "react";

/**
 * "Put the panel away" — Lucide `panel-right-close`. The worktree header's
 * Show panel button draws `panel-right-open`, so the pair now reads as one
 * control in two states: the same panel, the arrow pointing the way it goes.
 *
 * It replaced a `›` text character. That one rendered from Geist, so this is
 * not a fallback fix; it is that a lone guillemet in a 24px icon button said
 * "next" rather than "collapse", and was the only text glyph in the rail's
 * tab strip.
 */
export function PanelCloseGlyph({ size = 14 }: { size?: number }): ReactElement {
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
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
      <path d="m8 9 3 3-3 3" />
    </svg>
  );
}
