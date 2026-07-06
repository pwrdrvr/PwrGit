-- Repos discovered per profile (root-folder scan or manual add), and their
-- worktrees. Dirty/ahead/behind counts are NOT stored here — those are the
-- cached, watcher-invalidated state added in U8 (0003_wt_state).
CREATE TABLE IF NOT EXISTS repos (
  id           TEXT PRIMARY KEY,       -- stable hash of the canonical path
  profile_id   TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  path         TEXT NOT NULL UNIQUE,   -- primary worktree (git common dir owner)
  source       TEXT NOT NULL DEFAULT 'scan', -- 'scan' | 'manual'
  pinned       INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_repos_profile ON repos(profile_id);

CREATE TABLE IF NOT EXISTS worktrees (
  id           TEXT PRIMARY KEY,       -- stable hash of the worktree path
  repo_id      TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  branch       TEXT NOT NULL,
  path         TEXT NOT NULL UNIQUE,
  is_primary   INTEGER NOT NULL DEFAULT 0,
  pinned       INTEGER NOT NULL DEFAULT 0,
  custom_order INTEGER,                -- null unless the user drag-orders (U14)
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_worktrees_repo ON worktrees(repo_id);
