-- Staleness-vs-default-branch signals (U18). Extends the cached worktree
-- state so the sidebar can flag prunable worktrees.
ALTER TABLE worktree_state ADD COLUMN behind_default INTEGER NOT NULL DEFAULT 0;
ALTER TABLE worktree_state ADD COLUMN merged_into_default INTEGER NOT NULL DEFAULT 0;
ALTER TABLE worktree_state ADD COLUMN is_default_branch INTEGER NOT NULL DEFAULT 0;
