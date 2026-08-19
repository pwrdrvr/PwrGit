import {
  type Commit,
  err,
  type LaneBranchInfo,
  ok,
  type PrSummary
} from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { prSummaryFromRow, prSummarySelect } from "../forge/pr-row";
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
  topoMergeCommits,
  unappliedUpstreams
} from "./git-service";
import type { WorktreeStateService } from "./worktree-state";

/** The repo-level part of the lane graph (same for every worktree of a repo);
 *  only the HEAD dot varies per worktree, so this is cached and reused. */
type CachedLanes = {
  commits: Commit[];
  tips: Record<string, string[]>;
  /** commit hash → remote-tracking refs tipped there (e.g. "origin/main"). */
  remoteTips: Record<string, string[]>;
  branches: Record<string, LaneBranchInfo>;
  defaultBranch: string;
  /** The resolvable ref for the default branch (e.g. "origin/develop"). */
  defaultRef: string;
  /** Tips of each remote's copy of the default branch. */
  defaultRefTips: string[];
  /** Local branch → its upstream, for branches holding unapplied upstream
   *  work. Repo-level, so the per-worktree step can consult it for free. */
  upstreamOf: Record<string, string>;
  shownBranches: string[];
  upstreamRefs: string[];
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
        `SELECT w.path AS path, w.repo_id AS repo_id, w.branch AS branch,
                p.email AS email
         FROM worktrees w
         JOIN repos r ON r.id = w.repo_id
         JOIN profiles p ON p.id = r.profile_id
         WHERE w.id = ?`
      )
      .get(req.worktreeId) as
      | { path: string; repo_id: string; branch: string | null; email: string }
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

      const tips = await branchTips(execGit, wt.path);
      if (!tips.ok) return tips;
      // Every remote's copy of the default branch joins the trunk walk, so a
      // remote-ahead trunk (origin/main, or upstream/main on a fork) is in the
      // window — the graph draws it as the dashed top of the spine, with the
      // remote ref's chip at its tip.
      const remoteDefaultRefs: string[] = [];
      const defaultRefTips = new Set<string>();
      for (const [hash, names] of Object.entries(tips.value.remote)) {
        for (const n of names) {
          if (n.slice(n.indexOf("/") + 1) !== def.name) continue;
          remoteDefaultRefs.push(n);
          defaultRefTips.add(hash);
        }
      }

      // A branch behind its upstream has fetched commits that no local ref
      // reaches. The trunk already gets this through `remoteDefaultRefs`;
      // without the same for every other drawn branch, origin/releases/1.0's
      // commits sit in the object store and are never drawn — the lane reads
      // as current when it is a commit short, and the "↓1" in the sidebar has
      // nothing to point at. Their refs ride in `upstreamRefs` — NOT in
      // `shownBranches`, which the toolbar counts as active branches — and the
      // renderer draws that union, dashing them as fetched-but-unapplied.
      const unapplied = await unappliedUpstreams(execGit, wt.path);
      if (!unapplied.ok) return unapplied;
      // The trunk's own remotes are already walked and drawn as the spine.
      // Re-adding one here would hand the default branch's ref to a feature
      // branch's lane, so any branch TRACKING the trunk — common for branches
      // cut from main and never pushed — contributes nothing extra.
      const trunkRefs = new Set([def.ref, ...remoteDefaultRefs]);
      const upstreamOf: Record<string, string> = {};
      for (const u of unapplied.value) {
        if (u.branch === def.name || trunkRefs.has(u.upstream)) continue;
        upstreamOf[u.branch] = u.upstream;
      }
      const drawn = new Set(shown);
      const upstreamRefs = [
        ...new Set(
          shown
            .map((b) => upstreamOf[b])
            .filter((r): r is string => r !== undefined && !drawn.has(r))
        )
      ];
      const walkRefs = [...shown, ...upstreamRefs];

      // Compose the log from segments instead of one flat window: a busy trunk
      // would otherwise flood `git log refs -n N` and silently drop every
      // branch tip older than the trunk's newest N commits. Trunk and branch
      // segments are fetched separately (branch segments in ONE not-in-trunk
      // walk) and topo-merged, so every drawn branch is genuinely present.
      const trunk = await readLogRefs(
        execGit,
        wt.path,
        [...new Set([def.ref, ...remoteDefaultRefs])],
        req.limit ?? TRUNK_CAP
      );
      if (!trunk.ok) return trunk;
      const uniques = await readUniqueCommits(
        execGit,
        wt.path,
        def.ref,
        walkRefs,
        UNIQUE_CAP
      );
      if (!uniques.ok) return uniques;

      // Per-branch adornments for the tip chips: PR (from branch_pr) and the
      // worktree the branch is checked out in. Repo-level like everything
      // else in this cache.
      const branchInfo: Record<string, LaneBranchInfo> = {};
      const wtRows = db
        .prepare("SELECT id, branch, path FROM worktrees WHERE repo_id = ?")
        .all(wt.repo_id) as { id: string; branch: string; path: string }[];
      for (const row of wtRows) {
        branchInfo[row.branch] = { worktreeId: row.id, worktreePath: row.path };
      }
      const prRows = db
        .prepare(
          `SELECT branch, ${prSummarySelect("branch_pr", "")}
           FROM branch_pr WHERE repo_id = ? AND number IS NOT NULL`
        )
        .all(wt.repo_id) as (Record<string, unknown> & { branch: string })[];
      for (const row of prRows) {
        // Same projection the sidebar uses: a branch chip's card has to carry
        // the same detail as the same PR's chip anywhere else.
        const pr = prSummaryFromRow(row, "");
        if (pr === undefined) continue;
        const entry = (branchInfo[row.branch] ??= {});
        entry.pr = pr;
      }

      cached = {
        commits: topoMergeCommits([trunk.value, uniques.value]),
        tips: tips.value.local,
        remoteTips: tips.value.remote,
        branches: branchInfo,
        defaultBranch: def.name,
        defaultRef: def.ref,
        defaultRefTips: [...defaultRefTips],
        upstreamOf,
        shownBranches: shown,
        upstreamRefs,
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

    // Unlike the lanes themselves, this is specific to the selected
    // worktree. It gives the renderer an authoritative answer to "is this
    // commit beyond the default ref?" without guessing from visual lanes or
    // from a ref chip. In particular, a detached checkout should not lend its
    // label to every shared ancestor in the graph.
    let headOnlyCommits: string[] = [];
    if (head !== "") {
      const headOnly = await readUniqueCommits(
        execGit,
        wt.path,
        cached.defaultRef,
        [head],
        UNIQUE_CAP
      );
      // Context labeling is supplemental. Preserve a usable graph if this
      // extra rev walk cannot run (for example, a transiently unavailable
      // worktree); the card simply omits branch context in that case.
      if (headOnly.ok) headOnlyCommits = headOnly.value.map((commit) => commit.hash);
    }

    // Two things the repo-level walk can miss for THIS worktree:
    //
    //   • HEAD itself — a detached checkout, or a branch the active filter hid
    //     (merged via PR, or past the recency cap). The graph must still show
    //     "you are here".
    //   • the checked-out branch's unapplied upstream work, when that branch
    //     did not make the drawn set. The branch the user is focused on is the
    //     one place we must never skip this: being told "↓1" while the graph
    //     omits the commit is the whole complaint.
    //
    // Cached per head SHA + upstream; repos with few odd worktrees pay rarely.
    const headBranch = wt.branch ?? "";
    const headUpstream =
      headBranch === "" ? undefined : cached.upstreamOf[headBranch];
    // The upstream ref to add, or undefined when the repo-level walk already
    // drew it (or there is nothing unapplied to draw).
    // Checked against both lists: in "all" scope a remote whose local branch is
    // merged is drawn as a branch in its own right, and appending it again
    // would draw the same ref twice.
    const missingUpstream =
      headUpstream !== undefined &&
      !cached.upstreamRefs.includes(headUpstream) &&
      !cached.shownBranches.includes(headUpstream)
        ? headUpstream
        : undefined;
    const missingHead =
      head !== "" && !cached.commits.some((c) => c.hash === head);

    let out = cached;
    if (missingHead || missingUpstream !== undefined) {
      const supKey = `${key}:${head}:${missingUpstream ?? ""}`;
      const supCached = laneCache.get(supKey);
      if (
        supCached !== undefined &&
        req.force !== true &&
        Date.now() - supCached.at < LANE_TTL_MS
      ) {
        out = supCached;
      } else {
        // This worktree's own line (commits not in the trunk), topo-merged
        // into the cached graph. A HEAD that IS old trunk history has no
        // unique commits — fall back to the lone commit so "you are here"
        // resolves.
        const supRefs = [
          ...(missingHead ? [head] : []),
          ...(missingUpstream !== undefined ? [missingUpstream] : [])
        ];
        const line = await readUniqueCommits(
          execGit,
          wt.path,
          cached.defaultRef,
          supRefs,
          80
        );
        if (!line.ok) return line;
        let extra = line.value;
        if (missingHead && !extra.some((c) => c.hash === head)) {
          const self = await readLogRefs(execGit, wt.path, [head], 1);
          if (self.ok) extra = [...extra, ...self.value];
        }
        out = {
          ...cached,
          commits: topoMergeCommits([cached.commits, extra]),
          upstreamRefs:
            missingUpstream !== undefined
              ? [...cached.upstreamRefs, missingUpstream]
              : cached.upstreamRefs,
          at: Date.now()
        };
        laneCache.set(supKey, out);
      }
    }

    return ok({
      commits: out.commits,
      tips: out.tips,
      remoteTips: out.remoteTips,
      branches: out.branches,
      head,
      headOnlyCommits,
      defaultBranch: out.defaultBranch,
      defaultRef: out.defaultRef,
      defaultRefTips: out.defaultRefTips,
      shownBranches: out.shownBranches,
      upstreamRefs: out.upstreamRefs,
      matchedBranches: out.matchedBranches,
      hiddenBranches: out.hiddenBranches
    });
  });
}
