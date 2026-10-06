# Hiding and removing repositories

Every repository under a profile's repo folders appears in that profile's
window. Two commands on a repository row's menu (right-click, or the row's
`⋯`) get one out of the way.

## Hide repository

Hiding is per profile and changes nothing on disk. The repository and its
linked worktrees leave the profile's:

- sidebar, lens counts and selection;
- **Fetch all repos** and **Try pull all**;
- **Repository maintenance** (garbage collection, branch review, worktree
  pruning);
- **⌘K** (Ctrl+K) search and its browse list;
- agent catalog, so the MCP app tools neither list nor open it (the
  path-based Git tools still work).

There is no confirmation. The toast that follows offers **Undo**. If the
hidden repository held the selection, the next repository in the list is
selected instead.

A hide is keyed by the repository's path, so it survives a rescan, a moved
or deleted folder, and the repository being re-cloned to the same place.
Another profile that scans the same folder is unaffected.

To bring one back:

- the sidebar's **Hidden N** row, at the bottom of the list (shown only while
  something is hidden): choose **Unhide <name>**;
- **Settings → Profiles → Hidden repositories**, which lists every profile's
  hidden repositories. An entry whose folder no longer exists offers
  **Forget** instead;
- **⌘K**: type a hidden repository's full name and press Return to unhide and
  open it. Type `hidden` for **Show hidden repositories**, which opens the
  sidebar's list.

## Remove repository…

Removal moves the repository's folders to the Trash (the Recycle Bin on
Windows): every linked worktree first, then the main checkout, which holds
`.git`. The remote is not touched. Nothing is removed until the review is
complete and the button is pressed.

The review inspects each checkout and the repository-wide state in `.git`:

| Verdict | Means | Choices |
| --- | --- | --- |
| safe | No uncommitted, untracked or conflicted files, and every commit is on a remote. | none needed |
| at risk | Changes or commits that exist nowhere else; a folder that is not found (it may be on a volume that is not mounted); or a checkout Git could not inspect. | Push first (when unpushed commits are the only risk), Keep, Discard |
| blocked | A rebase, merge, cherry-pick, revert or bisect is in progress, or the worktree is locked with `git worktree lock`. | Keep, or **Open worktree** to finish it there |

Stashes, and local branches that are not checked out but hold commits on no
remote, live in the main checkout's `.git`, so they are reviewed with it.

- **Keep** on anything that needs `.git` — a worktree, the stashes, a branch —
  keeps the main checkout. The removal becomes partial: only the other
  worktrees go, and the repository stays in PwrGit.
- **Push first** pushes through PwrGit's ordinary push (a branch without an
  upstream is published to its remote) and reviews again before removing.
- A full removal that discards anything asks for the repository's name to be
  typed.

Before anything moves, PwrGit reviews again. If a checkout changed since the
dialog opened, nothing is removed and the dialog shows the new state.

A worktree's record is cleared with `git worktree remove` for that worktree
only. PwrGit never runs `git worktree prune`, which would also forget
worktrees that are only on an unmounted volume.

If a folder cannot be moved to the Trash, the run stops before the main
checkout. The failed step offers **Retry**, **Reveal**, and **Delete
permanently…**, which deletes that folder without the Trash after a separate
confirmation.

After a full removal the repository leaves the profile and does not come back
in a scan, since its folder is gone. To get it back, restore the folders from
the Trash, or clone it again.
