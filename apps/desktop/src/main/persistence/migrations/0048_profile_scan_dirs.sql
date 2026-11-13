-- 0048_profile_scan_dirs — the repository folders a profile's last scan saw.
--
-- A full rescan runs Git in every repository, so it is throttled to once a
-- day. Walking the roots for `.git` entries costs milliseconds. The walk's
-- answer is compared with this list, and only a folder the last scan did not
-- see asks for the full rescan (`RepoIndexer.unscannedRepoDirs`). Walk output
-- is compared with walk output, never with Git's paths, which resolve
-- symlinks and spell drives their own way.
--
-- Written after every completed scan, readable roots or not: a root that could
-- not be listed contributes nothing, so its folders read as new once it
-- mounts. The profile row owns the list, so deleting a profile drops it.
CREATE TABLE profile_scan_dirs (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  dir        TEXT NOT NULL,
  PRIMARY KEY (profile_id, dir)
) WITHOUT ROWID;
