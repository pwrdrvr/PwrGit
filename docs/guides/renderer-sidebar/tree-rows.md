# Sidebar tree rows and selection

This guide covers the sidebar footer, pins, the worktree list cap, refs-browser rows, selection, anchoring, and section-heading fit.

## The sidebar footer holds the profile's AI switch

`.sidebar__footer` sits under `.sidebar__list` and carries `AiFeaturesSwitch`.
It is a footer, not a row: the switch belongs to the profile
(`settings/AGENTS.md`).

**Do not portal a sidebar overlay to `<body>`.** Dialogs render in place, like
`NewWorktreeModal`. `.overlay-backdrop` (`position: fixed`) covers the window.
`.pane--sidebar` has `container-type: inline-size`, but Chromium does not
confine the fixed child (measured at 1000×700, pane 300px).

## Three things pin, and a branch pin follows the branch

Pins live in `repos.pinned`, `worktrees.pinned` and `pinned_branches`
(migration 0036). `local_branches` cannot hold a pin: it is a derived search
table, re-synced when a branch gains a worktree or a ref listing changes.
`worktrees.pinned` cannot pin an unchecked-out branch.

Rules (all in `RepoIndexer`):

- **A worktree reads as pinned when its branch is** (`PINNED_WORKTREE_SQL`).
  Pin `main`, add a worktree on it later: Pinned shows the worktree.
- **`worktree:setPin(false)` also deletes the branch's row.** Otherwise
  unpinning a branch-derived pin does nothing.
- **`branch:setPin` pins a holding worktree directly** and writes a row only
  for an unheld branch. `Repo.pinnedBranches` lists those rows, so no branch
  shows twice.
- **A rename moves the pin** (`renamePinnedBranch`, before the refresh). The
  ref listing prunes pins on branches git no longer has.

**Only local branches pin** (remote-tracking refs have no local name, change
requests no checkout). The ⌘K and refs-browser stars skip them; the refs
browser keeps an empty slot so names align.

## Other worktrees shows six, and the row you are on ghosts in

`sliceOtherWorktrees` (`repo-view.ts`) draws the first six in-flight rows of
`remaining` (sort chip order), then "Finished N" and "View all N worktrees…",
which open the refs browser's Worktrees tab (`RepoWorktreeTable`). The heading
counts all of `remaining`, so headings sum to the repo row.
Design: `design/Worktree List Cap - UX Review.dc.html`.

- **`isFinishedWorktree` is the only test** (shared with Focused's Working
  block): clean (`dirty === 0`), not pinned, and done — PR merged or closed,
  upstream gone, or old enough in main.
- **A merged or closed PR counts only if its `headOid` equals the checkout's
  `head`.** After a squash merge nothing else in Git ties the branch to main,
  and `--not --remotes` counts every commit as unpushed.
- **A bare `mergedIntoDefault` waits 24 hours**, so a new branch with no
  commits is not "finished".
- **Selecting a row never opens the disclosure.** A selected row outside the
  six draws as a ghost (`WorktreeRow` with `ghost`), not draggable, under a
  "visiting" rule or above a closed disclosure. ⌘⇧↑/↓ moves only the drawn
  six. `displayIds` is the drawn order (ghost included) for posinset and
  arrows.
- **One lifecycle word per row.** A merged or closed chip hides `gone`. An
  open chip beside `gone` is stale; main refreshes it on the gone transition
  (`github/AGENTS.md`).

## The refs browser's rows are focus stops

Keys (`lib/refsRowKeys.ts`): ↓ from the filter enters the rows; ↑/↓ walk;
Home/End jump. Space pins — a **row** key, because in the filter it types a
space. Enter or double-click runs the button inside `data-refs-primary`
(`RefRowActions`' first slot). Copy targets take `deferForDoubleClick`, so a
double-click on the name does not copy.

- **The actions column is three fixed slots (`RefRowActions`) on every tab**,
  Remotes cards' branch rows included. Do not hand-roll row buttons outside it.
- **`--refs-actions-w` in `app.css` is the slot widths plus gaps.** Change a
  slot, change the token, or the columns drift.
- **Size the grid track with the token, never by hand.** A fixed 112px track
  on the Remotes cards wrapped two button labels.

**Anything a sidebar row can do, its refs-browser row must do too**: the
browser reaches rows past the short list. Add each new verb, chip or gesture
to `RepoRefsModal` and `ChangeRequestTable`, with parity tests in
`RepoRefsModal.test.tsx` and `RepoChangeRequestSection.test.tsx`.
`WorktreeHolderChip` is the shared "which worktree holds this" chip.

## At most one thing looks selected

A row is lit by `is-selected` (the worktree on screen) or `is-multiselected`
(the ⌘/Shift batch). This broke five times before the rules moved into
`worktree-batch.ts`, held by the model in `worktree-batch.property.test.ts`.
A new selection gesture goes there, and into the model as a command.

- **The row on screen is always a member of the batch** when the batch is in
  its repository; otherwise "N selected" counts one row fewer than are lit.
- **The batch follows the row on screen only when that row changes** (a pick,
  an expand, a jump, Hide, a change request), never on a refresh.
- **A change request on screen empties the batch** and holds the selection
  for its own repository (`selectionHolder`).

## The sidebar holds the reader's row across a selection change

`sidebar-anchor.ts` remembers the last pressed, focused or scrolled row
(`data-nav-anchor`, `data-wt-id`, `data-repo-id`) and its offset. A
press-caused selection change holds it still briefly; Back restores it by key.
Both run in Sidebar's layout effects before paint and suspend the "reveal the
selection" scroll.

- **A row that a user can jump *from* needs a stable `data-nav-anchor`.**
- A ghost keeps `data-wt-id`, so reveals and anchors find it.

## Section headings never overlap, wrap, or cut a count

Section rows for Worktrees / PRs / Branches / Tags / Remotes can be 170px
(narrow sidebar plus repository index). Each repository block steps them down
by fit, **never by a breakpoint**: `RepoRow` wraps them in `.repo-sections` and
runs `useStepLadder` (`section-fit.tsx`; step CSS in `app.css`). Design: `design/Sidebar Section Headings - UX Review.dc.html`,
2c and turn 3.

- **Cumulative steps:** `fit-short` ("Pull requests" → "PRs"), `fit-glyphs`
  (labels → glyph beside count), then `fit-fold-1..3` (gone, then behind,
  then ahead fold into a +N chip). Totals, "N failing", refresh buttons and
  Recent never step. Past the last step a row clips at its edge.
- **Per repository block, not per tree** (operator's decision): a quiet repo
  keeps its words where a busy one folds.
- **Fit test: every heading row's items end inside its box** (`headingsFit`
  over `.ref-section__head-wrap` and the Worktrees `.wt-section__head`). A new
  heading needs one of those classes.
- **Everything a step acts on is rigid** (`flex: 0 0 auto`): disclosure,
  chips, ⟳, Recent. A shrinkable item ellipsizes and passes the test. Only
  "on main" takes leftover space.
- **A section with its own data calls `useRefitSections()`**, as
  `RepoRefsSections` and `RepoChangeRequestSection` do: it re-renders after
  `RepoRow`.
- **A reload keeps the last answer on screen.** A section reloads when its
  `Repo` object changes. `useRepoTree` swaps in only the repositories a
  `repo:changed` names, but one without `repoIds` replaces every object.
  Draw "…" only before the first answer, and let only the newest reload
  land, as `RepoRefsSections` does.
- **The ladder observes `.repo-block`, not `.repo-sections`.** The sections
  unmount with the disclosure, so a mount-time observer would watch a
  detached node after re-expand.
- **Words leave the screen, not the accessible name.** A stepped label is
  visually hidden, so the name still says "Branches 533" and contains the
  visible "PRs" (SC 2.5.3). `steppedTooltip` shows "Branches · 533" on hover
  only after the step.
- **Glyphs are the shared marks:** `WorktreeGlyph`, `ChangeRequestGlyph`,
  `BranchGlyph`, `TagGlyph`, `RemoteGlyph` (Lucide's cloud).
- **+N is one chip per fold step** (`foldChips`); CSS shows only the deepest.
  Its card and name list the folded counts. A click opens the refs browser on
  Branches, unfiltered, because the chip can mix statuses.

The repository row has its own ladder. Test: the name is whole (`isCutShort`,
a text range against the box, not `scrollWidth`). Steps: `rr-no-marks` (forge
chip and `.repo-mark`s leave; `.badge--source`, the fork mark that carries an
upstream pull, is an action and stays), then `rr-short-count` ("279 wts" →
worktree glyph + 279). Then the name ellipsizes. Star and kebab never step.

**Run `e2e/section-headings.spec.ts` after you touch heading markup or CSS**
(jsdom has no layout). It measures a Vite build of the real `RepoRow` at 270,
222, 194 and 170px in a hidden Electron window (`e2e/AGENTS.md`, "Harness
pages").
