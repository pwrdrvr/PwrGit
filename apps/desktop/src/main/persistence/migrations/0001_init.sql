-- Profiles: single-instance, in-app profiles. Each carries a default commit
-- email under one shared GitHub identity, plus the root folders scanned to
-- discover its repos.
CREATE TABLE IF NOT EXISTS profiles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  author_name  TEXT,
  mono         TEXT NOT NULL DEFAULT '',
  kind         TEXT,
  roots        TEXT NOT NULL DEFAULT '[]', -- JSON array of absolute paths
  last_used_at TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- App-level key/value (active profile id, etc.).
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
