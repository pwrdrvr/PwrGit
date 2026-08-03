-- Commit-associated pull requests are discovered only for deliberate hover or
-- currently visible graph rows. The cache may remember prior discoveries, but
-- the in-memory monitor set—not this table—owns ongoing polling.
CREATE TABLE commit_pr (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  number INTEGER,
  url TEXT,
  title TEXT,
  state TEXT,
  is_draft INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo_id, commit_sha)
);

CREATE INDEX idx_commit_pr_number ON commit_pr(repo_id, number);
