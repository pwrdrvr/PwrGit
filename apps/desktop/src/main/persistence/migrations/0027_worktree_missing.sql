-- A worktree whose directory was deleted behind PwrGit's back (an agent
-- cleaning up its checkouts, a shell rm -rf) stays registered with git, which
-- lists it with a `prunable` line, and stays in the sidebar. Until now the row
-- looked healthy: every action on it then failed with git's raw "cannot change
-- to '<path>'". `missing` records that the checkout is gone so the row can say
-- so and per-worktree actions can refuse up front. It is set from git's
-- prunable line on re-index and from a state probe that finds no directory,
-- and cleared the same two ways — never by pruning, which is repo-wide and
-- would also unregister a worktree on a volume that is merely unmounted.
ALTER TABLE worktrees ADD COLUMN missing INTEGER NOT NULL DEFAULT 0;
-- `git worktree lock`ed (removable media). Git refuses to remove one without
-- --force, and never reports it prunable, so the sidebar names the state.
ALTER TABLE worktrees ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
