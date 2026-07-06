-- Cached, watcher-invalidated per-worktree state (dirty count, ahead/behind
-- vs upstream, HEAD, last-activity). Recomputed in the background off the
-- click path; U18 adds default-branch staleness columns.
CREATE TABLE IF NOT EXISTS worktree_state (
  worktree_id      TEXT PRIMARY KEY REFERENCES worktrees(id) ON DELETE CASCADE,
  branch           TEXT NOT NULL,
  head             TEXT NOT NULL DEFAULT '',
  has_upstream     INTEGER NOT NULL DEFAULT 0,
  ahead            INTEGER NOT NULL DEFAULT 0,
  behind           INTEGER NOT NULL DEFAULT 0,
  dirty            INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
