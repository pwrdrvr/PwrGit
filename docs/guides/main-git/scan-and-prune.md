# Scanning, discovery and pruning

This guide covers profile scans, repository discovery, hidden repositories and the worktree pruner. It was moved from
[apps/desktop/src/main/git/AGENTS.md](../../../apps/desktop/src/main/git/AGENTS.md).

Code paths in backticks are relative to [apps/desktop/src/main/git](../../../apps/desktop/src/main/git/).

## A scan that found nothing is not proof anything was deleted

**A prune caused by a bad scan cannot be undone.** `rescanProfile` prunes the
repos that a scan did not see. The delete cascades through every table keyed
to `repos(id)`: pins, sort and custom order, identity, the branch and PR
caches, the LFS notice. Rediscovery recreates the row under the same hashed id
but none of that data.

Discovery skips unreadable directories, so an empty result is ambiguous.
`scanRepoRoot` reports `rootReadable`. `canPruneFromScan` refuses a scan whose
root could not be listed (an unmounted volume, a share not up at login), or
that resolved no repos while roots are configured. Clearing every root is the
one deliberate route to zero, and it prunes.

- **The scan clock and the prune answer different questions.**
  `profile_scan_state` records only that a pass could *look*, and a readable
  empty root did look. Stamped after an unreadable root, it starts the 24h
  throttle in `shouldRescanProfile` from a scan that saw nothing.
- **A new folder under a root asks for the scan at the next look.**
  `root-discovery.ts` walks the roots (no Git) 15s after launch, at the
  start of every Fetch/Pull run (`remote:bulkSync`, that profile only) and
  every 15 minutes. Not on focus: switching windows is not evidence of a
  clone. It forces a scan when the walk finds a `.git` folder that the last
  scan did not record (`unscannedRepoDirs` against `profile_scan_dirs`,
  0048), and runs the daily scan when it is due. Both back off (10 min,
  doubling to a day) when the same request comes back, because an unreadable
  root keeps the daily scan due forever. Compare walk output with walk
  output, never with Git's paths: Git resolves symlinks, so a quiet root
  would rescan every tick. A scan records only the folders Git could read,
  so a clone caught mid-write is asked about again, and records readable
  roots or not, so a volume's folders read as new once it mounts. `root-discovery.property.test.ts` holds
  the rule against real Git. Add ▾ → Rescan folders (`profile:rescan`) is
  the manual route.
- **A repository whose own folder is gone requests the rescan early.** When the
  state probe finds a PRIMARY checkout missing, `missing-repo-rescan.ts` runs
  the rescan past the throttle, at most once per repo per ten minutes. It
  changes when the scan runs, not what it may prune. A deleted repo leaves the
  sidebar within one poll. A hand-added repo (never pruned) stays flagged
  missing.
- **Readability is checked only at the root.** An unmounted mount point
  *below* a root reads as an empty directory (or throws where discovery
  ignores it), so its repos are pruned if another repo resolved. Do not check
  every depth: macOS denies a non-FDA app `~/Documents` and similar folders,
  and one EACCES would disable pruning permanently.

## Find my repositories never looks inside a repository

`repo-search.ts` walks the home folder (fs only, three levels, breadth first)
and proposes folders; it adds nothing. Design: `design/New User Journey -
UX Review.dc.html`, cards 2a, 2d, 2e.

- **It stops at the first `.git`**, and at a bare repository's own folder.
  Worktrees, submodules and clones kept inside a repository
  (`repo/.claude/worktrees/x`) are never reached or counted. Home's own
  `.git` does not stop it; home is never proposed.
- **It shares the scan's never-opened rule** (`isScanSkippedDir`). Add to
  `SKIP_DIRS`, never to a copy.
- **Counts are repositories keyed by Git's common directory**, read from a
  `.git` file's pointer, so they equal what `rescanProfile` indexes.
  `repo-search.property.test.ts` holds that against the real scan; run it
  after changing either walk.
- **Main runs one search per window** (`repo-search-handlers.ts`); a second
  supersedes the first. macOS's TCC folders (Documents, Desktop, Downloads)
  are opened only when asked.

A folder that may not exist yet (`profiles/new-root.ts`) is created or added
only by a `SUGGESTED_ROOTS` name under home or a path the system picker
returned this session. Clone and Fork take it as `newRoot` and take it back
out if they fail.

## A hidden repository is filtered in SQL, by path

`hidden_repos` (0041) is keyed `(profile_id, path)`, not `repos.id`, because a
rescan recreates repo rows and a hide must survive.

- **Anything that hands out a profile's repositories puts
  `visibleRepoSql("r")` (`hidden-repos.ts`) in its WHERE clause**:
  `listRepos`, `browseRepos`, `searchAll`, bulk sync, maintenance, the pruner.
  Several are capped, and a filter after the cap does not return the slots.
- ⌘K rows have no repo column. `SEARCH_ROW_REPO_SQL` maps each kind to its
  repository. A `change_request` row's `entity_id` is its `repo_open_pr` id
  (0039), not `repo:number`.
- A caller that asks what is on disk, not what to show (clone's "already
  cloned", fork's "Reveal checkout"), passes
  `listRepos(id, { includeHidden: true })`.
- `hidden-repos.test.ts` covers both profiles.

## The pruner: one rule, one removal path, and `clean -X` is not what it looks like

Files: `worktree-prune.ts` (the sweep), `worktree-reclaim.ts` (the
`git clean -Xd` operation) and `prune-handlers.ts` (both commands).

- **"Safe to prune" has one definition.** `prunableReason` /
  `isPrunableWorktree` (`packages/shared/src/prunable.ts`) run in the
  renderer's Stale lens *and* the sweep in main. A second copy would let the
  two disagree about which rows the pruner may touch.
- **A merged branch's age comes from `general.worktreeFinishedAfterDays`**
  (0 is "right away"). Both callers pass it: the sidebar through
  `FinishedAfterDaysContext`, the dialog in `prune:scan`'s request. A diverged
  branch keeps the fixed `STALE_AGE_DAYS`, because nothing proves it merged.
- **`prunableReason` returns null for `locked === true`**, as for dirty and
  missing. `git worktree lock` is git's only explicit "do not touch"
  (`repo-indexer.ts` reasons the same way). Removing a locked worktree needs
  `--force`, which `removeWorktrees` offers only for the *dirty* set. So a
  locked row would confirm "Remove 3 worktrees" and then fail one.
  `PruneCandidate` has no `locked` field.
- **The sweep computes its own state.** Per-worktree state is computed lazily
  on expand (`repo:computeState`), because computing ~150 at launch overloads
  git. So the Stale lens is empty on an unbrowsed profile (see
  pwrdrvr/PwrGit#248). `sweepPrunableWorktrees` runs at
  `PRUNE_SCAN_CONCURRENCY` (4, inside the indexer's
  `HYDRATION_GIT_CONCURRENCY`) and takes the repository lock per repo. Results
  go into `worktree_state`, so a cancelled sweep is not wasted and a re-run
  reports `cached` without git. `prune-handlers.test.ts` pins this.
- **Sizing is a separate phase** after candidates are known, because walking
  `node_modules` is slow. The sweep reuses up to four Node workers for its
  filesystem metadata reads. Each walk has an entry ceiling (the size becomes
  a lower bound), checks for cancellation, and skips symlink targets. The
  asynchronous walk yields every few directories when used on main.
- **Sizes de-duplicate hard links.** pnpm hard-links one store blob into every
  package, so summing `stat.size` turned a 400 MB checkout into "freeing
  4.2 GB". `directorySize` counts each `dev:ino` once (`hardLinks` reports the
  skipped repeats). Links from *another* worktree still count, so the figure is
  an upper bound on what a delete returns.
- **Removal is `worktree:removeMany`. Do not add a second path.** It removes in
  bulk, streams `worktree:removed` (and `worktree:removeProgress` during a
  folder delete), updates sidebar rows live, logs outcomes and owns the
  dirty/force retry. The pruner passes `{ confirmed: true }` to
  `useRepoTree.removeWorktrees`, because its own confirm names repos, reasons
  and bytes. Two confirms in a row train people to click through.
- **The byte figure is file size, never free space.** Confirms say "holding
  4.9 GB on disk" or "totalling 3.9 GB", never "freeing X". APFS clones look
  like copies to `stat` and `du`, and deleting a clone frees nothing. A local
  Time Machine snapshot keeps deleted blocks until it expires.
  `diskSpaceNote` (renderer `prune-view.ts`) explains this (darwin: APFS
  clones + Time Machine; elsewhere: hard links). Do not add a free-space
  delta: `f_bavail` drifted 1.1 MB in one idle second.

**`git clean -e <pattern>` does not spare anything under `-X`.** This trap is
silent data loss.

- `-e` *adds* an ignore rule, and `-X` deletes the ignored set. So
  `clean -Xdn -e '.env'` reports `Would remove .env`.
- Spare a path with a **negated** pattern (`-e '!.env'`). It un-ignores the
  path. Command-line excludes outrank `.gitignore`. Globs and trailing-slash
  directory patterns work the same way.
- `spareArgs` adds the negation. `excludePatternProblem` refuses a user-typed
  `!`, which would become `!!foo`.
- `worktree-reclaim.test.ts` pins both directions against real git. It is the
  only guard against this bug. Do not remove it as redundant.

Invariants in `worktree-reclaim.ts`:

- **`-X`, never `-x`.** `-x` also deletes untracked files that no rule covers,
  which is uncommitted work. There is deliberately no UI for it.
- **The preview is git's dry run. The deletion runs git again.** The parsed
  `Would remove …` paths are only displayed. Do not "optimize"
  `reclaimIgnored` into `clean -- <paths>`: a mis-parse can then only draw a
  row wrongly, never widen the delete. The dry run needs `LC_ALL=C` (git
  translates the prefix) and `-c core.quotePath=false` (else non-ASCII paths
  arrive as octal escapes).
- **A single `-f`.** Git deletes a directory that holds its own `.git` only
  with `-f` twice. This keeps a vendored clone inside an ignored directory.
- **Ignored does not mean worthless.** `.env` files, local SQLite databases,
  keys and notes are often gitignored and have no object in the store, so
  `clean -X` cannot be undone. `RECLAIM_DEFAULT_EXCLUDES` spares that class by
  default, and the user can narrow it. `discardAllChanges` restores from HEAD.
  Its own `clean -fd` must keep excluding ignored paths. Neither command may
  take the other's flags.
- **The reclaim panel does not delete with unapplied edits.** `reclaim()`
  sends `appliedExcludes` (the preview's patterns), so an unapplied pattern
  would be dropped and its file deleted. Delete is disabled until "Update
  preview". The footer says what is spared *and* that the edit is not applied.
  Keep both messages, so the procedure does not hide the danger.
