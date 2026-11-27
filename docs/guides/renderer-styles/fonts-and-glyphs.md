# Bundled fonts and glyphs

This guide covers which bundled font faces draw which characters, how to check glyph coverage, and how to design icon glyphs that stay legible at 15px.

Code paths in backticks are relative to [apps/desktop/src/renderer/src/styles](../../../apps/desktop/src/renderer/src/styles/).

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
| `▴` U+25B4, `▾` U+25BE (a caret) | **no** — now `lib/ChevronGlyph.tsx` |
| `‥` U+2025 (two-dot leader) | **no** — the ledger's hash range uses `…` |
| `✓` U+2713, `✕` U+2715 | **no** — now `CheckGlyph`, `CloseGlyph` |
| `⚙` `＋` `ⓘ` `⚠` `⌕` `⟳` `▸` | **no** — now `SettingsGlyph`, `PlusGlyph`, `InfoGlyph`, `WarningGlyph`, `SearchGlyph`, `RefreshGlyph`, `ChevronGlyph` |
| `⑂` U+2442, `⌂` U+2302 (branch, worktree holder) | **no** — now `lib/BranchGlyph.tsx`, `lib/WorktreeGlyph.tsx`, `lib/CheckoutGlyph.tsx` |

On macOS these drew in five different families in one icon column. The audit
and what stays as typography:
[design/Text Glyph Icons - UX Review.dc.html](../../../design/Text%20Glyph%20Icons%20-%20UX%20Review.dc.html).

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

## A 15px glyph separates by silhouette, not by counting

- **Check a glyph as a raster at the real 15px**, magnified with
  nearest-neighbour. An enlarged SVG proves nothing. Contact sheet:
  [design/Palette Kind Glyphs - UX Review.dc.html](../../../design/Palette%20Kind%20Glyphs%20-%20UX%20Review.dc.html).
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

[design/Worktree Chip Glyphs - UX Review.dc.html](../../../design/Worktree%20Chip%20Glyphs%20-%20UX%20Review.dc.html)
(2c) merged the separate sidebar, refs browser, graph and ⌘K palette glyphs.
A glyph also needs words: see "The kind glyph is labelled twice" in
`features/sidebar/AGENTS.md`.
