-- 0036_pinned_branches — branches the user pinned, whether or not a worktree
-- holds them.
--
-- `worktrees.pinned` can only pin a checkout, so a branch with no worktree (the
-- common case for `main` in a repo the user works in through feature worktrees)
-- had nowhere to be pinned. The search tables (`local_branches`,
-- `remote_branches`) are derived: rows are dropped and re-synced whenever a
-- branch gains a worktree or a ref listing changes, so a pin cannot live there.
--
-- A row means "this branch is pinned". A worktree on it reads as pinned too
-- (RepoIndexer.pinnedWorktreeSql), so pinning `main` and then creating a
-- worktree on it leaves the Pinned group showing it. Rows for branches git no
-- longer lists are pruned by the same ref listing that maintains the search
-- tables.
CREATE TABLE pinned_branches (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  PRIMARY KEY (repo_id, branch)
);
