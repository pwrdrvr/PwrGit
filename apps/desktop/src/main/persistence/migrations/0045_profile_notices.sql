-- 0045_profile_notices — one-time notices a profile has been given.
--
-- A notice that must be raised at most once (the Clones offer: a background
-- dry run, then one toast) records its outcome here, so a restart neither
-- scans again nor nags. Any row at all means "done"; `state` says how it
-- ended, for the logs and for tests. The profile row owns its notices, so
-- deleting a profile drops them.
CREATE TABLE profile_notices (
  profile_id    TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  notice        TEXT NOT NULL,
  state         TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (profile_id, notice)
);
