# renderer/src/styles — AGENTS.md

## Appearance axes: `--sidebar-title-size` and `data-density`

Two independent axes, persisted in `general.sidebarTextSize` /
`general.sidebarDensity` and stamped on `<html>` by `lib/appearance.ts`.
**Defaults carry no attribute** — the bare `:root` block is the tuned default,
so returning to it means *removing* the attribute, not writing `md`.

Type reads the token; density only touches padding and gaps. Keeping them
independent is the point: large text at high density is a combination the old
fixed-height rows could not express. So don't add a font-size to a
`[data-density]` block, and don't add padding to the token ladder.

Sidebar rows are `min-height` + padding, never `height`. A fixed height cannot
grow with the type axis — the text clips instead. Same rule for any new row.

## Spacing inside `.sidebar__actions` belongs to the container

That block and the rows nested in it (`.clone-repo-row`, `.bulk-sync-actions`)
separate their children with `gap`, so the children declare no `margin-top`: a
margin on a flex child does not collapse into a gap, it adds to it, and the
seam draws double. The shared ghost-button rule (`.new-wt`, `.clone-repo`,
`.fork-repo`, `.add-folder`) hands out no margin for the same reason — those
four sit in four different parents. `.new-wt` and `.add-folder` set their own,
because theirs are plain blocks with no gap to inherit.

## PwrGit deliberately has no centre-column cap

PwrAgnt caps its chat column (`--chat-column-max: 940px`) because a transcript
is prose and long measures hurt reading. PwrGit's centre pane is a lineage
graph and a diff — data-dense surfaces that *want* the horizontal room. The
sidebar default likewise stays 320px against PwrAgnt's 408px: PwrGit rows carry
a short repo name, not a thread title plus chip rows.

These are considered divergences, not drift. Don't "align" them without a
reason that applies to this app's content.

## Text selection is opt-IN, not opt-out

`.app` sets `user-select: none`. Chrome is not a document: before this, any
drag in the sidebar painted a blue selection across every row it crossed, and
each row that later grew a drag affordance had to remember to opt out.

So a **new text surface a user would want to copy** must be added to the
opt-in list beside `.app` in `app.css` — diff bodies, file paths, commit
subjects and hashes, log output. Do not "fix" an unselectable surface by
adding `user-select: none` to its neighbor. `.selectable` is the escape hatch
for a one-off that doesn't warrant its own rule.

Form controls (`input`, `textarea`, `[contenteditable]`) opt back in near the
top of the file and must stay that way — a field you can't select inside is
broken, not merely unpolished.

## Busy state is `[aria-busy]`, and the arrow spins

Every control that re-reads state — `git fetch` over the network or a local
re-read — says "working" one way: an accent tint on the button, plus its
circular-arrow glyph rotating in place. Three treatments used to be visible on
one screen; see `design/Refresh Affordances - Normalization.dc.html`.

Three rules fall out of that, and a new refresh control needs all three:

- **Draw the glyph with `lib/RefreshGlyph.tsx`**, never a `↻` text character.
  Neither bundled face contains U+21BB, so that character resolves through an
  OS fallback and changes shape per platform. A text node also gives an animation
  nothing to target: the rule had to spin the *button*, and a bordered 24px box
  cartwheeled.
- **Paint busy from `[aria-busy="true"]`, not a class.** The blanket
  `prefers-reduced-motion` rule at the top of `app.css` kills every animation,
  so a motion-only busy state leaves reduced-motion users with no signal at
  all. A tint survives it. Keying paint to the ARIA state also means a control
  cannot look busy without announcing it.
- **Don't add your selector to the spin rule.** It keys off `.refresh-glyph`,
  which the shared component stamps, so it already covers you. Only the tint
  list enumerates buttons, because their shapes differ.

A glyph that is not a circular arrow — Pull's ↓, Push's ↑ — swaps to
`.wt-btn__spinner` instead. Spinning an arrow that means "down" reads as
broken. The rule is the glyph, not the control.

In-flight is `aria-disabled`, never `disabled`: Chromium blurs an element the
moment it becomes disabled, so activating one from the keyboard throws focus to
`<body>` for the length of the operation (SC 2.4.3). Guard the click handler
instead. `disabled` still belongs on a genuinely unavailable action.

One considered exception, `.lens-chip.is-empty`: a lens with nothing in it is
genuinely unavailable, and still uses `aria-disabled` plus a guarded click. A
`disabled` button receives no pointer events, so it can show no hover card —
and these five chips are icon-only, which makes "why is this one grey" a
question the chip itself has to answer. Reach for `disabled` on a genuinely
unavailable control unless it owes the user an explanation on hover.

**Dimming a focusable control with `opacity` dims its focus ring too.** An
`aria-disabled` control keeps focus, and nothing exempts an outline from its
own element's opacity. `filter: opacity()` halves it the same way, and a
`mask` removes it. So a new dimmed `aria-disabled` rule also joins the
focused-unavailable block in `app.css` (after every fade rule, so it wins the
tie). While focused, that block trades the fade for a muted paint at full
opacity: subtle border, transparent fill, `--text-subtle` text.

## No raw color literals outside `tokens.css`

`tokens.css` holds the theme blocks — `:root` (dark) and
`:root[data-theme="light"]`. They are the **only** place a hex / `rgb()` /
`rgba()` / `hsl()` literal may appear in renderer CSS. `app.css` and any other
stylesheet here must use `var(--token)`, or
`color-mix(in srgb, var(--token) X%, transparent)` for a derived alpha.

`pnpm lint:colors` (`scripts/lint-renderer-colors.mjs`, run in CI) enforces
this. It walks the whole renderer tree, not just this directory, so a
stylesheet dropped beside a feature component is covered too. A literal
anywhere else — including a stray `:root` block in `app.css`, or a second
`tokens.css` elsewhere in the tree — fails the build. Without it, the next
`color: #abcdef;` silently breaks light theme, because a literal doesn't flip
with `data-theme`.

Adding a one-off tint? Reach for inline `color-mix` on an existing token
before adding a token. Adding a genuinely new color? Define it in **both**
theme blocks.

The script has a substring allowlist for illustration assets that must not
theme-flip. It's empty today; keep it that way unless a surface truly can't
be themed, and document why in the script.

`theme-contract.test.ts` covers what the linter can't: both blocks declare the
same surface, every token has a reader, and the main process's pre-paint
literals still match the tokens they mirror.

## The palette is shared across the Pwr family

Values track PwrAgnt's `docs/UI-THEME.md` — the cross-app source of truth for
the "Tangerine Terminal" theme. Prefer PwrAgnt's token names when adding
something that has an equivalent there, so the block can eventually lift into
a shared package. PwrGit-only tokens (`--border-default`, `--accent-tint`,
`--bg-rail`, `--danger-on`, `--lane-*`, …) are commented as such in
`tokens.css`.

The block is a **subset** of PwrAgnt's contract on purpose: tokens no PwrGit
surface paints with are left out, because an unread token drifts silently.
Pull one back in from PwrAgnt's `docs/UI-THEME.md` when something needs it.

## A bundled font is requested by its `@font-face` name

A bundled face loads only when a rule names its exact `@font-face` family, and
nothing warns when none does: text falls through the stack. @fontsource calls
Geist's sans "Geist Sans", not upstream's "Geist" (the name PwrAgnt's
`docs/UI-THEME.md` uses). Asking for "Geist" left the bundled sans unloaded from
v0.1.0 through 0.17.0, so sans text drew in whatever the machine had installed:
the platform font, on a machine without Geist. `bundled-fonts.test.ts` fails
unless a font token leads with each family `fonts.css` imports.

`document.fonts.check('13px Geist')` returned `true` throughout. `check()` is
vacuously true for a family no face in the set matches, so it cannot show a face
loaded. Ask CDP's `CSS.getPlatformFontsForNode`, which names the font that drew
the glyphs and whether it is a web font.

The bundled Geist Sans is latin only, so a glyph outside it draws in the OS
font beside Geist. "↻ Fetch all repos" came apart exactly that way once Geist
loaded. That is why an icon is a stroked SVG component — `lib/*Glyph.tsx`, or
a local one like Sidebar's `ForkGlyph` — and not a text character. The refs
sections' `+` and `●` were the last two icons drawn as text; they are now
`<PlusGlyph />` and `<CheckoutGlyph />`.

**Don't convert the rest of the arrows on suspicion — probe first.** "Latin
only" is narrower than it sounds, and the characters this renderer actually
uses are mostly inside it. Asking `CSS.getPlatformFontsForNode` which font drew
each one, against `geist-sans-latin-600-normal.woff2`:

| char | drew in |
|---|---|
| `↑` U+2191, `↓` U+2193 (ahead/behind counts) | Geist SemiBold |
| `●` U+25CF, `→` U+2192, `·` U+00B7, `…` U+2026, `↵` U+21B5 | Geist SemiBold |
| `↻` U+21BB | **Menlo** — the OS |

So `↑3 ↓2` in a ref row and `●{dirty}` in the repo switcher are typographic
notation that renders in the bundled face, not latent bugs. U+21BB was the
outlier, and it is gone. A NEW character still needs the probe before it ships
— the answer is per-codepoint, and nothing warns when it falls through.

**Reading the cmap answers the same question without a running app**, and it
answers the *cause* rather than the symptom: `CSS.getPlatformFontsForNode`
names the font that drew a glyph, while the face's character map says whether
it could have. Parse the `.woff` beside the `.woff2` — it is zlib rather than
brotli, so `zlib.decompress` on each table in the WOFF directory is the whole
reader — and look the codepoint up in `cmap`. Probe U+21BB alongside whatever
you are asking about: a reader that finds it present is reading the file wrong.

The agent surfaces were checked that way against both faces
(`geist-sans-latin-600-normal.woff`, 538 codepoints;
`geist-mono-latin-400-normal.woff`, 225):

| char | in either bundled face? |
|---|---|
| `✦` U+2726 (the agent mark) | **no** — now `lib/AgentGlyph.tsx` |
| `▴` U+25B4, `▾` U+25BE (a caret) | **no** — now `lib/ChevronGlyph.tsx` |
| `‥` U+2025 (two-dot leader) | **no** — the ledger's hash range uses `…` |
| `✓` U+2713, `✕` U+2715 | **no** — still drawn as text elsewhere in the app |

`▾` and the two check marks predate the agent work and are still text in
TitleBar, ToastHost, DiffViewer and the remote activity card; converting them
is its own pass. Until it happens, a test that sweeps the renderer for
out-of-subset characters would fail on them, which is why there isn't one.

**An SVG in a flex button needs `flex: 0 0 auto`, and the label needs its own
element.** Both fall out of the swap and neither announces itself. A text node
sitting on the baseline draws the mark ~2px above the label's optical centre,
so the button wants `display: flex; align-items: center` — at which point the
glyph becomes a flex item, inherits `0 1 auto`, and gives up width to the label
(measured: a 12px mark drawn at 9.86px at the 240px sidebar floor). And
`text-overflow` needs a block container, so a button that used to ellipsize its
own text stops doing anything once its text is one of two flex items; the
truncation moves to a `__label` span. `.bulk-sync-action` is the worked
example.

## Theme selection uses one light attribute

The dark palette is the bare `:root`; Light (including resolved System mode)
sets `data-theme="light"` on `<html>`. Returning to dark removes the attribute.
The preload bootstrap and inline `<head>` script apply this before first paint;
the renderer appearance sync keeps every window live afterwards.

## Window chrome can't read tokens

`src/main/window-chrome.ts` hand-mirrors `--bg-app`, `--bg-titlebar` and
`--text-secondary`: `backgroundColor` and the Windows title-bar overlay paint
before the renderer exists. Change a token, change that file —
`theme-contract.test.ts` fails if they drift.

## TSX is not covered by the lint

`lint:colors` is CSS-only. SVG `fill=` / `stroke=` attributes and inline
styles in `.tsx` need a manual pass. Pass `var(--token)` strings instead of
literals — Chromium resolves custom properties in SVG presentation
attributes, which is how `GraphRow.tsx` renders lane colors.

## A 15px glyph separates by silhouette, not by counting

Row glyphs are drawn at 15px in a 24-unit viewBox, so a 1.7–1.8 stroke lands on
about 1.1 device pixels and an `r2` circle is a 3px disc whose interior fills
with antialiasing. Node count, radius and anything inside a closed shape are all
gone at that size; what survives is the **silhouette class** (open line art vs a
closed shape), fill vs stroke, and gross aspect.

This is why the ⌘K palette shipped a branch glyph and a worktree glyph that
nobody could tell apart: both were an open trunk on the left with round nodes
and a curve to an upper-right node, differing only in how many circles and how
big. The folder beside them was always legible, and never had more detail — it
had a different silhouette.

Two consequences when adding or changing one of these marks:

- **Check it as a raster, not as vector.** Blowing the SVG up proves nothing;
  render at the real 15px and magnify the bitmap with nearest-neighbour. A
  contact sheet and the two failing marks are in
  [design/Palette Kind Glyphs - UX Review.dc.html](../../../../../../design/Palette%20Kind%20Glyphs%20-%20UX%20Review.dc.html).
- **Check it against its neighbours, not alone.** Every glyph here reads fine on
  its own; the question is only ever whether it reads apart from the row above
  it. Moving the palette's worktree mark to a closed shape traded one collision
  for a possible worktree-vs-repo one, and that had to be drawn to settle.

A glyph also needs words. See "The kind glyph is labelled twice" in
`features/sidebar/AGENTS.md`.
