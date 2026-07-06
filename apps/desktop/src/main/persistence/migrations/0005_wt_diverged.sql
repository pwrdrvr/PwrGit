-- A branch with no common ancestor with the default branch (rewritten/orphaned
-- history) — otherwise `behindDefault` inflates to the full default-branch
-- length, which reads as a wrong count (U18 follow-up).
ALTER TABLE worktree_state ADD COLUMN diverged_from_default INTEGER NOT NULL DEFAULT 0;
