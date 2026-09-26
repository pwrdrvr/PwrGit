-- GitHub commit association can return a PR from another fork-network repo.
-- Older versions stamped origin onto it, and number polling could then replace
-- even its URL and details. Discard those untrustworthy associations so visible
-- commits are resolved again. Branch/open-list caches are repository-scoped.
DELETE FROM commit_pr WHERE forge = 'github' OR forge IS NULL;
