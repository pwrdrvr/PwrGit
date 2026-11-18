# Changes, switching, history and commits

This guide covers path handling, staging, branch switching, the lane graph, sequencer operations and commit identity. It was moved from
[apps/desktop/src/main/git/AGENTS.md](../../../apps/desktop/src/main/git/AGENTS.md).

## Paths from git are always forward-slash

`git status`, `ls-files` and `ls-tree` report `a/b/c` on every platform. Split
on `/`. Do not use `node:path`, `sep`, or `join()`, which makes backslashes
that git never emits.

## Batched pathspecs are all-or-nothing

`runBatched` splits long path lists across several git runs, because Windows
limits a command line to ~32 KB.

- Git validates a whole pathspec list before it changes anything, so one bad
  path aborts its batch. Partition mixed kinds (for example, untracked and
  staged-new paths in one discard) and send each set to the command that suits
  it. Otherwise later steps see an unexpected state.
- A failure in a later batch leaves earlier batches applied. Announce the
  change also on error (`notifyChanged` in `changes-handlers.ts`).

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
