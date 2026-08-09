-- Manual drag-order for repos, mirroring worktrees.custom_order (0002).
--
-- Deliberately NOT reusing repos.sort_order: that column is NOT NULL DEFAULT 0,
-- so "never ordered" and "ordered to the top" are the same value. A nullable
-- column is what lets the sidebar tell a hand-arranged list from a computed one
-- and fall back to the name sort for repos the user has never touched.
ALTER TABLE repos ADD COLUMN custom_order INTEGER;
