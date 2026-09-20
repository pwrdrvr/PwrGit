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

Only four glyphs exist for five kinds: `isWorktreelessBranch()` sends both
`local_branch` and `remote_branch` to `BranchIcon`, so those two rows are the
identical drawing and only the label and `__meta` tell them apart. The fifth,
`change_request` (an open PR whose head is not in the checkout), draws
`ChangeRequestIcon` and says the forge's own noun — "Pull request" or "Merge
request" — through `changeRequestLabel`, never a hard-coded word. Options for
giving the remote its own mark are in
[design/Palette Kind Glyphs - UX Review.dc.html](../../../../../../../design/Palette%20Kind%20Glyphs%20-%20UX%20Review.dc.html),
turn 4. Legibility rules for a mark this small: "A 15px glyph separates by
silhouette, not by counting" in `styles/AGENTS.md`.

## Palette rows are asserted on by E2E

Several specs in `apps/desktop/e2e` locate rows with `.overlay-result` plus a
`hasText` filter, so **text added to a row lands in those filters**. The
sr-only kind label is deliberately a word no fixture branch name contains.

## A PR is found through the ref that holds it

Main resolves a PR search hit to the worktree or branch holding its head
(`RepoIndexer.searchAll`), so a palette row keeps its own kind and only gains
`pr`. Two consequences in the renderer:

- **`buildPaletteItems` lifts the hit whose `pr.number` the query names** into
  the leading group beside an exactly-named repo. A bare number also reads as
  a commit-hash prefix and a path, and those groups otherwise sit above it.
- **A `change_request` hit has nothing to pin or poll** (`hasNoCheckout`), and
  picking it fetches first: `pr:fetchHead`, then `hitForLocation` turns the
  answer back into the branch hit the existing New-worktree path expects.

The refs browser (`RepoRefsModal` + `RepoChangeRequests.tsx`) matches with the
shared `changeRequestMatch`, so `106` means #106 — never #1060 — in both places.
With a query typed, every tab shows its own hit count, which is why the tag and
remote searches run while their tabs are hidden.

## The footer holds the profile's AI switch

`.sidebar__footer` sits under `.sidebar__list` and carries `AiFeaturesSwitch`.
It is a footer and not a list row because the switch belongs to the profile,
not to a repo. The rules it follows are in `settings/AGENTS.md`.

A dialog opened from here renders in place, like `NewWorktreeModal` and the
rest: `.overlay-backdrop` is `position: fixed` and covers the window, even
though `.pane--sidebar` carries `container-type: inline-size`. That reads as
though it would confine a fixed child — layout containment does — but Chromium
does not confine one here, measured at 1000×700 with the pane at 300px. Don't
portal a sidebar overlay to `<body>` on that theory.
