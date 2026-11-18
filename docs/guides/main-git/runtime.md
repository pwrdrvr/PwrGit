# Git runtime: bundled, installed and managed Git

This guide covers which Git binary PwrGit runs, the managed runtime downloads, and copy-on-write clones. It was moved from
[apps/desktop/src/main/git/AGENTS.md](../../../apps/desktop/src/main/git/AGENTS.md).

Code paths in backticks are relative to [apps/desktop/src/main/git](../../../apps/desktop/src/main/git/).

## Which Git runs: the bundle, set up the way an installed Git would be

Every Git process goes through `gitLaunch` in `dugite.ts`. It returns the
bundled Git unless Settings › Git chose an installed Git
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
  - An inherited `GIT_CONFIG_SYSTEM` of the user's own is included in place of
    Dugite's. `userSystemConfig` follows a Pwr app's generated file (in the
    data directory, or with a `# Written by Pwr…:` first line) to its last
    `[include]`, so the user's file survives rebuilds, PwrAgent's terminal and
    a later installed-Git choice. A bundled Git's own `git/etc/gitconfig`
    means the user set none. PwrAgent's `operatorSystemConfig` follows the same
    rule, and parses our generated file: keep its `[include] path = "…"`, and
    change both apps together. `git-runtime.oracle.test.ts` checks every case
    against real Git.
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
  variable: `GIT_EXEC_PATH`, a Pwr app's `GIT_CONFIG_SYSTEM` and the
  bundle's PATH directories. Any one of them silently sends that Git to the
  bundle's helpers or config.

Discovery (`runtime-status.ts`) never runs Apple's `/usr/bin/git`. Without
developer tools, that shim opens the installer dialog. Discovery lists the Git
under `xcode-select -p` instead, only when that Git exists. A Git without
working Git LFS is listed but cannot be chosen. `git:selectRuntime` probes a
path before it saves it.

## PwrGit's Git: downloaded builds of the bundled runtime (`managed/`)

Settings › Git › PwrGit’s Git checks `huntharo/git` for builds newer than
the bundled `custom-git-runtime.json`, and downloads, verifies and installs
them under `<userData>/git-runtimes`. Design: `design/Git Settings and
Managed Updates - UX Review.dc.html`. PwrAgent has the same downloader under
its own root; the two never share a directory.

- **Two tracks, as PwrAgent's managed Codex and grok-build.** Latest (the
  default) offers releases promoted out of testing: GitHub's prerelease flag
  cleared (`promoted`). Prerelease offers the newest, promoted or not. huntharo/git
  publishes every release as a prerelease, so Latest offers nothing newer than
  the bundle until one is promoted on GitHub. List `/releases`, never
  `/releases/latest`. Order by version, never by publish date
  (`eligibleReleases`).
- **One check answers both tracks** (`lastCheck.tracks`), fetching a release's
  catalog only while a track it belongs to is open. `gitManaged:setTrack`
  re-reads that answer: no network, and the build in use stays in use. A
  check saved before tracks existed is dropped.
- **Trust is the stager's, not new.** `acceptCatalog` requires SHA256SUMS,
  the catalog and GitHub's asset `digest` to agree (a missing digest is
  allowed), and a catalog whose `consumer_sha256` is not this app's pin is
  "needs a newer PwrGit", never installed. `verifyManagedRuntime` is an async
  port of `stage-runtime.mjs`'s `verifyRuntime`;
  `verify-runtime.oracle.test.ts` holds the two to one verdict. Change both
  together.
- **Install order is fixed:** hash the archive (also a cached one) → list its
  members and refuse `/` or `..` → unpack into same-volume staging → verify
  → test-run → atomic rename. A failure leaves nothing.
- **Installing never selects.** Use is `git:selectRuntime` with `managed`,
  the same command the Installs list uses. Precedence: an installed Git
  chosen in Settings > a chosen build > the bundle. `selectionPatch` keeps the
  build being left as `previous` for rollback.
- **A chosen build runs as the whole bundle** (`useManagedGit`): its
  `LOCAL_GIT_DIRECTORY`, helpers, templates and, on Linux, `ssl/cacert.pem`.
- **Launch verifies the chosen build before any Git runs.** Commands wait on
  `gitReady()` and pick their Git only after it opens (a launch taken before
  the wait binds the shipped bundle). A build that fails its check fails every
  command by name, and never falls back. Pruning runs only at launch, so a
  build in use by a running operation is never removed mid-session. Known gap:
  a multi-step operation can pick up a build chosen while it runs.
- **`.install.lock` is shared by every PwrGit on the data directory.** Pruning
  takes it too, and skips while another holds it. The pid is written before the
  lock is linked into place: an empty lock is never a dead holder's
  (`install-lock.race.test.ts`).
- **No E2E may reach GitHub.** `launchApp` sets
  `PWRGIT_E2E_MANAGED_GIT_OFFLINE`, so the check fails as offline.

## Copy-on-write clones: a `-c` flag and Maintenance › Clones

PwrGit's own Git (huntharo/git runtime) clones files a worktree shares with
its main checkout. Support is read from `git worktree -h`
(`parseReflinkSupport`): `[--[no-]reflink]` means `checkout.reflink` (runtime
.1), a `git worktree reflink` line means re-share (.2). Never from a version
string: a local build of the same source has none.

- **The switch reaches the bundle as system config, not `-c`.**
  `bundledSystemConfig` writes `checkout.reflink = true|false` *after* the
  bundle's include, while Settings' switch is on *and* the last probe of the
  Git in use (`refreshActiveGitReflink`, at launch and after every runtime
  switch) said it can. Off is written as `false`, so the runtime's own config
  never decides: `.2`'s `etc/gitconfig` forced `true`; `.3` and `.4`
  (which PwrGit ships) set nothing. System scope keeps the user's global and
  repository config in charge, as for LFS and the keychain.
  An installed Git reads its own system config, which PwrGit never writes, so
  it gets `-c checkout.reflink=true` while on and nothing while off.
  - Add no `[include]` or `path =` after the include: `userSystemConfig` and
    PwrAgent's `operatorSystemConfig` read the first `path =` after the last
    `[include]`. Keep the `# Written by PwrGit:` first line.
  - `git-runtime.reflink-oracle.test.ts` asks real Git all 81 combinations of
    repository, global, switch and runtime config; a sample missed a switch
    written before the include. `dugite.property.test.ts` and
    `runtime-status.property.test.ts` hold the switch to the Git in use
    across runtime switches and out-of-order probes.
- **Clones (`worktree-reshare.ts`) is non-destructive by Git's contract.**
  Git compares bytes before it shares and skips changed, untracked and ignored
  files. Keep the real-Git tests (`worktree-reshare.test.ts`, and the
  generated-loose-work property in `worktree-reshare.property.test.ts`; run with
  `PWRGIT_TEST_GIT=installed` and the runtime first on PATH; they skip on any
  other Git, CI included) proving loose work survives byte for byte.
- **A file the main checkout just wrote is racy and is no donor** (`no-donor`).
  After a fast-forward, wait past the index's timestamp, then let `git status`
  rewrite the index (it does whenever an entry is racy).
- The main-checkout update is Try pull's own soft pull
  (`softPullMainCheckout` over `bulkSyncRepositories`), only on the default
  branch. A running `git worktree reflink` is never cancelled.
- The receipt's figure is Git's `observed-private-reduction`: file data that
  stopped being private. Word it "now shared", never "freed".
- **The one-time offer only dry-runs** (`clones-offer.ts`):
  `git worktree reflink -n` per linked worktree, under its worktree lock.
  Its `potential-private-reduction` matched a real run's
  `observed-private-reduction` to the byte. Any `profile_notices` row (0045)
  means never scan again. A Git that cannot re-share, no linked worktree, or
  a failed dry run with no offer from the rest records nothing, so a later
  launch scans. The rules
  are `@pwrgit/shared` `clones-offer.ts`, held by its model test.

Design: `design/Refresh Clones - UX Review.dc.html`.
