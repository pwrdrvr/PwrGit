import type { WorktreeState } from "@pwrgit/shared";
import type { DB } from "../persistence/db";
import { mapLimit } from "../util/map-limit";
import { requireExit0, type GitExec } from "./dugite";

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

type WorktreeRow = { id: string; branch: string; path: string };
type StateRow = {
  worktree_id: string;
  branch: string;
  head: string;
  has_upstream: number;
  ahead: number;
  behind: number;
  dirty: number;
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
  constructor(
    private readonly db: DB,
    private readonly git: GitExec
  ) {}

  getCached(worktreeId: string): WorktreeState | null {
    const row = this.db
      .prepare("SELECT * FROM worktree_state WHERE worktree_id = ?")
      .get(worktreeId) as StateRow | undefined;
    return row === undefined ? null : rowToState(row);
  }

  private worktreeRow(worktreeId: string): WorktreeRow | null {
    const row = this.db
      .prepare("SELECT id, branch, path FROM worktrees WHERE id = ?")
      .get(worktreeId) as WorktreeRow | undefined;
    return row ?? null;
  }

  /** Run git and cache a fresh snapshot for one worktree. */
  async compute(worktreeId: string): Promise<WorktreeState | null> {
    const wt = this.worktreeRow(worktreeId);
    if (wt === null) return null;

    const statusRaw = await this.git(
      ["status", "--porcelain=v2", "--branch"],
      wt.path
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

    const state: WorktreeState = {
      worktreeId,
      branch: parsed.branch !== "" ? parsed.branch : wt.branch,
      head: parsed.head,
      hasUpstream: parsed.hasUpstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      dirty: parsed.dirty,
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
           (worktree_id, branch, head, has_upstream, ahead, behind, dirty, last_activity_at, updated_at)
         VALUES (@worktree_id, @branch, @head, @has_upstream, @ahead, @behind, @dirty, @last_activity_at, @updated_at)
         ON CONFLICT(worktree_id) DO UPDATE SET
           branch = excluded.branch, head = excluded.head,
           has_upstream = excluded.has_upstream, ahead = excluded.ahead,
           behind = excluded.behind, dirty = excluded.dirty,
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
        last_activity_at: s.lastActivityAt ?? null,
        updated_at: s.updatedAt
      });
  }
}
