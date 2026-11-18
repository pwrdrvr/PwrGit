# renderer/src/styles — AGENTS.md

## Appearance axes: `--sidebar-title-size` and `data-density`

- **Type size and density are independent axes.** Never add a font-size to a
  `[data-density]` block. Never add padding to the token ladder.
- **Rows use `min-height` plus padding, never `height`.** A fixed height
  cannot grow with the type axis, so the text clips.

Settings persist the axes in `general.sidebarTextSize` and
`general.sidebarDensity`. `lib/appearance.ts` stamps them on `<html>`. The
bare `:root` block is the tuned default and carries no attribute. To return to
a default, remove the attribute; do not write `md`. Type reads the token.
Density changes only padding and gaps. This allows large text at high density.

## The sidebar toolbar steps down by fit, so its buttons are rigid

- **Fetch and Pull keep `flex-shrink: 0`.** They grow into spare room
  (`flex-grow: 1`) but never shrink.

`.sidebar-toolbar` is one row: Add ▾, Fetch all, Pull all, the maintenance
wrench. `useFitLadder` in `SidebarToolbar` removes Add's word, then the words
of Fetch and Pull, while the last button overflows. A shrinking button makes
the row report a fit while a label ellipsizes. The title strip's
`.titlebar-jump` is rigid for the same reason; it steps while a crumb is cut
short. Design: `design/Sidebar Header Toolbar - UX Review.dc.html`.

## PwrGit deliberately has no centre-column cap

- **Do not "align" these with PwrAgnt** unless the reason applies to this
  app's content. They are intentional divergences, not drift.

PwrAgnt caps its chat column (`--chat-column-max: 940px`) because a
transcript is prose. PwrGit's centre pane is a lineage graph and a diff, which
need the horizontal room. The sidebar default is 320px (PwrAgnt: 408px),
because a PwrGit row carries only a short repo name.

## Text selection is opt-IN, not opt-out

- **Add a new copyable text surface to the opt-in list beside `.app` in
  `app.css`.** Examples: diff bodies, file paths, commit subjects and hashes,
  log output. Use `.selectable` for a one-off.
- **Do not fix an unselectable surface with `user-select: none` on its
  neighbor.**
- **Keep form controls opted in** (`input`, `textarea`, `[contenteditable]`,
  near the top of `app.css`). A field without selection is broken.

`.app` sets `user-select: none` because app chrome is not a document. Without
it, a sidebar drag painted a selection across every row.

## Busy state is `[aria-busy]`, and the arrow spins

A refresh control draws its glyph with `lib/RefreshGlyph.tsx` and paints busy
from `[aria-busy="true"]`, not from a class. Mark an in-flight control
`aria-disabled`, never `disabled`, and guard the click handler.
Read [Busy and unavailable
controls](../../../../../../docs/guides/renderer-styles/busy-state.md#busy-state-is-aria-busy-and-the-arrow-spins)
before adding a refresh control or dimming an unavailable one.

## An idle window draws nothing

- **`infinite` animations only on in-flight state**: a spinner, a busy
  attribute, an indeterminate bar. Anything on screen at rest pulses a
  finite number of times, then holds its last keyframe's value.
- Why: even a compositor animation can keep submitting frames. HEAD's
  endless ring held an idle one-repo window at ~7% renderer + GPU CPU.
  Animate `opacity` or `transform` for motion that can avoid main-thread
  paints. Chromium's layer tree can verify that an animation is composited.
- `idle-animation.test.ts` lists each `infinite` selector with its gate. Add
  yours there with what mounts it, or make it finite.

## No raw color literals outside `tokens.css`

- **Only `tokens.css` may contain a hex, `rgb()`, `rgba()` or `hsl()`
  literal.** Elsewhere use `var(--token)`, or
  `color-mix(in srgb, var(--token) X%, transparent)` for a derived alpha.
- **For a one-off tint, use inline `color-mix` on an existing token** before
  you add a token.
- **Define a new color in both theme blocks**: `:root` (dark) and
  `:root[data-theme="light"]`.

A literal does not flip with `data-theme`, so it silently breaks light theme.
`pnpm lint:colors` (`scripts/lint-renderer-colors.mjs`, run in CI) walks the
whole renderer tree. It fails a literal anywhere else, including a stray
`:root` block in `app.css` or a second `tokens.css`.

`ALLOWED_SELECTOR_SUBSTRINGS` in the script exempts illustration assets that
must not flip. Keep it empty unless a surface truly cannot be themed, and
document the reason in the script.

`theme-contract.test.ts` checks that both blocks declare the same tokens, that
every token has a reader, and that main's pre-paint literals match their
tokens.

## The palette is shared across the Pwr family

- **Use PwrAgnt's token name when an equivalent exists**, so the block can
  later move into a shared package.

Values follow PwrAgnt's `docs/UI-THEME.md`, the source of truth for the
"Tangerine Terminal" theme. `tokens.css` marks PwrGit-only tokens
(`--border-default`, `--accent-tint`, `--bg-rail`, `--danger-on`, `--lane-*`,
…). The block is a **subset** on purpose: an unread token drifts silently.
Copy a token from `docs/UI-THEME.md` when a surface needs it.

## A bundled font is requested by its `@font-face` name

- **Name the exact `@font-face` family.** Otherwise the face never loads and
  text silently falls through the stack.
- **Draw an icon as a stroked SVG component, never a text character.**
- **Probe each new non-ASCII character in the face its rule asks for**;
  `text-glyph-coverage.test.ts` checks both `--font-sans` and `--font-mono`.

Read [Bundled fonts and
glyphs](../../../../../../docs/guides/renderer-styles/fonts-and-glyphs.md#a-bundled-font-is-requested-by-its-font-face-name)
before adding a non-ASCII character, changing `fonts.css` or a font token.

## Theme selection uses one light attribute

The dark palette is the bare `:root`. Light, including System mode resolved
to light, sets `data-theme="light"` on `<html>`. To return to dark, remove the
attribute. The preload bootstrap and an inline `<head>` script apply it before
first paint. The renderer appearance sync then keeps every window current.

## Window chrome can't read tokens

- **When you change `--bg-app`, `--bg-titlebar` or `--text-secondary`, also
  change `src/main/window-chrome.ts`.**

`backgroundColor` and the Windows title-bar overlay paint before the renderer
exists, so that file copies the values by hand. `theme-contract.test.ts`
fails if they drift.

## TSX is not covered by the lint

- **Check SVG `fill=` / `stroke=` and inline styles in `.tsx` by hand.**
  `lint:colors` reads CSS only.
- **Pass `var(--token)` strings, not literals.** Chromium resolves custom
  properties in SVG presentation attributes, as `GraphRow.tsx` does for lane
  colors.

## A 15px glyph separates by silhouette, not by counting

Check a glyph as a raster at the real 15px, against its neighbours. One noun,
one drawing, on every surface: reuse the existing kind glyphs.
Read [Bundled fonts and
glyphs](../../../../../../docs/guides/renderer-styles/fonts-and-glyphs.md#a-15px-glyph-separates-by-silhouette-not-by-counting)
before drawing or changing an icon glyph.

## A sticky inset starts at the scroller's padding edge

- **`top: 0` inside a scroller with `padding-top: 14px` sticks 14px down.**
  Rows scroll past in that band, so content slides under the head and then
  reappears above it.
- **A padded scroller publishes its top padding as
  `--sticky-scroll-pad-top`. Its sticky child uses
  `top: calc(-1 * var(--sticky-scroll-pad-top, 0px))`.** See
  `.diff-file__head`.
- **Add each new sticky rule to `INVENTORY` in
  `sticky-scroll-padding.test.ts`**, with the container it sticks in. For
  layout proof, extend `e2e/sticky-heads.spec.ts` (a hidden harness).
