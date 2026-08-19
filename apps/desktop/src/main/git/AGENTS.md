# src/main/git — AGENTS.md

Notes for the git layer. See `apps/desktop/AGENTS.md` for app-wide facts.

## Real-git tests run on Windows CI too

Many suites here drive the system `git` against temp repos. Two hazards only
ever fail on the Windows runner, so a green local run proves nothing about
them:

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

Two rules follow, and `graph-lanes.test.ts` pins both:

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
