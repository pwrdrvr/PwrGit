# src/main/persistence — AGENTS.md

## Every SQL statement here runs on the main process

better-sqlite3 is synchronous. A slow statement is not slow in the background:
it is the app not painting, not taking input, and — past a couple of seconds —
the macOS beachball. Trigger bodies count, and they multiply: a trigger runs
once per affected row, including rows a `ON DELETE CASCADE` removes.

So a trigger's lookup must hit an index. The one that did not: every search
trigger addressed `search_fts` by `entity_id`, an `UNINDEXED` fts5 column,
which fts5 answers by scanning the whole table. At 29k search rows that was
~3.7ms per written row — a fetch's 100-branch chunk held the loop ~400ms, and
deleting a repo with 6,672 remote branches took 21.8s in one statement.
`0037_search_rows_indexed.sql` has the fix; check a new trigger's statements
with `EXPLAIN QUERY PLAN` and look for `SCAN` over a large table.

## The ⌘K index: write `search_fts`, never `search_fts_index`

Since 0037, `search_fts` is an ordinary table of search rows (indexed on
`kind, entity_id`), and `search_fts_index` is an external-content fts5 index
over it, kept current by three triggers on `search_fts`. A new kind of search
row is written to `search_fts` and is indexed for free. Writing
`search_fts_index` directly desynchronises it from its rows; queries `MATCH`
against it and read columns through it.
