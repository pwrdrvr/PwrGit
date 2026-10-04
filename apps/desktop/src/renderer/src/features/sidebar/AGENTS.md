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

`lib/refsRowKeys.ts`: ↓ from the filter enters the rows, ↑/↓ walk them, Space
pins, Enter runs the primary action. Space is a **row** key on purpose — in the
filter it types a space. The actions column is three fixed slots
(`RefRowActions`), and `--refs-actions-w` in `app.css` is their widths plus
gaps: change a slot, change the token, or the columns drift again.

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
  is known for `origin` alone, and a maintainer can have a fork and still push
  upstream, so the Pull and Remotes entries draw no refusal and no "can't push".
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
- **Sync's dotted arrow appears only where the original's default branch is
  the branch's name.** A feature branch on a fork has nothing to sync.
- **Fork&hellip; draws strips only for a branch that tracks a remote**
  (`routeBranch`). An unpublished branch has no route to change, so it keeps
  the "Afterwards" list.

Design: `design/Fork Route Graphic - UX Review.dc.html`.
