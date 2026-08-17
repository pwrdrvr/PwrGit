-- 0022_local_branch_search — keep local branches that no worktree has checked
-- out in the command-palette index. Sibling of 0019's remote_branches: a branch
-- created without a checkout ("Branch from this commit…" → don't check out), or
-- made outside the app, was in none of the three indexed kinds and so was
-- unreachable from ⌘K. Branches that ARE checked out stay covered by their
-- kind='worktree' row — the indexer excludes them here so one branch never
-- yields two hits.

CREATE TABLE local_branches (
  id        TEXT PRIMARY KEY,
  repo_id   TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  full_name TEXT NOT NULL,
  UNIQUE(repo_id, full_name)
);

CREATE INDEX local_branches_repo_idx ON local_branches(repo_id);

CREATE TRIGGER local_branches_ai_fts AFTER INSERT ON local_branches
BEGIN
  DELETE FROM search_fts WHERE entity_id = NEW.id AND kind = 'local_branch';
  INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr)
  VALUES (
    NEW.id, 'local_branch', NEW.name, NEW.full_name,
    (SELECT name FROM repos WHERE id = NEW.repo_id), NULL
  );
END;

CREATE TRIGGER local_branches_au_fts
AFTER UPDATE OF name, full_name, repo_id ON local_branches
BEGIN
  UPDATE search_fts
     SET name = NEW.name,
         path = NEW.full_name,
         repo_name = (SELECT name FROM repos WHERE id = NEW.repo_id)
   WHERE entity_id = NEW.id AND kind = 'local_branch';
END;

CREATE TRIGGER local_branches_ad_fts AFTER DELETE ON local_branches
BEGIN
  DELETE FROM search_fts WHERE entity_id = OLD.id AND kind = 'local_branch';
END;

CREATE TRIGGER repos_au_local_branches_fts
AFTER UPDATE OF name ON repos
BEGIN
  UPDATE search_fts SET repo_name = NEW.name
   WHERE kind = 'local_branch'
     AND entity_id IN (
       SELECT id FROM local_branches WHERE repo_id = NEW.id
     );
END;

-- Existing databases already carry a completion marker for every repository
-- (0020), which would leave this new table empty until a daily rescan happened
-- to come round. Clearing the markers re-arms the same one-time backfill that
-- populated remote_branches — hydrateRemoteBranches now fills both tables.
DELETE FROM remote_branch_index_state;
