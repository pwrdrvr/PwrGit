-- 0020_remote_branch_hydration_state — the 0019 backfill needs Git, so track
-- which persisted repos have been attempted instead of repeating it at every
-- startup. Repos already populated by a 0019-era dev build are complete.

CREATE TABLE remote_branch_index_state (
  repo_id    TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO remote_branch_index_state (repo_id)
SELECT DISTINCT repo_id FROM remote_branches;
