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
  `--font-mono` contains no U+21BB, so that character resolves through an OS
  fallback and changes shape per platform. A text node also gives an animation
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
