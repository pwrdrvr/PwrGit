# renderer/src/features/sidebar — AGENTS.md

## The kind glyph is labelled twice

Each `.overlay-result` in the ⌘K palette (`RepoSwitcherOverlay.tsx`) starts
with a 15px kind glyph. Keep both labels:

- an `.a11y-sr-only` span with the kind, **before** the glyph;
- `hoverTooltip(tip, …)` on the `.overlay-result__kind` wrapper, same string.

Rules:

- **No `aria-label` on the `<svg>`; keep it `aria-hidden`.** The row is
  `role="option"`, so screen readers announce its subtree text (the folder
  label uses the same `.a11y-sr-only` shape). `aria-hidden` stops a double
  announcement.
- **Put the tooltip on the wrapper `<span>`**, as `.overlay-result__folder`
  does. `hoverTooltip` is typed for `HTMLElement`; `SVGSVGElement` fails `tsc`.
- **Keep the string short**: it is read on **every** arrow key. Only
  `hitKindLabel()` spells it.

Four glyphs serve five kinds:

- `isWorktreelessBranch()` sends `local_branch` and `remote_branch` to
  `BranchGlyph`. Only the label and `__meta` tell them apart.
- `change_request` (an open PR whose head is not in the checkout) draws
  `ChangeRequestGlyph` (`lib/`), labelled with the forge's noun ("Pull
  request" or "Merge request") from `changeRequestLabel`, never hard-coded.

Remote-glyph options:
[design/Palette Kind Glyphs - UX Review.dc.html](../../../../../../../design/Palette%20Kind%20Glyphs%20-%20UX%20Review.dc.html),
turn 4. Legibility at 15px: "A 15px glyph separates by silhouette, not by
counting" in `styles/AGENTS.md`.

## Palette rows are asserted on by E2E

**Text that you add to a palette row lands in E2E filters.** Specs in
`apps/desktop/e2e` find rows with `.overlay-result` plus `hasText`. The sr-only
kind label is a word that no fixture branch name contains.

## A PR is found through the ref that holds it

Main resolves a PR hit to the worktree or branch that holds its head
(`RepoIndexer.searchAll`). The row keeps its own kind and gains `pr`.

- **`buildPaletteItems` lifts the hit whose `pr.number` the query names** into
  the leading group, beside an exactly-named repo. A bare number also matches
  commit-hash prefixes and paths, whose groups otherwise sit above it.
- **A `change_request` hit has nothing to pin or poll** (`hasNoCheckout`).
  Picking it calls `pr:fetchHead`. `hitForLocation` turns the answer into the
  branch hit that the New-worktree path expects.

The refs browser (`RepoRefsModal` + `RepoChangeRequests.tsx`) also uses the
shared `changeRequestMatch`: `106` means #106, never #1060. With a query, every
tab shows its hit count, so tag and remote searches run while hidden.

## The sidebar's PR section reads a cache and asks nothing per PR

`RepoChangeRequestSection` (between Worktrees and Branches) draws main's open
list: one forge list call per repository, refreshed by the repo-expand sweep.

- **No per-row lookup.** 30 rows would cost 30 API calls per expand.
- **It mounts with `refreshOnOpen: false`.** Only ⟳ asks, with `wait: true`
  so the button stays busy until the answer.
- **Local is `refs/heads`, not "fetched".** A fetched `origin/…` head stays in
  Remote only. The `+ Worktree` step makes it yours
  (`change-request-groups.ts`).
- **Remote only starts closed** per repository
  (`pwrgit.changeRequestsRemoteOpen.<repoId>`); on busy repos it is mostly
  others' work.
- **+ Worktree goes through `reachableLocation`**, as in the refs browser.
  Main re-locates the head with git (`main/github/AGENTS.md`), then
  `NewWorktreeModal` names the PR. Never act on the list's locations; the
  branch index can lag a terminal.
- **Do not shift the sections below.** With a forge in `repo.identity`, the
  heading renders before the first answer (count `…`). `useChangeRequestList`
  keeps each repo's last answer per session, so re-expands paint at once.
  Only a session's first expand of a repo without identity, or with the
  section left open, still shifts.
- **Show a failed refresh.** `list.failure` draws a warning and tints ⟳; the
  entries stay the last good list.
- **Lens only for two or more remotes that list something** (from
  `list.remotes`). It picks All or one remote, per repo
  (`pwrgit.changeRequestsLens.<repoId>`). Past three it is a `<select>`. The
  original (`identity.parent`) comes first. On All, rows carry a `RemoteChip`.
  The heading says "Pull & merge requests" only when the forges differ.
- **Local is keyed by branch** (`groupChangeRequests`). A fork branch with a
  CI PR on `origin` and a PR upstream draws once, led by the upstream PR, the
  other as a paired chip.
- **Key rows by `changeRequestKey`** (forge repository + number), never the
  number alone. Every verb passes `entry.forgeRepo` to `pr:fetchHead`.
- **A row is a place, not a launcher.** Click or Space shows it in the main
  pane (`../change-request/AGENTS.md`); arrows select after 150 ms at rest.
  Its verb (⌂ or + Worktree) runs on Enter, double-click and its button.
  Selection comes through `ChangeRequestSelectionContext`, not props; while
  it is set, worktree rows drop their selected look (`RepoRow`).

Design: `design/Change Requests in Sidebar - UX Review.dc.html`, 2b and 3.
Design: `design/Change Request View - UX Review.dc.html`, 2a.

## The palette asks in this window's profile

`repo:search` carries `windowProfileId()`. Main answers from that profile only,
unless widened. The search line's This profile / All profiles control
(`SettingsSegmented`, ⇧⌘A) shows only with two or more profiles.

- **The control *is* General → Search all profiles.** It writes that setting,
  keeps no own state, and follows `settings:changed`. It sits on the search
  line, not the footer, so it stays under the pointer as the list resizes.
- **Each search sends the scope shown (`allProfiles`)**, so results never lag
  a save in flight.
- **The profile badge on each row is load-bearing.** `App.tsx` routes a pick
  from another profile to **that** profile's window (one of three ways to
  reach it).
- **Do not filter or re-sort by profile in the renderer.** Main caps the
  answer at 60 rows first. Scope and this-profile-first order live in
  `searchAll` ("Main cannot tell which profile is asking", `src/main/AGENTS.md`).

## The sidebar's actions are one toolbar row; search is in the title strip

`SidebarToolbar` holds Add ▾ (Add folders, Clone, Fork through
`ContextMenu`), the one sync button (Fetch ▾ / Pull ▾, below), and the
maintenance wrench. The jump field is in the title strip (`TitleBar`'s
`.titlebar-jump`, `onOpenSearch`).

- **Names outlive labels.** Short labels ("Fetch all") hide at narrow widths.
  Accessible names ("Fetch all repos" or the sync face's other names,
  "Repository maintenance…", "Add repositories") contain the visible label
  (SC 2.5.3). E2E finds buttons by name; rename only with the specs.
- **A disabled menu entry explains itself** with `hint` from
  `addMenuReasons`. Do not remove it from the menu.
- **Day one lives in the empty list.** With no folder, `.sidebar__start`
  draws Add folders in `.sidebar__empty`, outside `role="tree"`. E2E's
  `clickAddFolders` (`e2e/fixtures/steps.ts`) handles both places.

Design: `design/Sidebar Header Toolbar - UX Review.dc.html`, 2b and 3.

## Focused means something you did

`focusedRepos` (the Focused lens, and the sync button's `recent` scope) admits
a repo only for the current worktree, a pin, a visit in PwrGit, or a commit
**you authored** (`Worktree.lastAuthoredAt`, the repo's `user.email`), the
last two within `RECENT_DAYS` (7, `@pwrgit/shared`). Don't add HEAD's date
(`lastActivityAt`) or dirty/ahead/unpublished back to the repo ladder: every
pull moves the first and agent worktrees carry the second, so through 0.46.0
"recent" held 88 repos the user had not touched. The worktree list inside a
repo (`partitionFocusedWorktrees`) still surfaces work in flight.
`lastAuthoredAt` is kept current for every worktree by main's sweep
(`WorktreeStateService.sweepAuthored`, at launch and every 15 minutes), not
only for rows on screen: Focused decides what is on screen.

## One sync button (Fetch ▾ / Pull ▾) and the bulk-sync run

Fetch and Try pull are one split button: Try pull already fetches every
repository before it fast-forwards, so two buttons offered the same first
half twice (and fought over the row's width). The face runs the remembered
verb and scope — Fetch or Pull, `all` or `recent` (the Focused list from
`focusedRepos`, every page of it) — and its accessible name keeps the old
buttons' words: "Fetch all repos", "Fetch recent repos", "Try pull all",
"Try pull recent". The chevron ("Sync options") lists those four, then
the interval, headed **Fetch automatically** or **Pull automatically** to
match the face. Verb, scope, interval and view live in
`bulk-sync-prefs.ts` (`localStorage`, per machine). Rules, all in
`useBulkSyncRun.ts`:

- **The menu configures; the face runs.** Every entry is `keepOpen`: a pick
  moves its check and relabels the face, starts nothing, and leaves the menu
  open. The menu closes on the chevron, an outside click (the face included,
  which then runs) or Escape. 0.45.0 ran each pick and closed the menu, so
  setting an interval meant reopening it and choosing a scope started a run.
- **The split is one control, as PwrAgnt's Send pill.** `.sidebar-toolbar__split`
  owns the border, radius and fill and clips the face and chevron, which shed
  theirs. Hover lights the whole outline and fills the half under the pointer;
  open tints the chevron and points its caret up (`ChevronGlyph up`); one
  focus ring rings the pair. Don't give either half its own border or
  outline: as butted buttons, hover drew a three-sided orange box.
  Design: `design/Sync Split Button - UX Review.dc.html`.
- **The timer runs the face**: its verb and scope, read at each tick. A
  timed pull is the same soft pull (fast-forward only clean, tracked
  branches). 0.45.0 always fetched, so a face set to Pull never pulled.
- **The run is not the dialog.** `BulkSyncDialog` owns the operation and
  draws it as `dialog`, `toast` or `hidden`; unmounting it still cancels. So
  while a run is live, Escape and a backdrop click **minimise**, never
  cancel. Once it has finished they close, as before.
- **One run at a time** (`nextBulkSyncRun`, pure and tested). A click on a
  live run shows it instead of starting another; a timed tick skips it.
- **The view is remembered.** Minimising writes `toast`, expanding writes
  `dialog`. With nothing written yet, the first dialog minimises itself
  after `FIRST_RUN_MINIMIZE_MS` unless the pointer moved or a key was
  pressed inside it (focus is no signal: the dialog takes it). E2E specs
  that read the dialog write `dialog` first, or a slow runner loses it.
- **Timed runs are `hidden`.** At one minute a toast would be up a third of
  the time, and a repository that always fails would raise one every tick.
  The face shows `aria-busy` while any run is going (Pull's arrow swaps to
  the ring; the circular arrow turns); its hover card carries the last
  timed result.

- **Only a clean finish leaves by itself, and it shows its clock.** The
  toast draws the remote-activity card's green rail; the dismiss timer banks
  what is left under the pointer and resumes from there, so rail and timer
  agree. A failure or a cancel draws no rail and stays.
- **The toast's header is the remote-activity card's.** Headline at the left
  edge; clock, Show details and Dismiss (Cancel while live) on its line at
  the right, as 20px buttons 2px apart. No status mark: a circled red cross
  beside Dismiss read as a second close. The border carries the tone.
  Design: `design/Bulk Sync Toast Header - UX Review.dc.html`.
- **The headline counts what went through.** "Pulled 29 of 83 repositories",
  never "Pulled 83" over 52 skipped. The counts below name each outcome in
  the legend's words ("12 partial") on one row under the header, across the
  card's full width (not beside the actions), wrapping rather than
  ellipsizing the last count (usually failed).
- **Skipped means held back from something to pull.** A worktree with
  nothing to pull (detached, no upstream or one deleted on the remote,
  ahead, or dirty but already current) keeps its reason in the details but
  does not make its repository `skipped` or `partial` (`repoOutcome` in
  `main/git/bulk-sync.ts`). In 0.45.0 agent worktrees turned most
  repositories partial and dirty-but-current checkouts skipped.

Design: `design/Fetch Toast and Scope - UX Review.dc.html`.

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

## Clone and Fork… ask the forge the same question

Clone's "Clone from" pair (the original, or your fork) runs
`repo:forkPreflight` once per pick, after `repo:forkTargets`, as
`ForkRepoDialog` does. `repo:forkTargets` runs once per instance, 300ms after
the source box first asks a forge anything, never on open. The default, pill
and submit label come from `clone-from.ts` and `forkAction` (unit-tested), not
JSX.

- **Creating a repository is never a default.** Your fork is preselected only
  when you cannot push to the original *and* the fork exists.
- **`originRepository` is the one source of "what origin will be"** for the
  protocol cards, "Will create" and the SSH recovery card.

A repository that is **itself a fork** gets an "Add `upstream`" row, on by
default: parent first, then root for a fork of a fork. `repo:clone` carries
the slug. Lineage sources:

- **A search row has no `parent`**, so absence means "not asked".
  `cloneLineageSource` takes preflight's source, then a one-off
  `repo:checkCloneSource`, then the pick, and accepts only one that names a
  parent.
- **Your own fork gets no preflight** without another account to fork into;
  that is when the lookup runs. Never per keystroke; a successful exact-name
  check is already the answer.
- **Clone waits for the answer** (`lineageKnown`). An early Enter would clone a
  fork without its default-on upstream row.
- **GitHub search rows carry `isFork`** (no parent). `true` draws the row at
  the pick with target `checking…`; `false` skips the lookup.

Design: `design/Upstream When Cloning a Fork - UX Review.dc.html`.

**Nothing below the source may move after the pick.** The forge answers
0.6–2s later, with focus already in Check out to; late rows moved focus, Clone
with and the footer ~100px. Draw every forge-dependent row in the pick's frame
and change only its words:

- the pair (accounts asked early, or `viewerCanPush: false`, which no
  account's own repository has);
- the pending upstream row;
- "Fork into" on the Clone from label's line, hidden while the original is
  chosen;
- the cards' top lines, at chip height.

To measure, do as pwrdrvr/PwrGit#477: a Vite build of the dialog against a
fake bridge with delayed answers, a `layout-shift` observer, and a rAF sampler
on the controls below. Known remaining shift: a fork of a fork's radio list
appears when the lineage arrives. Design:
`design/Clone Dialog Layout Shift - UX Review.dc.html`.

Fork… from a checkout (`inPlace`) forks it **in place** while the source is
that checkout. It asks `repo:forkCheckoutPreflight`, submits
`repo:forkCheckout`, and draws `ForkRemotePlan` (shared with
`ForkCheckoutDialog`) in place of Clone with / Check out to. Reveal wins when
your fork is already checked out elsewhere. Design:
`design/Fork While Cloning - UX Review.dc.html`.

## Fork tracking repair draws the route, from one dialog

A remote rename can leave a branch pulling from and pushing to the fork's
parent. Push (refused), Pull's menu and the Remotes card all open
`ForkTrackingRecoveryDialog`. **Only that dialog changes the branch's
upstream.** `ForkRoute` draws Now and After as three boxes (original, this
checkout, fork); the git command sits under "In Git terms".

- **Only a refused push says the original is closed to you.**
  `viewerCanPush` is known only for `origin` (here the fork), and a maintainer
  with a fork can still push upstream. Pull and Remotes draw no "can't push".
  Publish and Fork&hellip; may, from `viewerCanPush: false`: there `origin`
  *is* the original.
- **Offer a fork other than `origin` only after the forge confirms** it forks
  the same parent and accepts your pushes. `remote:inspectForkTracking` asks
  after it releases the repository lock. Never guess from a remote's URL. Two
  or more draw the scrolling Push to list.

Design: `design/Fork Tracking Repair - UX Review.dc.html`, 2b and 4a.

## The route is drawn wherever a fork changes where a branch goes

`RouteStrip` (`ForkRoute.tsx`) generalizes the repair's strip (three boxes,
verb-directed arrows, a phase pill). It also draws
Fork&hellip;'s plan (`forkPlanRoutes`), Publish's destination
(`publishRoute`), and the Remotes card, healthy case included
(`remotesRoute`). `RouteLine` is the one-line form under each Pull menu
choice. **Roles come from `routedRemotes` in `@pwrgit/shared`, never from a
remote's name:**

- **The forge's identity names fork and original only while origin's URL
  still matches it.** A remote called `upstream` that is not the parent is
  "other", with no role.
- **Draw "You can push" only from `viewerCanPush`, and only for a remote whose
  push URL is origin's repository.** No pill means "not asked" (Publish to the
  original says so).
- **Sync's dotted arrow needs the original to be known to carry the branch**:
  its default branch, a fetched branch of that name, or the branch it tracks
  now (the repair). Absence from the preview sample proves nothing, so draw no
  arrow.
- **One-line routes use the strip's order**: original first, this checkout
  dashed (`RouteLine` in Pull's choices, `ForkRouteLine` in its repair note).
- **Fork&hellip; draws strips only for a branch that tracks a remote**
  (`routeBranch`). An unpublished branch keeps the "Afterwards" list.

Design: `design/Fork Route Graphic - UX Review.dc.html`.

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
- **Accessibility:** a `nav` named "Repository index", outside `role="tree"`,
  with a list per folder and a button per repository. The spy item has
  `aria-current="location"`. One roving tab stop: ↑/↓, Home/End, typeahead,
  Enter or Space to jump. Display options → Repo index turns it off
  (`pwrgit.repoIndex`). That kebab is always drawn; its hint says why an
  enabled index is not showing.

Design: `design/Sidebar Repo Index - UX Review.dc.html`, 3a and turn 4.

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
