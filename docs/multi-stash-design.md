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
  numeric index. Under the repository operation lock the main process re-lists
  and maps that hash to its current selector immediately before mutation. If a
  terminal added/dropped entries meanwhile, PwrGit either finds the same stash
  at its new index or refuses because it is gone; it cannot act on the entry
  that inherited a stale index.
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
Affected files, full patch, apply, pop, and drop use the same hash-guarded
paths as every other stash. Pull announces a stack refresh after its
auto-stash sequence so a kept recovery entry appears immediately.

## Deliberate v1 boundary

Partial-file stashing and editing stash messages remain outside this first UI.
PwrGit v1 ships whole-worktree named stashes, including an untracked option,
because those map cleanly onto the current Changes rail and cover safe context
switching. The underlying Git stack stays fully compatible with partial or
renamed entries created by another client: PwrGit lists, inspects, restores,
and drops them without needing to know how they were authored.
