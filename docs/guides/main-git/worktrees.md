# Worktrees, queue locks and removal

This guide covers the operation queue, process limits, nested and vanished worktrees, and removing worktrees and repositories. It was moved from
[apps/desktop/src/main/git/AGENTS.md](../../../apps/desktop/src/main/git/AGENTS.md).

## Git queue locks have one order

Acquire repository -> worktree when both scopes are needed. Prefer
`WorktreeOperationQueue.runRepositoryWorktree(repoId, worktreeId, op)` for a
combined operation. Explicit nesting follows the same order. The queue rejects
reversed acquisition and same-scope reentry before enqueueing.

Drain `WorktreeStateService.lockForRemoval` probes before taking either queue
lock: a pending probe can itself be waiting on the worktree queue.

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

`worktree:removeMany` runs each `worktreeRemove` inside that worktree's queue,
after `lockForRemoval` drains its probes, as repository removal does. Without
the queue, a Pull, a switch or a second removal ran Git in the checkout while
its folder was deleted (`worktree-operation-queue.property.test.ts`).

## Removing a repository never prunes

**No step runs `git worktree prune`.** `repo-removal.ts`:

- Reviews every checkout. On `repo:remove` it reviews again and refuses
  (`review_changed`) if the answers changed. Main never trusts the renderer's
  review.
- Removes linked worktrees first, each in its worktree lock with
  `lockForRemoval` held: the folder goes to the Trash, then
  `git worktree remove --force <path>` clears that record.
- Removes the main checkout last, only if every worktree went and nothing in
  `.git` was kept, inside the repository lock and then the worktree lock.
- "Push first" is the renderer's job, through the tracked push commands,
  before `repo:remove`. Main refuses a decision set that still has one.
- E2E replaces the Trash with a directory through `PWRGIT_E2E_TRASH_DIR`.
