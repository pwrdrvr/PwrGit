import type { ReactElement } from "react";

/**
 * The one refresh/fetch glyph.
 *
 * Every control that re-reads state draws this — over the network
 * (`git fetch`) or from disk. It replaced a `↻` text node in three places,
 * for two reasons that both bit.
 *
 * PwrGit's `--font-mono` stack contains no U+21BB. The character therefore
 * resolved through whatever fallback the OS happened to supply, so the remotes
 * buttons drew a different shape, weight and baseline per platform and never
 * matched the stroked 13px icons beside them. (`--font-sans` does resolve it,
 * which is why only the mono callers looked wrong.)
 *
 * And a text node gives an animation nothing to target. `.ref-fetch-all` had
 * to spin the *button*, so a bordered 24px box cartwheeled — border, radius
 * and all — while its remote fetched. An element inside the button is what
 * makes the busy rule in app.css able to rotate the glyph alone.
 *
 * The `refresh-glyph` class is what the busy animation selects, so every
 * caller — present and future — spins by construction rather than by being
 * remembered in a selector list. Busy state is painted from
 * `[aria-busy="true"]` rather than a class; see "Refresh and fetch
 * affordances" in app.css for why.
 */
export function RefreshGlyph({ size = 13 }: { size?: number }): ReactElement {
  return (
    <svg
      className="refresh-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      /* The 24-unit viewBox scales to `size`, so a fixed stroke thins as the
         glyph shrinks — at 11px, 1.8 renders ~0.83 device px against ~0.98 at
         13, and the small instance reads as a lighter-weight icon than its
         neighbours. Scaling the stroke by the same factor holds the apparent
         weight constant, which is the whole point of one shared glyph. */
      strokeWidth={(1.8 * 13) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}
