# ⌘K palette and PR lookup

This guide covers the ⌘K palette's rows, ranking and profile scope, and the sidebar's pull and merge request section.

Code paths in backticks are relative to [apps/desktop/src/renderer/src/features/sidebar](../../../apps/desktop/src/renderer/src/features/sidebar/).

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
[design/Palette Kind Glyphs - UX Review.dc.html](../../../design/Palette%20Kind%20Glyphs%20-%20UX%20Review.dc.html),
turn 4. Legibility at 15px: "A 15px glyph separates by silhouette, not by
counting" in `styles/AGENTS.md`.

## Palette rows are asserted on by E2E

**Text that you add to a palette row lands in E2E filters.** Specs in
`apps/desktop/e2e` find rows with `.overlay-result` plus `hasText`. The sr-only
kind label is a word that no fixture branch name contains.

## Typing a repository's name puts it first

`buildPaletteItems` groups main's answer; main's order stands inside each
group. The groups, top down:

1. **A repository the query names** (`searchNameKey`), always, even while
   you are in it (operator's decision; #358 had put that repository's
   same-named branches above it). Same-named repositories: the one you are
   in, then this profile's, then by folder (`RepoIndexer.searchAll`).
2. The hit holding the PR the query numbers (`106`, `#106`).
3. The focused repository's rows of exactly that name (#358): `main`, Enter.
4. Show hidden repositories, then a hidden repository named in full.
5. **Repositories whose name or folder the query begins**, above files and
   commits: people switch by typing a name's first letters.
6. Files, commits, everything else.

Main keeps the same promise before its 60-row cap (`src/main/AGENTS.md`).
Tests: `RepoSwitcherOverlay.ranking.property.test.ts` runs SQL, main and
this grouping over a real FTS5 index; `search-rank.property.test.ts` holds
main's re-rank alone.

## A PR is found through the ref that holds it

Main resolves a PR hit to the worktree or branch that holds its head
(`RepoIndexer.searchAll`). The row keeps its own kind and gains `pr`.

- **`buildPaletteItems` lifts the hit whose `pr.number` the query names**
  to just under an exactly named repo. A bare number also matches
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
