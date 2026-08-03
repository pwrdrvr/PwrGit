-- A GitHub account belongs to a Git author identity, not to just one commit.
-- Keep the stable numeric user id on exact proofs and reuse a separately
-- hashed email alias so newly landed commits by an already-proven author can
-- paint their login/avatar from local storage before hover.
ALTER TABLE github_commit_author_identity_cache
  ADD COLUMN github_user_id INTEGER;

CREATE TABLE github_commit_author_account_cache (
  author_key      TEXT PRIMARY KEY,
  status          TEXT NOT NULL CHECK (status IN ('resolved', 'ambiguous')),
  github_user_id  INTEGER,
  github_login    TEXT,
  avatar_url      TEXT,
  fetched_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_github_commit_author_account_cache_expiry
  ON github_commit_author_account_cache(status, expires_at);

CREATE INDEX idx_github_commit_author_account_cache_access
  ON github_commit_author_account_cache(last_accessed_at);
