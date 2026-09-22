# Git-native multi-stash design

Status: implemented. Research checked 2026-08-23.

## Evidence and premise

Git already defines the complete interoperable model:

- The [`git stash` manual](https://git-scm.com/docs/git-stash) says the newest
  entry is `refs/stash`, older entries are that ref's reflog, and
  `stash@{0}`, `stash@{1}`, … name the ordered entries. It also defines
  named `push -m`, `list`, `show`, selected `apply`, `pop`, and
  `drop`, including the safety rule that a conflicted pop does not remove the
  entry.
- Git stores ordinary refs and their reflogs in the common repository
  directory for linked worktrees; only specifically named namespaces are
  per-worktree. See [Git repository layout](https://git-scm.com/docs/gitrepository-layout)
  (`$GIT_COMMON_DIR/refs` and `$GIT_COMMON_DIR/logs`). `refs/stash` is
  therefore one repository stack visible from every linked worktree, while an
  apply/pop changes whichever worktree runs the command.
Conclusion: PwrGit must be a view and safe command surface over
`refs/stash`. It must never add a database table, sidecar file, or private
metadata required to recover an entry.

## Shipped behavior

- `git stash list --format=…` supplies every entry's stable commit hash,
  current `stash@{n}` selector, base commit, branch-bearing subject, name, and
  creation time. Details and full patches come lazily from
  `git stash show --include-untracked`.
- Named creation runs `git stash push --message …`; the explicit
  “Include untracked files” option adds `--include-untracked`. Ignored files
  remain outside scope, matching ordinary Git's distinction between `-u` and
  `-a`.
- Apply, pop, and drop send the selected stash **commit hash**, not a cached
  numeric index. Apply passes the immutable hash to Git. Pop and Drop acquire
  Git's `refs/stash.lock` before reading and validating the reflog, then remove
  exactly one occurrence of the selected hash. Pop applies that hash while
  still holding the lock and only removes it after successful application.
  This follows the synchronization used by
  [Git's files ref backend](https://github.com/git/git/blob/master/refs/files-backend.c)
  (`files_reflog_expire`). The reflog is rewritten with the same predecessor
  chain as `reflog delete --rewrite --updateref`; no private store is created.
  Git can store the same commit in the reflog
  more than once, but reflog occurrences have no immutable IDs. PwrGit keeps
  inspection and Apply available for that shared content and refuses Pop/Drop
  until the hash has only one occurrence rather than guessing which duplicate
  to remove.
- Removal also holds `packed-refs.lock` to exclude concurrent ref packing.
  Packed stash refs, symbolic refs, reftable storage, malformed logs, and
  existing locks fail safely before Pop applies anything. Apply and inspection
  remain available; users can remove entries with Git in unsupported layouts.
  Like Git's files backend, updating the reflog and ref requires separate
  filesystem operations; a process or machine crash is not a two-file atomic
  transaction. Ordinary ref-commit errors restore the original log.
- All stash commands reject worktrees flagged missing, so Git cannot discover
  a containing repository after a nested checkout's `.git` link disappears.
- Repository locking nests outside worktree locking, the same order used by
  pull. Stack mutations serialize across linked worktrees; apply/pop/create
  also serialize with operations in their destination worktree.
- A repository-level watcher fingerprints the whole list (not only the tip, so
  dropping a non-top entry is visible) on window focus and the existing gentle
  active-worktree poll. CLI-created and CLI-dropped entries refresh the tab
  even when another linked worktree made the change.
- The UI states the scope directly: all worktrees see the same stack, while
  Apply and Pop restore into the currently selected worktree.

## PwrGit pull recovery entries

Pull's existing recovery path creates an ordinary named stash with
`git stash push --include-untracked` and the exact message
`pwrgit: auto-stash before pull`. It remains in `refs/stash` when reapplication
conflicts or fails, so command-line `git stash list/show/apply` can always
inspect or recover it.

PwrGit recognizes that exact public message only to add a **PwrGit pull
recovery** label. It does not move, rewrite, or privately tag the entry.
Affected files, full patch, apply, pop, and drop use the same guarded paths as
every other stash. Pull announces a stack refresh after its auto-stash sequence
so a kept recovery entry appears immediately.

## Deliberate v1 boundary

Partial-file stashing and editing stash messages remain outside this first UI.
PwrGit v1 ships whole-worktree named stashes, including an untracked option,
because those map cleanly onto the current Changes rail and cover safe context
switching. The underlying Git stack stays fully compatible with partial or
renamed entries created by another client: PwrGit lists, inspects, restores,
and drops them without needing to know how they were authored.
