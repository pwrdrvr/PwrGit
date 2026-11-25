-- 0050_fork_sync_remotes — cached forge metadata for non-origin remotes and
-- per-remote opt-out preferences for multi-fork upstream sync.
--
-- A repository can hold several writable forks of the same upstream (for
-- example a personal fork and an organization fork). `repo_identity` tracks
-- `origin` alone; `repo_remote_identity` caches the same push-access and
-- fork-parent facts for sibling remotes on the same forge so fork sync and the
-- Remotes tab can identify every writable fork without re-querying the forge
-- on every worktree selection.
--
-- `fork_sync_remote_prefs` records per-remote overrides for whether fork sync
-- pushes synced commits to that remote. Writable fork remotes are enabled by
-- default; a row with `enabled = 0` opts that remote out.

CREATE TABLE IF NOT EXISTS repo_remote_identity (
  repo_id         TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  hostname        TEXT NOT NULL,
  slug_lower      TEXT NOT NULL,
  name_with_owner TEXT NOT NULL,
  viewer_can_push INTEGER,
  parent_slug     TEXT,
  root_slug       TEXT,
  fetched_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo_id, hostname, slug_lower)
);

CREATE TABLE IF NOT EXISTS fork_sync_remote_prefs (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  remote  TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (repo_id, remote)
);
