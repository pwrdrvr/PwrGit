import type { ReactElement } from "react";

/**
 * "Git outside PwrGit" — Lucide `terminal`, a prompt and a cursor. It leads
 * the profile menu's row for what Terminal and coding agents commit as.
 */
export function TerminalGlyph({ size = 13 }: { size?: number }): ReactElement {
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
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}
