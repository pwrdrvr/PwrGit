-- 0010_search_fts_pr — make PRs searchable from ⌘F. Typing "13029" (or
-- words from the PR title) must find the worktree whose branch carries
-- that PR. The association lives in branch_pr; fold it into the search
-- index as a `pr` column ("13029 <title>") on worktree rows.
--
-- FTS5 virtual tables can't ALTER TABLE ADD COLUMN, and the index is
-- purely derived data — so drop and rebuild table + triggers, then
-- backfill. (This also re-heals any pre-0009 duplicate rows for free.)

DROP TRIGGER IF EXISTS repos_ai_fts;
DROP TRIGGER IF EXISTS repos_au_fts;
DROP TRIGGER IF EXISTS repos_ad_fts;
DROP TRIGGER IF EXISTS worktrees_ai_fts;
DROP TRIGGER IF EXISTS worktrees_au_fts;
DROP TRIGGER IF EXISTS worktrees_ad_fts;
DROP TABLE IF EXISTS search_fts;

CREATE VIRTUAL TABLE search_fts USING fts5(
  entity_id UNINDEXED,
  kind UNINDEXED,
  name,
  path,
  repo_name,
  pr,
  tokenize = "unicode61 remove_diacritics 2"
);

-- ── repos ───────────────────────────────────────────────────────────

CREATE TRIGGER repos_ai_fts AFTER INSERT ON repos
BEGIN
  DELETE FROM search_fts WHERE entity_id = NEW.id AND kind = 'repo';
  INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr)
  VALUES (NEW.id, 'repo', NEW.name, NEW.path, NULL, NULL);
END;

CREATE TRIGGER repos_au_fts
AFTER UPDATE OF name, path ON repos
BEGIN
  UPDATE search_fts SET name = NEW.name, path = NEW.path
   WHERE entity_id = NEW.id AND kind = 'repo';
  UPDATE search_fts SET repo_name = NEW.name
   WHERE kind = 'worktree'
     AND entity_id IN (SELECT id FROM worktrees WHERE repo_id = NEW.id);
END;

CREATE TRIGGER repos_ad_fts AFTER DELETE ON repos
BEGIN
  DELETE FROM search_fts WHERE entity_id = OLD.id AND kind = 'repo';
END;

-- ── worktrees ───────────────────────────────────────────────────────

CREATE TRIGGER worktrees_ai_fts AFTER INSERT ON worktrees
BEGIN
  DELETE FROM search_fts WHERE entity_id = NEW.id AND kind = 'worktree';
  INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr)
  VALUES (
    NEW.id, 'worktree', NEW.branch, NEW.path,
    (SELECT name FROM repos WHERE id = NEW.repo_id),
    (SELECT CAST(p.number AS TEXT) || ' ' || COALESCE(p.title, '')
       FROM branch_pr p
      WHERE p.repo_id = NEW.repo_id AND p.branch = NEW.branch
        AND p.number IS NOT NULL)
  );
END;

CREATE TRIGGER worktrees_au_fts
AFTER UPDATE OF branch, repo_id ON worktrees
BEGIN
  UPDATE search_fts
     SET name = NEW.branch,
         repo_name = (SELECT name FROM repos WHERE id = NEW.repo_id),
         pr = (SELECT CAST(p.number AS TEXT) || ' ' || COALESCE(p.title, '')
                 FROM branch_pr p
                WHERE p.repo_id = NEW.repo_id AND p.branch = NEW.branch
                  AND p.number IS NOT NULL)
   WHERE entity_id = NEW.id AND kind = 'worktree';
END;

CREATE TRIGGER worktrees_ad_fts AFTER DELETE ON worktrees
BEGIN
  DELETE FROM search_fts WHERE entity_id = OLD.id AND kind = 'worktree';
END;

-- ── branch_pr ───────────────────────────────────────────────────────
-- PR discoveries/updates flow onto the matching worktree rows. A NULL
-- number (negative cache: "checked, no PR") clears the column.

CREATE TRIGGER branch_pr_ai_fts AFTER INSERT ON branch_pr
BEGIN
  UPDATE search_fts
     SET pr = CASE
       WHEN NEW.number IS NULL THEN NULL
       ELSE CAST(NEW.number AS TEXT) || ' ' || COALESCE(NEW.title, '')
     END
   WHERE kind = 'worktree'
     AND entity_id IN (
       SELECT id FROM worktrees
        WHERE repo_id = NEW.repo_id AND branch = NEW.branch
     );
END;

CREATE TRIGGER branch_pr_au_fts AFTER UPDATE ON branch_pr
BEGIN
  UPDATE search_fts
     SET pr = CASE
       WHEN NEW.number IS NULL THEN NULL
       ELSE CAST(NEW.number AS TEXT) || ' ' || COALESCE(NEW.title, '')
     END
   WHERE kind = 'worktree'
     AND entity_id IN (
       SELECT id FROM worktrees
        WHERE repo_id = NEW.repo_id AND branch = NEW.branch
     );
END;

CREATE TRIGGER branch_pr_ad_fts AFTER DELETE ON branch_pr
BEGIN
  UPDATE search_fts SET pr = NULL
   WHERE kind = 'worktree'
     AND entity_id IN (
       SELECT id FROM worktrees
        WHERE repo_id = OLD.repo_id AND branch = OLD.branch
     );
END;

-- ── backfill ────────────────────────────────────────────────────────

INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr)
SELECT r.id, 'repo', r.name, r.path, NULL, NULL FROM repos r;

INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr)
SELECT w.id, 'worktree', w.branch, w.path, r.name,
       CASE
         WHEN p.number IS NULL THEN NULL
         ELSE CAST(p.number AS TEXT) || ' ' || COALESCE(p.title, '')
       END
  FROM worktrees w
  JOIN repos r ON r.id = w.repo_id
  LEFT JOIN branch_pr p
    ON p.repo_id = w.repo_id AND p.branch = w.branch;
