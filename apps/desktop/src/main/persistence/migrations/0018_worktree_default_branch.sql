-- Name of the resolved default branch used for the cached staleness signals.
-- Keeping it beside behind_default prevents the renderer from guessing based
-- on whichever branches happen to be checked out in a worktree.
ALTER TABLE worktree_state ADD COLUMN default_branch TEXT NOT NULL DEFAULT '';
