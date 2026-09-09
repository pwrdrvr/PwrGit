ALTER TABLE branch_pr ADD COLUMN check_state TEXT;
ALTER TABLE branch_pr ADD COLUMN checks_still_running INTEGER;
ALTER TABLE branch_pr ADD COLUMN merge_state TEXT;
ALTER TABLE commit_pr ADD COLUMN check_state TEXT;
ALTER TABLE commit_pr ADD COLUMN checks_still_running INTEGER;
ALTER TABLE commit_pr ADD COLUMN merge_state TEXT;
