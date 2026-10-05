# renderer/src/features/change-request — AGENTS.md

The PR view: a change request picked in the sidebar, drawn in the main pane
with no worktree. Design: `design/Change Request View - UX Review.dc.html`
(2a; 3 for the header and provenance line).

## It is a second kind of place, beside a worktree

`App` keeps the worktree `selection` and, separately, a `changeRequest` pick.
While a pick is set the main pane draws `ChangeRequestView`, the rail draws
`ChangeRequestRail`, and the title bar's crumb names the PR. The worktree view
stays **mounted and hidden** (`.worktree-view`, `display: none`), so leaving
the PR (Esc, or picking any worktree) returns to it with its graph, scroll
and lens untouched. Anything that selects a worktree must clear the pick —
`selectWorktree` does, so route through it.

The sidebar learns which row is on screen from `ChangeRequestSelectionContext`
(`change-request-selection.tsx`), not through props. App memoizes the value;
keep it memoized or every row re-renders on every App render.

## It asks git, never the forge

`useChangeRequestView` calls `pr:view` (main's `OpenPrService.view`, see
`src/main/github/AGENTS.md`). The header paints at once from the list row the
pick carried; everything below waits for git.

- **First ask never fetches.** If the answer is `needsFetch`, a pointer pick
  asks again with `fetch: true` straight away. A keyboard pick waits
  `KEYBOARD_FETCH_DWELL_MS`, so holding ↓ down the list costs no fetch per
  row. Nothing is ever checked out — the line says so while it fetches.
- **Two ends, one shown.** When the local branch and the forge's head differ,
  `provenance.ts` says which end the diff is drawn to and offers the other.
  Keep that sentence honest: it is the only thing telling the reader the diff
  may not be what the forge shows.
- **A commit's diff and image previews go through any worktree** of the repo
  (`diff:commit`, `diff:image`) — the object store is shared, so the view
  needs no worktree of its own.

## The rail is its table of contents

Changes lists the files of what the main pane draws; a click scrolls the diff
to `.diff-file[data-path]` (set in `DiffViewer`). Commits switches the scope
between all changes and one commit. Rows are buttons, so they are focus stops.
