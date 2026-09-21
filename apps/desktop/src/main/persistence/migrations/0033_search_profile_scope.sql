-- 0033_search_profile_scope — every search row says which profile owns it.
--
-- ⌘K answered `106` in one profile's window with a merged pull request from
-- another profile's repository. Searching every profile is deliberate — a hit
-- carries its profile, the palette badges it, and picking it opens that
-- profile's window — but it is now off by default, and the filter has to run
-- INSIDE the query: search_fts caps its answer, so a row filtered out
-- afterwards has already spent a result slot this profile needed. "Main cannot
-- tell which profile is asking" in ../../AGENTS.md has the rule.
--
-- fts5 has no ALTER TABLE ADD COLUMN, so the table is rebuilt — the move 0010
-- already made once. Only the five INSERT triggers name columns and so only
-- they change; the UPDATE and DELETE triggers keep working untouched.
-- profile_id is UNINDEXED: it is a filter, never a search term, and indexing
-- it would let a profile's id match as text.
--
-- A row's profile can change after it is written, two ways, and the column
-- has to follow both. A repo's id is a hash of its path, so scanning or adding
-- a path another profile already holds moves that repo — and everything
-- under it — to the new profile (upsertRepoRow). And a worktree or branch can
-- be reclaimed by a different repo (syncWorktrees). The existing UPDATE
-- triggers follow neither; the *_profile_fts triggers at the end do.

DROP TRIGGER repos_ai_fts;
DROP TRIGGER worktrees_ai_fts;
DROP TRIGGER local_branches_ai_fts;
DROP TRIGGER remote_branches_ai_fts;
DROP TRIGGER repo_open_pr_ai_fts;
DROP TABLE search_fts;

CREATE VIRTUAL TABLE search_fts USING fts5(
  entity_id UNINDEXED,
  kind UNINDEXED,
  name,
  path,
  repo_name,
  pr,
  profile_id UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE TRIGGER repos_ai_fts AFTER INSERT ON repos
BEGIN
  DELETE FROM search_fts WHERE entity_id = NEW.id AND kind = 'repo';
  INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr, profile_id)
  VALUES (NEW.id, 'repo', NEW.name, NEW.path, NULL, NULL, NEW.profile_id);
END;

CREATE TRIGGER worktrees_ai_fts AFTER INSERT ON worktrees
BEGIN
  DELETE FROM search_fts WHERE entity_id = NEW.id AND kind = 'worktree';
  INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr, profile_id)
  VALUES (
    NEW.id, 'worktree', NEW.branch, NEW.path,
    (SELECT name FROM repos WHERE id = NEW.repo_id),
    (SELECT CAST(p.number AS TEXT) || ' ' || COALESCE(p.title, '')
       FROM branch_pr p
      WHERE p.repo_id = NEW.repo_id AND p.branch = NEW.branch
        AND p.number IS NOT NULL),
    (SELECT profile_id FROM repos WHERE id = NEW.repo_id)
  );
END;

CREATE TRIGGER local_branches_ai_fts AFTER INSERT ON local_branches
BEGIN
  DELETE FROM search_fts WHERE entity_id = NEW.id AND kind = 'local_branch';
  INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr, profile_id)
  VALUES (
    NEW.id, 'local_branch', NEW.name, NEW.full_name,
    (SELECT name FROM repos WHERE id = NEW.repo_id),
    (SELECT CAST(p.number AS TEXT) || ' ' || COALESCE(p.title, '')
       FROM branch_pr p
      WHERE p.repo_id = NEW.repo_id AND p.branch = NEW.name
        AND p.number IS NOT NULL),
    (SELECT profile_id FROM repos WHERE id = NEW.repo_id)
  );
END;

CREATE TRIGGER remote_branches_ai_fts AFTER INSERT ON remote_branches
BEGIN
  DELETE FROM search_fts WHERE entity_id = NEW.id AND kind = 'remote_branch';
  INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr, profile_id)
  VALUES (
    NEW.id, 'remote_branch', NEW.name, NEW.full_name,
    (SELECT name FROM repos WHERE id = NEW.repo_id), NULL,
    (SELECT profile_id FROM repos WHERE id = NEW.repo_id)
  );
END;

CREATE TRIGGER repo_open_pr_ai_fts AFTER INSERT ON repo_open_pr
BEGIN
  DELETE FROM search_fts
   WHERE kind = 'change_request' AND entity_id = NEW.repo_id || ':' || NEW.number;
  INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr, profile_id)
  VALUES (
    NEW.repo_id || ':' || NEW.number, 'change_request', NEW.title, NEW.head_ref,
    (SELECT name FROM repos WHERE id = NEW.repo_id),
    CAST(NEW.number AS TEXT) || ' ' || NEW.title,
    (SELECT profile_id FROM repos WHERE id = NEW.repo_id)
  );
END;

-- Rebuild every row the dropped table held.

INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr, profile_id)
SELECT r.id, 'repo', r.name, r.path, NULL, NULL, r.profile_id FROM repos r;

INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr, profile_id)
SELECT w.id, 'worktree', w.branch, w.path, r.name,
       (SELECT CAST(p.number AS TEXT) || ' ' || COALESCE(p.title, '')
          FROM branch_pr p
         WHERE p.repo_id = w.repo_id AND p.branch = w.branch
           AND p.number IS NOT NULL),
       r.profile_id
  FROM worktrees w JOIN repos r ON r.id = w.repo_id;

INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr, profile_id)
SELECT b.id, 'local_branch', b.name, b.full_name, r.name,
       (SELECT CAST(p.number AS TEXT) || ' ' || COALESCE(p.title, '')
          FROM branch_pr p
         WHERE p.repo_id = b.repo_id AND p.branch = b.name
           AND p.number IS NOT NULL),
       r.profile_id
  FROM local_branches b JOIN repos r ON r.id = b.repo_id;

INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr, profile_id)
SELECT b.id, 'remote_branch', b.name, b.full_name, r.name, NULL, r.profile_id
  FROM remote_branches b JOIN repos r ON r.id = b.repo_id;

INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr, profile_id)
SELECT o.repo_id || ':' || o.number, 'change_request', o.title, o.head_ref,
       r.name, CAST(o.number AS TEXT) || ' ' || o.title, r.profile_id
  FROM repo_open_pr o JOIN repos r ON r.id = o.repo_id;

-- Keep profile_id true after the row is written.

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
            SELECT repo_id || ':' || number FROM repo_open_pr WHERE repo_id = NEW.id
          ));
END;

CREATE TRIGGER worktrees_au_profile_fts AFTER UPDATE OF repo_id ON worktrees
WHEN NEW.repo_id IS NOT OLD.repo_id
BEGIN
  UPDATE search_fts
     SET profile_id = (SELECT profile_id FROM repos WHERE id = NEW.repo_id)
   WHERE kind = 'worktree' AND entity_id = NEW.id;
END;

CREATE TRIGGER local_branches_au_profile_fts AFTER UPDATE OF repo_id ON local_branches
WHEN NEW.repo_id IS NOT OLD.repo_id
BEGIN
  UPDATE search_fts
     SET profile_id = (SELECT profile_id FROM repos WHERE id = NEW.repo_id)
   WHERE kind = 'local_branch' AND entity_id = NEW.id;
END;

CREATE TRIGGER remote_branches_au_profile_fts AFTER UPDATE OF repo_id ON remote_branches
WHEN NEW.repo_id IS NOT OLD.repo_id
BEGIN
  UPDATE search_fts
     SET profile_id = (SELECT profile_id FROM repos WHERE id = NEW.repo_id)
   WHERE kind = 'remote_branch' AND entity_id = NEW.id;
END;
