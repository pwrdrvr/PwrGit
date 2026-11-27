# Sidebar toolbar and bulk sync

This guide covers the sidebar toolbar, the Focused lens, and the Fetch/Pull split button with its bulk-sync run.

Code paths in backticks are relative to [apps/desktop/src/renderer/src/features/sidebar](../../../apps/desktop/src/renderer/src/features/sidebar/).

## The sidebar's actions are one toolbar row; search is in the title strip

`SidebarToolbar` holds Add ▾ (Add folders, Rescan folders, Clone, Fork
through `ContextMenu`), the one sync button (Fetch ▾ / Pull ▾, below), and the
maintenance wrench. The jump field is in the title strip (`TitleBar`'s
`.titlebar-jump`, `onOpenSearch`).

- **Names outlive labels.** Short labels ("Fetch all") hide at narrow widths.
  Accessible names ("Fetch all repos" or the sync face's other names,
  "Repository maintenance…", "Add repositories") contain the visible label
  (SC 2.5.3). E2E finds buttons by name; rename only with the specs.
- **A disabled menu entry explains itself** with `hint` from
  `addMenuReasons`. Do not remove it from the menu.
- **Day one lives in the main pane, not the list.** A profile with no
  repositories gets the start screen (`onboarding/StartScreen.tsx`), drawn
  from `repos.length === 0`, never from the lens being empty. The list keeps
  one line ("No repositories yet."). E2E's `clickAddFolders` uses Add ▾.
- **Clone and Fork never wait for a folder.** With none, their destination
  step is `NoFolderDestination`; the request carries `newRoot`, and main
  creates and adds the folder only as the operation starts. Only Rescan is
  gated on a folder. Find repositories… stays in Add ▾ for good.

Design: `design/Sidebar Header Toolbar - UX Review.dc.html`, 2b and 3;
`design/New User Journey - UX Review.dc.html`, 4a, 4d and 5a.

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
- **"Sync forks with upstream" is main's setting, not a `localStorage` pref**
  (`general.syncForksOnBulkPull`, `useSyncMenuSettings`): during bulk pull
  (manual and timed), clean fork branches fast-forward from their upstream
  source and leased-push to enabled writable fork remotes, honouring each
  repository's Pull menu choice (`forkModes`) and per-remote overrides
  (`fork_sync_remote_prefs`). Sits beside "Check tags after sync", hidden until
  read.
- **"Check tags after sync" is main's setting, not a `localStorage` pref**
  (`general.tagCheckAfterSync`, `useSyncMenuSettings`): main checks after
  every Fetch and Pull, including a repository's own and timed ones. It
  sits between the interval and Show last run, and hides until the setting
  is read rather than showing a guessed check.
- **The timer runs the face**: its verb and scope, read at each tick. A
  timed pull is the same soft pull (fast-forward only clean, tracked
  branches). 0.45.0 always fetched, so a face set to Pull never pulled.
- **The run is not the dialog.** `BulkSyncDialog` owns the operation and
  draws it as `dialog`, `toast` or `hidden`; unmounting it still cancels. So
  while a run is live, Escape and a backdrop click **minimise**, never
  cancel. Once it has finished they close, as before.
- **One run at a time** (`nextBulkSyncRun`, pure and tested). A click on a
  live run opens it **in the dialog**, whatever view it is in or was
  remembered, instead of starting another; a timed tick skips it. Its hover
  card says "Click to open"; reopening a remembered toast (or doing nothing
  on a run already in one) broke that (`useBulkSyncRun.property.test.ts`).
- **The face shows the live run's position**: "Pull recent 12/27", with the
  dialog's outcome bar along the split's bottom edge, a live hover card
  (`SyncRunCard`) and a hint on Show the running sync. All read one value:
  `BulkSyncDialog` reports its own fold through `onProgress`, hidden runs
  included, and `acceptBulkSyncProgress` keeps only the live run's report.
  Don't subscribe to `remote:bulkSyncProgress` a second time for the
  toolbar. The report goes into `progressStore`, not React state:
  `LiveSidebarToolbar` subscribes alone, so a report never re-renders the
  sidebar. The label keeps its words (the name must contain it, SC 2.5.3);
  the count goes beside it and in `aria-description`, and
  `.sidebar-toolbar__count` survives the icon step.
  Design: `design/Sync Progress on the Button - UX Review.dc.html`, 2a and 3a.
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
- **Sync options → Show last run reads any run afterwards.** The menu's
  last entry shows the run going now ("Show the running sync", a hidden
  timed one included) or reopens the newest finished run's dialog from its
  stored summary (`BulkSyncRun.replay`, `BulkSyncDialog replay`), which
  starts no operation. The record belongs to the profile.

- **A finished toast leaves by itself, and shows its clock.** A clean finish
  after `TOAST_DISMISS_MS` on the green rail; a failure or a cancel after
  `TOAST_FAILED_DISMISS_MS`, its rail red on a failure. A repository that
  fails every run (a deleted remote) used to pin the toast for good; Show last
  run brings it back. A run that stopped with an error stays. The dismiss
  timer banks what is left under the pointer, so rail and timer agree.
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
