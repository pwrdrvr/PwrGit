import type { ReactElement } from "react";

/**
 * The "worth knowing" mark — Lucide `info` — that leads an informational
 * notice. `WarningGlyph` is its sibling for a notice that warns.
 *
 * It replaced `ⓘ` U+24D8, which is in neither bundled face (see
 * `styles/AGENTS.md`); on macOS Hiragino Sans drew it, a circled letter at
 * text weight, thinner than every stroked icon around it.
 */
export function InfoGlyph({ size = 14 }: { size?: number }): ReactElement {
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
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}
