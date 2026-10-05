import type { ReactElement } from "react";

/**
 * The caution mark — Lucide `triangle-alert` — for a notice that warns rather
 * than informs. Its sibling is `InfoGlyph`; the two differ by silhouette
 * (triangle vs circle), which is the channel that survives at 14px (see "A
 * 15px glyph separates by silhouette" in `styles/AGENTS.md`).
 *
 * It replaced `⚠` U+26A0, which is in neither bundled face. On macOS the
 * system face drew it, at text weight in the notice's grey: a thin outline
 * that did not take the notice's `--status-warning` tint.
 */
export function WarningGlyph({ size = 14 }: { size?: number }): ReactElement {
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
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}
