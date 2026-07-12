-- 0008_search_fts — FTS5 index behind ⌘F (repo:search). Lifted from
-- PwrSnap's capture_search_fts pattern: a normal FTS5 virtual table
-- (NOT external content — FTS5 owns duplicated text; at our scale the
-- overhead is trivial and we avoid the external-content stale-token
-- footgun), synced by triggers that run inside the same transaction
-- as the source write, plus a one-shot backfill.
--
-- One table for both entity kinds so a single MATCH returns a mixed,
-- bm25-ranked result list:
--   kind='repo'      name=repo name    path=repo path   repo_name=NULL
--   kind='worktree'  name=branch       path=wt path     repo_name=owner
--
-- `tokenize = "unicode61 remove_diacritics 2"` splits on punctuation
-- (so "claude/side-by-side" indexes as [claude, side, by, side]) and
-- matches diacritic-insensitively.

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  entity_id UNINDEXED,
  kind UNINDEXED,
  name,
  path,
  repo_name,
  tokenize = "unicode61 remove_diacritics 2"
);

-- ── repos ───────────────────────────────────────────────────────────

CREATE TRIGGER IF NOT EXISTS repos_ai_fts AFTER INSERT ON repos
BEGIN
  DELETE FROM search_fts WHERE entity_id = NEW.id AND kind = 'repo';
  INSERT INTO search_fts (entity_id, kind, name, path, repo_name)
  VALUES (NEW.id, 'repo', NEW.name, NEW.path, NULL);
END;

-- Renames also refresh the repo_name context on the repo's worktree rows.
CREATE TRIGGER IF NOT EXISTS repos_au_fts
AFTER UPDATE OF name, path ON repos
BEGIN
  UPDATE search_fts SET name = NEW.name, path = NEW.path
   WHERE entity_id = NEW.id AND kind = 'repo';
  UPDATE search_fts SET repo_name = NEW.name
   WHERE kind = 'worktree'
     AND entity_id IN (SELECT id FROM worktrees WHERE repo_id = NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS repos_ad_fts AFTER DELETE ON repos
BEGIN
  DELETE FROM search_fts WHERE entity_id = OLD.id AND kind = 'repo';
END;

-- ── worktrees ───────────────────────────────────────────────────────
-- (FK ON DELETE CASCADE from repos fires the worktree delete trigger.)

CREATE TRIGGER IF NOT EXISTS worktrees_ai_fts AFTER INSERT ON worktrees
BEGIN
  DELETE FROM search_fts WHERE entity_id = NEW.id AND kind = 'worktree';
  INSERT INTO search_fts (entity_id, kind, name, path, repo_name)
  VALUES (
    NEW.id, 'worktree', NEW.branch, NEW.path,
    (SELECT name FROM repos WHERE id = NEW.repo_id)
  );
END;

-- branch changes on branch:switch; repo_id on ownership reclaim.
CREATE TRIGGER IF NOT EXISTS worktrees_au_fts
AFTER UPDATE OF branch, repo_id ON worktrees
BEGIN
  UPDATE search_fts
     SET name = NEW.branch,
         repo_name = (SELECT name FROM repos WHERE id = NEW.repo_id)
   WHERE entity_id = NEW.id AND kind = 'worktree';
END;

CREATE TRIGGER IF NOT EXISTS worktrees_ad_fts AFTER DELETE ON worktrees
BEGIN
  DELETE FROM search_fts WHERE entity_id = OLD.id AND kind = 'worktree';
END;

-- ── backfill ────────────────────────────────────────────────────────

INSERT INTO search_fts (entity_id, kind, name, path, repo_name)
SELECT r.id, 'repo', r.name, r.path, NULL
  FROM repos r
 WHERE NOT EXISTS (
   SELECT 1 FROM search_fts s WHERE s.entity_id = r.id AND s.kind = 'repo'
 );

INSERT INTO search_fts (entity_id, kind, name, path, repo_name)
SELECT w.id, 'worktree', w.branch, w.path, r.name
  FROM worktrees w
  JOIN repos r ON r.id = w.repo_id
 WHERE NOT EXISTS (
   SELECT 1 FROM search_fts s WHERE s.entity_id = w.id AND s.kind = 'worktree'
 );
