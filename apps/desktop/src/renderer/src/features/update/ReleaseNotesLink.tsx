// "Release notes" — the one control that takes a version out to its published
// GitHub release page.
//
// Four surfaces render it (Settings → Updates' slot tiles and status line, the
// update toast's live and offered cards, the settled outcome toasts, and
// Settings → About's version row) and they share this component rather than
// each writing their own link, for the same reason they share
// `updateProgressCopy`: the wording and the behaviour must not drift. Only the
// skin differs, which is what `className` is for.
//
// It is a BUTTON, not an anchor, and that is deliberate on both counts:
//
//   - Semantically it performs an action — hand a URL to the OS browser —
//     rather than navigating this document. `shell:openExternal` is the only
//     thing that ever opens it, and `external-links.ts` is the one awaited
//     boundary every renderer link already goes through.
//   - No `href` means no navigation vector. PwrGit's windows install
//     `setWindowOpenHandler` (deny + hand to the OS), so a middle-click or
//     cmd-click on a real anchor is already covered — but NOTHING guards
//     same-frame navigation: no window in this app installs `will-navigate`
//     except the agent-consent window. An ordinary left click on an `<a href>`
//     would load github.com into the app frame and take the UI with it.
//
// Render nothing when there is no URL. `releaseNotesUrl` answers undefined for
// a version that is not shaped like a tag this repo publishes, and a dead
// "Release notes" control is worse than none. It cannot screen out a
// well-formed version that was never tagged — `simulateDevUpdateCheck`'s
// `420.0.0` is the case that occurs — so in `pnpm dev` this control is live and
// lands on GitHub's 404.

import type { ReactElement } from "react";
import { dispatch } from "../../lib/pwrgit";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";

export type ReleaseNotesLinkProps = {
  /** From `releaseNotesUrl(version)`. `undefined` renders nothing. */
  url: string | undefined;
  /** Surface skin. Every caller styles it in its own namespace. */
  className: string;
  /** Visible text. The compact surfaces have room for less. */
  label?: string;
  /**
   * Accessible name, when the visible label alone does not say WHICH
   * version's notes these are — the four-slot matrix renders four of these at
   * once, and "Release notes, Release notes, Release notes" is not a usable
   * list.
   */
  ariaLabel?: string;
};

export function ReleaseNotesLink({
  url,
  className,
  label = "Release notes",
  ariaLabel
}: ReleaseNotesLinkProps): ReactElement | null {
  // Before the early return, per the rules of hooks — and `hoverTooltip`
  // renders nothing for empty content, so an unused instance costs no DOM.
  const tip = useViewportTooltip();
  if (url === undefined) return null;
  return (
    <>
      <button
        type="button"
        className={className}
        {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
        // The house hover card, never a native `title` (#269): `title` never
        // appears on keyboard focus and cannot be dismissed. Showing the URL
        // is worth the card here — a renderer window has no status bar, so
        // this is the only way to see where the link goes without taking it.
        {...hoverTooltip(tip, url)}
        onClick={() => {
          // Fire and forget. The bus answers a Result, but the only failures
          // it can report are a refused URL — which this component cannot
          // compose, since every URL it is handed comes from
          // `releaseNotesUrl` — and a browser that would not launch, which
          // none of these surfaces has an error slot for. Settings → About,
          // which does have one, keeps its own `settings-button` rows for
          // that reason.
          void dispatch("shell:openExternal", { url });
        }}
      >
        {label}
        <svg
          viewBox="0 0 24 24"
          width="10"
          height="10"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M14 4h6v6" />
          <path d="M20 4 11 13" />
          <path d="M18 14.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4.5" />
        </svg>
      </button>
      {tip.tooltipNode}
    </>
  );
}
