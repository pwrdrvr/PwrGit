# renderer/src/features/sidebar — AGENTS.md

## The kind glyph is labelled twice

Every `.overlay-result` in the ⌘K palette (`RepoSwitcherOverlay.tsx`) leads with
a 15px glyph naming the hit's kind. It carries its word two ways, and both are
load-bearing:

- an `.a11y-sr-only` span with the kind, **before** the glyph; and
- `hoverTooltip(tip, …)` on the `.overlay-result__kind` wrapper, with the same
  string.

The reason it is not an `aria-label` on the `<svg>`: the row is a
`role="option"`, so its accessible name is built from its own subtree — text in
the subtree is what actually gets announced when the listbox is arrowed, which
is why the folder label beside it uses the same `.a11y-sr-only` shape. The
`<svg>` itself is `aria-hidden` so the kind is not announced twice.

The reason the tooltip is on a wrapper `<span>` and not spread onto the `<svg>`:
`hoverTooltip`'s handlers are typed for `HTMLElement`, and `SVGSVGElement` is not
one. `tsc` catches this; the wrapper is the same workaround
`.overlay-result__folder` already uses.

Keep the string short — it is read aloud on **every** arrow key through the
list, so a sentence is punishing. `hitKindLabel()` is the one place it is
spelled.

Only three glyphs exist for four kinds: `isWorktreelessBranch()` sends both
`local_branch` and `remote_branch` to `BranchIcon`, so those two rows are the
identical drawing and only the label and `__meta` tell them apart. Options for
giving the remote its own mark are in
[design/Palette Kind Glyphs - UX Review.dc.html](../../../../../../../design/Palette%20Kind%20Glyphs%20-%20UX%20Review.dc.html),
turn 4. Legibility rules for a mark this small: "A 15px glyph separates by
silhouette, not by counting" in `styles/AGENTS.md`.

## Palette rows are asserted on by E2E

Several specs in `apps/desktop/e2e` locate rows with `.overlay-result` plus a
`hasText` filter, so **text added to a row lands in those filters**. The
sr-only kind label is deliberately a word no fixture branch name contains.

## The footer holds the profile's AI switch

`.sidebar__footer` sits under `.sidebar__list` and carries `AiFeaturesSwitch`.
It is a footer and not a list row because the switch belongs to the profile,
not to a repo. The rules it follows are in `settings/AGENTS.md`.

`.pane--sidebar` is a size container, and a size container is the containing
block for its `position: fixed` descendants. An overlay opened from inside the
sidebar must be portalled to `<body>`, as `AiConsentDialog` is. Rendered in
place, its backdrop covers only the sidebar and the dialog is squeezed to the
sidebar's width.
