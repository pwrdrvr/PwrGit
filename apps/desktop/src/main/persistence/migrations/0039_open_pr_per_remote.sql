-- 0039_open_pr_per_remote — the open list is one list per forge repository a
-- checkout has a remote on, not one list per checkout.
--
-- 0032 asked origin alone and keyed rows (repo_id, number). In a fork checkout
-- origin is the reader's own repository, so the PR they sent to the original
-- (on `upstream`) was never listed, and a mirror on a second forge was never
-- asked. Listing both makes the old key collide: the fork's #14 and the
-- original's #14 are different change requests. So rows are keyed by the
-- forge repository too (`forge_repo`, `host/path` lowercased), and the state
-- row — freshness, truncation — is one per forge repository, so each list
-- refreshes and fails on its own.
--
-- The search row's entity id was `<repo_id>:<number>`, which the new key no
-- longer fits; it is the row's own integer id now. Every trigger that spelled
-- the old id is dropped and written again.
--
-- Rows already cached were origin's list, and carry across under origin's
-- forge repository, which they recorded themselves (`host`, `repo_path`). The
-- state rows do not say which forge repository they were for, so they go:
-- each repository lists again once, on its next sweep.

DROP TRIGGER repos_au_open_pr_fts;
DROP TRIGGER repos_au_profile_fts;
DROP TRIGGER repo_open_pr_ai_fts;
DROP TRIGGER repo_open_pr_au_fts;
DROP TRIGGER repo_open_pr_ad_fts;
DROP INDEX repo_open_pr_head_idx;

DELETE FROM search_fts WHERE kind = 'change_request';

ALTER TABLE repo_open_pr RENAME TO repo_open_pr_0039;
DROP TABLE repo_open_pr_state;

CREATE TABLE repo_open_pr (
  id                   INTEGER PRIMARY KEY,
  repo_id              TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  -- The forge repository this list came from: `host/path`, lowercased.
  forge_repo           TEXT NOT NULL,
  -- A fork's head repository in the same form, so a head on another of this
  -- checkout's remotes (your fork, for a PR you sent upstream) can be found
  -- without re-deriving it from `host` and `head_repo_path`. NULL: same
  -- repository as forge_repo.
  head_forge_repo      TEXT,
  number               INTEGER NOT NULL,
  url                  TEXT NOT NULL,
  title                TEXT NOT NULL,
  state                TEXT NOT NULL,
  is_draft             INTEGER NOT NULL DEFAULT 0,
  check_state          TEXT,
  checks_still_running INTEGER,
  merge_state          TEXT,
  forge                TEXT,
  host                 TEXT,
  repo_path            TEXT,
  head_ref             TEXT,
  base_ref             TEXT,
  head_oid             TEXT,
  additions            INTEGER,
  deletions            INTEGER,
  changed_files        INTEGER,
  commit_count         INTEGER,
  opened_at            INTEGER,
  merged_at            INTEGER,
  closed_at            INTEGER,
  author               TEXT,
  head_repo_path       TEXT,
  updated_at           INTEGER,
  UNIQUE (repo_id, forge_repo, number)
);

CREATE INDEX repo_open_pr_head_idx ON repo_open_pr(repo_id, head_ref);

-- One row per forge repository listed. `remote` is the git remote it was
-- listed through, as of that refresh — what search uses to find a head on
-- that remote's tracking refs without asking git.
CREATE TABLE repo_open_pr_state (
  repo_id    TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  forge_repo TEXT NOT NULL,
  remote     TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  truncated  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, forge_repo)
);

CREATE TRIGGER repo_open_pr_ai_fts AFTER INSERT ON repo_open_pr
BEGIN
  DELETE FROM search_fts
   WHERE kind = 'change_request' AND entity_id = CAST(NEW.id AS TEXT);
  INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr, profile_id)
  VALUES (
    CAST(NEW.id AS TEXT), 'change_request', NEW.title, NEW.head_ref,
    (SELECT name FROM repos WHERE id = NEW.repo_id),
    CAST(NEW.number AS TEXT) || ' ' || NEW.title,
    (SELECT profile_id FROM repos WHERE id = NEW.repo_id)
  );
END;

-- See 0032: the WHEN clause, not the column list, keeps a refresh that only
-- moved check state from rewriting the search row.
CREATE TRIGGER repo_open_pr_au_fts AFTER UPDATE OF title, head_ref ON repo_open_pr
WHEN NEW.title IS NOT OLD.title OR NEW.head_ref IS NOT OLD.head_ref
BEGIN
  UPDATE search_fts
     SET name = NEW.title,
         path = NEW.head_ref,
         pr = CAST(NEW.number AS TEXT) || ' ' || NEW.title
   WHERE kind = 'change_request' AND entity_id = CAST(OLD.id AS TEXT);
END;

CREATE TRIGGER repo_open_pr_ad_fts AFTER DELETE ON repo_open_pr
BEGIN
  DELETE FROM search_fts
   WHERE kind = 'change_request' AND entity_id = CAST(OLD.id AS TEXT);
END;

CREATE TRIGGER repos_au_open_pr_fts AFTER UPDATE OF name ON repos
BEGIN
  UPDATE search_fts SET repo_name = NEW.name
   WHERE kind = 'change_request'
     AND entity_id IN (
       SELECT CAST(id AS TEXT) FROM repo_open_pr WHERE repo_id = NEW.id
     );
END;

-- 0033's trigger, with the change_request arm on the new id.
CREATE TRIGGER repos_au_profile_fts AFTER UPDATE OF profile_id ON repos
WHEN NEW.profile_id IS NOT OLD.profile_id
BEGIN
  UPDATE search_fts SET profile_id = NEW.profile_id
   WHERE (kind = 'repo' AND entity_id = NEW.id)
      OR (kind = 'worktree'
          AND entity_id IN (SELECT id FROM worktrees WHERE repo_id = NEW.id))
      OR (kind = 'local_branch'
          AND entity_id IN (SELECT id FROM local_branches WHERE repo_id = NEW.id))
      OR (kind = 'remote_branch'
          AND entity_id IN (SELECT id FROM remote_branches WHERE repo_id = NEW.id))
      OR (kind = 'change_request'
          AND entity_id IN (
            SELECT CAST(id AS TEXT) FROM repo_open_pr WHERE repo_id = NEW.id
          ));
END;

-- The insert trigger writes each carried row's search row.
INSERT INTO repo_open_pr (
  repo_id, forge_repo, head_forge_repo, number, url, title, state, is_draft,
  check_state, checks_still_running, merge_state, forge, host, repo_path,
  head_ref, base_ref, head_oid, additions, deletions, changed_files,
  commit_count, opened_at, merged_at, closed_at, author, head_repo_path,
  updated_at
)
SELECT
  repo_id, lower(host || '/' || repo_path),
  CASE WHEN head_repo_path IS NULL THEN NULL
       ELSE lower(host || '/' || head_repo_path) END,
  number, url, title, state, is_draft,
  check_state, checks_still_running, merge_state, forge, host, repo_path,
  head_ref, base_ref, head_oid, additions, deletions, changed_files,
  commit_count, opened_at, merged_at, closed_at, author, head_repo_path,
  updated_at
  FROM repo_open_pr_0039
 WHERE host IS NOT NULL AND repo_path IS NOT NULL;

DROP TABLE repo_open_pr_0039;
