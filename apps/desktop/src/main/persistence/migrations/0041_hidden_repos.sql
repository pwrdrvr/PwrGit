-- 0041_hidden_repos — repositories a profile has hidden.
--
-- Keyed by the repository's PATH (its main checkout), not by `repos.id`. A
-- `repos` row is not durable: a rescan that stops seeing a repository deletes
-- it and every table cascading from it, and re-discovery inserts a fresh row.
-- A hide has to survive that, and has to survive the folder disappearing
-- altogether, which is why the name is copied here: Settings still lists a
-- hidden repository that no longer has a row, as "Not found".
--
-- Per profile, because profiles are workspaces: two profiles can scan the same
-- folder and only one of them may want a repository out of sight. The profile
-- row owns the hide list, so deleting a profile drops it.
CREATE TABLE hidden_repos (
  profile_id   TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  name         TEXT NOT NULL,
  hidden_at_ms INTEGER NOT NULL,
  PRIMARY KEY (profile_id, path)
);
