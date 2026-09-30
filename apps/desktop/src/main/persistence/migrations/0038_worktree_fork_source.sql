-- 0036_worktree_fork_source — the branch against its fork's source, and a
-- pruned upstream, kept with the rest of the worktree snapshot.
--
-- On a fork, `main` tracks `origin/main` (the user's own copy), so the stored
-- ahead/behind read 0/0 while `upstream/main` moves on. The header asked the
-- source live, but the sidebar only reads this table, and a change to the
-- source alone never moved the snapshot — so the refresher never announced
-- it. NULL source columns mean "no fork source for this branch".
ALTER TABLE worktree_state ADD COLUMN source_remote TEXT;
ALTER TABLE worktree_state ADD COLUMN source_label TEXT;
ALTER TABLE worktree_state ADD COLUMN source_parent TEXT;
ALTER TABLE worktree_state ADD COLUMN source_ahead INTEGER;
ALTER TABLE worktree_state ADD COLUMN source_behind INTEGER;

-- `git status --branch` names an upstream whose remote branch was pruned but
-- prints no ahead/behind line for it; without this flag that read as 0/0,
-- "up to date", for a branch whose work had landed.
ALTER TABLE worktree_state ADD COLUMN upstream_gone INTEGER NOT NULL DEFAULT 0;
