import { existsSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type PwrGitError, type Result } from "@pwrgit/shared";
import type { DB } from "../persistence/db";

/**
 * Whether a worktree's checkout is still there. Git's own test for a
 * `prunable` entry is the `.git` link inside the worktree — a directory whose
 * link was deleted is as gone as a deleted directory — so the state probe and
 * the indexer ask the same question and never disagree about a row.
 */
export function checkoutExists(worktreePath: string): boolean {
  return existsSync(join(worktreePath, ".git"));
}

export const WORKTREE_MISSING_CODE = "worktree_missing";

/** The one error every per-worktree action returns for a gone checkout, in
 *  place of git's raw "fatal: cannot change to '<path>'". */
export function worktreeMissingError(worktreePath: string): PwrGitError {
  return {
    kind: "repo",
    code: WORKTREE_MISSING_CODE,
    message: `This worktree's folder no longer exists: ${worktreePath}. Remove the worktree to drop it from the sidebar, or put the folder back and refresh the repo.`
  };
}

/**
 * Refuse a git action on a worktree the index knows is gone. Reads only the
 * `missing` flag — the state probe and re-index keep it current — so a fake
 * path in a stubbed test database is not mistaken for a deleted checkout.
 * Returns null when the row is absent: the handler's own not-found answer is
 * the right one there, and this guard is not it.
 */
export function missingWorktreeError(
  db: DB,
  worktreeId: string
): PwrGitError | null {
  const row = db
    .prepare("SELECT path, missing FROM worktrees WHERE id = ?")
    .get(worktreeId) as { path: string; missing?: number } | undefined;
  if (row === undefined || row.missing !== 1) return null;
  return worktreeMissingError(row.path);
}

const notFound: PwrGitError = {
  kind: "repo",
  code: "not_found",
  message: "worktree not found"
};

/** A worktree's path for a git action: not-found for an unknown id, the
 *  typed `worktree_missing` error for a gone checkout, its path otherwise. */
export function liveWorktreePath(db: DB, worktreeId: string): Result<string> {
  const row = db
    .prepare("SELECT path, missing FROM worktrees WHERE id = ?")
    .get(worktreeId) as { path: string; missing?: number } | undefined;
  if (row === undefined) return err(notFound);
  if (row.missing === 1) return err(worktreeMissingError(row.path));
  return ok(row.path);
}
