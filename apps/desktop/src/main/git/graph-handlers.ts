import { type Commit, err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { execGit } from "./dugite";
import {
  branchTips,
  listLocalBranchNames,
  readLog,
  readLogRefs,
  selectActiveBranches
} from "./git-service";
import type { WorktreeStateService } from "./worktree-state";

/** The repo-level part of the lane graph (same for every worktree of a repo);
 *  only the HEAD dot varies per worktree, so this is cached and reused. */
type CachedLanes = {
  commits: Commit[];
  tips: Record<string, string[]>;
  defaultBranch: string;
  shownBranches: string[];
  hiddenBranches: number;
  at: number;
};
const laneCache = new Map<string, CachedLanes>();
const LANE_TTL_MS = 30_000;

export function registerGraphHandlers(
  bus: CommandBus,
  db: DB,
  state: WorktreeStateService
): void {
  bus.register("graph:log", async (req) => {
    const wt = db
      .prepare("SELECT path, repo_id FROM worktrees WHERE id = ?")
      .get(req.worktreeId) as { path: string; repo_id: string } | undefined;
    if (wt === undefined) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "worktree not found"
      });
    }

    const commits = await readLog(execGit, wt.path, req.limit ?? 200);
    if (!commits.ok) return commits;

    const def = await state.resolveDefaultBranch(wt.repo_id, wt.path);
    let branchRoot: string | null = null;
    const mb = await execGit(["merge-base", "HEAD", def.ref], wt.path);
    if (mb.ok && mb.value.exitCode === 0) {
      const hash = mb.value.stdout.trim();
      branchRoot = hash !== "" ? hash : null;
    }

    return ok({ commits: commits.value, branchRoot, defaultBranch: def.name });
  });

  bus.register("graph:lanes", async (req) => {
    const wt = db
      .prepare(
        `SELECT w.path AS path, w.repo_id AS repo_id, p.email AS email
         FROM worktrees w
         JOIN repos r ON r.id = w.repo_id
         JOIN profiles p ON p.id = r.profile_id
         WHERE w.id = ?`
      )
      .get(req.worktreeId) as
      | { path: string; repo_id: string; email: string }
      | undefined;
    if (wt === undefined) {
      return err({ kind: "repo", code: "not_found", message: "worktree not found" });
    }

    // The branch set + union log is the same for every worktree in a repo — only
    // the HEAD dot moves — so compute it once and cache it. A plain worktree
    // switch reuses the cache (one cheap rev-parse); `force` (a real change) and
    // the TTL recompute it.
    const key = `${wt.repo_id}:${req.scope}`;
    let cached = laneCache.get(key);
    const fresh =
      cached !== undefined &&
      req.force !== true &&
      Date.now() - cached.at < LANE_TTL_MS;

    if (!fresh) {
      const def = await state.resolveDefaultBranch(wt.repo_id, wt.path);
      const worktreeBranches = new Set(
        (
          db
            .prepare("SELECT branch FROM worktrees WHERE repo_id = ?")
            .all(wt.repo_id) as { branch: string }[]
        ).map((r) => r.branch)
      );
      const mergedPrBranches = new Set(
        (
          db
            .prepare(
              "SELECT branch FROM branch_pr WHERE repo_id = ? AND state = 'merged'"
            )
            .all(wt.repo_id) as { branch: string }[]
        ).map((r) => r.branch)
      );

      const allLocal = await listLocalBranchNames(execGit, wt.path);
      if (!allLocal.ok) return allLocal;
      const totalOther = allLocal.value.filter((b) => b !== def.name).length;

      let shown: string[];
      if (req.scope === "all") {
        shown = allLocal.value.filter((b) => b !== def.name);
      } else {
        const active = await selectActiveBranches(execGit, wt.path, {
          defaultRef: def.ref,
          defaultName: def.name,
          email: wt.email,
          worktreeBranches,
          mergedPrBranches
        });
        if (!active.ok) return active;
        shown = active.value;
      }

      // Repo-level refs (default spine + shown branches) — no per-worktree HEAD,
      // so the result is worktree-independent and cacheable.
      const refs = [...new Set([def.ref, ...shown])];
      const commits = await readLogRefs(execGit, wt.path, refs, req.limit ?? 300);
      if (!commits.ok) return commits;
      const tips = await branchTips(execGit, wt.path);
      if (!tips.ok) return tips;

      cached = {
        commits: commits.value,
        tips: tips.value,
        defaultBranch: def.name,
        shownBranches: shown,
        hiddenBranches: Math.max(0, totalOther - shown.length),
        at: Date.now()
      };
      laneCache.set(key, cached);
    }
    if (cached === undefined) {
      return err({ kind: "repo", code: "graph_failed", message: "graph unavailable" });
    }

    // HEAD is per-worktree — always resolve it (one cheap call).
    const headSha = await execGit(["rev-parse", "HEAD"], wt.path);
    const head =
      headSha.ok && headSha.value.exitCode === 0
        ? headSha.value.stdout.trim()
        : "";

    return ok({
      commits: cached.commits,
      tips: cached.tips,
      head,
      defaultBranch: cached.defaultBranch,
      shownBranches: cached.shownBranches,
      hiddenBranches: cached.hiddenBranches
    });
  });
}
