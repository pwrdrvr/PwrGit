-- The Git LFS notice speaks with two voices: a broken setup nags durably on
-- every open, while a working one is announced once and then stays quiet.
-- This records the last outcome per repo so "once" spans every worktree of
-- the repo and survives restarts — and so a repair after breakage is a fresh
-- transition worth announcing again.
CREATE TABLE IF NOT EXISTS repo_lfs_notice (
  repo_id      TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  last_outcome TEXT NOT NULL CHECK (last_outcome IN ('ready', 'broken')),
  -- When the outcome last FLIPPED, not when it was last observed.
  recorded_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
