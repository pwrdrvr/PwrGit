import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { WorktreeState } from "@pwrgit/shared";
import type { DB } from "../persistence/db";
import { mapLimit } from "../util/map-limit";
import { stateChanged } from "./worktree-state";

/** A visible row older than this is re-read while a window is focused. */
export const VISIBLE_STALE_MS = 30_000;
/** With no PwrGit window focused, visible rows wait this much longer. */
export const UNFOCUSED_STALE_FACTOR = 4;
/** At most this many worktrees are re-read per round. */
export const VISIBLE_BATCH = 8;
/** Git processes one round may run at once (each probe runs several). */
const ROUND_CONCURRENCY = 4;
/** One window cannot ask for more than this many rows. */
export const VISIBLE_REPORT_CAP = 400;

type VisibleRow = {
  id: string;
  repo_id: string;
  path: string;
  repo_path: string;
  profile_id: string;
};

export type VisibleRefreshDeps = {
  db: DB;
  state: {
    getCached: (worktreeId: string) => WorktreeState | null;
    compute: (worktreeId: string) => Promise<WorktreeState | null>;
  };
  emit: {
    worktreeChanged: (worktreeId: string) => void;
    graphChanged: (repoId: string) => void;
    repoChanged: (profileId: string) => void;
  };
  isFocused: () => boolean;
  now?: () => number;
  /** Spawn-free change stamp for a repository's refs; see `refsFingerprint`. */
  fingerprint?: (repoPath: string, worktreePaths: readonly string[]) => string;
};

/**
 * Keeps the rows a window is showing current with work done outside PwrGit.
 *
 * Agents fetch, pull and push in these repositories all day, and nothing in
 * the app hears it: the one continuous refresh was the selected worktree. The
 * renderer reports which rows are on screen (`worktree:reportVisible`); this
 * decides what that costs, per the git layer's rule that main owns process
 * counts. A round re-reads at most `VISIBLE_BATCH` worktrees, oldest first,
 * and never overlaps the previous one. A row is due when it is older than
 * `VISIBLE_STALE_MS`, or at once when its repository's refs fingerprint moved
 * (a fetch rewrites `FETCH_HEAD`; a pull or commit moves a `HEAD` reflog) —
 * read with `stat`, so an unchanged repository costs no Git at all between
 * its stale reads.
 *
 * No filesystem watchers: recursive watches pegged fseventd on large trees
 * (see `index.ts`), and this is the same poll-and-fingerprint shape
 * `StashWatch` uses.
 */
export class VisibleWorktreeRefresher {
  private readonly reports = new Map<number, Set<string>>();
  private readonly lastRead = new Map<string, number>();
  private readonly fingerprints = new Map<string, string>();
  private running: Promise<void> | null = null;

  constructor(private readonly deps: VisibleRefreshDeps) {}

  /** Replace one window's visible set. */
  report(webContentsId: number, worktreeIds: readonly string[]): void {
    this.reports.set(
      webContentsId,
      new Set(worktreeIds.slice(0, VISIBLE_REPORT_CAP))
    );
  }

  /** A window closed: stop refreshing what only it was showing. */
  releaseWebContents(webContentsId: number): void {
    this.reports.delete(webContentsId);
  }

  /** Run one round; a round already running is returned, not doubled. */
  tick(): Promise<void> {
    if (this.running !== null) return this.running;
    const round = this.round().finally(() => {
      this.running = null;
    });
    this.running = round;
    return round;
  }

  private visibleIds(): string[] {
    const ids = new Set<string>();
    for (const set of this.reports.values()) {
      for (const id of set) ids.add(id);
    }
    return [...ids];
  }

  private rowsFor(ids: readonly string[]): VisibleRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.deps.db
      .prepare(
        `SELECT w.id, w.repo_id, w.path, r.path AS repo_path,
                r.profile_id AS profile_id
         FROM worktrees w JOIN repos r ON r.id = w.repo_id
         WHERE w.id IN (${placeholders})`
      )
      .all(...ids) as VisibleRow[];
  }

  private async round(): Promise<void> {
    const now = this.deps.now ?? Date.now;
    const rows = this.rowsFor(this.visibleIds());
    if (rows.length === 0) return;

    const byRepo = new Map<string, VisibleRow[]>();
    for (const row of rows) {
      const list = byRepo.get(row.repo_id) ?? [];
      list.push(row);
      byRepo.set(row.repo_id, list);
    }
    const fingerprint = this.deps.fingerprint ?? refsFingerprint;
    const moved = new Set<string>();
    for (const [repoId, list] of byRepo) {
      const first = list[0];
      if (first === undefined) continue;
      const stamp = fingerprint(
        first.repo_path,
        list.map((row) => row.path)
      );
      const previous = this.fingerprints.get(repoId);
      this.fingerprints.set(repoId, stamp);
      if (previous !== undefined && previous !== stamp) moved.add(repoId);
    }

    const staleAfter =
      VISIBLE_STALE_MS * (this.deps.isFocused() ? 1 : UNFOCUSED_STALE_FACTOR);
    const at = now();
    // The newer of this refresher's own read and the stored snapshot: the
    // selected worktree's poll and every header operation re-read too, and a
    // row one of them just refreshed is not due again here.
    const lastOf = (id: string): number => {
      const updated = this.deps.state.getCached(id)?.updatedAt;
      const parsed = updated === undefined ? Number.NaN : Date.parse(updated);
      return Math.max(
        this.lastRead.get(id) ?? 0,
        Number.isNaN(parsed) ? 0 : parsed
      );
    };
    const due = rows
      .filter(
        (row) => moved.has(row.repo_id) || at - lastOf(row.id) >= staleAfter
      )
      // A repository whose refs just moved goes first, then oldest first,
      // so a fleet larger than one batch still converges.
      .sort(
        (a, b) =>
          Number(moved.has(b.repo_id)) - Number(moved.has(a.repo_id)) ||
          lastOf(a.id) - lastOf(b.id)
      )
      .slice(0, VISIBLE_BATCH);
    if (due.length === 0) return;

    const changed: VisibleRow[] = [];
    await mapLimit(due, ROUND_CONCURRENCY, async (row) => {
      const before = this.deps.state.getCached(row.id);
      const fresh = await this.deps.state.compute(row.id);
      this.lastRead.set(row.id, now());
      if (fresh === null) return;
      if (before === null || stateChanged(before, fresh)) changed.push(row);
    });
    if (changed.length === 0) return;

    // One tree reload per profile and one graph invalidation per repository
    // for the whole round: the per-worktree refresher emits all three for each
    // row, which for a batch of eight is eight full sidebar reloads.
    const repos = new Set<string>();
    const profiles = new Set<string>();
    for (const row of changed) {
      this.deps.emit.worktreeChanged(row.id);
      repos.add(row.repo_id);
      profiles.add(row.profile_id);
    }
    for (const repoId of repos) this.deps.emit.graphChanged(repoId);
    for (const profileId of profiles) this.deps.emit.repoChanged(profileId);
  }
}

const gitDirCache = new Map<string, string | null>();

/**
 * The directory Git keeps a checkout's own state in: `<path>/.git` for a
 * primary checkout, or the `gitdir:` a linked worktree's `.git` file names.
 * Read from disk rather than asked of Git, because this runs every few
 * seconds per visible repository and its whole point is to spawn nothing.
 */
export function checkoutGitDir(checkoutPath: string): string | null {
  const cached = gitDirCache.get(checkoutPath);
  if (cached !== undefined) return cached;
  const dotGit = join(checkoutPath, ".git");
  let dir: string | null = null;
  try {
    if (statSync(dotGit).isDirectory()) {
      dir = dotGit;
    } else {
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      const target = match?.[1]?.trim();
      if (target !== undefined && target !== "") {
        dir = isAbsolute(target) ? target : resolve(checkoutPath, target);
      }
    }
  } catch {
    dir = null;
  }
  // A missing checkout is not cached: it may be a volume that is mounted later.
  if (dir !== null) gitDirCache.set(checkoutPath, dir);
  return dir;
}

/** A linked worktree's gitdir names the shared one in its `commondir` file. */
function commonDirOf(gitDir: string): string {
  const pointer = join(gitDir, "commondir");
  if (!existsSync(pointer)) return gitDir;
  try {
    const target = readFileSync(pointer, "utf8").trim();
    return isAbsolute(target) ? target : resolve(gitDir, target);
  } catch {
    return gitDir;
  }
}

function stamp(path: string): string {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "-";
  }
}

/**
 * A change stamp for everything outside work can do to a repository's refs,
 * read with `stat` alone. `FETCH_HEAD` is rewritten by every fetch (even one
 * that brings nothing); `packed-refs` moves on a pack or prune; each
 * checkout's `HEAD`, `logs/HEAD` and `index` move on a pull, commit, checkout
 * or stage. A push that moves only a loose remote-tracking ref is not seen
 * here, and the stale read catches it within `VISIBLE_STALE_MS`.
 */
export function refsFingerprint(
  repoPath: string,
  worktreePaths: readonly string[]
): string {
  const primary = checkoutGitDir(repoPath);
  if (primary === null) return "missing";
  const common = commonDirOf(primary);
  const parts = [
    stamp(join(common, "FETCH_HEAD")),
    stamp(join(common, "packed-refs"))
  ];
  for (const path of worktreePaths) {
    const dir = checkoutGitDir(path);
    if (dir === null) {
      parts.push("missing");
      continue;
    }
    parts.push(
      stamp(join(dir, "HEAD")),
      stamp(join(dir, "logs", "HEAD")),
      stamp(join(dir, "index"))
    );
  }
  return parts.join("|");
}
