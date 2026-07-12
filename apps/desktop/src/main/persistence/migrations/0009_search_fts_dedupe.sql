-- 0009_search_fts_dedupe — scrub duplicate rows from the ⌘F index.
--
-- Databases carrying pre-hardening fossils (duplicate worktree rows from
-- before worktrees.id was reliably unique) could double-insert into
-- search_fts via 0008's backfill: its NOT EXISTS guard evaluates against
-- the table state at statement START, so N source duplicates all passed
-- the guard in one INSERT…SELECT. Duplicate index rows become duplicate
-- ⌘F hits → duplicate React keys → ghost rows in the results list.
--
-- searchAll also dedupes defensively at query time; this heals the data.
DELETE FROM search_fts
 WHERE rowid NOT IN (
   SELECT MIN(rowid) FROM search_fts GROUP BY entity_id, kind
 );
