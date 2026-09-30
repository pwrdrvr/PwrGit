-- 0037_search_rows_indexed — the ⌘K index finds its rows by an index.
--
-- Every trigger that keeps the index current (0008 onward: repos, worktrees,
-- local and remote branches, branch_pr, repo_open_pr) addresses its row as
-- `WHERE entity_id = … AND kind = …`. In an fts5 table those columns are
-- UNINDEXED, so each of those statements was a scan of the whole index. With
-- a real profile's 24,321 remote branches that is ~3.7ms per written row, on
-- the main process, inside a synchronous better-sqlite3 call: a fetch's
-- 100-row branch chunk held the event loop for ~400ms, and deleting a repo
-- whose cascade fires the trigger for each of its 6,672 remote branches froze
-- the app for ~25s in one statement.
--
-- So the two jobs are split:
--
-- * `search_fts` becomes an ordinary table of search rows, indexed on
--   (kind, entity_id). It keeps the name every trigger already writes, so
--   none of them change — their lookups simply stop scanning. Not UNIQUE:
--   fossil databases can hold a duplicate row, and the search dedupes those.
-- * `search_fts_index` is the fts5 index over it, an external-content table.
--   The three triggers below are the ONLY writers: anything that adds a kind
--   of search row writes `search_fts` and gets indexed for free. Writing the
--   index directly would desynchronise it from its content.
--
-- Queries MATCH against `search_fts_index`; its columns read through to the
-- row by `id`.

CREATE TABLE search_fts_carry AS
  SELECT entity_id, kind, name, path, repo_name, pr, profile_id FROM search_fts;

DROP TABLE search_fts;

CREATE TABLE search_fts (
  id         INTEGER PRIMARY KEY,
  entity_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  name       TEXT,
  path       TEXT,
  repo_name  TEXT,
  pr         TEXT,
  profile_id TEXT
);

CREATE INDEX search_fts_entity ON search_fts (kind, entity_id);

INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr, profile_id)
SELECT entity_id, kind, name, path, repo_name, pr, profile_id FROM search_fts_carry;

DROP TABLE search_fts_carry;

CREATE VIRTUAL TABLE search_fts_index USING fts5(
  entity_id UNINDEXED,
  kind UNINDEXED,
  name,
  path,
  repo_name,
  pr,
  profile_id UNINDEXED,
  content = 'search_fts',
  content_rowid = 'id',
  tokenize = "unicode61 remove_diacritics 2"
);

INSERT INTO search_fts_index (search_fts_index) VALUES ('rebuild');

-- An external-content index is told what to remove: 'delete' must carry the
-- row's old values exactly, which is why OLD is passed through whole.

CREATE TRIGGER search_fts_ai_index AFTER INSERT ON search_fts
BEGIN
  INSERT INTO search_fts_index
    (rowid, entity_id, kind, name, path, repo_name, pr, profile_id)
  VALUES
    (NEW.id, NEW.entity_id, NEW.kind, NEW.name, NEW.path, NEW.repo_name,
     NEW.pr, NEW.profile_id);
END;

CREATE TRIGGER search_fts_ad_index AFTER DELETE ON search_fts
BEGIN
  INSERT INTO search_fts_index
    (search_fts_index, rowid, entity_id, kind, name, path, repo_name, pr, profile_id)
  VALUES
    ('delete', OLD.id, OLD.entity_id, OLD.kind, OLD.name, OLD.path,
     OLD.repo_name, OLD.pr, OLD.profile_id);
END;

CREATE TRIGGER search_fts_au_index AFTER UPDATE ON search_fts
BEGIN
  INSERT INTO search_fts_index
    (search_fts_index, rowid, entity_id, kind, name, path, repo_name, pr, profile_id)
  VALUES
    ('delete', OLD.id, OLD.entity_id, OLD.kind, OLD.name, OLD.path,
     OLD.repo_name, OLD.pr, OLD.profile_id);
  INSERT INTO search_fts_index
    (rowid, entity_id, kind, name, path, repo_name, pr, profile_id)
  VALUES
    (NEW.id, NEW.entity_id, NEW.kind, NEW.name, NEW.path, NEW.repo_name,
     NEW.pr, NEW.profile_id);
END;
