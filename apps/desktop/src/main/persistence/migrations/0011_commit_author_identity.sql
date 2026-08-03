-- Proof-backed GitHub account enrichment for local Git commit authors.
-- `identity_key` is a versioned SHA-256 of normalized local name/email, never
-- the raw author fields themselves. The cache contains no credentials.
CREATE TABLE IF NOT EXISTS github_commit_author_identity_cache (
  identity_key  TEXT PRIMARY KEY,
  status        TEXT NOT NULL CHECK (status IN ('resolved', 'negative', 'unavailable')),
  github_login  TEXT,
  avatar_url    TEXT,
  fetched_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_github_commit_author_identity_cache_expiry
  ON github_commit_author_identity_cache(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_github_commit_author_identity_cache_retry
  ON github_commit_author_identity_cache(next_retry_at)
  WHERE next_retry_at IS NOT NULL;
