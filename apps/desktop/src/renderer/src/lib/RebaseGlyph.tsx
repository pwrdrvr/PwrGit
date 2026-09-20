import type { ReactElement } from "react";

/**
 * The Rebase tool's mark — Lucide `list-restart`, a list of lines with a
 * replay arrow, which is what the tool does to a run of commits: squash or
 * reorder them, then replay them onto the same base.
 *
 * It replaced a `↻` text node, which resolved through an OS fallback — neither
 * bundled face carries U+21BB — and so changed shape per platform. See
 * `styles/AGENTS.md`.
 *
 * Deliberately NOT <RefreshGlyph />, though that is the app's other circular
 * mark. A circular arrow here means "re-read state" — fetch, or a reload from
 * disk — and every control that draws it can spin it to say busy. Rebase is
 * neither, so it gets a silhouette of its own: lines first, arc second.
 */
export function RebaseGlyph({ size = 15 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      /* Scaled like its siblings: the viewBox shrinks with `size`, and a fixed
         stroke would thin the smaller instance into a lighter icon. */
      strokeWidth={(2 * 13) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 5H3" />
      <path d="M7 12H3" />
      <path d="M7 19H3" />
      <path d="M12 18a5 5 0 0 0 9-3 4.5 4.5 0 0 0-4.5-4.5c-1.33 0-2.54.54-3.41 1.41L11 14" />
      <path d="M11 10v4h4" />
    </svg>
  );
}
