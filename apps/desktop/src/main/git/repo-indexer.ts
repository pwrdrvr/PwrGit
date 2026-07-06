import { createHash } from "node:crypto";
import { type Dirent, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  err,
  ok,
  type Profile,
  type ProfileId,
  type Repo,
  type RepoSearchHit,
  type Result,
  type Worktree
} from "@pwrgit/shared";
import type { DB } from "../persistence/db";
import { mapLimit } from "../util/map-limit";
import type { GitExec } from "./dugite";
import { listWorktrees } from "./git-service";

const MAX_SCAN_DEPTH = 5;
const GIT_CONCURRENCY = 12;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  "target",
  "vendor",
  ".cache",
  "Library"
]);

function hashId(path: string): string {
  return createHash("sha1").update(path).digest("hex").slice(0, 12);
}

type RepoRow = {
  id: string;
  profile_id: string;
  name: string;
  path: string;
  pinned: number;
};
type WorktreeRow = {
  id: string;
  repo_id: string;
  branch: string;
  path: string;
  is_primary: number;
  pinned: number;
  dirty: number | null;
  ahead: number | null;
  behind: number | null;
  behind_default: number | null;
  merged_into_default: number | null;
  is_default_branch: number | null;
  last_activity_at: string | null;
};

/**
 * Discovers git repositories under a profile's root folders and persists a
 * repo/worktree index the sidebar reads. Read-only with respect to git.
 * The GitExec is injected so the scan logic is testable against system git.
 */
export class RepoIndexer {
  constructor(
    private readonly db: DB,
    private readonly git: GitExec
  ) {}

  /** Rescan a profile's roots; upsert discovered repos, prune vanished ones. */
  async rescanProfile(profile: Profile): Promise<Repo[]> {
    const found = new Set<string>();
    for (const root of profile.roots) {
      for (const dir of findRepoDirs(root)) found.add(dir);
    }

    // Resolve each found dir to its canonical (primary worktree) path via git,
    // deduping repos reachable from more than one worktree dir.
    const canonical = new Map<string, { path: string; worktrees: Worktree[] }>();
    await mapLimit([...found], GIT_CONCURRENCY, async (dir) => {
      const listed = await listWorktrees(this.git, dir);
      if (!listed.ok || listed.value.length === 0) return;
      const primary = listed.value[0];
      if (primary === undefined || primary.bare) return;
      if (canonical.has(primary.path)) return;
      canonical.set(primary.path, {
        path: primary.path,
        worktrees: listed.value
          .filter((w) => !w.bare)
          .map((w, i) =>
            worktreeShape(w.path, w.branch, i === 0)
          )
      });
    });

    const seenRepoIds: string[] = [];
    const upsertRepo = this.db.transaction(() => {
      for (const { path, worktrees } of canonical.values()) {
        const repoId = this.upsertRepoRow(profile.id, basename(path), path, "scan");
        seenRepoIds.push(repoId);
        this.syncWorktrees(repoId, worktrees);
      }
      this.pruneScannedRepos(profile.id, seenRepoIds);
    });
    upsertRepo();

    return this.listRepos(profile.id);
  }

  /** Index a single repo path (manual add) under the given profile. */
  async indexRepoAt(
    profileId: ProfileId,
    path: string
  ): Promise<Result<Repo>> {
    const listed = await listWorktrees(this.git, path);
    if (!listed.ok) return listed;
    const primary = listed.value[0];
    if (primary === undefined || primary.bare) {
      return err({
        kind: "repo",
        code: "not_a_repo",
        message: `No git worktree found at ${path}`
      });
    }
    const worktrees = listed.value
      .filter((w) => !w.bare)
      .map((w, i) => worktreeShape(w.path, w.branch, i === 0));

    const repoId = hashId(primary.path);
    const run = this.db.transaction(() => {
      this.upsertRepoRow(profileId, basename(primary.path), primary.path, "manual");
      this.syncWorktrees(repoId, worktrees);
    });
    run();

    const repo = this.getRepo(repoId);
    return repo === null
      ? err({ kind: "repo", code: "insert_failed", message: "repo did not persist" })
      : ok(repo);
  }

  listRepos(profileId: ProfileId): Repo[] {
    const repoRows = this.db
      .prepare(
        "SELECT id, profile_id, name, path, pinned FROM repos WHERE profile_id = ? ORDER BY pinned DESC, sort_order, name"
      )
      .all(profileId) as RepoRow[];
    return repoRows.map((r) => this.repoFromRow(r));
  }

  getRepo(repoId: string): Repo | null {
    const row = this.db
      .prepare("SELECT id, profile_id, name, path, pinned FROM repos WHERE id = ?")
      .get(repoId) as RepoRow | undefined;
    return row === undefined ? null : this.repoFromRow(row);
  }

  setRepoPinned(repoId: string, pinned: boolean): void {
    this.db
      .prepare("UPDATE repos SET pinned = ? WHERE id = ?")
      .run(pinned ? 1 : 0, repoId);
  }

  setWorktreePinned(worktreeId: string, pinned: boolean): void {
    this.db
      .prepare("UPDATE worktrees SET pinned = ? WHERE id = ?")
      .run(pinned ? 1 : 0, worktreeId);
  }

  searchAll(query: string): RepoSearchHit[] {
    const like = `%${query.trim().toLowerCase()}%`;
    const rows = this.db
      .prepare(
        `SELECT r.id, r.name, r.path, r.profile_id, p.name AS profile_name,
                (SELECT COUNT(*) FROM worktrees w WHERE w.repo_id = r.id) AS wt_count
         FROM repos r JOIN profiles p ON p.id = r.profile_id
         WHERE lower(r.name) LIKE ? OR lower(r.path) LIKE ?
         ORDER BY r.name LIMIT 50`
      )
      .all(like, like) as {
      id: string;
      name: string;
      path: string;
      profile_id: string;
      profile_name: string;
      wt_count: number;
    }[];

    return rows.map((r) => ({
      repoId: r.id,
      name: r.name,
      path: r.path,
      profileId: r.profile_id,
      profileName: r.profile_name,
      worktreeCount: r.wt_count
    }));
  }

  private repoFromRow(r: RepoRow): Repo {
    const worktrees = (
      this.db
        .prepare(
          `SELECT w.id, w.repo_id, w.branch, w.path, w.is_primary, w.pinned,
                  s.dirty AS dirty, s.ahead AS ahead, s.behind AS behind,
                  s.behind_default AS behind_default,
                  s.merged_into_default AS merged_into_default,
                  s.is_default_branch AS is_default_branch,
                  s.last_activity_at AS last_activity_at
           FROM worktrees w
           LEFT JOIN worktree_state s ON s.worktree_id = w.id
           WHERE w.repo_id = ?
           ORDER BY w.is_primary DESC, w.branch`
        )
        .all(r.id) as WorktreeRow[]
    ).map((w): Worktree => {
      const wt: Worktree = {
        id: w.id,
        repoId: w.repo_id,
        branch: w.branch,
        path: w.path,
        dirty: w.dirty ?? 0,
        ahead: w.ahead ?? 0,
        behind: w.behind ?? 0,
        behindDefault: w.behind_default ?? 0,
        mergedIntoDefault: w.merged_into_default === 1,
        isDefaultBranch: w.is_default_branch === 1,
        pinned: w.pinned === 1,
        isPrimary: w.is_primary === 1
      };
      if (w.last_activity_at !== null) wt.lastActivityAt = w.last_activity_at;
      return wt;
    });
    return {
      id: r.id,
      name: r.name,
      path: r.path,
      profileId: r.profile_id,
      pinned: r.pinned === 1,
      worktrees
    };
  }

  private upsertRepoRow(
    profileId: string,
    name: string,
    path: string,
    source: "scan" | "manual"
  ): string {
    const id = hashId(path);
    this.db
      .prepare(
        `INSERT INTO repos (id, profile_id, name, path, source, last_seen_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           profile_id = excluded.profile_id,
           name = excluded.name,
           source = excluded.source,
           last_seen_at = datetime('now')`
      )
      .run(id, profileId, name, path, source);
    return id;
  }

  private syncWorktrees(repoId: string, worktrees: Worktree[]): void {
    const seen: string[] = [];
    const stmt = this.db.prepare(
      `INSERT INTO worktrees (id, repo_id, branch, path, is_primary, last_seen_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         branch = excluded.branch,
         is_primary = excluded.is_primary,
         last_seen_at = datetime('now')`
    );
    for (const w of worktrees) {
      const id = hashId(w.path);
      seen.push(id);
      stmt.run(id, repoId, w.branch, w.path, w.isPrimary ? 1 : 0);
    }
    if (seen.length === 0) {
      this.db.prepare("DELETE FROM worktrees WHERE repo_id = ?").run(repoId);
      return;
    }
    const placeholders = seen.map(() => "?").join(",");
    this.db
      .prepare(
        `DELETE FROM worktrees WHERE repo_id = ? AND id NOT IN (${placeholders})`
      )
      .run(repoId, ...seen);
  }

  private pruneScannedRepos(profileId: string, keepIds: string[]): void {
    if (keepIds.length === 0) {
      this.db
        .prepare("DELETE FROM repos WHERE profile_id = ? AND source = 'scan'")
        .run(profileId);
      return;
    }
    const placeholders = keepIds.map(() => "?").join(",");
    this.db
      .prepare(
        `DELETE FROM repos WHERE profile_id = ? AND source = 'scan' AND id NOT IN (${placeholders})`
      )
      .run(profileId, ...keepIds);
  }
}

function worktreeShape(path: string, branch: string, isPrimary: boolean): Worktree {
  return {
    id: hashId(path),
    repoId: "",
    branch,
    path,
    dirty: 0,
    ahead: 0,
    behind: 0,
    behindDefault: 0,
    mergedIntoDefault: false,
    isDefaultBranch: false,
    pinned: false,
    isPrimary
  };
}

/** Depth-bounded scan for directories containing a `.git` entry. */
export function findRepoDirs(
  root: string,
  maxDepth: number = MAX_SCAN_DEPTH
): string[] {
  const results: string[] = [];

  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // A `.git` entry (dir or file) marks a repo/worktree — record it and do
    // not descend further into it.
    if (entries.some((e) => e.name === ".git")) {
      results.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };

  walk(root, 0);
  return results;
}
