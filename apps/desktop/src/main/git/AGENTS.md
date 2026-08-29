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
