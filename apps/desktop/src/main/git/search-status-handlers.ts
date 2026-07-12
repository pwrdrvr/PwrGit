import { err, ok, type SearchHitStatus } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { execGit } from "./dugite";

/**
 * Per-hit status for ⌘F results. Deliberately ONE unit of work per call —
 * the renderer's cancelable fill queue (asyncFill + p-map-iterable) decides
 * which hits are visible, debounces scrolling, and bounds concurrency, so
 * the main process never gets asked to rip through 100 directories.
 *
 * Cost ladder: a cached worktree_state row answers with zero git; otherwise
 * one `git log -1` in the checkout gives the tip age (the "how stale is
 * this branch" signal), leaving dirty/ahead/behind unknown.
 */
export function registerSearchStatusHandlers(bus: CommandBus, db: DB): void {
  bus.register("search:status", async (req) => {
    const worktreeId =
      req.worktreeId ??
      ((
        db
          .prepare(
            "SELECT id FROM worktrees WHERE repo_id = ? AND is_primary = 1"
          )
          .get(req.repoId) as { id: string } | undefined
      )?.id ??
        null);
    if (worktreeId === null) {
      return err({ kind: "repo", code: "not_found", message: "no worktree" });
    }

    const cached = db
      .prepare(
        `SELECT last_activity_at, dirty, ahead, behind
         FROM worktree_state WHERE worktree_id = ?`
      )
      .get(worktreeId) as
      | {
          last_activity_at: string | null;
          dirty: number;
          ahead: number;
          behind: number;
        }
      | undefined;
    if (cached !== undefined) {
      return ok<SearchHitStatus>({
        lastActivityAt: cached.last_activity_at,
        dirty: cached.dirty,
        ahead: cached.ahead,
        behind: cached.behind
      });
    }

    const wt = db
      .prepare("SELECT path FROM worktrees WHERE id = ?")
      .get(worktreeId) as { path: string } | undefined;
    if (wt === undefined) {
      return err({ kind: "repo", code: "not_found", message: "no worktree" });
    }
    const raw = await execGit(["log", "-1", "--format=%cI"], wt.path);
    const lastActivityAt =
      raw.ok && raw.value.exitCode === 0 && raw.value.stdout.trim() !== ""
        ? raw.value.stdout.trim()
        : null;
    return ok<SearchHitStatus>({
      lastActivityAt,
      dirty: null,
      ahead: null,
      behind: null
    });
  });
}
