import type { ReactElement } from "react";

/**
 * The "this one" mark — Lucide `check` — for the chosen row of a menu whose
 * rows are `menuitemradio`. Drawn rather than typed: U+2713 is in neither
 * bundled face (see `styles/AGENTS.md`).
 */
export function CheckGlyph({ size = 12 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      /* Scaled like its siblings, so a smaller instance keeps the weight. */
      strokeWidth={(2.4 * 13) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
