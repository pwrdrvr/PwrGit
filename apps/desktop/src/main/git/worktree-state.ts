import type { WorktreeState } from "@pwrgit/shared";
import type { DB } from "../persistence/db";
import { mapLimit } from "../util/map-limit";
import { NO_OPTIONAL_LOCKS, requireExit0, type GitExec } from "./dugite";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

export type ParsedStatus = {
  head: string;
  branch: string;
  hasUpstream: boolean;
  ahead: number;
  behind: number;
  dirty: number;
};

/**
 * Parse `git status --porcelain=v2 --branch`. Header lines start with `#`;
 * every non-header line is a changed/renamed/unmerged/untracked entry.
 */
export function parseStatus(stdout: string): ParsedStatus {
  let head = "";
  let branch = "";
  let hasUpstream = false;
  let ahead = 0;
  let behind = 0;
  let dirty = 0;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("# branch.oid ")) head = line.slice(13).trim();
    else if (line.startsWith("# branch.head ")) branch = line.slice(14).trim();
    else if (line.startsWith("# branch.upstream ")) hasUpstream = true;
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(-?\d+)\s+-(-?\d+)/.exec(line);
      if (m !== null) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.length > 0 && !line.startsWith("#")) {
      dirty += 1;
    }
  }

  return { head, branch, hasUpstream, ahead, behind, dirty };
}

type WorktreeRow = {
  id: string;
  branch: string;
  path: string;
  repo_id: string;
  repo_path: string;
};
type StateRow = {
  worktree_id: string;
  branch: string;
  head: string;
  has_upstream: number;
  ahead: number;
  behind: number;
  dirty: number;
  behind_default: number;
  default_branch: string;
  merged_into_default: number;
  diverged_from_default: number;
  is_default_branch: number;
  last_activity_at: string | null;
  updated_at: string;
};

function rowToState(r: StateRow): WorktreeState {
  const s: WorktreeState = {
    worktreeId: r.worktree_id,
    branch: r.branch,
    head: r.head,
    hasUpstream: r.has_upstream === 1,
    ahead: r.ahead,
    behind: r.behind,
    dirty: r.dirty,
    behindDefault: r.behind_default,
    defaultBranch: r.default_branch,
    mergedIntoDefault: r.merged_into_default === 1,
    divergedFromDefault: r.diverged_from_default === 1,
    isDefaultBranch: r.is_default_branch === 1,
    updatedAt: r.updated_at
  };
  if (r.last_activity_at !== null) s.lastActivityAt = r.last_activity_at;
  return s;
}

/**
 * Computes and caches per-worktree state. `getState` never blocks on git; it
 * returns the cached snapshot and the caller schedules a background refresh.
 * GitExec is injected (tests drive it against system git).
 */
export class WorktreeStateService {
  /** Per-repo default branch (ref + name), resolved once per process. */
  private readonly defaultBranch = new Map<
    string,
    { ref: string; name: string }
  >();

  /** Probes currently running git for a worktree (removal drains these). */
  private readonly inFlight = new Map<string, Set<Promise<unknown>>>();

  /** Worktrees whose removal is underway; counted so overlapping batches nest. */
  private readonly removalLocks = new Map<string, number>();

  constructor(
    private readonly db: DB,
    private readonly git: GitExec,
    private readonly operations = new WorktreeOperationQueue()
  ) {}

  getCached(worktreeId: string): WorktreeState | null {
    const row = this.db
      .prepare("SELECT * FROM worktree_state WHERE worktree_id = ?")
      .get(worktreeId) as StateRow | undefined;
    return row === undefined ? null : rowToState(row);
  }

  private worktreeRow(worktreeId: string): WorktreeRow | null {
    const row = this.db
      .prepare(
        `SELECT w.id, w.branch, w.path, w.repo_id, r.path AS repo_path
         FROM worktrees w JOIN repos r ON r.id = w.repo_id
         WHERE w.id = ?`
      )
      .get(worktreeId) as WorktreeRow | undefined;
    return row ?? null;
  }

  /**
   * Resolve a repo's default branch: prefer the remote default
   * (`origin/HEAD` → `origin/<name>`), fall back to a local `main`/`master`.
   * Cached per repo for the process lifetime.
   */
  async resolveDefaultBranch(
    repoId: string,
    repoPath: string
  ): Promise<{ ref: string; name: string }> {
    const cached = this.defaultBranch.get(repoId);
    if (cached !== undefined) return cached;

    let resolved: { ref: string; name: string } = { ref: "main", name: "main" };
    const sym = await this.git(
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      repoPath
    );
    if (sym.ok && sym.value.exitCode === 0) {
      const name = sym.value.stdout.trim().replace("refs/remotes/origin/", "");
      if (name !== "") resolved = { ref: `origin/${name}`, name };
    } else {
      for (const cand of ["main", "master"]) {
        const v = await this.git(
          ["rev-parse", "--verify", "--quiet", cand],
          repoPath
        );
        if (v.ok && v.value.exitCode === 0) {
          resolved = { ref: cand, name: cand };
          break;
        }
      }
    }
    this.defaultBranch.set(repoId, resolved);
    return resolved;
  }

  /**
   * Run git and cache a fresh snapshot for one worktree. While the worktree is
   * locked for removal the probe is dropped (cached state is returned, no git
   * spawns): on Windows a directory that is any process's cwd cannot be
   * deleted, so a probe racing the removal would make the delete fail.
   */
  async compute(worktreeId: string): Promise<WorktreeState | null> {
    if (this.removalLocks.has(worktreeId)) return this.getCached(worktreeId);

    const run = this.operations.run(worktreeId, () =>
      this.computeFresh(worktreeId)
    );
    let running = this.inFlight.get(worktreeId);
    if (running === undefined) {
      running = new Set();
      this.inFlight.set(worktreeId, running);
    }
    running.add(run);
    try {
      return await run;
    } finally {
      running.delete(run);
      if (running.size === 0) this.inFlight.delete(worktreeId);
    }
  }

  /**
   * Lock a worktree for removal: from now until the returned release fn runs,
   * compute() is a no-op for it. Resolves once every already-running probe has
   * finished, i.e. once no git process has its cwd inside the worktree.
   */
  async lockForRemoval(worktreeId: string): Promise<() => void> {
    this.removalLocks.set(
      worktreeId,
      (this.removalLocks.get(worktreeId) ?? 0) + 1
    );
    const running = this.inFlight.get(worktreeId);
    if (running !== undefined) await Promise.allSettled([...running]);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.removalLocks.get(worktreeId) ?? 0;
      if (count <= 1) this.removalLocks.delete(worktreeId);
      else this.removalLocks.set(worktreeId, count - 1);
    };
  }

  private async computeFresh(
    worktreeId: string
  ): Promise<WorktreeState | null> {
    const wt = this.worktreeRow(worktreeId);
    if (wt === null) return null;

    const statusRaw = await this.git(
      ["status", "--porcelain=v2", "--branch"],
      wt.path,
      NO_OPTIONAL_LOCKS
    );
    if (!statusRaw.ok) return this.getCached(worktreeId);
    const status = requireExit0(statusRaw.value, ["status"]);
    if (!status.ok) return this.getCached(worktreeId);
    const parsed = parseStatus(status.value.stdout);

    let lastActivityAt: string | undefined;
    const logRaw = await this.git(["log", "-1", "--format=%cI"], wt.path);
    if (logRaw.ok && logRaw.value.exitCode === 0) {
      const iso = logRaw.value.stdout.trim();
      if (iso !== "") lastActivityAt = iso;
    }

    // Agents and terminal git switch branches without going through PwrGit,
    // and only a full rescan rewrites the worktrees.branch column the sidebar
    // and header labels read — so every state refresh (poll, focus, activate)
    // reconciles that column with the live checkout. Detached HEADs get the
    // same label the indexer writes.
    const liveBranch =
      parsed.branch === "(detached)"
        ? `detached@${parsed.head.slice(0, 7)}`
        : parsed.branch;
    if (liveBranch !== "" && liveBranch !== wt.branch) {
      this.db
        .prepare("UPDATE worktrees SET branch = ? WHERE id = ?")
        .run(liveBranch, worktreeId);
    }

    // Staleness vs the repo's default branch.
    const branchName = liveBranch !== "" ? liveBranch : wt.branch;
    const def = await this.resolveDefaultBranch(wt.repo_id, wt.repo_path);
    const isDefaultBranch = branchName === def.name;
    let behindDefault = 0;
    let mergedIntoDefault = false;
    let divergedFromDefault = false;
    if (!isDefaultBranch) {
      // With no common ancestor (rewritten/orphaned history), `HEAD..default`
      // counts the *entire* default branch — a misleading "behind" number. Flag
      // it as diverged instead of reporting the inflated count.
      const mergeBase = await this.git(["merge-base", "HEAD", def.ref], wt.path);
      const hasMergeBase = mergeBase.ok && mergeBase.value.exitCode === 0;
      if (!hasMergeBase) {
        divergedFromDefault = true;
      } else {
        const bd = await this.git(
          ["rev-list", "--count", `HEAD..${def.ref}`],
          wt.path
        );
        if (bd.ok && bd.value.exitCode === 0) {
          behindDefault = Number(bd.value.stdout.trim()) || 0;
        }
        const anc = await this.git(
          ["merge-base", "--is-ancestor", "HEAD", def.ref],
          wt.path
        );
        mergedIntoDefault = anc.ok && anc.value.exitCode === 0;
      }
    }

    const state: WorktreeState = {
      worktreeId,
      branch: branchName,
      head: parsed.head,
      hasUpstream: parsed.hasUpstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      dirty: parsed.dirty,
      behindDefault,
      defaultBranch: def.name,
      mergedIntoDefault,
      divergedFromDefault,
      isDefaultBranch,
      updatedAt: new Date().toISOString()
    };
    if (lastActivityAt !== undefined) state.lastActivityAt = lastActivityAt;

    this.upsert(state);
    return state;
  }

  /** Background refresh for many worktrees, concurrency-bounded. */
  async refreshMany(worktreeIds: string[], concurrency = 8): Promise<void> {
    await mapLimit(worktreeIds, concurrency, async (id) => {
      await this.compute(id);
    });
  }

  private upsert(s: WorktreeState): void {
    this.db
      .prepare(
        `INSERT INTO worktree_state
           (worktree_id, branch, head, has_upstream, ahead, behind, dirty,
            behind_default, default_branch, merged_into_default, diverged_from_default,
            is_default_branch, last_activity_at, updated_at)
         VALUES (@worktree_id, @branch, @head, @has_upstream, @ahead, @behind, @dirty,
                 @behind_default, @default_branch, @merged_into_default, @diverged_from_default,
                 @is_default_branch, @last_activity_at, @updated_at)
         ON CONFLICT(worktree_id) DO UPDATE SET
           branch = excluded.branch, head = excluded.head,
           has_upstream = excluded.has_upstream, ahead = excluded.ahead,
           behind = excluded.behind, dirty = excluded.dirty,
           behind_default = excluded.behind_default,
           default_branch = excluded.default_branch,
           merged_into_default = excluded.merged_into_default,
           diverged_from_default = excluded.diverged_from_default,
           is_default_branch = excluded.is_default_branch,
           last_activity_at = excluded.last_activity_at, updated_at = excluded.updated_at`
      )
      .run({
        worktree_id: s.worktreeId,
        branch: s.branch,
        head: s.head,
        has_upstream: s.hasUpstream ? 1 : 0,
        ahead: s.ahead,
        behind: s.behind,
        dirty: s.dirty,
        behind_default: s.behindDefault,
        default_branch: s.defaultBranch,
        merged_into_default: s.mergedIntoDefault ? 1 : 0,
        diverged_from_default: s.divergedFromDefault ? 1 : 0,
        is_default_branch: s.isDefaultBranch ? 1 : 0,
        last_activity_at: s.lastActivityAt ?? null,
        updated_at: s.updatedAt
      });
  }
}
