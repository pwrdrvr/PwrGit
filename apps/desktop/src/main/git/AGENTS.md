# src/main/git — AGENTS.md

Notes for the git layer. See `apps/desktop/AGENTS.md` for app-wide facts.

## Real-git tests run on Windows CI too

Many suites here drive the system `git` against temp repos. Some hazards only
fail on the Windows runner, so a green local run proves nothing about them:

- **Never give a Git process a native cwd inside a directory we may remove.**
  Git for Windows can hand execution from its launcher to descendant
  `git.exe` processes; awaiting the launcher does not guarantee every
  descendant has released that cwd, and removal then fails with `EPERM` or
  `EBUSY`. Keep the process cwd in a stable directory and address the repo with
  `git -C <repo>` (use `gitProcessInvocation` in `dugite.ts`).

- **Get the `GitExec` from `test-support/system-git.ts`; never hand-roll one.**
  It preserves the existing exit + stream-end policy and 250ms post-exit drain
  grace. A grace expiry does not prove inherited pipes caused a test failure.
  It honours cancellation and output callbacks like production's `execGit`.
  The remote, partial-staging and rebase-assistant tests enable a 5s diagnostic
  tripwire. `timedGitSync` records their fixture-helper calls before/after a
  blocking invocation; it cannot inspect Git while blocked. CI uploads JSONL
  begin/end records and per-test totals via `PWRGIT_GIT_DIAGNOSTICS_DIR` even on
  failure. Only instrumented calls within test scopes count; beforeAll setup
  and production Dugite calls are outside this narrow coverage. Reports omit
  raw arguments, paths, output and environment. A `killed` flag is a signal
  request, not observed termination. No diagnostic changes timeouts or cleanup.

- **`core.autocrlf` defaults to true on Windows.** Anything restored out of
  HEAD comes back with CRLF, and a test comparing file *contents* against the
  bytes it committed fails on that alone. Set it off in the repo setup, beside
  `user.name` / `user.email`:

  ```ts
  git(repo, ["config", "core.autocrlf", "false"]);
  ```

  Only needed when a test reads file contents back — suites that only compare
  paths are unaffected.

- **Windows forbids `* ? : " < > |` in filenames.** A test that needs an
  awkwardly-named file on disk cannot use `*` or `?`, so `writeFileSync` fails
  with ENOENT before the assertion is reached. `[` and `]` are legal
  everywhere, and a bracket expression exercises glob-escaping just as well
  (see `gitignore.test.ts`). Keep `*` / `?` cases to pure string assertions.

## Which Git runs: the bundle, set up the way an installed Git would be

Every Git process goes through `gitLaunch` in `dugite.ts`. It returns the
bundled Git unless Settings › General › Git runtime chose an installed one
(`useInstalledGit`, persisted as `gitPath`). `execGit`, `execGitRecords` and
`execGitBinary` spawn whatever `gitLaunch` returns and do not call
`dugite.exec`. Three things here are easy to undo:

- **The bundle needs a system config of PwrGit's own.** Dugite points
  `GIT_CONFIG_SYSTEM` at its `etc/gitconfig`. That file only includes
  `/etc/gitconfig`, so it never reads the config file of the Git the user
  installed. Homebrew and Apple set `credential.helper = osxkeychain` there,
  and with no helper every keychain-backed HTTPS fetch fails with "terminal
  prompts disabled". The file also sets no LFS filter, so LFS repositories
  check out pointer files. `bundledGitEnvironment`
  (`packages/mcp-server/src/git-runtime.ts`) writes a content-named file under
  `<userData>/git` with the `git lfs install --system` filter. On macOS it
  adds the installed Git's own `git-credential-osxkeychain`, then includes
  Dugite's config. The file is system scope, so the user's global config
  still wins, and `credential.helper =` still opts out. Until
  `configureBundledGitConfig` runs, nothing is written. That keeps unit tests
  out of the real data directory, and tests that need the file configure a
  temp one.
- **Borrow the keychain helper from the Git the user runs in their terminal.**
  A keychain item stays readable without an access prompt only for the helper
  binary that stored it. An app opened from Finder has launchd's PATH, which
  puts Apple's `/usr/bin/git` before Homebrew's, the opposite of a shell that
  ran `brew shellenv`. So `keychainSearchPath` tries launchd's directories
  last.
- **A chosen Git never falls back.** If it breaks, every command fails with a
  message that names it and points at Settings. Running the bundle instead
  would make Settings wrong about which Git is running. `installedGitEnvironment`
  strips every bundle variable: `GIT_EXEC_PATH`, the generated
  `GIT_CONFIG_SYSTEM`, and the bundle's directories on PATH. Any one of them
  would quietly send that Git to the bundle's helpers or config.

Discovery (`runtime-status.ts`) never runs Apple's `/usr/bin/git`. Without
developer tools that shim opens the installer dialog. Discovery lists the Git
under `xcode-select -p` instead, and only when that Git exists. A Git without
working Git LFS is listed but cannot be chosen, and `git:selectRuntime` probes
a path before saving it.

## Main decides how many Git processes exist, not the renderer

`file-insights-handlers.ts` tracks live reads per renderer **and kind**
(`<webContentsId>:history`), never per operation id. A pane shows one file one
way, so a second read of a kind supersedes the first.

That keying is the point. Operation ids are unique per request by construction,
so keying on them capped nothing: a renderer that asked in a loop — a retry that
never backed off, a bad effect dependency — had this process spawning a Git
child per iteration for as long as it kept asking. It happened, and the guard
that stopped it lived in a React hook.

So the rule for anything here that spawns off an IPC message: **bound it on this
side.** A renderer-side guard is worth having and is not sufficient, because the
renderer does not own process lifetime and its bugs are exactly the case the
bound exists for. Fan-out over a list already has `mapLimit` (`util/map-limit.ts`)
for the same reason; a per-message spawn needs its own ceiling.

## Every long-running remote command registers an activity

`remote-activity.ts` holds one record per live fetch / pull / push, and the
toolbar popover, the elsewhere-toast and the cancel button all read it. A new
network command belongs in it too — wrap it in `tracked()` in
`remote-handlers.ts` rather than calling `execGit` directly.

What the registry is *for* is the distinction a spinner cannot draw. Three
fields carry it, and none of them is decoration:

- **`queued`.** An operation waits for `WorktreeOperationQueue`'s repository
  lock before it runs any Git at all. That wait is not Git being slow, and the
  watchdog deliberately does not start until the lock is held — so registering
  BEFORE taking the lock is what keeps the two stories consistent.
- **`silent` / `lastOutputAt`.** `--progress` is forced on fetch and push
  (`forceProgress`), so those phases are *obliged* to emit; silence there is
  evidence. The local phases promise nothing, which is why the renderer only
  warns about quiet during network phases.
- **`command` + `tail`.** Git's own words. A wedged transfer is diagnosed from
  "which command" and "what did it last print", and both used to exist only
  inside a process that had not exited yet.

Two rules that are easy to undo:

- **Cancel and the watchdog are different endings, and both must reach Git.**
  Pull combines them with `AbortSignal.any([watchdog.signal, activity.signal])`
  and hands Git one signal. Passing either alone silently disables the other.
  Rollback/recovery is deliberately NOT cancellable — stopping a rollback is
  how a checkout is left broken.
- **A cancel is an outcome, not a failure.** `safePullError` returns it
  untouched and the pull logs at `info`; the renderer shows a neutral flash
  and raises no error toast. Anything that routes `code: "canceled"` into the
  failure path is reporting the user's own decision back to them as a fault.

Output lines are sanitized through `sanitizeGitLogDetail` on the way in, so a
credential in a remote URL never reaches the record, the event, or the clipboard.

**"Long-running remote command" means every command that reaches a remote, not
just the ones with a toolbar button.** `remote:planPushRefs` and
`remote:pushRefs` sat outside the registry for exactly that reason — they
belong to a sidebar dialog rather than the worktree header — and the review
half fetches EVERY destination remote before it can compare anything. Both are
tracked now, repo-scoped (`worktreeId: null`, since no checkout owns a push
aimed at named remotes), and every network command they run forces
`--progress`: the quiet warning reads silence as evidence, so a command that
was never obliged to emit would make that reading a lie. `pushFailureMessage`
is the other half of forcing it — Git writes the meter with CR, and a
rejection's stderr would otherwise reach the review table with every repaint of
"Writing objects" in front of it.

The failure that motivated all of this: an SSH agent that is present but cannot
answer (1Password's agent with 1Password stopped or locked) accepts the
connection and then blocks forever. Git prints nothing, exits never, and every
timeout in the app is measured in *minutes* by design because a large clone
looks the same from the outside. Nothing short of "Git has written nothing at
all since this command started" separates the two — which is why `silent` is
scoped to the command and why Cancel exists.

## Paths from git are always forward-slash

`git status`, `ls-files` and `ls-tree` report `a/b/c` on every platform, so
path handling here splits on `/` rather than reaching for `node:path`. Don't
"fix" that with `sep` — and don't rebuild a git path with `join()`, which
would produce backslashes git never emits.

## Batched pathspecs are all-or-nothing

`runBatched` splits long path lists across several git runs (Windows caps a
command line at ~32 KB). Two consequences worth holding onto:

- Git validates a whole pathspec list *before* touching anything, so one bad
  path aborts its entire batch. Anything that mixes kinds — say untracked and
  staged-new paths in one discard — must partition first and send each set to
  the command that suits it, or the batch fails as a unit and later steps see
  a state they did not expect.
- A failure in a later batch leaves earlier ones applied. A caller that
  reports "nothing happened" on error is wrong; announce the change either
  way (`notifyChanged` in `changes-handlers.ts`).

## The lane graph draws fetched work, not just local work

`graph-handlers.ts` composes the lineage from a trunk walk plus one
not-in-trunk walk over the drawn branches. A branch that is BEHIND its upstream
has commits sitting in the object store that no local ref reaches, so walking
local tips alone silently omits them — the lane reads as current while the
sidebar says "↓1", and the row the user wants is simply absent.

`unappliedUpstreams` (git-service) answers "which branches are behind?" in one
`for-each-ref`, via `%(upstream:trackshort)` — `<` behind, `<>` diverged. Use
the short form, not `%(upstream:track)`: it is a fixed set of symbols rather
than a sentence git may translate.

Two rules follow. `graph-lanes.test.ts` pins which commits get walked;
`lane-layout.test.ts` pins how the result is drawn — run both when you touch
either half:

- Every drawn branch contributes its upstream to the walk when it is behind.
  That ref rides in `upstreamRefs`, NOT `shownBranches` — the toolbar counts
  the latter as active branches — and the renderer draws the union, dashing it
  as fetched-but-unapplied. `lane-layout.ts` handles the drawing already: it
  needs the data, not new logic. A diverged branch forks at the merge base,
  below the local tip, so the dashed leg runs past our own rows and bends into
  our lane there; `lane-layout.test.ts` pins that geometry, including the
  rewritten-SHA case where both legs carry the same work.
- **The focused worktree's own branch is never skipped.** It can fall out of
  the repo-level set entirely (`ACTIVE_DRAW_CAP` keeps 30 branches by
  recency), so the per-worktree step re-adds its upstream. Anything scoped
  "what the user is looking at right now" belongs there, not in the
  repo-level cache, which is deliberately shared across a repo's worktrees.

## `--continue` exits non-zero on ordinary progress

`git rebase --continue` returns **1** when it successfully commits the current
step and then stops on the *next* conflict. So does a multi-commit
`cherry-pick`. Reading the exit code alone reports the normal path of a
multi-commit rebase as a failure, and dumps Git's `hint:` block into the user's
face at the exact moment things are going fine.

`operation-service.ts` classifies against observed state instead: it snapshots
HEAD, the sequencer counter, and the conflict count, runs the command, and calls
the result `stopped` (progress) when any of them moved. Only a run where
nothing moved is a real `continue_failed`. `operation-service.test.ts` pins both
halves against real Git — keep that rebase test if you touch this.

Two related traps in the same area:

- **An operation with zero conflicts is normal.** `rebase -i` paused on `edit`,
  and `merge --no-commit`, both leave markers with a clean index. Treating
  "mid-operation" as "conflicted" is wrong, and gating UI on it hides the
  Changes and Rebase tabs exactly when they are needed.
- **`GIT_AUTHOR_*` / `GIT_COMMITTER_*` outrank `-c user.email`.** Tests that set
  those in the environment cannot prove identity handling; unset them for that
  assertion (see `execGitWithoutIdentityEnv`).
## A scan that found nothing is not proof anything was deleted

`rescanProfile` prunes the repos a scan did not see, and that delete cascades
through every table keyed to `repos(id)` — pins, sort and custom order,
identity, the branch and PR caches, the LFS notice. Re-discovering the same
directory later re-inserts the row under the same hashed id and rebuilds none
of it, so a prune driven by a bad scan is unrecoverable.

Discovery skips unreadable directories rather than throwing, so an empty result
is ambiguous. `scanRepoRoot` reports `rootReadable` to break the tie, and
`canPruneFromScan` refuses a scan that is too weak to act on: one whose root
could not be listed (an unmounted volume, a share not up yet at login), or one
that resolved no repos at all while roots remain configured. Clearing every
root is the one deliberate route to zero and still prunes.

Two things follow that are easy to undo by accident:

- **The scan clock and the prune answer different questions.** Pruning wants
  evidence the repos are gone; `profile_scan_state` only records that a pass
  got to *look*, and a readable-but-empty root did look. Stamping it after an
  unreadable root arms the 24h throttle in `shouldRescanProfile` off a scan
  that saw nothing — and there is no manual rescan channel, only
  `profile:setRoots`, so the volume stays undiscovered for a day after it
  mounts.
- **Readability is only observed at the root.** A mount point *below* a
  configured root that is unmounted still reads as an ordinary empty directory
  (or throws where discovery ignores it), so repos under it are pruned as long
  as some other repo resolved. Widening the check to every depth is not the
  fix: macOS denies a non-FDA app `~/Documents` and friends, and one EACCES
  would disable pruning for good.

## A worktree whose directory is gone stays a row, flagged `missing`

Agents delete their checkouts without `git worktree remove` (Codex cleans up
`~/.codex/worktrees/…`), and git keeps listing the entry with a `prunable`
line. `worktrees.missing` (0027) records that so the sidebar can say
"directory missing" and every per-worktree handler can refuse with one typed
`worktree_missing` error (`worktree-liveness.ts`) instead of git's raw
"cannot change to '<path>'". Three things to keep straight:

- **Two sources set it, and they must agree.** The indexer reads git's
  `prunable` line; the state probe stats the checkout before it spawns git.
  Both are the same question — `checkoutExists`, the `.git` link inside the
  worktree, which is git's own prunability test — and the indexer only stats
  a *locked* worktree itself, because git never reports one prunable (a
  locked checkout on an unmounted drive would otherwise flip between the two
  forever) and a synchronous stat per worktree per rescan is main-thread
  time. The probe must not trust `git status`'s exit code instead: run from a
  nested worktree whose link is gone, git resolves the *parent* repo and
  succeeds with that checkout's branch and dirt.
- **Never prune.** An unmounted volume reads exactly like a deleted directory,
  and `git worktree prune` is repo-wide; a remounted checkout must clear the
  flag by itself (the next successful probe or re-index does). Remove stays
  available on a missing row — git removes a prunable entry cleanly — and
  removal is deliberately not guarded.
- **The guard reads only the flag, in the lookup.** Handlers that resolve a
  worktree through a per-file closure (`pathOf`, `rowOf`, `worktreeOf`) get
  the refusal from that closure, so a new handler cannot reach git without
  it; the one-off lookups check `missing` inline or call
  `missingWorktreeError`. None of them stat the path: handler tests stub the
  DB with paths that do not exist, and a live check would turn every one of
  them into a "missing" worktree.

## The pruner: one rule, one removal path, and `clean -X` is not what it looks like

The worktree pruner is `worktree-prune.ts` (the sweep), `worktree-reclaim.ts`
(the `git clean -Xd` operation) and `prune-handlers.ts` (both commands). Four
things about it are load-bearing.

**"Safe to prune" has exactly one definition, and it is in `@pwrgit/shared`.**
`prunableReason` / `isPrunableWorktree` (`packages/shared/src/prunable.ts`) are
run by the Stale lens in the renderer *and* by the sweep in main. It lives in
shared because two processes ask the same question from opposite sides of the
IPC boundary, and a second copy would let the lens and the verb disagree about
which rows the pruner may touch. Loosening or tightening the rule moves both —
that is the point, not a side effect.

**The sweep exists because the tree cannot answer.** Per-worktree Git state is
computed lazily, one repo at a time, on expand (`repo:computeState`) —
computing all ~150 at launch storms git. So on a profile nobody has browsed the
Stale lens is empty *by construction*, and a pruner that read the current tree
would report "nothing to prune" on a disk full of finished worktrees
(pwrdrvr/PwrGit#248 fixed the first-run confusion this caused; it did not
change the constraint). `sweepPrunableWorktrees` therefore computes its own,
capped at `PRUNE_SCAN_CONCURRENCY` (4 — inside the indexer's
`HYDRATION_GIT_CONCURRENCY` budget) and taking the repository lock per repo.
It is resumable for free: everything it computes lands in `worktree_state`, so
a cancelled sweep is not wasted and a re-run reports those repos as `cached`
and spawns no git. `prune-handlers.test.ts` pins that against real git.

Sizing is a **separate phase** after the candidate set is known, because it is
the slow half and it is not git — measuring a checkout means walking its
`node_modules`. `util/dir-size.ts` bounds it: an entry ceiling (the answer
comes back as a floor, which is the same decision), an abort signal, a yield
every few directories, and symlinks never followed (a pnpm store outside the
tree is not this worktree's bytes).

**Removal is `worktree:removeMany`, not a second path.** That command already
removes in bulk, streams `worktree:removed`, prunes the sidebar rows live and
owns the dirty/force retry. The pruner passes `{ confirmed: true }` to
`useRepoTree.removeWorktrees` because its own confirm names the repos, the
reasons and the bytes; two confirms in a row train people to click through
both.

**`git clean -e <pattern>` does not spare anything under `-X`.** This is the
trap, and it is silent. `-e` *adds* to git's ignore rules and `-X` deletes
exactly the ignored set, so `clean -Xdn -e '.env'` still reports
`Would remove .env` — a "default spare list" implemented that way would delete
precisely the files it advertises as protected. Sparing needs a **negated**
command-line pattern (`-e '!.env'`), which un-ignores the path so `-X` has no
reason to touch it; command-line excludes outrank `.gitignore`, and globs and
trailing-slash directory patterns work the same way. `spareArgs` does the
negation, `excludePatternProblem` refuses a user-typed `!` (it would become
`!!foo`), and `worktree-reclaim.test.ts` pins both directions against real git.
If that test ever looks redundant, it is the only thing between this feature
and a silent data-loss bug.

Three more invariants in the same file:

- **`-X`, never `-x`.** `-x` also deletes untracked files that no rule covers,
  which is uncommitted work. There is no UI for it, deliberately.
- **The preview is git's own dry run; the deletion re-runs git.** The parsed
  `Would remove …` paths are shown to the user and then thrown away. Do not
  "optimize" `reclaimIgnored` into `clean -- <paths>`: as written, a mis-parse
  can only mis-*draw* a row, never widen what gets deleted. The dry run is
  also the reason that command forces `LC_ALL=C` (git translates its own
  messages, so the prefix would otherwise be a guess) and
  `-c core.quotePath=false` (or a non-ASCII path arrives as octal escapes).
- **A single `-f`.** Git refuses to delete a directory holding its own `.git`
  unless `-f` is given twice, which is what keeps a vendored clone inside an
  ignored directory alive. One `-f` is the whole authorization wanted here.

And the reason all of this care is warranted: **ignored does not mean
worthless.** `.env` files, local SQLite databases, keys and scratch notes are
all routinely gitignored and have no object in the object store, so
`clean -X` is unrecoverable in a way that `discardAllChanges` (which restores
from HEAD) is not. `RECLAIM_DEFAULT_EXCLUDES` spares that class by default and
the user can narrow it; `discardAllChanges`' own `clean -fd` must keep
excluding ignored paths — two commands, two blast radii, and neither may
quietly acquire the other's flags.

**A lock is a refusal, and the predicate honours it.** `prunableReason` returns
null for `locked === true`, alongside dirty and missing. Two reasons, and the
second is the one that bites: `git worktree lock` is the only explicit "do not
touch this" in git's worktree model — repo-indexer.ts already reasons from it
("Git never reports a LOCKED worktree prunable ... that is what locking is
for") — and removing one needs `--force`, which `removeWorktrees` only offers
for the *dirty* set behind its own prompt. So a locked row in the list would be
a confirm promising "Remove 3 worktrees" followed by a failure notice for one of
them. `PruneCandidate` therefore carries no `locked` field: nothing that reaches
the dialog can be locked.

**The byte figure is the size of the files, never a promise about free space.**
Both confirms say what is being deleted ("holding 4.9 GB on disk", "totalling
3.9 GB") and never "freeing X", because the space returned to the volume is not
knowable ahead of time and sometimes not even afterwards. Measured on an APFS
volume: `cp -c` clone and a real `cp` copy of the same 20 MB file are
indistinguishable in every field `stat` exposes — same `nlink=1`, same
`st_blocks=40960`, same `du` — yet the volume lost 20 MB for both, and deleting
the clone returned nothing. `du` accordingly reported 60 MB for 20 MB of real
consumption. macOS adds a second layer: a local Time Machine snapshot pins the
blocks of anything deleted until it expires, so a correct measurement would
read zero and be right. `diskSpaceNote` in the renderer's prune-view.ts carries
this to the user, in two variants (APFS clones + Time Machine on darwin, hard
links elsewhere), and says the space does come back — later. Do not "fix" this
by reintroducing a free-space delta: on a live machine `f_bavail` drifted 1.1 MB
in the one second of an idle measurement.

**Sizes de-duplicate hard links, and are still a floor.** pnpm fills
`node_modules` by hard-linking one store blob into every package that needs it,
so summing `stat.size` per directory entry counts the same blocks repeatedly —
a 400 MB checkout measures as several GB, and that number becomes "freeing
4.2 GB" on a confirm. `directorySize` keys multiply-linked files by `dev:ino`
and counts each once (`hardLinks` reports how many repeats it skipped). Links
from *another* worktree into the same blob are still counted, because from this
root's view they are its bytes; what a delete returns to the filesystem is at
most this, never more.

**The reclaim panel will not delete with unapplied edits.** `reclaim()` sends
`appliedExcludes` — the patterns the visible preview was taken with — so a
pattern typed but not applied via "Update preview" would be silently dropped
and the file it was meant to protect deleted. The Delete button is disabled
while the field differs from the applied list, and the footer says both things:
what is currently spared, *and* that it is not applied yet. Do not collapse
those two messages into one; the dangerous fact must not be displaced by the
procedural one.

## Partial staging works through Git, never through renderer patch text

`partial-staging.ts` stages and unstages hunks and lines. Four invariants hold
it together; breaking any of them corrupts the index quietly.

- **Line IDs are positional, and only valid for their fingerprint.** An ID is
  `h:<hunkIndex>:<oldStart>:<newStart>:a|d:<lineNo>` — derived from where a
  line sits in one exact `-U0` snapshot, not from its content. The same ID
  names a different line as soon as the diff moves, so `applyPartialSelection`
  refuses any selection whose `fingerprint` no longer matches. The renderer
  relies on the same token to decide whether ticks survive a refresh: equal
  fingerprint means the ticks still point at the lines the user chose. Anything
  that can change what the pane shows must therefore change the fingerprint —
  which is why it hashes the display patch as well as the selection patch (an
  untracked file has no `-U0` output at all).

- **The fingerprint covers one path.** Status is read repo-wide so a
  path-limited query cannot disguise a rename's destination as a new file, but
  only this path's statuses enter the token. An edit to an unrelated file must
  not stale a diff the user is reading — the change watcher fingerprints the
  whole worktree and fires constantly.

- **Unstaging is a forward patch applied in reverse.** `buildSelectedPatch`
  describes residual-index → current-index and sets `reverse`, rather than
  inventing an inverted edit script. That keeps replacement ordering and
  `\ No newline at end of file` markers native to Git. The two directions
  compute different hunk starts, and `priorDelta` accumulates across hunks in
  both — the multi-hunk cases are the ones worth testing, since a single-hunk
  patch leaves that term zero.

- **`git apply` gets `--unidiff-zero --recount`.** `--recount` recomputes hunk
  counts from the body, so the counts written into the header are advisory;
  the *starts* are not, and neither is line order. `--unidiff-zero` disables
  context matching, so a wrong start silently writes to the wrong place instead
  of failing to apply.

Whole-file actions stay available for every kind partial staging refuses
(binary, conflicted, submodule, non-UTF-8, new, deleted, renamed, mode-only);
`partialDiffCapability` names the reason and the pane shows it.

## Clone and fork reach a forge INSTANCE, not a forge

`CloneService` and `ForkService` resolve providers through
`ForgeRepoRegistry.get(kind, hostname)`. Passing only the kind returns the
**SaaS** provider, so a project on `ghe.acme.example` is answered by github.com
— and a slug that exists on both confirms, clones, or forks the wrong
repository, silently. Every lookup here passes the hostname the request
carried; `repo:searchCloneSources` is the one channel that still cannot.

Resolving an instance is not permission to talk to it. Anything that spawns a
CLI also asks `forgeBlockAt(status, provider.hostname)` — including
`runClone`'s CLI branch and `fork`, which writes. SSH and HTTPS clones are
plain git and are deliberately not gated: the per-host switch governs the
forge, not `git clone`.

The local-checkout index (`repoKey`) is keyed on the hostname for the same
reason — two instances can host the same slug.

`apps/desktop/src/main/forge/AGENTS.md` has the whole rule, including why a
hostname is never evidence of which forge runs on it.

## Forking a checkout in place: add `upstream` first, then re-point `origin`

`ForkService.forkCheckout` forks what a checkout was cloned from and points the
checkout at the fork. Nothing is cloned and nothing moves on disk; the remote
rewire (`fork-remotes.ts`) is the whole operation, and **its order is not
interchangeable with the obvious one.**

`git remote rename origin upstream` rewrites every `branch.<name>.remote` that
named it. Renaming and then adding a fresh `origin` therefore leaves every
local branch tracking the ORIGINAL — so the next push goes straight back to the
repository the user just established they cannot push to, and the feature
silently does nothing. Adding the upstream remote first and re-pointing
`origin` in place leaves tracking untouched and correct: those branches already
track `origin`, and `origin` is now the fork.

Three more things that are easy to undo:

- **A separate `pushurl` is re-pointed too.** `origin`'s fetch URL alone
  decides nothing about where a push lands. `SshRemoteRecovery` deliberately
  *preserves* a custom push URL — it is changing how you reach the same
  repository, where this changes which repository you push to.
- **An existing remote is never clobbered.** `planUpstreamRemote` reuses a
  remote that already points at the original, and otherwise takes `upstream`
  or a suffixed variant. A remote is something the user may have configured
  deliberately (a mirror, a second fork).
- **`defaultBranchOnly` is never set on this path**, and the fetches never
  `--prune`. A partial fork is a clone-size saving, and this clones nothing —
  what it buys instead is `origin/*` refs for branches the fork does not have,
  which the next pruning fetch deletes out from under any local branch
  tracking them.

**Four ways in, and all of them are the same command.** The read-only mark in
the sidebar repo row, the fork action on the `origin` row under REMOTES, the
`read-only` chip in the worktree header, and a push the forge refuses all raise
`ForkCheckoutDialog`. The first three are statements of a constraint and each
one is also the way past it — a mark that reports "you cannot push here" and
offers no verb sends people hunting through REMOTES, which is exactly what
happened when the header chip was the only entry point. The sidebar's `Fork…`
button is the OTHER operation (`repo:fork`: search, fork, clone somewhere new)
and seeds itself from the selected row via `forkSeedFromRepo`.

Neither the mark nor the REMOTES action asks the forge whether a fork already
exists before offering. That answer costs a round trip per row, and the dialog
resolves it anyway: `forkCheckoutAction` says "Switch origin to my fork"
instead of "Fork & switch origin" once the preflight lands.

`pushWasDenied` (git-service.ts) is the other half: it classifies the one push
failure with a remedy inside PwrGit, and deliberately excludes a protected
branch, which reads almost identically on GitLab and means the opposite thing
about access.

## Publishing a branch asks for a remote, never a name

`remote:push` with `publish` runs `git push --set-upstream -- <remote> HEAD` —
the `--` because `git remote add -- -x` is accepted and Git would otherwise read
that name as an option. The
branch keeps its own name on the remote because Git's default
`push.default=simple` refuses a plain push whose upstream is named differently:
publish under another name and the toolbar's next Push fails, with no way back
short of a terminal. Verified against real Git in `remote.test.ts`.

A failed push's `message` is the **reason** (`pushFailureHeadline`) and Git's
stderr rides as `PwrGitError.detail`. The renderer's headline is the message's
first line, and Git's first line is `To <url>` — so a rejected push used to
headline as the one thing the user already knew. The headline is Git's first
line that says *why* — never simply its first `fatal:`, which is usually a
wrapper around the cause printed just before it ("Could not read from remote
repository" after "Permission denied (publickey)"). Keep the two apart: the card's
Git-output block, Copy and the command log read `detail`, and a sentence
PwrGit wrote must never be quoted there as something Git printed.

## A missing credential reads the same from fetch, pull and push

`classifyAuthFailure` (`remote-handlers.ts`) turns "Git had no credential it
may prompt for" into `authentication_required` for all three toolbar
operations; the worktree header answers it with `SshRemoteRecoveryDialog`.
Pull still rewrites the message through `safePullError`. Two things are easy
to undo:

- **It reads `detail` as well as `message`**, because a push's message is
  `pushFailureHeadline`'s sentence and Git's stderr is in `detail`. It never
  overrides `canceled`, `push_denied` (the forge accepted the credential, and
  an SSH key signs in as the same account) or the pull watchdog's codes.
- **A push is offered the change only if the push uses the URL being
  changed.** `inspectSshPushRecovery` returns null for a separate `pushurl`
  and for a `pushRemote` / `pushDefault` that names another remote. Offering
  it there would test and rewrite a URL the failed push never used.

## SSH host approval

`ssh-host-trust.ts` keeps scanned keys in expiring, window-bound proposals.
The renderer can approve an opaque proposal ID, never submit key bytes or a
known_hosts path. Inspection sends no account credentials. Approval appends only
the displayed key, and refuses existing trust entries, published-key mismatches,
or configuration/trust changes since inspection. Preserve the terminal fallback
for custom SSH commands, proxy routing, aliases and trust files; do not bypass
those settings or replace existing keys to make a clone succeed.
