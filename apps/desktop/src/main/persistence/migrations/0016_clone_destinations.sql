-- Clone destinations are profile-scoped. Registered roots and inferred prefix
-- folders need no persistence; this table supplies the explicit MRU signal.
CREATE TABLE IF NOT EXISTS clone_destinations (
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (profile_id, path)
);

CREATE INDEX IF NOT EXISTS idx_clone_destinations_recent
  ON clone_destinations(profile_id, last_used_at DESC);
