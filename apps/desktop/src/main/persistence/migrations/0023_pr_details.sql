-- Change-request detail for the PR hover card, plus the forge identity that
-- makes a number unambiguous.
--
-- Every column is nullable on purpose. Rows cached before this migration will
-- never gain values: a change request that already reached a terminal state
-- stops being refreshed, so its row is frozen. Readers must treat NULL as
-- "not known" and render nothing, never as zero.
ALTER TABLE branch_pr ADD COLUMN forge TEXT;
ALTER TABLE branch_pr ADD COLUMN host TEXT;
ALTER TABLE branch_pr ADD COLUMN repo_path TEXT;
ALTER TABLE branch_pr ADD COLUMN head_ref TEXT;
ALTER TABLE branch_pr ADD COLUMN base_ref TEXT;
ALTER TABLE branch_pr ADD COLUMN additions INTEGER;
ALTER TABLE branch_pr ADD COLUMN deletions INTEGER;
ALTER TABLE branch_pr ADD COLUMN changed_files INTEGER;
ALTER TABLE branch_pr ADD COLUMN commit_count INTEGER;
ALTER TABLE branch_pr ADD COLUMN opened_at INTEGER;
ALTER TABLE branch_pr ADD COLUMN merged_at INTEGER;
ALTER TABLE branch_pr ADD COLUMN closed_at INTEGER;

ALTER TABLE commit_pr ADD COLUMN forge TEXT;
ALTER TABLE commit_pr ADD COLUMN host TEXT;
ALTER TABLE commit_pr ADD COLUMN repo_path TEXT;
ALTER TABLE commit_pr ADD COLUMN head_ref TEXT;
ALTER TABLE commit_pr ADD COLUMN base_ref TEXT;
ALTER TABLE commit_pr ADD COLUMN additions INTEGER;
ALTER TABLE commit_pr ADD COLUMN deletions INTEGER;
ALTER TABLE commit_pr ADD COLUMN changed_files INTEGER;
ALTER TABLE commit_pr ADD COLUMN commit_count INTEGER;
ALTER TABLE commit_pr ADD COLUMN opened_at INTEGER;
ALTER TABLE commit_pr ADD COLUMN merged_at INTEGER;
ALTER TABLE commit_pr ADD COLUMN closed_at INTEGER;
