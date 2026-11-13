-- The merge queue (GitHub) / merge train (GitLab) as the forge last reported
-- it: a JSON `PrMergeQueue`, NULL when not known. One column rather than five
-- because only `mergeQueueStatus` reads it, and it is read whole.
ALTER TABLE branch_pr ADD COLUMN merge_queue TEXT;
ALTER TABLE commit_pr ADD COLUMN merge_queue TEXT;
ALTER TABLE repo_open_pr ADD COLUMN merge_queue TEXT;
