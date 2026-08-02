-- Exact commit proofs keep their source URL in SQLite. The thumbnail bytes are
-- intentionally separate, tiny files under userData/cache so a large history
-- can reuse one avatar across many proven commit rows without IPC filesystem
-- paths or repeated network image loads.
ALTER TABLE github_commit_author_identity_cache
  ADD COLUMN last_accessed_at INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_github_commit_author_identity_cache_access
  ON github_commit_author_identity_cache(last_accessed_at);

CREATE TABLE IF NOT EXISTS github_avatar_thumbnail_cache (
  avatar_key       TEXT PRIMARY KEY,
  source_url       TEXT NOT NULL,
  mime_type        TEXT,
  byte_length      INTEGER NOT NULL DEFAULT 0,
  fetched_at       INTEGER NOT NULL DEFAULT 0,
  expires_at       INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER NOT NULL DEFAULT 0,
  failure_count    INTEGER NOT NULL DEFAULT 0,
  next_retry_at    INTEGER,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_github_avatar_thumbnail_cache_access
  ON github_avatar_thumbnail_cache(last_accessed_at);

CREATE INDEX IF NOT EXISTS idx_github_avatar_thumbnail_cache_retry
  ON github_avatar_thumbnail_cache(next_retry_at)
  WHERE next_retry_at IS NOT NULL;
