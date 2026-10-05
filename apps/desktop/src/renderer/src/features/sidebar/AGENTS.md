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
`local_branch` and `remote_branch` to `BranchGlyph`, so those two rows are the
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

## The sidebar's PR section reads a cache and asks nothing per PR

`RepoChangeRequestSection` (between Worktrees and Branches) draws main's open
list — one forge list call per repository, refreshed by the repo-expand sweep.
It mounts with `refreshOnOpen: false`, so opening a repository costs no extra
call; only ⟳ asks, with `wait: true` so the button can stay busy until the
answer lands. Don't add a per-row lookup: a list of 30 rows would become 30
API calls on every expand.

- **Local is `refs/heads`, not "fetched".** A worktree or local branch holds
  the head; a fetched `origin/…` head is still Remote only, because + Worktree
  is the step that makes it yours (`change-request-groups.ts`).
- **Remote only starts closed**, per repository
  (`pwrgit.changeRequestsRemoteOpen.<repoId>`). On a busy repository it is
  mostly other people's work.
- **+ Worktree goes through `reachableLocation`**, the refs browser's path:
  main re-locates the head with git (fetching it if it is not here), then the
  PR goes to `NewWorktreeModal` so the dialog names it. The list's locations
  come from the branch index and can lag a terminal; the action must not.
- **It must not shift the sections below it.** The heading renders before
  the first answer whenever `repo.identity` names a forge (count `…`), and
  `useChangeRequestList` keeps each repo's last answer for the session, so a
  re-expand paints at once. What is left is a first expand, per session, of a
  repo with no identity yet or a section left open — keep it that way.
- **A failed refresh is shown, not swallowed**: `list.failure` draws a
  warning line under the heading and tints ⟳; the entries stay the last good
  list.
- **More than one remote: a lens, only when it has something to say.** Main
  lists every forge remote (`list.remotes`). With two or more of them
  listing something, a lens under the heading picks All or one remote
  (remembered per repo, `pwrgit.changeRequestsLens.<repoId>`; past three it
  is a `<select>`), the original first (`identity.parent`). On All each row
  carries a `RemoteChip`; on one remote the lens already says it. The
  heading says "Pull & merge requests" only when the forges differ.
- **Local is keyed by branch** (`groupChangeRequests`): a fork checkout's
  branch with a CI PR on `origin` and the PR sent upstream draws once, led
  by the one that leaves your repository, the other as a paired chip.
  Rows are keyed `changeRequestKey` (forge repository + number), never the
  number alone, and every verb passes `entry.forgeRepo` to `pr:fetchHead`.
- **A row is a place, not a launcher.** A click (or Space) shows the change
  request in the main pane — `../change-request/AGENTS.md` — and the list
  stays put. Arrow keys select after 150 ms at rest. The row's own verb (⌂
  or + Worktree) is Enter, double-click and its button. The selection comes
  through `ChangeRequestSelectionContext`, not props, and while a change
  request has it the worktree rows drop their selected look
  (`RepoRow`).

Design: `design/Change Requests in Sidebar - UX Review.dc.html`, 2b and 3.
Design: `design/Change Request View - UX Review.dc.html`, 2a.

## The palette asks in this window's profile

`repo:search` carries `windowProfileId()`, and main answers from that profile
alone unless the search is widened. The search line's This profile / All
profiles control (`SettingsSegmented`, ⇧⌘A, shown only with two or more
profiles) **is** General → Search all profiles — it writes that setting rather
than keeping its own, and follows `settings:changed`, so the palette and
Settings cannot disagree. It sits on the search line, not the footer, so it
stays under the pointer when the result list changes height. Each search also
sends the scope shown (`allProfiles`), so results never lag a save in flight.
Two consequences here:

- **The profile badge on each row is load-bearing, not decoration.** With the
  setting on, rows from elsewhere appear, and `App.tsx` routes a pick in
  another profile to **that** profile's window instead of acting in this one —
  one of the three ways to reach it.
- **Do not filter or re-sort by profile in the renderer.** The index caps its
  answer at 60 rows before any of it arrives, so a pass here is too late to put
  back a row that was never sent. Both the scope and this-profile-first
  ordering live in `searchAll` — see "Main cannot tell which profile is asking"
  in `src/main/AGENTS.md`.

## The sidebar footer holds the profile's AI switch

`.sidebar__footer` sits under `.sidebar__list` and carries `AiFeaturesSwitch`.
It is a footer and not a list row because the switch belongs to the profile,
not to a repo. The rules it follows are in `settings/AGENTS.md`.

A dialog opened from here renders in place, like `NewWorktreeModal` and the
rest: `.overlay-backdrop` is `position: fixed` and covers the window, even
though `.pane--sidebar` carries `container-type: inline-size`. That reads as
though it would confine a fixed child — layout containment does — but Chromium
does not confine one here, measured at 1000×700 with the pane at 300px. Don't
portal a sidebar overlay to `<body>` on that theory.

## Three things pin, and a branch pin follows the branch

`repos.pinned`, `worktrees.pinned` and `pinned_branches` (migration 0036). The
last exists because `local_branches` is a derived search table — its rows are
dropped and re-synced whenever a branch gains a worktree or a ref listing
changes — so a pin cannot live there, and `worktrees.pinned` cannot pin a branch
nobody has checked out.

The rules that keep the three from disagreeing (all in `RepoIndexer`):

- **A worktree reads as pinned when its branch is** (`PINNED_WORKTREE_SQL`).
  Pin `main`, create a worktree on it later, and the Pinned group still shows it.
- **`worktree:setPin(false)` also deletes the branch's row**, or unpinning a
  worktree whose pin came from its branch would change nothing.
- **`branch:setPin` pins a holding worktree directly** and writes a row only
  for a branch nothing holds; `Repo.pinnedBranches` lists just those, so a
  branch never shows twice.
- **A rename moves the pin** (`renamePinnedBranch`, called before the refresh),
  and the ref listing prunes pins on branches git no longer has.

Only local branches pin. A remote-tracking ref has no local name of its own and a
change request no checkout; the ⌘K star and the refs browser's star both skip
them, and the refs browser keeps an empty slot so names stay aligned.

## The refs browser's rows are focus stops

`lib/refsRowKeys.ts`: ↓ from the filter enters the rows, ↑/↓ walk them,
Home/End jump, Space pins, and Enter or a double-click runs the primary action
— the button inside `data-refs-primary` (`RefRowActions`' first slot). Space
is a **row** key on purpose — in the filter it types a space. A row's copy
targets take `deferForDoubleClick`, so a double-click on the name activates
without copying. The actions column is three fixed slots (`RefRowActions`) on
every tab, the Remotes cards' branch rows included, and `--refs-actions-w` in
`app.css` is their widths plus gaps: change a slot, change the token, or the
columns drift again. Don't hand-roll a row's buttons outside it, and don't
size its grid track by hand: the Remotes cards' fixed 112px track squeezed two
buttons' labels onto two lines. The track is the token.

**Anything a sidebar row can do, its refs-browser row must do too** — the
browser is how the rows past the short list are reached. When you add a verb,
chip or gesture to a sidebar ref row, add it there (both `RepoRefsModal` and
`ChangeRequestTable`), and the parity tests in `RepoRefsModal.test.tsx` and
`RepoChangeRequestSection.test.tsx` beside it. `WorktreeHolderChip` is the
shared "which worktree holds this" chip.

## Clone and Fork… ask the forge the same question

Clone's "Clone from" pair (the original, or your fork) runs `repo:forkPreflight`
once per pick, after `repo:forkTargets` — the same answer `ForkRepoDialog`
reads. The default, the pill and the submit label come from `clone-from.ts` and
`forkAction`, not from JSX, and are unit-tested there. Two rules worth keeping:

- **Creating a repository is never a default.** Your fork is preselected only
  when you can't push to the original *and* the fork already exists.
- **`originRepository` is the one source of "what origin will be".** The
  protocol cards, "Will create" and the SSH recovery card all read it, so
  choosing the fork can't leave one of them describing the source.

Fork… opened from a checkout (`inPlace`) forks it **in place** while the source
is still that checkout: it asks `repo:forkCheckoutPreflight`, submits
`repo:forkCheckout`, and draws `ForkRemotePlan` (shared with
`ForkCheckoutDialog`) instead of Clone with / Check out to. Reveal still wins
when your fork is already checked out elsewhere. Design:
`design/Fork While Cloning - UX Review.dc.html`.

## Fork tracking repair draws the route, from one dialog

A branch can be left pulling from and pushing to the fork's parent after a
remote rename. Push (refused), Pull's menu and the Remotes card all open
`ForkTrackingRecoveryDialog`; none of them changes the branch's upstream
without it. `ForkRoute` draws Now and After as three boxes (the original,
this checkout, the fork), so the change reads without Git's vocabulary; the
command itself sits under "In Git terms". Two rules:

- **Only a refused push says the original is closed to you.** `viewerCanPush`
  is known for `origin` alone, and here `origin` is the fork; a maintainer can
  have a fork and still push upstream, so the Pull and Remotes entries draw no
  refusal and no "can't push". (Publish and Fork&hellip; may say it from
  `viewerCanPush: false`, because there `origin` *is* the original.)
- **A fork other than `origin` is offered only once the forge confirms it**
  forks the same parent and takes your pushes. `remote:inspectForkTracking`
  asks after releasing the repository lock; the renderer never guesses from a
  remote's URL. Two or more draws the scrolling Push to list.

Design: `design/Fork Tracking Repair - UX Review.dc.html`, 2b and 4a.

## The route is drawn wherever a fork changes where a branch goes

`RouteStrip` (in `ForkRoute.tsx`) is the repair's strip made general: three
boxes, arrows whose direction follows the verb, and a phase pill. It also
draws Fork&hellip;'s plan (`forkPlanRoutes`), Publish's destination
(`publishRoute`), and the Remotes card in the healthy case too
(`remotesRoute`). `RouteLine` is the one-line form under each Pull menu choice.
Roles come from `routedRemotes` in `@pwrgit/shared`, never from a remote's
name:

- **The forge's identity names the fork and the original only while origin's
  URL still matches it.** A remote called `upstream` that is not the parent is
  "other" and gets no role.
- **"You can push" is drawn only from `viewerCanPush`, and only for a remote
  whose push URL is origin's repository.** No pill means "not asked", which is
  why Publish to the original says PwrGit hasn't asked.
- **Sync's dotted arrow appears only where the original is known to carry the
  branch**: its default branch, a fetched branch of that name, or the branch it
  tracks now (the repair). Absent from the preview sample proves nothing, so
  it draws no arrow rather than a guess.
- **One-line routes read in the strip's order**, the original first and this
  checkout dashed: `RouteLine` in Pull's choices, `ForkRouteLine` in its
  repair note.
- **Fork&hellip; draws strips only for a branch that tracks a remote**
  (`routeBranch`). An unpublished branch has no route to change, so it keeps
  the "Afterwards" list.

Design: `design/Fork Route Graphic - UX Review.dc.html`.
