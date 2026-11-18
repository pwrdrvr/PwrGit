# src/main/git — AGENTS.md

Notes for the git layer. See `apps/desktop/AGENTS.md` for app-wide facts.
Each group below names its rules; the linked guide holds the full text.

## Git runtime

Read [runtime.md](../../../../../docs/guides/main-git/runtime.md) before you
change how Git is launched, configured, downloaded or told to reflink.

- **Which Git runs: the bundle, set up the way an installed Git would be.**
  Every Git process goes through `gitLaunch`; a chosen Git never falls back.
- **PwrGit's Git: downloaded builds of the bundled runtime (`managed/`).**
  Installing never selects, and launch verifies the chosen build first.
- **Copy-on-write clones: a `-c` flag and Maintenance › Clones.** Read support
  from `git worktree -h`, never from a version string.

## Real-Git tests

Read [testing.md](../../../../../docs/guides/main-git/testing.md) before you
write or fix a test that runs real Git.

- **Real-git tests run on Windows CI too.** Use `git -C`, the shared
  `GitExec`, and no `*` / `?` filenames; never raise a timeout for a slow
  runner.
- **A stale remote-tracking ref comes from a separate clone.** Push from a
  separate clone; do not depend on Git 2.56's push-URL ref update.

## Remotes, fetch, push and tags

Read
[remotes-and-tags.md](../../../../../docs/guides/main-git/remotes-and-tags.md)
before you touch fetch, pull, push, tags, change events or SSH trust.

- **Fetch never rewrites a tag; the published remote is compared, not
  trusted.** No fetch passes `--tags`, `--force` or `--prune-tags`.
- **Every long-running remote command registers an activity.** Wrap it in
  `tracked()`, registered before the lock.
- **`repo:changed` names its repositories when it can.** Pass `repoIds` unless
  the list or its order may move.
- **Publishing a branch asks for a remote, never a name.** The branch keeps
  its name; a failed push's `message` is the reason.
- **A missing credential reads the same from fetch, pull and push.**
  `classifyAuthFailure` maps it to `authentication_required`.
- **SSH host approval.** The renderer approves an opaque proposal ID, never
  key bytes.

## Clone and fork

Read [clone-and-fork.md](../../../../../docs/guides/main-git/clone-and-fork.md)
before you change clone, fork or remote rewiring.

- **Clone and fork reach a forge INSTANCE, not a forge.** Every provider
  lookup passes the request's hostname.
- **A fresh clone of a fork keeps its original through `keepForkOriginal`.**
  Read the remotes first; never overwrite one.
- **Forking a checkout in place: add `upstream` first, then re-point
  `origin`.** Never rename `origin`.

## Worktrees, queue locks and removal

Read [worktrees.md](../../../../../docs/guides/main-git/worktrees.md) before
you take queue locks, spawn Git per message, or add, drop or remove worktrees.

- **Git queue locks have one order.** Repository, then worktree; drain
  `lockForRemoval` probes first.
- **Main decides how many Git processes exist, not the renderer.** Bound every
  IPC-started spawn on the main side.
- **A nested agent worktree is not a change.** Status reads append
  `nestedWorktreePathspec(cwd)`.
- **A worktree whose directory is gone is dropped, unless it may come back.**
  Never run `git worktree prune`.
- **Removing a worktree: PwrGit deletes the folder, then Git drops the
  record.** Delete asynchronously, `.git` link last, inside the worktree
  queue.
- **Removing a repository never prunes.** Main re-reviews every checkout and
  removes the main checkout last.

## Scanning, discovery and pruning

Read [scan-and-prune.md](../../../../../docs/guides/main-git/scan-and-prune.md)
before you change rescans, repository search, hiding or the pruner.

- **A scan that found nothing is not proof anything was deleted.**
  `canPruneFromScan` refuses a scan of an unreadable root.
- **Find my repositories never looks inside a repository.** It stops at the
  first `.git` and shares `SKIP_DIRS`.
- **A hidden repository is filtered in SQL, by path.** Put
  `visibleRepoSql("r")` in the WHERE clause.
- **The pruner: one rule, one removal path, and `clean -X` is not what it
  looks like.** Spare paths with negated `-e '!x'`; use `-X`, never `-x`.

## Changes, switching, history and commits

Read
[changes-and-history.md](../../../../../docs/guides/main-git/changes-and-history.md)
before you change staging, switching, the lane graph, operations or commit
identity.

- **Paths from git are always forward-slash.** Split on `/`; never use
  `node:path`.
- **Batched pathspecs are all-or-nothing.** Partition mixed kinds, and
  announce the change also on error.
- **Partial staging works through Git, never through renderer patch text.**
  Line IDs are valid only for their fingerprint.
- **Switching with uncommitted work: bring is a plain switch first.** Stash
  only on refusal, and address stashes by SHA.
- **The lane graph draws fetched work, not just local work.** Behind upstreams
  join the walk in `upstreamRefs`.
- **`--continue` exits non-zero on ordinary progress.** Judge by whether HEAD,
  the sequencer or conflicts moved.
- **A PwrGit commit records the profile, completely.** Every commit gets
  `commitIdentityArgs` plus `SCRUBBED_IDENTITY_ENV`.
