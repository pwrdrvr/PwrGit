-- GitHub's commit response may leave `author` null even when an exact commit
-- belongs to a uniquely associated pull request. Re-evaluate prior negatives
-- now that the resolver can corroborate that PR author's login.
DELETE FROM github_commit_author_identity_cache WHERE status = 'negative';
