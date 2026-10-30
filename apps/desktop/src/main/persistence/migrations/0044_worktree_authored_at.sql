-- 0044_worktree_authored_at — when you last committed on this checkout.
--
-- "Recent" (the Focused list and Fetch/Pull recent) used last_activity_at, the
-- date of whatever commit HEAD points at. A pull moves HEAD to other people's
-- commits, so nearly every repo you had pulled read as recent. This is the
-- newest commit on HEAD authored by the repo's configured user.email within
-- the recent window, or NULL when there is none.
ALTER TABLE worktree_state ADD COLUMN last_authored_at TEXT;
