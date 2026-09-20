import type { ReactElement } from "react";

/**
 * The "add one of these" mark — Lucide `plus`. It leads the dashed ghost
 * buttons that create something: "Add folders…" in the sidebar and the profile
 * modal, and "New worktree" on a repo row.
 *
 * It replaced a `+` text node. Unlike the `↻` characters elsewhere, that one
 * did render from the bundled face — this is about the icon column rather than
 * about fallback. A typographic `+` is drawn to the font's own weight and
 * optical size, so it sat among `<ForkGlyph />` and `<PruneGlyph />` as the one
 * mark that would change shape if the type ever did.
 */
export function PlusGlyph({ size = 12 }: { size?: number }): ReactElement {
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
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}
