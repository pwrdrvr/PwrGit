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

A control that re-reads state (network `git fetch` or a local re-read) shows
"working" one way: an accent tint, and its circular-arrow glyph rotating. See
`design/Refresh Affordances - Normalization.dc.html`. A new refresh control
obeys all three rules:

- **Draw the glyph with `lib/RefreshGlyph.tsx`, never a `↻` text
  character.** Neither bundled face has U+21BB, so it draws in an OS font. A
  text node also gives the animation no target; spinning the whole bordered
  24px button made it cartwheel.
- **Paint busy from `[aria-busy="true"]`, not from a class.** The blanket
  `prefers-reduced-motion` rule at the top of `app.css` stops every
  animation, but the tint survives. A control also cannot look busy without
  announcing it.
- **Do not add your selector to the spin rule.** It keys off
  `.refresh-glyph`, which the shared component stamps. Only the tint list
  names buttons, because their shapes differ.

A glyph that is not a circular arrow (Pull's ↓, Push's ↑) swaps to
`.wt-btn__spinner`. A spinning "down" arrow looks broken.

- **Mark an in-flight control `aria-disabled`, never `disabled`, and guard the
  click handler.** Chromium blurs an element when it becomes `disabled`, so
  keyboard activation sends focus to `<body>` (WCAG SC 2.4.3).
- **Use `disabled` for a truly unavailable action**, unless it must explain
  itself on hover. A `disabled` button gets no pointer events, so it shows no
  hover card. For this reason `.lens-chip.is-empty` uses `aria-disabled` and a
  guarded click: the lens chips are icon-only, so the chip must explain why it
  is grey.
- **`opacity` on a focusable control also dims its focus ring.**
  `filter: opacity()` does the same, and a `mask` removes the ring. Add each
  new dimmed `aria-disabled` rule to the focused-unavailable block in
  `app.css`. That block comes after every fade rule, so it wins the tie. While
  focused, it paints subtle border, transparent fill and `--text-subtle` text
  at full opacity.

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
- **Draw an icon as a stroked SVG component, never a text character.** Use
  `lib/*Glyph.tsx` or a local one such as the sidebar's `SectionGlyph`
  (`features/sidebar/section-fit.tsx`).
- **Probe each new non-ASCII character in the face its rule asks for.** The
  answer is per-codepoint and per-face.
- **Do not trust `document.fonts.check()`.** It is vacuously `true` for a
  family that no face matches. Use CDP's `CSS.getPlatformFontsForNode`, which
  names the font that drew the glyphs.

@fontsource names the sans "Geist Sans", not upstream's "Geist" (the name in
PwrAgnt's `docs/UI-THEME.md`). PwrGit asked for "Geist" from v0.1.0 through
0.17.0, so sans text drew in the platform font. `bundled-fonts.test.ts` fails
unless a font token leads with each family `fonts.css` imports.

The bundled Geist Sans is latin only. A glyph outside it draws in an OS font,
as "↻ Fetch all repos" did. The refs sections' `+` and `●` are now
`<PlusGlyph />` and `<CheckoutGlyph />`.

**Do not convert the remaining arrows on suspicion; probe first.** In
`geist-sans-latin-600-normal.woff2`:

| char | drew in |
|---|---|
| `↑` U+2191, `↓` U+2193 (ahead/behind counts) | Geist SemiBold |
| `●` U+25CF, `→` U+2192, `·` U+00B7, `…` U+2026, `↵` U+21B5 | Geist SemiBold |
| `↻` U+21BB | **Menlo** — the OS |

So `↑3 ↓2` in a ref row is safe typography. This table is Geist Sans only.
`●` drew in **Menlo** in `.badge` and `.hit-status__b`, which use
`--font-mono`; Geist Mono lacks it. Those marks are now `DotGlyph`.

### The mono stack's symbol fallthrough

`--font-mono` is `"Geist Mono", "Geist Sans Symbols", …OS fonts`.
`"Geist Sans Symbols"` is a `@font-face` alias in `fonts.css` over Geist
Sans's files, so it adds no download.

- Its `unicode-range` covers arrows, math operators, misc technical, enclosed
  alphanumerics, and geometric shapes through dingbats, minus every codepoint
  Geist Mono has.
- It is not plain `"Geist Sans"` because of `font-display: swap`. While Geist
  Mono loads, the next family draws every glyph, which would set mono letters
  and digits proportionally. The alias cannot reach a letter or digit.
- Its weights mirror Geist Mono's 400/500/600. A 700 mono rule draws both at
  600.

Probed in a Vite harness build:

| char, where it is set in mono | before | after |
|---|---|---|
| `↑` `↓`: sync chip, switcher footer | Geist Mono | Geist Mono (Geist Mono has U+2191 and U+2193) |
| `↵`: switcher footer | **Menlo** | Geist Medium |
| `⇧` `⏎`: diff help keycaps | **Menlo** | Geist SemiBold |
| `←` `→`: commit-alignment relation | **Menlo** | Geist SemiBold |
| `≈`: commit-alignment relation (700) | **Courier** | Geist SemiBold |

Boxes with only Geist Mono glyphs did not change size. A box with a
fallthrough glyph grew by its wider advance: a `⏎` keycap went from 20.0px to
22.9px.

### Reading the cmap

The face's `cmap` tells whether it *can* draw a codepoint, without a running
app:

1. Parse the `.woff` beside the `.woff2` (zlib, not brotli).
2. Run `zlib.decompress` on each table in the WOFF directory.
3. Look up the codepoint in `cmap`.
4. Also look up U+21BB. If the reader finds it, the reader is wrong.

Agent surfaces checked against `geist-sans-latin-600-normal.woff` (538
codepoints) and `geist-mono-latin-400-normal.woff` (225):

| char | in either bundled face? |
|---|---|
| `✦` U+2726 (the agent mark) | **no** — now `lib/AgentGlyph.tsx` |
| `▴` U+25B4, `▾` U+25BE (a caret) | **no** — now `lib/ChevronGlyph.tsx` |
| `‥` U+2025 (two-dot leader) | **no** — the ledger's hash range uses `…` |
| `✓` U+2713, `✕` U+2715 | **no** — now `CheckGlyph`, `CloseGlyph` |
| `⚙` `＋` `ⓘ` `⚠` `⌕` `⟳` `▸` | **no** — now `SettingsGlyph`, `PlusGlyph`, `InfoGlyph`, `WarningGlyph`, `SearchGlyph`, `RefreshGlyph`, `ChevronGlyph` |
| `⑂` U+2442, `⌂` U+2302 (branch, worktree holder) | **no** — now `lib/BranchGlyph.tsx`, `lib/WorktreeGlyph.tsx`, `lib/CheckoutGlyph.tsx` |

On macOS these drew in five different families in one icon column. The audit
and what stays as typography:
[design/Text Glyph Icons - UX Review.dc.html](../../../../../../design/Text%20Glyph%20Icons%20-%20UX%20Review.dc.html).

### `text-glyph-coverage.test.ts`

Every non-ASCII character in JSX text, string literals (`.tsx` and `.ts`;
keycap labels come from `lib/platform.ts`) and stylesheet `content:` strings
must draw in a bundled face **in both `--font-sans` and `--font-mono`**.

- Coverage comes from each `.woff` `cmap`, narrowed by `unicode-range`.
- It checks both stacks, because it cannot see which one a site uses.
- A stack counts only its leading run of bundled families, so a fallthrough
  behind an OS font fails.
- A fallthrough's range must be disjoint from the face ahead of it, with equal
  weights.
- A Geist Mono-only character (such as box drawing) fails the sans stack. Fix
  it with a symmetric fallthrough, not an exception.
- `PENDING` lists characters no Geist face has, and their replacements. Today:
  the macOS `⌘` `⌥` keycaps and the refs browser's `⧉` copy mark.

### SVG glyphs in flex buttons

- **Give an SVG in a flex button `flex: 0 0 auto`.** The button needs
  `display: flex; align-items: center`, because a baseline glyph sits ~2px
  above the label's optical centre. A flex item defaults to `0 1 auto` and
  shrinks: a 12px mark drew at 9.86px at the 240px sidebar minimum.
- **Put an ellipsizing label in its own `__label` span.** `text-overflow`
  needs a block container, and the text is now a flex item.

`.sidebar-toolbar__btn > svg` is the glyph half of this rule.

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

- **Check a glyph as a raster at the real 15px**, magnified with
  nearest-neighbour. An enlarged SVG proves nothing. Contact sheet:
  [design/Palette Kind Glyphs - UX Review.dc.html](../../../../../../design/Palette%20Kind%20Glyphs%20-%20UX%20Review.dc.html).
- **Check a glyph against its neighbours, not alone.** A change can trade one
  collision for another; the palette's closed-shape worktree mark risked a
  worktree-vs-repo collision.

At 15px in a 24-unit viewBox, a 1.7–1.8 stroke is about 1.1 device pixels
and an `r2` circle is a 3px disc. Node count, radius and detail inside a
closed shape disappear. Only the **silhouette class** (open line art or closed
shape), fill vs stroke, and gross aspect survive. So the ⌘K palette's branch
and worktree glyphs (both an open trunk with nodes and a curve, differing only
in circles) were indistinguishable, while the folder stayed legible.

**One noun, one drawing, on every surface.** Use these before you draw a
variant:

- Branch: `BranchGlyph` (Lucide `git-branch`, the graph chip's mark).
- Linked worktree: `WorktreeGlyph`.
- Primary checkout: `CheckoutGlyph` (a house).
- Pull or merge request: `ChangeRequestGlyph`.
- Remote: `RemoteGlyph` (a cloud, checked at 15px for the sidebar's section
  headings).
- Repository: the palette's folder.

[design/Worktree Chip Glyphs - UX Review.dc.html](../../../../../../design/Worktree%20Chip%20Glyphs%20-%20UX%20Review.dc.html)
(2c) merged the separate sidebar, refs browser, graph and ⌘K palette glyphs.
A glyph also needs words: see "The kind glyph is labelled twice" in
`features/sidebar/AGENTS.md`.
