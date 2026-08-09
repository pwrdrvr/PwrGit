# renderer/src/styles — AGENTS.md

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

## Light theme is authored but not reachable

The `:root[data-theme="light"]` block is complete; nothing sets `data-theme`
yet. When the appearance plumbing lands, it flips the attribute and this block
takes over — no color values should need to move.

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
