-- Bounded metadata/checkpoints, owned by a profile. No credential storage.
CREATE TABLE contribution_snapshots (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  viewer_id TEXT NOT NULL,
  window_key TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY(profile_id, host, viewer_id, window_key)
);
CREATE INDEX contribution_snapshots_age ON contribution_snapshots(updated_at_ms);
