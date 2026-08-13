-- 0019_remote_branch_search — keep fetched remote-tracking branches in the
-- command-palette index even when no worktree has checked them out locally.

CREATE TABLE remote_branches (
  id          TEXT PRIMARY KEY,
  repo_id     TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  full_name   TEXT NOT NULL,
  remote_name TEXT NOT NULL,
  UNIQUE(repo_id, full_name)
);

CREATE INDEX remote_branches_repo_idx ON remote_branches(repo_id);

CREATE TRIGGER remote_branches_ai_fts AFTER INSERT ON remote_branches
BEGIN
  DELETE FROM search_fts WHERE entity_id = NEW.id AND kind = 'remote_branch';
  INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr)
  VALUES (
    NEW.id, 'remote_branch', NEW.name, NEW.full_name,
    (SELECT name FROM repos WHERE id = NEW.repo_id), NULL
  );
END;

CREATE TRIGGER remote_branches_au_fts
AFTER UPDATE OF name, full_name, repo_id ON remote_branches
BEGIN
  UPDATE search_fts
     SET name = NEW.name,
         path = NEW.full_name,
         repo_name = (SELECT name FROM repos WHERE id = NEW.repo_id)
   WHERE entity_id = NEW.id AND kind = 'remote_branch';
END;

CREATE TRIGGER remote_branches_ad_fts AFTER DELETE ON remote_branches
BEGIN
  DELETE FROM search_fts WHERE entity_id = OLD.id AND kind = 'remote_branch';
END;

CREATE TRIGGER repos_au_remote_branches_fts
AFTER UPDATE OF name ON repos
BEGIN
  UPDATE search_fts SET repo_name = NEW.name
   WHERE kind = 'remote_branch'
     AND entity_id IN (
       SELECT id FROM remote_branches WHERE repo_id = NEW.id
     );
END;
