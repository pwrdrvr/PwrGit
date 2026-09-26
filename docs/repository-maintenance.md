# Repository maintenance

Open **Garbage collection…** in the sidebar to maintain every known repository
in the current profile. Enable **Include all profiles** to cover all known
repositories. Repositories do not need to be expanded in the sidebar first.
Linked worktrees share an object store, so collection and branch review process
that store once per run.

## Garbage collection

Start with **Standard (recommended)**. Git normally performs some maintenance
automatically; a manual collection is useful when you want to consolidate object
storage and see the outcome across your repositories.

| Option | Git behavior | When to use it |
| --- | --- | --- |
| Standard | `git gc`: repack objects and expire unreachable history according to Git's retention settings. | Routine cleanup; recommended first. |
| Keep the largest pack | `git gc --keep-largest-pack`: leave the largest pack intact while repacking others. | Reduce repacking work in a large repository; it may leave more storage in use. |
| Aggressive compression | `git gc --aggressive`: spend more effort finding efficient ways to compress objects. | An occasional deliberate optimization when extra CPU, memory, and time are acceptable. A smaller result is not guaranteed. |

PwrGit runs Git in the foreground, one repository at a time. Each repository
reports queued, running, success, skipped, failure, or cancellation; a failed
repository does not stop the others. Another window cannot start an overlapping
maintenance run. **Cancel** finishes the current local operation and skips
remaining work. Closing the owning window also requests cancellation.

The before/after figures are the sizes of loose objects and packs reported by
`git count-objects -v`, in KiB, MiB, or GiB. They do not measure free space on the
volume. Filesystem snapshots and shared blocks can delay reclamation; repacking
also needs temporary disk space. A large pack may contain essential history
with little garbage to remove.

Git objects contain commits, file contents, and directory information.
**Repacking** reorganizes and compresses those objects. **Pruning** expires
objects no longer retained by references or recovery history. Deleting a large
file in a new commit does not remove it from older commits: normal collection
preserves retained history, local branches, stashes, and working files.

PwrGit does not request `--prune=now`, expire reflogs immediately, or force a
competing collection. Existing Git configuration still controls retention.
PwrGit overrides `gc.worktreePruneExpire=never` for this command so that missing
worktree registrations survive; a missing checkout may be on an unmounted drive.
It also passes `--no-detach` so completion means the Git process finished.

## Fetch pruning and leftover local branches

PwrGit's regular fetch actions and **Fetch all repos** already use `--prune`.
With ordinary branch refspecs, if `feature` disappeared from a remote, fetching
removes the stale `origin/feature` reference. It does **not** delete your local
`feature` branch. Git's configured fetch refspecs determine which references
are pruned; unusual mirror or explicit tag mappings can have wider effects.

To review leftover local branches:

1. Run **Fetch all repos** to refresh and prune remote-tracking references.
2. Open **Garbage collection… → Local branches → Review local branches**.
3. Review the repository, local branch, missing upstream, and commit tip.
4. Select individual branches or **Select all eligible branches**, then choose
   **Delete selected local branches**.

Review itself does not fetch or delete. A branch is eligible only when its
configured upstream belongs to a still-configured remote, that remote-tracking
reference is absent, and its tip is reachable from the repository checkout's
current `HEAD`. Branches held by any worktree, including missing worktrees,
are excluded, as are `main`, `master`, `trunk`, `develop`, `development`, and
default branch names identified by remote HEAD references.

Before deletion PwrGit checks eligibility and the exact reviewed tip again, then
uses its ordinary, non-force local-branch deletion path. A moved branch, restored
upstream, checked-out branch, or Git operation in progress is retained. Results
name branches that were deleted and explain those that were retained. Remote
branches are never deleted by this action.

Branches without an upstream and branches with commits not reachable from
the current checkout are retained. Squash and rebase merges can produce new
commit IDs, so their original branch tips may not pass Git's ancestry check.
Those branches require individual review in the repository's branch list;
remote deletion alone does not prove their work is safe to discard. Garbage
collection does not substitute for this review.

Git references: [garbage collection](https://git-scm.com/docs/git-gc),
[fetch pruning](https://git-scm.com/docs/git-fetch#_pruning), and
[local branch deletion](https://git-scm.com/docs/git-branch).
