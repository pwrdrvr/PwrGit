-- Legacy automatic GitHub matches checked only the head branch name, and
-- cannot prove which repository supplied it. Re-query once with source
-- identity. NULL forge rows predate multi-forge support and are GitHub too.
-- Exact-commit associations are independent evidence, including upstream PRs.
DELETE FROM branch_pr WHERE forge = 'github' OR forge IS NULL;
