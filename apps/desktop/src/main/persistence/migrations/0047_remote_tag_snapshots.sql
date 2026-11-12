-- 0047_remote_tag_snapshots — what each remote published under refs/tags,
-- recorded beside Git's single local tag namespace instead of inside it.
--
-- Git keeps one `refs/tags/*` for every remote, and a fetch never rewrites an
-- existing name. So a tag re-cut on origin stays at its old object locally,
-- and two remotes can publish different objects under one name. A Git ref
-- cannot record either fact when the remote's objects are not downloaded (a
-- ref must point at an object that exists), so the remote's side lives here.
--
-- Cached data: losing it costs one `ls-remote --tags`. It cascades with the
-- repository row.
--
-- Written as 0045 before main shipped its own 0045. `IF NOT EXISTS` lets a
-- database that ran it under the old name run it again harmlessly.

-- The remote the user chose as the publisher of this repository's tags. No row
-- means "origin if there is one, else nobody": the last remote fetched is
-- never assumed.
CREATE TABLE IF NOT EXISTS repo_tag_source (
  repo_id        TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  primary_remote TEXT NOT NULL
);

-- One row per listed remote. `checked_at_ms` is the last SUCCESSFUL listing;
-- a failed attempt records `error` and leaves the previous rows, and their
-- real age, in place. `differs` is the comparison count as of the last
-- comparison, so the sidebar can show it without running Git.
CREATE TABLE IF NOT EXISTS remote_tag_snapshots (
  repo_id         TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  remote          TEXT NOT NULL,
  fetch_url       TEXT,
  checked_at_ms   INTEGER,
  attempted_at_ms INTEGER,
  error           TEXT,
  tag_count       INTEGER NOT NULL DEFAULT 0,
  differs         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, remote)
);

-- The listing itself. `target_id` is the peeled object (`<name>^{}`), equal to
-- `object_id` for a lightweight tag.
CREATE TABLE IF NOT EXISTS remote_tags (
  repo_id   TEXT NOT NULL,
  remote    TEXT NOT NULL,
  name      TEXT NOT NULL,
  object_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  annotated INTEGER NOT NULL,
  PRIMARY KEY (repo_id, remote, name),
  FOREIGN KEY (repo_id, remote)
    REFERENCES remote_tag_snapshots(repo_id, remote) ON DELETE CASCADE
) WITHOUT ROWID;

-- "Keep my local value" for one exact pair of objects. Either side moving
-- makes the pair stale, and the tag asks again.
CREATE TABLE IF NOT EXISTS tag_keep_local (
  repo_id          TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  remote           TEXT NOT NULL,
  name             TEXT NOT NULL,
  local_object_id  TEXT NOT NULL,
  remote_object_id TEXT NOT NULL,
  decided_at_ms    INTEGER NOT NULL,
  PRIMARY KEY (repo_id, remote, name)
);
