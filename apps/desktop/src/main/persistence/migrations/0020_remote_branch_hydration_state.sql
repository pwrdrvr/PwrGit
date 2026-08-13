-- 0020_remote_branch_hydration_state — the 0019 backfill needs Git, so track
-- which persisted repos have been attempted instead of repeating it at every
-- startup. Repos already populated by a 0019-era dev build are complete.

CREATE TABLE remote_branch_index_state (
  repo_id    TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO remote_branch_index_state (repo_id)
SELECT DISTINCT repo_id FROM remote_branches;

-- Full root discovery is maintenance, not launch-critical work. Seed its
-- schedule from the last successful scan so upgrades do not immediately repeat
-- a recent scan.
CREATE TABLE profile_scan_state (
  profile_id    TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  scanned_at_ms INTEGER NOT NULL
);

INSERT INTO profile_scan_state (profile_id, scanned_at_ms)
SELECT profile_id, CAST(strftime('%s', MAX(last_seen_at)) AS INTEGER) * 1000
FROM repos
WHERE source = 'scan'
GROUP BY profile_id;
