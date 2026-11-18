# Real-Git tests

This guide covers the hazards of tests that run a real Git, on Windows CI and across Git versions. It was moved from
[apps/desktop/src/main/git/AGENTS.md](../../../apps/desktop/src/main/git/AGENTS.md).

Code paths in backticks are relative to [apps/desktop/src/main/git](../../../apps/desktop/src/main/git/).

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
  `pushPlannedRefs` pushes to the remote's push URL and keeps its refetch.
  Packaged macOS/Linux builds run a 2.56 development build, Windows and the
  tests run Dugite's older Git, and Settings accepts any installed Git.
  `remote.test.ts` pins this with two remotes on one URL, where 2.56 moves
  neither. The remote tag actions also push to the URL. They need no refresh,
  because the default fetch refspec maps no tags.
