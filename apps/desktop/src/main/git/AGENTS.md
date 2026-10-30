# src/main/git — AGENTS.md

Notes for the git layer. See `apps/desktop/AGENTS.md` for app-wide facts.

## Real-git tests run on Windows CI too

Many suites here run a real Git against temp repos. Some hazards fail only on
the Windows runner, so a green local run proves nothing about them.

- **Never give a Git process a native cwd inside a directory that we may
  remove.** Git for Windows can pass execution to descendant `git.exe`
  processes. Awaiting the launcher does not mean they released the cwd, so
  removal fails with `EPERM` or `EBUSY`. Keep the cwd in a stable directory and
  use `git -C <repo>` (`gitProcessInvocation` in `dugite.ts`).
- **Get the `GitExec` from `test-support/system-git.ts`. Never hand-roll one.**
  It keeps the exit + stream-end policy, a 250ms post-exit drain grace, and
  `execGit`'s cancellation and output callbacks. A grace expiry does not prove
  that inherited pipes caused a failure.
  - The remote, partial-staging, rebase-assistant and branch-lifecycle tests
    enable a 5s diagnostic tripwire. `timedGitSync` records their fixture
    calls before and after a blocking call. It cannot see inside the block.
  - CI uploads JSONL begin/end records and per-test totals through
    `PWRGIT_GIT_DIAGNOSTICS_DIR`, also on failure. Only instrumented calls in
    test scopes count, not `beforeAll` or production Dugite calls.
  - Reports omit arguments, paths, output and environment. `killed` means a
    signal was requested, not observed. Diagnostics change no timeout or
    cleanup.
- **Before you fix a Windows timeout, compare the run against other runs.**
  The runner sometimes slows spawning and disk I/O for minutes. Real-git files
  then slow together, JS-only files do not (#397: a ~2s `branch-lifecycle`
  test hit 20s). Compare each file's `(N tests) Xms` line with its median in
  recent Windows jobs. Overlapping slow files mean the runner. Do not raise a
  timeout or add a retry: a retry hides real hangs, and the runner can exceed
  any limit. One slow file means a hang (#261).
- **Code under test runs the bundled Git. Fixtures run the Git on PATH.**
  - Despite its name, `createSystemGit` runs Dugite's bundle like production:
    `gitExecutionEnvironment` puts the bundle first on PATH and sets
    `GIT_EXEC_PATH`. Its version follows the lockfile, not the machine.
  - Fixture helpers that call `execFileSync("git")` run the first `git` on
    PATH. So another Git first on PATH changes the fixtures only.
  - `PWRGIT_TEST_GIT=installed` makes the code under test run that PATH Git
    through `installedGitEnvironment`, as production runs a Git chosen in
    Settings. CI runs only the default, so CI never tests an installed Git.
  - If a change depends on Git's version, run the suite with the switch. Then
    run it again with another Git first on PATH (on macOS, a scratch directory
    with a symlink to `/usr/bin/git`).
  - The switch does not reach suites that call production's `execGit`. Those
    follow `useInstalledGit`, which is the bundle unless a test sets it.
- **`core.autocrlf` defaults to true on Windows.** A file restored from HEAD
  comes back with CRLF, so a test that compares file *contents* with the
  committed bytes fails. If a test reads contents back, set it off beside
  `user.name` / `user.email`:

  ```ts
  git(repo, ["config", "core.autocrlf", "false"]);
  ```

- **Windows forbids `* ? : " < > |` in filenames.** `writeFileSync` of a name
  with `*` or `?` fails with ENOENT before the assertion. `[` and `]` are legal
  everywhere and test glob-escaping equally well (see `gitignore.test.ts`).
  Keep `*` / `?` cases to pure string assertions.

## A stale remote-tracking ref comes from a separate clone

Git 2.56 changed `git push <url>`. When exactly one configured remote has that
push URL, Git now moves that remote's tracking ref (`refs/remotes/<name>/*`,
`@{push}`). Older Git does not. Today the match is byte for byte (`file://`,
`./`, a trailing slash or a relative path all miss). A later release may
normalize it. Do not depend on either behavior.

- **To make `origin/<branch>` stale, push from a separate clone.** A push never
  writes another repository's refs. A linked worktree is not separate, because
  worktrees share `refs/remotes`. Prefer this to `update-ref`, so the asserted
  precondition is a state that Git produced.
- **Product code that pushes a branch to a URL refreshes the ref itself.**
  `pushPlannedRefs` pushes to the remote's push URL and keeps its refetch. The
  bundled Git predates 2.56, and Settings accepts any installed Git.
  `remote.test.ts` pins this with two remotes on one URL, where 2.56 moves
  neither. The remote tag actions also push to the URL. They need no refresh,
  because the default fetch refspec maps no tags.

## Which Git runs: the bundle, set up the way an installed Git would be

Every Git process goes through `gitLaunch` in `dugite.ts`. It returns the
bundled Git unless Settings › General › Git runtime chose an installed Git
(`useInstalledGit`, persisted as `gitPath`). `execGit`, `execGitRecords` and
`execGitBinary` spawn what `gitLaunch` returns. They do not call
`dugite.exec`.

- **The bundle needs a system config that PwrGit owns.** Dugite sets
  `GIT_CONFIG_SYSTEM` to its `etc/gitconfig`, which includes only
  `/etc/gitconfig`, not the installed Git's config. That loses Homebrew's and
  Apple's `credential.helper = osxkeychain` (HTTPS fetches fail with "terminal
  prompts disabled") and any LFS filter (LFS repos check out pointer files).
  - `bundledGitEnvironment` (`packages/mcp-server/src/git-runtime.ts`) writes a
    content-named file under `<userData>/git`: the `git lfs install --system`
    filter, on macOS the installed Git's `git-credential-osxkeychain`, then an
    include of Dugite's config. At system scope, the user's global config still
    wins and `credential.helper =` still opts out.
  - Nothing is written until `configureBundledGitConfig` runs, so unit tests
    stay out of the real data directory. Tests that need it use a temp one.
- **Borrow the keychain helper from the user's terminal Git.** A keychain item
  is readable without a prompt only by the helper binary that stored it. An
  app opened from Finder has launchd's PATH, which puts Apple's `/usr/bin/git`
  before Homebrew's (the opposite of a shell that ran `brew shellenv`). So
  `keychainSearchPath` tries launchd's directories last.
- **A chosen Git never falls back.** If it breaks, every command fails with a
  message that names it and points at Settings. A fallback would make Settings
  wrong about which Git runs. `installedGitEnvironment` removes every bundle
  variable: `GIT_EXEC_PATH`, the generated `GIT_CONFIG_SYSTEM` and the
  bundle's PATH directories. Any one of them silently sends that Git to the
  bundle's helpers or config.

Discovery (`runtime-status.ts`) never runs Apple's `/usr/bin/git`. Without
developer tools, that shim opens the installer dialog. Discovery lists the Git
under `xcode-select -p` instead, only when that Git exists. A Git without
working Git LFS is listed but cannot be chosen. `git:selectRuntime` probes a
path before it saves it.

## Main decides how many Git processes exist, not the renderer

**Bound every Git spawn that an IPC message starts on the main side.** A
renderer guard is useful but not sufficient: the renderer does not own process
lifetime, and renderer bugs are the case the bound is for.

- `file-insights-handlers.ts` tracks live reads per renderer **and kind**
  (`<webContentsId>:history`), never per operation id. A pane shows one file in
  one way, so a second read of a kind supersedes the first.
- Operation ids are unique per request, so a key on them caps nothing. A
  renderer that asked in a loop (a retry with no backoff, a bad effect
  dependency) made main spawn one Git per iteration.
- Fan-out over a list uses `mapLimit` (`util/map-limit.ts`). A per-message
  spawn needs its own ceiling.

## Every long-running remote command registers an activity

**Wrap every command that reaches a remote in `tracked()` in
`remote-handlers.ts`, not only toolbar commands. Do not call `execGit`
directly.**

`remote-activity.ts` holds one record per live fetch / pull / push. The
toolbar popover, the elsewhere-toast and the cancel button read it. Three
fields carry what a spinner cannot show:

- **`queued`.** An operation waits for `WorktreeOperationQueue`'s repository
  lock before it runs Git. The watchdog starts only when the lock is held. So
  register BEFORE you take the lock.
- **`silent` / `lastOutputAt`.** `--progress` is forced on fetch and push
  (`forceProgress`), so silence there is evidence. Local phases promise no
  output, so the renderer warns about silence only in network phases.
- **`command` + `tail`.** Git's own words: which command, and what it printed
  last. These diagnose a wedged transfer.

Rules:

- **Cancel and the watchdog must both reach Git.** Pull combines them with
  `AbortSignal.any([watchdog.signal, activity.signal])`. Passing one silently
  disables the other. Rollback/recovery is deliberately NOT cancellable,
  because a stopped rollback leaves a broken checkout.
- **A cancel is an outcome, not a failure.** `safePullError` returns it
  unchanged and the pull logs at `info`. The renderer shows a neutral flash, no
  error toast. Do not route `code: "canceled"` into the failure path.
- Output lines go through `sanitizeGitLogDetail` on the way in, so a
  credential in a remote URL never reaches the record, the event or the
  clipboard.
- `remote:planPushRefs` and `remote:pushRefs` (a sidebar dialog, not the
  header) are tracked and repo-scoped (`worktreeId: null`), because no checkout
  owns a push to named remotes. The review fetches EVERY destination remote.
  Every network command they run forces `--progress`, or the silence warning
  would be false.
- `collapseProgress` (git-service.ts) is the other half. Git writes the
  progress meter with CR. Without it, a rejection's stderr reaches the review
  table behind every repaint of "Writing objects".

Why: a present but unanswering SSH agent (1Password's, with 1Password stopped
or locked) blocks Git forever with no output. Timeouts are in *minutes*,
because a large clone looks the same. So `silent` is per command, and Cancel
exists.

**The one exception is `remote:checkSelected`, the automatic check behind the
header's "up to date".** The registry drives the header's buttons. Registered,
this check showed "Preparing local changes…" on Fetch and locked Pull and Push
every minute. It stays out because it cannot wedge: it has its own 12s
timeout, holds the repository lock only for ref writes (`ls-remote` runs
unlocked), and `tracked()` aborts it so a user's fetch never queues behind it.
A background check without all three belongs in the registry.

## `repo:changed` names its repositories when it can

Pass `repoIds` when known repositories changed in place (a fetch, a branch,
a tag, a worktree, a state re-read). The sidebar then re-reads only those
rows (`repo:list` with `repoIds`), and every other repository keeps its
object. Without it, each window re-reads the whole profile and every
expanded repository re-runs `repo:refs`. Over a bulk fetch that was one git
call per expanded repository per repository fetched.

Leave `repoIds` off only when the list or its order may move: a scan, clone,
fork, removal, hide, pin or reorder.

A change that only moves refs (a new branch on a remote) changes no
checkout's state, so the worktree refresher says nothing. That is why
`refreshRemoteBranches` in `remote-handlers.ts` names its repository: it is
the only signal that reloads that repository's Branches and Remotes.

## Paths from git are always forward-slash

`git status`, `ls-files` and `ls-tree` report `a/b/c` on every platform. Split
on `/`. Do not use `node:path`, `sep`, or `join()`, which makes backslashes
that git never emits.

## A nested agent worktree is not a change

Agents put worktrees inside the repository (`.claude/worktrees/<name>`).
`git status` reports each one as an untracked folder, so a clean primary read
`●1` and every branch switch asked about it. Any status read that becomes a
dirty count or a change list appends `nestedWorktreePathspec(cwd)`
(`@pwrgit/mcp-server/nested-worktrees`): exclude pathspecs for this
repository's linked worktrees inside `cwd`.

- It is fs-only (no Git process) and keeps a real file beside the worktree
  visible. A folder whose `.git` link is gone counts as content again.
- Removal checks (`worktreeRemove`, `repo-removal.ts`) deliberately do not use
  it: deleting the folder deletes the nested checkout too.

## Batched pathspecs are all-or-nothing

`runBatched` splits long path lists across several git runs, because Windows
limits a command line to ~32 KB.

- Git validates a whole pathspec list before it changes anything, so one bad
  path aborts its batch. Partition mixed kinds (for example, untracked and
  staged-new paths in one discard) and send each set to the command that suits
  it. Otherwise later steps see an unexpected state.
- A failure in a later batch leaves earlier batches applied. Announce the
  change also on error (`notifyChanged` in `changes-handlers.ts`).

## Switching with uncommitted work: bring is a plain switch first

`branch:switch` answers "where does the uncommitted work go", and no answer
commits. `guardedSwitchBranch` (renderer `features/shell/branchSwitch.ts`)
asks; `switch-carrying.test.ts` pins all three paths against real Git.

- **Bring is a plain `git switch`; stash only on refusal.** Git carries what
  the destination does not touch and refuses atomically when it would
  overwrite a file. Do not stash "to be safe": the common case needs none.
  The refusal is `switch_would_overwrite` with Git's list in `error.paths`,
  parsed under `LC_ALL=C` (`parseSwitchOverwritePaths`, tracked and untracked
  lists). Only then does the renderer offer `"merge"`
  (`switchBranchCarryingChanges`) or `"leave"`.
- **Leave stashes as `pwrgitLeftOnStashMessage(<branch>)`**, the exact text a
  later switch onto that branch looks for to offer the work back. Change the
  spelling in `@pwrgit/shared` only.
- **Every stash in a switch is addressed by SHA, never `stash pop`**, and a
  failed switch reapplies it before returning Git's original refusal
  (`checked_out_elsewhere` is a navigation upstream).
- A linked worktree nested in the checkout (`.claude/worktrees/x`) is an
  untracked directory with a `.git` file. `stash -u` prints "Ignoring path"
  and leaves it alone; keep a test proving each path still does.

## The lane graph draws fetched work, not just local work

`graph-handlers.ts` builds the lineage from a trunk walk plus one not-in-trunk
walk over the drawn branches. A branch BEHIND its upstream has commits that no
local ref reaches. A walk of local tips omits them: the lane looks current,
the sidebar says "↓1", and the row is absent.

`unappliedUpstreams` (git-service) finds behind branches in one `for-each-ref`
with `%(upstream:trackshort)` (`<` behind, `<>` diverged). Do not use
`%(upstream:track)`: it is a sentence that git may translate.

`graph-lanes.test.ts` pins which commits get walked. `lane-layout.test.ts` pins
how they are drawn. Run both when you change either half.

- **Every drawn branch adds its upstream to the walk when it is behind.** That
  ref goes in `upstreamRefs`, NOT `shownBranches`, which the toolbar counts as
  active branches. The renderer draws the union and dashes the upstream as
  fetched-but-unapplied. `lane-layout.ts` already draws it. A diverged branch
  forks at the merge base, so the dashed leg runs past our rows and bends into
  our lane. `lane-layout.test.ts` pins that geometry, including the
  rewritten-SHA case where both legs carry the same work.
- **The lane cache is checked against the refs, not trusted for its TTL.**
  Each build stores a digest of `refs/heads` + `refs/remotes`, read before
  the build reads anything. An unforced request whose digest no longer
  matches rebuilds, and only the newest build started for a key may write
  the cache. Why: a pull fetches, then fast-forwards seconds later. A build
  in between sees `origin/main` ahead of `main` and dashes the trunk; as
  last writer it used to stay cached after the fast-forward.
  `graph-handlers.test.ts` reproduces it with a held `git log`.
- **The focused worktree's own branch is never skipped.** It can fall out of
  the repo-level set (`ACTIVE_DRAW_CAP` keeps 30 branches by recency), so the
  per-worktree step adds its upstream again. Put anything scoped to "what the
  user looks at now" there, not in the repo-level cache, which all worktrees
  of a repo share.

## `--continue` exits non-zero on ordinary progress

`git rebase --continue` returns **1** when it commits the current step and
stops on the *next* conflict. A multi-commit `cherry-pick` does the same. An
exit-code check shows normal progress as a failure, with Git's `hint:` block.

`operation-service.ts` snapshots HEAD, the sequencer counter and the conflict
count, then runs the command. If any moved, the result is `stopped`
(progress). Only a run where nothing moved is `continue_failed`.
`operation-service.test.ts` pins both against real Git. Keep that rebase test.

- **An operation with zero conflicts is normal.** `rebase -i` paused on `edit`
  and `merge --no-commit` leave markers with a clean index. Do not treat
  "mid-operation" as "conflicted". That hides the Changes and Rebase tabs when
  the user needs them.
- **`GIT_AUTHOR_*` / `GIT_COMMITTER_*` outrank `-c user.email`.** A test with
  them in the environment cannot prove identity handling. Unset them (see
  `execGitWithoutIdentityEnv`).

## A PwrGit commit records the profile, completely

`commit-identity.ts` owns authorship. Every commit PwrGit writes (commit,
amend, annotated tag, operation continue, the rebase assistant) gets
`commitIdentityArgs` plus `SCRUBBED_IDENTITY_ENV`.

- **`-c user.email` alone is not enforcement.** It loses to `author.email` /
  `committer.email` at any scope, and to `GIT_AUTHOR_*` / `GIT_COMMITTER_*` /
  `EMAIL` inherited from a shell. So the args set all three keys, and the env
  overlay *unsets* the variables (an `undefined` value removes a key for a
  Node child). The footer's prediction (`git var`, same args and env) then
  matches what is written.
- **An empty profile email must not reach `-c`.** `-c user.email=` records
  `Name <>`. With no email, pass `user.useConfigOnly=true`, so Git uses its own
  config or refuses.
- **A successful `git var` proves nothing on macOS.** Unconfigured macOS Git
  invents `login@host.local` and exits 0; Linux Git refuses.
  `resolveOutsideIdentity` adds `user.useConfigOnly=true`, run from `tmpdir()`
  for the machine-wide answer.
- **Refusal text puts the reason last.** After the "Author identity unknown"
  banner, the trailing `fatal:` line names the missing field.

Rebase-assistant signing:

- The *check* never signs (`commit.gpgSign=false`), so it can never prompt.
- *Apply* honours the user's signing config. When the signer fails, it aborts,
  restores and returns `signing_failed`. The handler keeps the approval for
  exactly one explicit `unsigned: true` apply.
- "Is it signed" reads the `gpgsig` header (`git log --pretty=raw`). Never use
  `%G?`: without `gpg.ssh.allowedSignersFile` it reports an SSH signature as
  `N`.

PwrGit writes identity config in exactly two places, each first previewed in a
Settings dialog: `identity:writeGlobal` (`user.name` / `user.email`) and
`identity:setFolderSync`. `git config --global` writes `GIT_CONFIG_GLOBAL`,
else `~/.gitconfig` if present, else the XDG file. `globalConfigFile`
reproduces that for the preview. Tests isolate `HOME`, `XDG_CONFIG_HOME` and
`GIT_CONFIG_NOSYSTEM`, or the dev machine's identity leaks into assertions.

`folder-identity.ts` is Settings › Profiles › By folder. It writes one
`[includeIf "gitdir/i:<root>/"]` per profile root, pointing at
`<global dir>/.gitconfig-pwrgit-<profile id>`. That file name is the only mark
of ownership. All other includes are the user's and are only read.

- **Order is the whole mechanism.** An include overrides only what comes
  before it. `git config --global user.email` on a file without `[user]`
  appends one after the includes, and it wins. So a sync removes PwrGit's
  entries and appends them at the end. `planIsApplied` checks order and
  content.
- **You cannot ask a folder.** `gitdir:` matches a repository's `.git`, so
  `git -C <root> config` outside a repo ignores the include. The report asks
  every indexed repository (`mapLimit`, six at a time).
- **With the switch on, profile edits rewrite the includes without a preview**
  (disclosed in the dialog and the profile editor). The rewrite runs from `observeEvent("profile:changed")` in `index.ts`:
  debounced, serialized with the switch, skipped when the config matches.
  Nothing else may write these entries.

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
  throttle in `shouldRescanProfile` from a scan that saw nothing. The only
  rescan channel is `profile:setRoots`, so the volume stays undiscovered for a
  day after it mounts.
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

## A worktree whose directory is gone is dropped, unless it may come back

Agents delete checkouts without `git worktree remove` (Codex cleans up
`~/.codex/worktrees/…`). Git keeps the entry with a `prunable` line and
refuses to check out its branch elsewhere ("already used by worktree at …").

- Every index pass (`vanished-worktrees.ts`, from all three `listWorktrees`
  sites in the indexer) runs `git worktree remove --force <path>` for each
  such entry, one at a time. The row goes with it.
- A probe that finds a linked checkout gone requests the re-index
  (`onWorktreePathMissing`, once per worktree per ten minutes, one pass per
  repo at a time). The row leaves within one poll.
- Passes overlap (a rescan, a user refresh). "is not a working tree" from the
  remove means another pass won. Treat it as done, here and in
  `gitWorktreeRemove`.

These stay, flagged `worktrees.missing` (0027):

- **A locked worktree** (git's "do not touch", usually removable media).
- **A folder on an unattached volume**, which git cannot tell from a deleted
  one. `onDetachedVolume`: under `/Volumes`, `/media`, `/run/media` or `/mnt`,
  a path with no mount point (device id unlike its parent's) below the
  container waits for its drive. On Windows, a missing drive root waits.
  Elsewhere the folder was deleted.
- **A folder that lost its `.git` link.** Its files remain, and git would
  refuse to remove it.
- **A detached HEAD that no ref contains.** The record is the last pointer to
  those commits. Remove is the user's decision.
- **Anything git declined to remove.** Logged, not retried for ten minutes
  (every refresh lists it again).

Known gap: a folder **moved by hand** (`mv`, not `git worktree move`) looks
gone at its old path. Dropping the record orphans the moved checkout, because
`git worktree repair` needs it. Accepted: agents delete much more often than
people move.

**Never run `git worktree prune`.** It is repo-wide and drops the entries
above too.

For kept rows, the sidebar says "directory missing", and every per-worktree
handler refuses with one typed `worktree_missing` error
(`worktree-liveness.ts`) instead of git's "cannot change to '<path>'".

- **Two sources set the flag, and they must agree.** The indexer reads git's
  `prunable` line. The state probe stats `checkoutExists` (the worktree's
  `.git` link, git's own test) before it spawns git. The indexer stats only
  *locked* worktrees, which git never reports prunable (else they flip
  forever). A sync stat per worktree per rescan costs main-thread time. Do not
  trust `git status`'s exit code: in a nested worktree with no link, git
  resolves the *parent* repo and succeeds.
- **A remounted checkout clears the flag** at the next probe or re-index.
  Remove stays available and unguarded on a missing row: git removes a
  prunable entry cleanly.
- **The guard reads only the flag, in the lookup.** Per-file closures
  (`pathOf`, `rowOf`, `worktreeOf`) return the refusal, so a new handler cannot
  reach git without it. One-off lookups check `missing` inline or call
  `missingWorktreeError`. None stat the path: handler tests stub the DB with
  nonexistent paths, which a live check would mark missing.

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
  `node_modules` is slow. `util/dir-size.ts` has an entry ceiling (the answer
  becomes a floor, with the same decision), an abort signal, a yield every few
  directories, and never follows symlinks (a pnpm store outside the tree is
  not this worktree's bytes).
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

## Partial staging works through Git, never through renderer patch text

`partial-staging.ts` stages and unstages hunks and lines. If you break one of
these invariants, the index is silently corrupted.

- **Line IDs are positional and valid only for their fingerprint.** An ID is
  `h:<hunkIndex>:<oldStart>:<newStart>:a|d:<lineNo>`, a position in one `-U0`
  snapshot. `applyPartialSelection` refuses a stale `fingerprint`, and the
  renderer keeps ticks only while it is equal. So anything that changes the
  pane must change the fingerprint: it hashes the display patch too (an
  untracked file has no `-U0` output).
- **The fingerprint covers one path.** Status is read repo-wide, so a rename's
  destination does not look like a new file. Only this path's statuses enter
  the token. The change watcher fingerprints the whole worktree and fires
  constantly. An unrelated edit must not stale the diff.
- **Unstaging is a forward patch applied in reverse.** `buildSelectedPatch`
  describes residual-index → current-index and sets `reverse`. This keeps
  replacement order and `\ No newline at end of file` markers native to Git.
  The two directions compute different hunk starts. `priorDelta` accumulates
  across hunks in both, so test multi-hunk cases (one hunk leaves it zero).
- **`git apply` gets `--unidiff-zero --recount`.** `--recount` recomputes
  counts, so header counts are advisory. Hunk starts and line order are not.
  `--unidiff-zero` disables context matching, so a wrong start writes to the
  wrong place and does not fail.

Whole-file actions stay available for every kind partial staging refuses
(binary, conflicted, submodule, non-UTF-8, new, deleted, renamed, mode-only).
`partialDiffCapability` names the reason, and the pane shows it.

## Clone and fork reach a forge INSTANCE, not a forge

**Every provider lookup passes the hostname from the request.**
`CloneService` and `ForkService` call `ForgeRepoRegistry.get(kind, hostname)`.
With only the kind it returns the **SaaS** provider, so github.com answers for
`ghe.acme.example`. A slug on both then confirms, clones or forks the wrong
repository, silently. `repo:searchCloneSources` is the one channel that still
cannot pass the hostname.

- Resolving an instance is not permission to use it. Anything that spawns a
  CLI also calls `forgeBlockAt(status, provider.hostname)`, including
  `runClone`'s CLI branch and `fork`, which writes.
- SSH and HTTPS clones are plain git and are deliberately not gated. The
  per-host switch governs the forge, not `git clone`.
- The local-checkout index (`repoKey`) is keyed on the hostname, because two
  instances can host the same slug.

`apps/desktop/src/main/forge/AGENTS.md` has the whole rule, including why a
hostname is never evidence of which forge runs on it.

## A fresh clone of a fork keeps its original through `keepForkOriginal`

`repo:clone` (with `upstream`) and `repo:fork` add the fork's original after
the transfer, through one helper in `fork-remotes.ts`.

- **Read the remotes first.** `gh repo clone` of a fork writes `upstream`
  itself, so a bare `git remote add upstream` failed. A remote that already
  points at the original is kept. If another repository has the name, the
  original goes to `upstream-2`.
- **Main asks the forge again before the transfer.** `CloneService` refuses a
  slug that is not the source's `parent` or `root`, so a renderer cannot get a
  remote written for any slug. If only the remote fails, the clone succeeds
  (`ClonedRepo.upstreamFailure`). An error would offer a retry into the folder
  it just made.

## Forking a checkout in place: add `upstream` first, then re-point `origin`

`ForkService.forkCheckout` forks the checkout's source and points the checkout
at the fork. Nothing is cloned or moved. The remote rewire (`fork-remotes.ts`)
is the whole operation.

**Add the upstream remote, then change `origin`'s URL in place. Never rename
`origin`.** `git remote rename origin upstream` rewrites every
`branch.<name>.remote`. Every branch then tracks the ORIGINAL, and the next
push goes to the repository the user cannot push to. With the correct order,
branches track `origin`, which is now the fork.

- **A separate `pushurl` is re-pointed too.** The fetch URL does not decide
  where a push goes. `SshRemoteRecovery` deliberately *keeps* a custom push
  URL, because it changes how you reach the same repository. This changes
  which repository you push to.
- **An existing remote is never overwritten.** `planUpstreamRemote` reuses a
  remote that already points at the original, else takes `upstream` or a
  suffixed variant. The user may have configured a remote (a mirror, a second
  fork).
- **`defaultBranchOnly` is never set here, and the fetches never `--prune`.**
  A partial fork only saves clone size, and this clones nothing. It would
  leave `origin/*` refs for branches the fork lacks, and the next pruning
  fetch would delete refs that local branches track.

Four entry points raise `ForkCheckoutDialog`: the sidebar repo row's
read-only mark, the fork action on REMOTES' `origin` row, the worktree
header's `read-only` chip, and a forge-refused push. A mark that states the
constraint must also offer the way past it.

- The sidebar's `Fork…` button is the OTHER operation (`repo:fork`: search,
  fork, clone elsewhere), seeded from the selected row by `forkSeedFromRepo`.
- The marks do not ask the forge if a fork exists (a round trip per row).
  After its preflight, `forkCheckoutAction` says "Switch origin to my fork"
  instead of "Fork & switch origin".
- `pushWasDenied` (git-service.ts) classifies the one push failure with a
  remedy in PwrGit. It excludes a protected branch, which reads almost the
  same on GitLab but means the opposite about access.

## Publishing a branch asks for a remote, never a name

`remote:push` with `publish` runs `git push --set-upstream -- <remote> HEAD`.

- The `--` is needed because `git remote add -- -x` is accepted, and Git would
  read that name as an option.
- The branch keeps its own name. `push.default=simple` (Git's default) refuses
  a plain push to a differently named upstream. Publish under another name and
  the next Push fails, with only a terminal to fix it. `remote.test.ts`
  verifies this.

A failed push's `message` is the **reason** (`pushFailureHeadline`). Git's
stderr goes in `PwrGitError.detail`.

- The renderer's headline is the first line of `message`. Git's first line is
  `To <url>`, which the user already knows.
- The headline is Git's first line that says *why*, not the first `fatal:`.
  That line usually wraps the cause printed before it ("Could not read from
  remote repository" after "Permission denied (publickey)").
- The card's Git-output block, Copy and the command log read `detail`. Never
  show a PwrGit sentence there as Git output.

## A missing credential reads the same from fetch, pull and push

`classifyAuthFailure` (`remote-handlers.ts`) maps "Git had no credential it
may prompt for" to `authentication_required` for all three toolbar
operations. The worktree header answers with `SshRemoteRecoveryDialog`. Pull
still rewrites the message through `safePullError`.

- **It reads `detail` as well as `message`**, because a push's message is the
  `pushFailureHeadline` sentence. It never overrides `canceled`,
  `push_denied` (the forge accepted the credential, and an SSH key signs in as
  the same account) or the pull watchdog's codes.
- **Offer a push the change only if the push uses the URL being changed.**
  `inspectSshPushRecovery` returns null for a separate `pushurl` and for a
  `pushRemote` / `pushDefault` that names another remote. Otherwise PwrGit
  tests and rewrites a URL the push never used.

## SSH host approval

`ssh-host-trust.ts` keeps scanned keys in expiring, window-bound proposals.

- The renderer approves an opaque proposal ID. It never submits key bytes or
  a known_hosts path.
- Inspection sends no account credentials.
- Approval appends only the displayed key. It refuses existing trust entries,
  published-key mismatches, and configuration or trust changes since
  inspection.
- Keep the terminal fallback for custom SSH commands, proxy routing, aliases
  and trust files. Do not bypass those settings or replace existing keys to
  make a clone succeed.

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

## Removing a worktree: PwrGit deletes the folder, then Git drops the record

`worktreeRemove` (git-service.ts) does not let `git worktree remove` delete the
checkout:

1. It checks what Git checks: main worktree, lock, and (unless forced) the
   same `status --porcelain --ignore-submodules=none`.
2. It deletes the folder with `util/delete-tree.ts`.
3. It runs `git worktree remove --force` on the missing path, which drops one
   admin entry.

Reasons (2026-10-16 beachball):

- **Git's delete stops at a read-only directory and unregisters anyway.** On
  Go's 0555 module cache, Git failed with "Permission denied" and left an
  unlisted folder. `deleteTree` adds the owner's rwx to a real
  directory before it empties it.
- **Never delete synchronously in main.** `rmSync` with `maxRetries` *sleeps*
  on the main thread between attempts (34s of beachball). `deleteTree` streams
  unlink/rmdir through p-map-iterable, four at a time, with progress. Keep all
  recursive work off `*Sync`.
- **A partial delete keeps the worktree registered.** The `.git` link goes
  last (`deleteLast`), so Git still recognises the rest and a forced retry
  finishes it. The renderer's Retry passes `force`, because Git reads the
  half-finished delete as changes.

Cases `worktreeRemove` does not check (submodules, a missing `.git` link, a
`prunable` entry) go to `git worktree remove` unchanged. The lifecycle handler
tests pin this against real Git, with an event-loop stall assertion that the
old path failed at 33s.

Worktree sharing through `pwrgit-share` is opt-in; unavailable sharing falls
back to a normal Git checkout. It uses reflinks, never hardlinks. Size UI must
not promise freed bytes: shared extents may still belong to another checkout.
See the [worktree sharing design](../../../../../docs/plans/2026-10-27-worktree-share.md).
On macOS, set `PWRGIT_SHARE_REAL_BINARY` to an absolute built CLI path and run
`pnpm test apps/desktop/src/main/git/worktree-share.real-cli.test.ts` for the
opt-in handler-to-binary tests; ordinary tests use the fake executable.

## Removing a repository never prunes

**No step runs `git worktree prune`.** `repo-removal.ts`:

- Reviews every checkout. On `repo:remove` it reviews again and refuses
  (`review_changed`) if the answers changed. Main never trusts the renderer's
  review.
- Removes linked worktrees first, each in its worktree lock with
  `lockForRemoval` held: the folder goes to the Trash, then
  `git worktree remove --force <path>` clears that record.
- Removes the main checkout last, only if every worktree went and nothing in
  `.git` was kept, inside the worktree lock and then the repository lock.
- "Push first" is the renderer's job, through the tracked push commands,
  before `repo:remove`. Main refuses a decision set that still has one.
- E2E replaces the Trash with a directory through `PWRGIT_E2E_TRASH_DIR`.
