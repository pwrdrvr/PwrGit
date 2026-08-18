# src/main/git — AGENTS.md

Notes for the git layer. See `apps/desktop/AGENTS.md` for app-wide facts.

## Real-git tests run on Windows CI too

Eleven suites here drive the system `git` against temp repos. Two hazards only
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
