import type { ReactElement } from "react";

/**
 * A status dot: filled for "this, now" (a running step, uncommitted changes),
 * hollow for "not yet" (a check that has not run).
 *
 * `●` U+25CF and `○` U+25CB are in Geist Sans but **not in Geist Mono**, and
 * every place that drew them as a mark — the dirty badge, the remote activity
 * steps, the proof ledger — set them in `--font-mono`. So they resolved
 * through the mono stack to an OS face, a different size and baseline per
 * platform, beside a count that stayed in Geist Mono.
 *
 * Drawn on a 24-unit box like its siblings. The filled disc is r7, which at
 * the badge's 10px is the ~6px of ink the fallback `●` drew; the hollow ring
 * is r6.5 so that, with its stroke, its outer edge lands on the disc's.
 */
export function DotGlyph({
  size = 10,
  hollow = false
}: {
  size?: number;
  hollow?: boolean;
}): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      {...(hollow
        ? { fill: "none", stroke: "currentColor", strokeWidth: (2 * 10) / size }
        : { fill: "currentColor" })}
    >
      <circle cx="12" cy="12" r={hollow ? 6.5 : 7} />
    </svg>
  );
}
