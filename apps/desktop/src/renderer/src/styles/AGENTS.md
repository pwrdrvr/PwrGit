# renderer/src/styles — AGENTS.md

## No raw color literals outside `tokens.css`

`tokens.css` holds the theme blocks — `:root` (dark) and
`:root[data-theme="light"]`. They are the **only** place a hex / `rgb()` /
`rgba()` / `hsl()` literal may appear in renderer CSS. `app.css` and any other
stylesheet here must use `var(--token)`, or
`color-mix(in srgb, var(--token) X%, transparent)` for a derived alpha.

`pnpm lint:colors` (`scripts/lint-renderer-colors.mjs`, run in CI) enforces
this. A literal anywhere else — including a stray `:root` block in `app.css` —
fails the build. Without it, the next `color: #abcdef;` silently breaks light
theme, because a literal doesn't flip with `data-theme`.

Adding a one-off tint? Reach for inline `color-mix` on an existing token
before adding a token. Adding a genuinely new color? Define it in **both**
theme blocks.

The script has a substring allowlist for illustration assets that must not
theme-flip. It's empty today; keep it that way unless a surface truly can't
be themed, and document why in the script.

## The palette is shared across the Pwr family

Values track PwrAgnt's `docs/UI-THEME.md` — the cross-app source of truth for
the "Tangerine Terminal" theme. Prefer PwrAgnt's token names when adding
something that has an equivalent there, so the block can eventually lift into
a shared package. PwrGit-only tokens (`--border-default`, `--accent-tint`,
`--bg-rail`, `--danger-on`, `--lane-*`, …) are commented as such in
`tokens.css`.

## Light theme is authored but not reachable

The `:root[data-theme="light"]` block is complete; nothing sets `data-theme`
yet. When the appearance plumbing lands, it flips the attribute and this block
takes over — no color values should need to move.

## TSX is not covered by the lint

`lint:colors` is CSS-only. SVG `fill=` / `stroke=` attributes and inline
styles in `.tsx` need a manual pass. Pass `var(--token)` strings instead of
literals — Chromium resolves custom properties in SVG presentation
attributes, which is how `GraphRow.tsx` renders lane colors.
