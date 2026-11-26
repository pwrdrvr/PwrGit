# renderer/src/features/sidebar — AGENTS.md

Rules for the sidebar tree, ⌘K palette, toolbar, refs browser and the dialogs
they open. Detail lives in `docs/guides/renderer-sidebar/`; read the guide
each section names before you change that code.

## The kind glyph is labelled twice

Each ⌘K palette row's kind glyph keeps an `.a11y-sr-only` label before it and
a `hoverTooltip` on its wrapper `<span>`, with the same short string from
`hitKindLabel()`. The `<svg>` stays `aria-hidden`, with no `aria-label`.
Read [⌘K palette and PR
lookup](../../../../../../../docs/guides/renderer-sidebar/palette.md#the-kind-glyph-is-labelled-twice)
before changing a palette row's glyph or its labels.

## Palette rows are asserted on by E2E

**Text that you add to a palette row lands in E2E filters.** Specs find rows
with `.overlay-result` plus `hasText`.

## Typing a repository's name puts it first

`buildPaletteItems` groups main's answer, and a repository the query names
always comes first. Main keeps the same promise before its 60-row cap.
Read [⌘K palette and PR
lookup](../../../../../../../docs/guides/renderer-sidebar/palette.md#typing-a-repositorys-name-puts-it-first)
before changing palette ranking or grouping.

## A PR is found through the ref that holds it

A PR hit resolves to the worktree or branch that holds its head, and the
query's PR number lifts it. A `change_request` hit has nothing to pin or poll.
Read [⌘K palette and PR
lookup](../../../../../../../docs/guides/renderer-sidebar/palette.md#a-pr-is-found-through-the-ref-that-holds-it)
before changing PR hits in the palette or refs browser.

## The sidebar's PR section reads a cache and asks nothing per PR

`RepoChangeRequestSection` draws main's cached open list: no per-row lookup.
Key rows by `changeRequestKey`, never the number alone.
Read [⌘K palette and PR
lookup](../../../../../../../docs/guides/renderer-sidebar/palette.md#the-sidebars-pr-section-reads-a-cache-and-asks-nothing-per-pr)
before changing the sidebar's PR section.

## The palette asks in this window's profile

`repo:search` carries `windowProfileId()`. Do not filter or re-sort by profile
in the renderer.
Read [⌘K palette and PR
lookup](../../../../../../../docs/guides/renderer-sidebar/palette.md#the-palette-asks-in-this-windows-profile)
before changing palette search scope or the profile control.

## The sidebar's actions are one toolbar row; search is in the title strip

`SidebarToolbar` holds Add ▾, the sync button and the maintenance wrench.
Accessible names contain the visible label, and E2E finds buttons by name;
rename only with the specs.
Read [Sidebar toolbar and bulk
sync](../../../../../../../docs/guides/renderer-sidebar/toolbar-and-sync.md#the-sidebars-actions-are-one-toolbar-row-search-is-in-the-title-strip)
before changing the toolbar, its menus or the empty-profile path.

## Focused means something you did

`focusedRepos` admits a repo only for the current worktree, a pin, a visit in
PwrGit, or a commit you authored. Don't add HEAD's date or
dirty/ahead/unpublished back to the repo ladder.
Read [Sidebar toolbar and bulk
sync](../../../../../../../docs/guides/renderer-sidebar/toolbar-and-sync.md#focused-means-something-you-did)
before changing the Focused lens.

## One sync button (Fetch ▾ / Pull ▾) and the bulk-sync run

The menu configures; the face runs. The run is not the dialog: one run at a
time, and while it is live Escape minimises, never cancels.
Read [Sidebar toolbar and bulk
sync](../../../../../../../docs/guides/renderer-sidebar/toolbar-and-sync.md#one-sync-button-fetch---pull--and-the-bulk-sync-run)
before changing the sync button, `useBulkSyncRun.ts`, `BulkSyncDialog` or its
toast.

## A Maintenance run outlives its dialog

Main and the dialog fold the same events; use `maintenance-attach.ts` to
reattach, and subscribe before asking.
Read [Repository maintenance
dialog](../../../../../../../docs/guides/renderer-sidebar/maintenance.md#a-maintenance-run-outlives-its-dialog)
before changing how the Maintenance dialog tracks a run.

## Maintenance keeps one frame, and each footer ends with its primary

`.modal.maintenance` is `height: min(720px, 82vh)` on every screen; never size
it to content. The last footer button is the screen's primary.
Read [Repository maintenance
dialog](../../../../../../../docs/guides/renderer-sidebar/maintenance.md#maintenance-keeps-one-frame-and-each-footer-ends-with-its-primary)
before changing Maintenance layout or footers.

## Clones is Combined's step 4, and the offer runs it alone

Combined runs Repair → Worktrees → Local branches → Clones → Garbage
collection (`STEP_ORDER`).
Read [Repository maintenance
dialog](../../../../../../../docs/guides/renderer-sidebar/maintenance.md#clones-is-combineds-step-4-and-the-offer-runs-it-alone)
before changing the Clones step or its offer toast.

## Sidebar overlays render in place

Render sidebar overlays inside the sidebar. Read [Sidebar tree rows and
selection](../../../../../../../docs/guides/renderer-sidebar/tree-rows.md#sidebar-overlays-render-in-place)
before adding a sidebar overlay.

## Three things pin, and a branch pin follows the branch

Pins live in `repos.pinned`, `worktrees.pinned` and `pinned_branches`;
`local_branches` cannot hold a pin. Only local branches pin.
Read [Sidebar tree rows and
selection](../../../../../../../docs/guides/renderer-sidebar/tree-rows.md#three-things-pin-and-a-branch-pin-follows-the-branch)
before changing pin storage or pin rules in `RepoIndexer`.

## Other worktrees shows six, and the row you are on ghosts in

`sliceOtherWorktrees` draws six rows; `isFinishedWorktree` is the only
finished test. Selecting a row never opens the disclosure.
Read [Sidebar tree rows and
selection](../../../../../../../docs/guides/renderer-sidebar/tree-rows.md#other-worktrees-shows-six-and-the-row-you-are-on-ghosts-in)
before changing the worktree list cap or finished rules.

## The refs browser's rows are focus stops

The actions column is three fixed `RefRowActions` slots on every tab.
**Anything a sidebar row can do, its refs-browser row must do too.**
Read [Sidebar tree rows and
selection](../../../../../../../docs/guides/renderer-sidebar/tree-rows.md#the-refs-browsers-rows-are-focus-stops)
before changing refs-browser rows, keys or a sidebar row's verbs.

## Clone and Fork… ask the forge the same question

Creating a repository is never a default. **Nothing below the source may move
after the pick.**
Read [Clone, fork and route
dialogs](../../../../../../../docs/guides/renderer-sidebar/clone-and-fork.md#clone-and-fork-ask-the-forge-the-same-question)
before changing the Clone or Fork dialogs.

## Fork tracking repair draws the route, from one dialog

**Only `ForkTrackingRecoveryDialog` changes the branch's upstream.** Offer
another fork only after the forge confirms it.
Read [Clone, fork and route
dialogs](../../../../../../../docs/guides/renderer-sidebar/clone-and-fork.md#fork-tracking-repair-draws-the-route-from-one-dialog)
before changing fork tracking repair.

## The route is drawn wherever a fork changes where a branch goes

**Roles come from `routedRemotes` in `@pwrgit/shared`, never from a remote's
name.**
Read [Clone, fork and route
dialogs](../../../../../../../docs/guides/renderer-sidebar/clone-and-fork.md#the-route-is-drawn-wherever-a-fork-changes-where-a-branch-goes)
before changing `RouteStrip`, `RouteLine` or a route's roles.

## At most one thing looks selected

Selection rules live in `worktree-batch.ts`, held by
`worktree-batch.property.test.ts`. A new selection gesture goes there, and
into the model as a command.
Read [Sidebar tree rows and
selection](../../../../../../../docs/guides/renderer-sidebar/tree-rows.md#at-most-one-thing-looks-selected)
before changing selection or the batch.

## The sidebar holds the reader's row across a selection change

**A row that a user can jump *from* needs a stable `data-nav-anchor`.** A
ghost keeps `data-wt-id`.
Read [Sidebar tree rows and
selection](../../../../../../../docs/guides/renderer-sidebar/tree-rows.md#the-sidebar-holds-the-readers-row-across-a-selection-change)
before changing `sidebar-anchor.ts` or scroll-on-select.

## Section headings never overlap, wrap, or cut a count

Section headings step down by fit, **never by a breakpoint**
(`useStepLadder`). Run `e2e/section-headings.spec.ts` after you touch heading
markup or CSS.
Read [Sidebar tree rows and
selection](../../../../../../../docs/guides/renderer-sidebar/tree-rows.md#section-headings-never-overlap-wrap-or-cut-a-count)
before changing section headings, the repo row's ladder or their CSS.

## The repository index is a map beside the tree, not part of it

`RepoIndex.tsx` uses only the width past the tree's 240px floor. **Never
replace the probe with a breakpoint.** It shares the tree's `repoDrag` and
`moveRepo`.
Read [Repository index, pins and
menus](../../../../../../../docs/guides/renderer-sidebar/repo-index-and-menus.md#the-repository-index-is-a-map-beside-the-tree-not-part-of-it)
before changing the repository index.

## Pinned repositories lead every lens, in one order

No lens puts an unpinned repository above a pinned one, and the pins' order is
one list. Move pins through `movePin`.
Read [Repository index, pins and
menus](../../../../../../../docs/guides/renderer-sidebar/repo-index-and-menus.md#pinned-repositories-lead-every-lens-in-one-order)
before changing pin order, the seam or the Pin slot.

## One object, one menu

Worktree entries come from `shell/worktree-menu-items.ts`, repository entries
from `repo-menu-items.ts`; don't hand-build a list beside them. An entry that
can't run stays, disabled with a `hint`.
Read [Repository index, pins and
menus](../../../../../../../docs/guides/renderer-sidebar/repo-index-and-menus.md#one-object-one-menu)
before changing any sidebar context menu.

## Hide and Remove live on the repo row's menu

Both move the selection to the neighbouring repository first. **Do not filter
hidden rows in the renderer.**
Read [Repository index, pins and
menus](../../../../../../../docs/guides/renderer-sidebar/repo-index-and-menus.md#hide-and-remove-live-on-the-repo-rows-menu)
before changing Hide, Remove or hidden-repository paths.
