-- 0021_remote_branch_hydration_retry — unavailable manual repositories must
-- retry migration hydration without restoring an every-launch Git scan.

CREATE TABLE remote_branch_hydration_retry (
  repo_id          TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  retry_after_ms   INTEGER NOT NULL
);
