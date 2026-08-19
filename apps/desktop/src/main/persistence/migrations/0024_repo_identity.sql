-- Forge identity for a repository's `origin`: who can see it, and whether it
-- is a fork. Persisted rather than fetched per launch because the sidebar
-- paints these marks on every row — a network round trip before the first
-- paint would make the list arrive blank and fill in.
--
-- Absence of a row is meaningful and distinct from `visibility = 'unknown'`:
-- no row means "never looked up", which the marks render as pending, while
-- 'unknown' means "asked, and the forge would not say".
CREATE TABLE IF NOT EXISTS repo_identity (
  repo_id     TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  host        TEXT NOT NULL,
  hostname    TEXT NOT NULL,
  owner       TEXT NOT NULL,
  name        TEXT NOT NULL,
  visibility  TEXT NOT NULL,
  -- Immediate fork parent, and the fork-network root when it differs.
  parent_slug TEXT,
  parent_url  TEXT,
  root_slug   TEXT,
  root_url    TEXT,
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Refreshes walk oldest-first, so a large profile spreads its re-reads out
-- instead of re-asking about the same repositories every time.
CREATE INDEX IF NOT EXISTS idx_repo_identity_staleness
  ON repo_identity(fetched_at);
