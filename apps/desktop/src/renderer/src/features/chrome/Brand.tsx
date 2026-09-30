/**
 * The PwrGit brand lockup for the title strip: lineage mark + wordmark.
 *
 * The mark is the app icon's glyph (scripts/generate-app-icon.swift), redrawn
 * from the same 1024-box coordinates with AppKit's y-up flipped to SVG's
 * y-down: a commit trunk with a node at each end, and one branch peeling off
 * to its own node at 55%. The dim tier is one group `opacity`, not a
 * per-stroke one, for the same reason the icon uses a transparency layer —
 * the arc and its ring overlap and must not double up where they do. The
 * viewBox is the glyph's own bounds (x 240–784, y 188–836) squared about its
 * centre, so the mark fills its box the way PwrSnap's does.
 *
 * It strokes `currentColor`, which the strip sets to `--accent` (the UI
 * orange, not the icon's #e8743a — see styles/tokens.css). The wordmark next
 * to it already names the app, so the mark is decorative to assistive tech.
 */
export function PwrGitMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      className="titlebar__mark"
      viewBox="188 188 648 648"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="56"
        strokeLinecap="round"
      >
        <g opacity="0.55">
          <path d="M352 600C352 470 470 404 588 404" />
          <circle cx="672" cy="404" r="84" />
        </g>
        <path d="M352 384V640" />
        <circle cx="352" cy="300" r="84" />
        <circle cx="352" cy="724" r="84" />
      </g>
    </svg>
  );
}

/** Mark + "Pwr" / "Git" wordmark, shared by the main and auxiliary strips. */
export function TitleBarBrand() {
  return (
    <div className="titlebar__brand">
      <PwrGitMark />
      <p className="titlebar__wordmark">
        Pwr<span className="titlebar__brand-accent">Git</span>
      </p>
    </div>
  );
}
