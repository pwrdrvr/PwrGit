-- Most-recent GitHub PR per (repo, branch), fetched in bulk via GraphQL.
-- A row with a NULL number is a negative cache ("checked, no PR") so we don't
-- re-query branches that have never had one. fetched_at drives the refresh TTL.
CREATE TABLE IF NOT EXISTS branch_pr (
  repo_id    TEXT NOT NULL,
  branch     TEXT NOT NULL,
  number     INTEGER,
  url        TEXT,
  title      TEXT,
  state      TEXT,               -- 'open' | 'merged' | 'closed'
  is_draft   INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo_id, branch)
);
