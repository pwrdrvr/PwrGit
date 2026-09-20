import type { ReactElement } from "react";

/**
 * The one pull glyph: an arrow landing on a line. The worktree toolbar's Pull
 * draws it, and so does the sidebar's "Try pull all", so the bulk action reads
 * as the same verb as the single one. It is also the partner of
 * <RefreshGlyph /> in the sidebar's bulk-sync pair, which is why neither of
 * those is a text character any more — it replaced a `↓`, its partner a `↻`.
 * See `styles/AGENTS.md` for what those text nodes cost once Geist loaded.
 *
 * It never spins. An arrow that means "down" is not a rotation, so a busy Pull
 * swaps it for `.wt-btn__spinner` instead.
 */
export function PullGlyph({ size = 13 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      /* Scaled like RefreshGlyph's: the viewBox shrinks with `size`, and a
         fixed stroke would thin the smaller instance into a lighter icon. */
      strokeWidth={(2 * 13) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}
