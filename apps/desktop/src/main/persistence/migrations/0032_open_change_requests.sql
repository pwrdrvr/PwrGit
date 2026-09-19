-- 0032_open_change_requests — a repository's open change requests, listed from
-- the forge rather than looked up per local ref.
--
-- branch_pr answers "which PR is this local branch's?" and commit_pr "which PR
-- holds this commit?" — both keyed by something the checkout already has. A
-- pull request whose head was never fetched (every one from a fork, and any
-- opened since the last fetch) was in neither, so typing its number found
-- nothing, in the refs browser or in ⌘K, even while the forge could name it.
--
-- repo_open_pr is one repository's open list, replaced by diff on each
-- successful refresh (OpenPrService). A PR that closes simply leaves it; the
-- per-branch and per-commit caches keep answering for closed and merged ones.

CREATE TABLE repo_open_pr (
  repo_id              TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
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
  additions            INTEGER,
  deletions            INTEGER,
  changed_files        INTEGER,
  commit_count         INTEGER,
  opened_at            INTEGER,
  merged_at            INTEGER,
  closed_at            INTEGER,
  author               TEXT,
  -- Set only for a fork: the forge path of the repository holding head_ref.
  head_repo_path       TEXT,
  updated_at           INTEGER,
  PRIMARY KEY (repo_id, number)
);

CREATE INDEX repo_open_pr_head_idx ON repo_open_pr(repo_id, head_ref);

-- When the list last landed. Separate from the rows because an empty list is
-- an answer too: a repository with no open PRs must still read as fresh.
CREATE TABLE repo_open_pr_state (
  repo_id    TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  fetched_at INTEGER NOT NULL,
  truncated  INTEGER NOT NULL DEFAULT 0
);

-- ── search_fts: one change_request row per open PR ──────────────────
-- name is the title (what a reader types words from), path the head branch,
-- and pr the "<number> <title>" text every other kind's pr column carries.
-- The indexer resolves a hit on this row to the worktree or branch that holds
-- its head, so it only surfaces as a PR of its own when no such ref exists.

CREATE TRIGGER repo_open_pr_ai_fts AFTER INSERT ON repo_open_pr
BEGIN
  DELETE FROM search_fts
   WHERE kind = 'change_request' AND entity_id = NEW.repo_id || ':' || NEW.number;
  INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr)
  VALUES (
    NEW.repo_id || ':' || NEW.number, 'change_request', NEW.title, NEW.head_ref,
    (SELECT name FROM repos WHERE id = NEW.repo_id),
    CAST(NEW.number AS TEXT) || ' ' || NEW.title
  );
END;

-- Only the indexed text: check and merge state change constantly and would
-- otherwise rewrite the index row on every refresh of a busy repository.
CREATE TRIGGER repo_open_pr_au_fts AFTER UPDATE OF title, head_ref ON repo_open_pr
BEGIN
  UPDATE search_fts
     SET name = NEW.title,
         path = NEW.head_ref,
         pr = CAST(NEW.number AS TEXT) || ' ' || NEW.title
   WHERE kind = 'change_request' AND entity_id = OLD.repo_id || ':' || OLD.number;
END;

CREATE TRIGGER repo_open_pr_ad_fts AFTER DELETE ON repo_open_pr
BEGIN
  DELETE FROM search_fts
   WHERE kind = 'change_request' AND entity_id = OLD.repo_id || ':' || OLD.number;
END;

CREATE TRIGGER repos_au_open_pr_fts AFTER UPDATE OF name ON repos
BEGIN
  UPDATE search_fts SET repo_name = NEW.name
   WHERE kind = 'change_request'
     AND entity_id IN (
       SELECT repo_id || ':' || number FROM repo_open_pr WHERE repo_id = NEW.id
     );
END;

-- ── branch_pr now reaches local_branch rows too ─────────────────────
-- 0010 flowed a branch's PR onto its worktree row only. branch_pr has always
-- covered every refs/heads branch, so a local branch with nothing checked out
-- had its PR cached and still could not be found by number or title.

DROP TRIGGER branch_pr_ai_fts;
DROP TRIGGER branch_pr_au_fts;
DROP TRIGGER branch_pr_ad_fts;
DROP TRIGGER local_branches_ai_fts;

CREATE TRIGGER branch_pr_ai_fts AFTER INSERT ON branch_pr
BEGIN
  UPDATE search_fts
     SET pr = CASE
       WHEN NEW.number IS NULL THEN NULL
       ELSE CAST(NEW.number AS TEXT) || ' ' || COALESCE(NEW.title, '')
     END
   WHERE (kind = 'worktree'
          AND entity_id IN (
            SELECT id FROM worktrees
             WHERE repo_id = NEW.repo_id AND branch = NEW.branch
          ))
      OR (kind = 'local_branch'
          AND entity_id IN (
            SELECT id FROM local_branches
             WHERE repo_id = NEW.repo_id AND name = NEW.branch
          ));
END;

CREATE TRIGGER branch_pr_au_fts AFTER UPDATE ON branch_pr
BEGIN
  UPDATE search_fts
     SET pr = CASE
       WHEN NEW.number IS NULL THEN NULL
       ELSE CAST(NEW.number AS TEXT) || ' ' || COALESCE(NEW.title, '')
     END
   WHERE (kind = 'worktree'
          AND entity_id IN (
            SELECT id FROM worktrees
             WHERE repo_id = NEW.repo_id AND branch = NEW.branch
          ))
      OR (kind = 'local_branch'
          AND entity_id IN (
            SELECT id FROM local_branches
             WHERE repo_id = NEW.repo_id AND name = NEW.branch
          ));
END;

CREATE TRIGGER branch_pr_ad_fts AFTER DELETE ON branch_pr
BEGIN
  UPDATE search_fts SET pr = NULL
   WHERE (kind = 'worktree'
          AND entity_id IN (
            SELECT id FROM worktrees
             WHERE repo_id = OLD.repo_id AND branch = OLD.branch
          ))
      OR (kind = 'local_branch'
          AND entity_id IN (
            SELECT id FROM local_branches
             WHERE repo_id = OLD.repo_id AND name = OLD.branch
          ));
END;

CREATE TRIGGER local_branches_ai_fts AFTER INSERT ON local_branches
BEGIN
  DELETE FROM search_fts WHERE entity_id = NEW.id AND kind = 'local_branch';
  INSERT INTO search_fts (entity_id, kind, name, path, repo_name, pr)
  VALUES (
    NEW.id, 'local_branch', NEW.name, NEW.full_name,
    (SELECT name FROM repos WHERE id = NEW.repo_id),
    (SELECT CAST(p.number AS TEXT) || ' ' || COALESCE(p.title, '')
       FROM branch_pr p
      WHERE p.repo_id = NEW.repo_id AND p.branch = NEW.name
        AND p.number IS NOT NULL)
  );
END;

-- Backfill the local_branch rows that already exist.
UPDATE search_fts
   SET pr = (
     SELECT CAST(p.number AS TEXT) || ' ' || COALESCE(p.title, '')
       FROM local_branches b
       JOIN branch_pr p ON p.repo_id = b.repo_id AND p.branch = b.name
      WHERE b.id = search_fts.entity_id AND p.number IS NOT NULL
   )
 WHERE kind = 'local_branch';
