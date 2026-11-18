# Clone, fork and route dialogs

This guide covers the Clone and Fork dialogs, fork tracking repair, and the route graphic.

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
