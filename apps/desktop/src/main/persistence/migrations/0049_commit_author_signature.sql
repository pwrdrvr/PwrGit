-- A forge account match says whose email a commit carries, not who wrote it.
-- Record, per exact commit only, whether the forge verified a signature made
-- by the commit's own author (committer email = author email). The reusable
-- email -> account cache never carries it: a signature belongs to one commit.
ALTER TABLE github_commit_author_identity_cache
  ADD COLUMN signature_verified INTEGER NOT NULL DEFAULT 0;

-- Rows written before this column existed never asked. Mark them stale (not
-- missing: the login and avatar still paint) so the people store re-checks
-- them on its own schedule rather than waiting out a week-long TTL.
UPDATE github_commit_author_identity_cache
   SET expires_at = fetched_at
 WHERE status = 'resolved' AND expires_at > fetched_at;
