# features/chrome — AGENTS.md

## The Pwr-family title strip

PwrGit, PwrAgent and PwrSnap draw the same top-of-window chrome on macOS.
These numbers are shared across the family; change them here and in the
sibling apps together, never in one app alone.

| Part | Value | Where in PwrGit |
| --- | --- | --- |
| Band | 40px fill, centreline y=20. A divider, if any, sits *below* the fill (41px border-box) | `.titlebar` in `styles/app.css` |
| Stoplights | `trafficLightPosition: { x: 16, y: 13 }` — a 14px button centred on y=20; the group ends at x=76 | `MACOS_TRAFFIC_LIGHT_POSITION` in `main/window-chrome.ts` |
| Brand start | x=96: 16px rail + 80px gutter, 20px clear of the stoplights | `.titlebar__gutter` |
| Mark | The app icon's glyph as inline SVG, 20px square, `currentColor` = `--accent`, 8px gap to the wordmark | `PwrGitMark` in `Brand.tsx` |
| Wordmark | `700 17px/1` Geist Sans, `letter-spacing: -0.01em`; "Pwr" `--text-primary`, app name `--accent` | `.titlebar__wordmark` |
| Centring | Text centres by cap height (`text-box: trim-both cap alphabetic`); the chevron by x-height (`trim-both ex alphabetic`) | `.titlebar__wordmark`, `.titlebar__sep` |

Why each one is what it is:

- **The fill must be an even number of points.** Electron's
  `trafficLightPosition` takes whole points, so a 14px button centres on a
  whole point only. A 1px border inside a 40px box leaves a 39px fill whose
  centre (19.5) no stoplight can sit on. That is how the old 32px strip ended
  up with its stoplights 1.5px below the chips.
- **Trim, don't nudge.** Flex centres a text element's line box, and Geist's
  ascent and descent put its capitals about 1.25px above the middle at these
  sizes. `text-box` trimming centres the ink that is actually drawn, at any
  size, so no pixel nudges are needed. A trimmed element that clips its
  overflow (the ellipsizing crumbs) needs `padding-block` to give descenders
  back.
- **The mark is the icon glyph, not a new drawing.** It comes from the same
  1024-box coordinates as `scripts/generate-app-icon.swift`, with AppKit's
  y-up flipped. It is drawn in `--accent`, the UI orange, not the icon's
  `#e8743a`.

Verify alignment by measuring, not by eye. Render the strip at 2× and compare
each element's ink centre with y=20. In the harness, draw the stoplights at
their Electron position as 14px circles. The macOS 26 geometry has been
measured; macOS 15 and earlier have not.

## Back / Forward

`HistoryNavButtons` sits between the brand (and Windows/Linux menubar) and the
crumbs, like PwrAgnt's. History is `lib/useNavigationHistory.ts`, ported from
PwrAgnt and keyed by worktree. Rules that are easy to break:

- **It observes `selection`; it is never pushed.** Every jump funnels through
  App's `selection`, so a new way to navigate is recorded for free. Don't add
  a push at a call site.
- **Riders, not entries.** The open commit and the sidebar anchor are
  captured as a place is *left* (`capture`) and ride on that entry. A restore
  re-opens the commit after the worktree-change effect clears it, the
  `pendingTag` way.
- **Diff and file details are overlays.** The first Back closes them without
  spending an entry.
- **Saved per profile** (`pwrgit.navigationHistory.<profileId>`), pruned of
  removed worktrees only once repos have loaded.
- Chords (⌘[ ⌘], ⌥←/→ outside text fields, mouse 3/4) are bound once in App
  and stand down while an `aria-modal` dialog is open.

Design: `design/Back Forward Navigation - UX Review.dc.html`.
