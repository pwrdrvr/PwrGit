# Repository index, pins and menus

This guide covers the repository index column, pinned-repository order, shared context menus, and Hide and Remove.

Code paths in backticks are relative to [apps/desktop/src/renderer/src/features/sidebar](../../../apps/desktop/src/renderer/src/features/sidebar/).

## The repository index is a map beside the tree, not part of it

`RepoIndex.tsx` lists the lens's repositories by name, left of
`.sidebar__list`, under the same folder labels. Rules: `repo-index.ts`
(unit-tested).

- **It uses only the width past the tree's floor**: the sidebar's 240px
  minimum (`SIDEBAR_MIN_WIDTH`, shared with App's resize). The index is
  `max-content`, capped at sidebar width minus the floor (`--repo-index-max`,
  written onto the aside so a drag re-renders nothing). It hides when the cap
  is below the probe's `calc(7ch + 19px)` in its own font. **Never replace the
  probe with a breakpoint**: it moves with the text-size axis.
- **`.sidebar__tree-pane` is the tree's size container** (no padding or
  border, so it equals `.pane--sidebar` when the index is hidden). Narrow
  rules in the tree (the 260px ghost tag) follow the tree's width.
- **A name selects like its row, then scrolls.** `jumpToRepo` and the row
  click share `selectPrimaryUnlessHeld` (primary worktree, unless the
  selection is already in that repo); scroll-only showed two selections. It
  also calls `releaseSidebarAnchor` and `onExpandRepo`, and puts the
  `.repo-block` at the top of the readable area (under the sticky folder
  heading when grouped). Measure the block, not the sticky `.repo-row`, which
  reports where it is stuck. A repo near the end gets `.sidebar__jump-room`, a
  blank tail of the missing height, dropped once it scrolls away.
- **Only the selection gets a tint**: `.is-selected` is the collapsed tree
  row's accent name on `--bg-hover-strong`. Scroll position (`.is-current`,
  `.is-in-view`) is a rail only; tinting both shows two selections.
- **Width is natural until dragged.** The grip is the shell's `PaneResizer`
  (drag, arrows, double-click for natural), saved as `pwrgit.repoIndexWidth`.
  Its bounds come from the column's computed `min-width` and `max-width`, so a
  drag cannot cross the probe minimum or the tree's floor.
- **Scroll-spy names the block whose header is stuck** (`spyRepos`: first
  block whose bottom is below the line), not the most visible one. The index
  scrolls it into view unless pointer or focus is there. Spy state lives in
  `RepoIndex`, so a scroll re-renders only the column.
- **The hover hold spans index and tree** (`held.containerProps` on
  `.sidebar__body`), so Focused cannot re-sort under a moving pointer.
- **Names move as tree rows move** (below). The index gets the tree's own
  `repoDrag` instance and `moveRepo`, never a second hook: held and aimed
  state shows in both views, a name drops on a tree row, and the two can
  never order repositories differently.
- **Accessibility:** a `nav` named "Repository index", outside `role="tree"`,
  with a list per folder and a button per repository. The spy item has
  `aria-current="location"`. One roving tab stop: ↑/↓, Home/End, typeahead,
  Enter or Space to jump. Display options → Repo index turns it off
  (`pwrgit.repoIndex`). That kebab is always drawn; its hint says why an
  enabled index is not showing.

Design: `design/Sidebar Repo Index - UX Review.dc.html`, 3a and turn 4.

## Pinned repositories lead every lens, in one order

As PwrAgnt's project index: pins first, a seam, then the rest. Rules in
`repo-view.ts` (`splitPins`, `filterReposByLens`, `movePin`), held by
`repo-view.pins.property.test.ts`.

- **A pin is the repository's own star** (`repoLeads`). A pinned worktree or
  branch admits its repository to the Pinned lens, below the seam.
- **No lens puts an unpinned repository above a pinned one.** Through 0.59.7
  All was strictly A-Z and Focused led with the current repository. The rest
  keeps the lens's order: Focused's ladder, by name elsewhere.
- **The pins' order is one list** (`order`, then name), the same in every
  lens and both columns. A lens may list only some pins, so a move goes
  through `movePin` over the profile's whole order; never renumber the pins
  on screen.
- **`Sidebar` splits again after the hover hold**, so a star pressed under
  the pointer crosses the seam at once.
- **Grouped by folder, the pins form a Pinned group above the folders**
  (`PINNED_GROUP`), so they stay one list and lead there too.
- **The seam is a drop target** (`.repo-seam`, `.repo-index__seam`; `PIN_SEAM`
  in `Sidebar`). A drop among the pins moves or pins; a pin dropped on or
  below the seam is unpinned, and the seam lights instead of a row line. Two
  repositories below the seam refuse each other.
- **With nothing pinned, a held repository opens the ghost Pin slot**
  (`.repo-pin-slot`, `.repo-index__pin-slot`; `PIN_SLOT`), stuck to the top of
  both columns. Only a drop inside it pins. It mounts a task after
  `dragstart` (a timer: an unpainted window runs no frames), because it moves every row down, and sits in `.sidebar__list`,
  not in the tree.
- **The tree's seam is labelled "Repositories" only when rows follow it.**
  Grouped, or in a lens that lists only pins, it is a bare hairline.
- **Only a pin draws the grip and takes ⌘⇧↑/↓** (`arrangeable` is
  `repoLeads(repo)`). `showPinVia` is the Pinned lens's "via wt" badge.
- **The seam is `aria-hidden` in both columns, and never a child of the
  `tree`**, which may own only treeitems and groups
  (`e2e/repo-reorder.spec.ts`, "valid, nested roles"). The last pin's
  `RepoRow` draws it at the end of its `.repo-block` (`after`). Do not wrap
  the pins in a group instead: a row that crosses the seam would change
  parent, and React would remount it with its open sections.
- **The star puts focus back on itself** (`toggleRepoPin`): its row moves,
  and Chromium drops focus from a moved node.

Design: `design/Pinned Repos Lead Every Lens - UX Review.dc.html` (1c, turn 3,
4a). It reverses `Repo Index Reorder`, 2b.

## One object, one menu

- **A worktree's entries come from `shell/worktree-menu-items.ts`** on every
  surface: the row's kebab, its right-click, the graph header's kebab and the
  refs browser's Worktrees tab. Don't hand-build a list beside it. They were
  four lists, and right-click lost Reset while only the header could Fork.
- **A repository's entries come from `repo-menu-items.ts`**: the tree row's
  kebab, its right-click and Menu key, and a right-click (or Menu key) on its
  name in the repository index. The index draws no menu of its own: Sidebar
  hands the request to that repository's `RepoRow` (`indexMenu`), as PwrAgnt's
  project index opens the project header's. The order is PwrAgnt's: Pin/Unpin
  (and, for a pin, Move up/down, which are `moveRepo`), the path, the
  repository's verbs, then Hide and Remove. Held by
  `repo-menu-items.property.test.ts` and, against the row's menu as oracle,
  `Sidebar.repo-index.test.tsx`. Design:
  `design/Repo Index Context Menu - UX Review.dc.html`, 2a and 2b.
- **An entry that can't run on this row stays, disabled with a `hint`.** The
  primary checkout's Remove points at Remove repository… on the repo row.
- **A change request's Open/Copy link entries come from
  `shell/change-request-menu-items.ts`**, in the forge's words. Never "PR #N".
- **The repo row's kebab shows at rest on the repository that holds the
  selection** (`.holds-selection`). Hidden there, people opened the primary
  checkout's look-alike kebab one row down and read Repository setup… as
  missing from that sidebar lens. No lens changes any menu.

## Hide and Remove live on the repo row's menu

- **Hide asks nothing** and offers Undo on its toast.
- **Remove opens `RemoveRepositoryDialog`.** Its rules (`removalStatus`,
  `checkoutChoices`) live in `@pwrgit/shared`, so the dialog enables exactly
  what main accepts.
- **Both move the selection to the neighbouring repository first**
  (`selectNeighbourOf`); otherwise the window falls back to the first repo.
- **Hidden repositories return through** `HiddenReposButton` (footer row,
  only while something is hidden), Settings → Profiles, and the palette (full
  name only).
- **Do not filter hidden rows in the renderer.** Main excludes them from
  `repo:search`.

Design: `design/Remove and Hide Repository - UX Review.dc.html`.
