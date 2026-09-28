-- 0035_pr_head_oid — the change request's head commit (PrSummary.headOid).
--
-- A squash or rebase merge leaves no ancestry between a local branch and the
-- default branch, so "is this branch's PR merged?" is only half the question:
-- the local branch may have moved on after the merge. The head commit a merged
-- PR last carried is what lets a later check prove the local tip IS that PR's
-- final commit. GitHub reports it as headRefOid, GitLab as diffHeadSha.
--
-- Nullable in all three tables that share the detail column list (pr-row.ts's
-- PR_DETAIL_COLUMNS), for the same reason as 0023: NULL is "not known".
ALTER TABLE branch_pr ADD COLUMN head_oid TEXT;
ALTER TABLE commit_pr ADD COLUMN head_oid TEXT;
ALTER TABLE repo_open_pr ADD COLUMN head_oid TEXT;

-- Merged branch rows are exactly the ones the new column exists for, and every
-- one cached so far has it NULL. Expire them so the next branch refresh asks
-- again instead of waiting out the TTL the last successful one earned.
--
-- PrService.isFresh reads fetched_at with Date.parse (it is written as an ISO
-- string, or SQLite's datetime('now') default) and treats a row as fresh only
-- when that time is inside the TTL. The epoch parses to 0, which is outside
-- every TTL, and it cannot be mistaken for a future stamp. Only fetched_at
-- changes: the cached PR keeps rendering until the refetch replaces it, and a
-- refresh that fails leaves it as it was.
UPDATE branch_pr
   SET fetched_at = '1970-01-01T00:00:00.000Z'
 WHERE state = 'merged' AND number IS NOT NULL;
