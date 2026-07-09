import { type Commit, err, ok } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { DB } from "../persistence/db";
import { execGit } from "./dugite";
import {
  branchTips,
  listLocalBranchNames,
  readLog,
  readLogRefs,
  readUniqueCommits,
  selectActiveBranches,
  selectAllGraphBranches,
  topoMergeCommits
} from "./git-service";
import type { WorktreeStateService } from "./worktree-state";

/** The repo-level part of the lane graph (same for every worktree of a repo);
 *  only the HEAD dot varies per worktree, so this is cached and reused. */
type CachedLanes = {
  commits: Commit[];
  tips: Record<string, string[]>;
  defaultBranch: string;
  /** The resolvable ref for the default branch (e.g. "origin/develop"). */
  defaultRef: string;
  shownBranches: string[];
  matchedBranches: number;
  hiddenBranches: number;
  at: number;
};
const laneCache = new Map<string, CachedLanes>();
const LANE_TTL_MS = 30_000;
/** Trunk window — recent default-branch history drawn as the spine. */
const TRUNK_CAP = 150;
/** Cap on the one-walk union of all branch segments (not-in-trunk commits). */
const UNIQUE_CAP = 500;
/** Most branches drawn as lanes in "active" scope — a machine with hundreds of
 *  active worktree branches must not become a 400-lane curtain. Most recent
 *  first; the toolbar reports "N of M". */
const ACTIVE_DRAW_CAP = 30;

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

      let shown: string[];
      let matchedBranches: number;
      let hiddenBranches = 0;
      if (req.scope === "all") {
        // Everything in flight: unmerged local + remote branches, recency-capped.
        const all = await selectAllGraphBranches(execGit, wt.path, def.ref, def.name);
        if (!all.ok) return all;
        shown = all.value.branches;
        matchedBranches = all.value.total;
      } else {
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
        // Recency-sorted (listLocalBranchNames sorts by committerdate).
        const allLocal = await listLocalBranchNames(execGit, wt.path);
        if (!allLocal.ok) return allLocal;
        const active = await selectActiveBranches(execGit, wt.path, {
          defaultRef: def.ref,
          defaultName: def.name,
          email: wt.email,
          worktreeBranches,
          mergedPrBranches
        });
        if (!active.ok) return active;
        // Draw the most recently committed active branches, capped.
        const activeSet = new Set(active.value);
        shown = allLocal.value
          .filter((b) => activeSet.has(b))
          .slice(0, ACTIVE_DRAW_CAP);
        matchedBranches = active.value.length;
        const totalOther = allLocal.value.filter((b) => b !== def.name).length;
        hiddenBranches = Math.max(0, totalOther - shown.length);
      }

      // Compose the log from segments instead of one flat window: a busy trunk
      // would otherwise flood `git log refs -n N` and silently drop every
      // branch tip older than the trunk's newest N commits. Trunk and branch
      // segments are fetched separately (branch segments in ONE not-in-trunk
      // walk) and topo-merged, so every drawn branch is genuinely present.
      const trunk = await readLogRefs(
        execGit,
        wt.path,
        [def.ref],
        req.limit ?? TRUNK_CAP
      );
      if (!trunk.ok) return trunk;
      const uniques = await readUniqueCommits(
        execGit,
        wt.path,
        def.ref,
        shown,
        UNIQUE_CAP
      );
      if (!uniques.ok) return uniques;
      const tips = await branchTips(execGit, wt.path);
      if (!tips.ok) return tips;

      cached = {
        commits: topoMergeCommits([trunk.value, uniques.value]),
        tips: tips.value,
        defaultBranch: def.name,
        defaultRef: def.ref,
        shownBranches: shown,
        matchedBranches,
        hiddenBranches,
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

    // The worktree may sit on a commit no drawn branch reaches — a detached
    // checkout, or a branch the active filter hid (e.g. merged via PR). The
    // graph must still show "you are here", so widen the log with HEAD itself.
    // Cached per head SHA; repos with few odd worktrees pay this rarely.
    let out = cached;
    if (head !== "" && !cached.commits.some((c) => c.hash === head)) {
      const supKey = `${key}:${head}`;
      const supCached = laneCache.get(supKey);
      if (
        supCached !== undefined &&
        req.force !== true &&
        Date.now() - supCached.at < LANE_TTL_MS
      ) {
        out = supCached;
      } else {
        // HEAD's own line (commits not in the trunk), topo-merged into the
        // cached graph. A HEAD that IS old trunk history has no unique
        // commits — fall back to the lone commit so "you are here" resolves.
        const line = await readUniqueCommits(
          execGit,
          wt.path,
          cached.defaultRef,
          [head],
          80
        );
        if (!line.ok) return line;
        let extra = line.value;
        if (!extra.some((c) => c.hash === head)) {
          const self = await readLogRefs(execGit, wt.path, [head], 1);
          if (self.ok) extra = [...extra, ...self.value];
        }
        out = {
          ...cached,
          commits: topoMergeCommits([cached.commits, extra]),
          at: Date.now()
        };
        laneCache.set(supKey, out);
      }
    }

    return ok({
      commits: out.commits,
      tips: out.tips,
      head,
      defaultBranch: out.defaultBranch,
      shownBranches: out.shownBranches,
      matchedBranches: out.matchedBranches,
      hiddenBranches: out.hiddenBranches
    });
  });
}
