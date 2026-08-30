import { isGitLfsReady, type GitLfsStatus } from "@pwrgit/shared";
import type { DB } from "../persistence/db";

/** Fold one LFS check into the repo's announcement record and answer whether
 * this check is the one that announces a working setup: the repo's first
 * ready check, or the first ready check after a broken one. Repos that do not
 * require LFS leave the record alone — a branch without LFS rules says
 * nothing about whether the rest of the repo's setup still works. */
export function recordLfsOutcome(
  db: DB,
  repoId: string,
  status: GitLfsStatus
): boolean {
  if (!status.required) return false;
  const outcome = isGitLfsReady(status) ? "ready" : "broken";
  const previous = db
    .prepare("SELECT last_outcome FROM repo_lfs_notice WHERE repo_id = ?")
    .get(repoId) as { last_outcome: string } | undefined;
  const changed = previous?.last_outcome !== outcome;
  if (changed) {
    db.prepare(
      `INSERT INTO repo_lfs_notice (repo_id, last_outcome, recorded_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(repo_id) DO UPDATE SET
         last_outcome = excluded.last_outcome,
         recorded_at = excluded.recorded_at`
    ).run(repoId, outcome);
  }
  return changed && outcome === "ready";
}
