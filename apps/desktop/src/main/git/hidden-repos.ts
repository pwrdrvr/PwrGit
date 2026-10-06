import { existsSync } from "node:fs";
import type { HiddenRepo, ProfileId, RepoId } from "@pwrgit/shared";
import type { DB } from "../persistence/db";

/**
 * SQL that is true when the repository aliased `alias` is NOT hidden in its
 * own profile. Every query that hands a profile's repositories to someone —
 * the sidebar, bulk sync, maintenance, the pruner, ⌘K, the agent catalog —
 * puts this in its WHERE clause rather than filtering the answer afterwards:
 * several of them are capped, and a filtered cap does not give the slots back
 * (src/main/AGENTS.md). The lookup is the table's primary key.
 */
export function visibleRepoSql(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM hidden_repos h
    WHERE h.profile_id = ${alias}.profile_id AND h.path = ${alias}.path)`;
}

/**
 * The repository a ⌘K search row belongs to, as SQL over `search_fts_index`'s
 * columns. Each branch is a primary-key lookup, and it only runs for rows the
 * MATCH already selected. A change request's `entity_id` is its
 * `repo_open_pr` row id (0039), not `repo:number`.
 */
export const SEARCH_ROW_REPO_SQL = `CASE kind
  WHEN 'repo' THEN entity_id
  WHEN 'worktree' THEN (SELECT repo_id FROM worktrees WHERE id = entity_id)
  WHEN 'local_branch' THEN (SELECT repo_id FROM local_branches WHERE id = entity_id)
  WHEN 'remote_branch' THEN (SELECT repo_id FROM remote_branches WHERE id = entity_id)
  WHEN 'change_request' THEN (SELECT repo_id FROM repo_open_pr WHERE id = CAST(entity_id AS INTEGER))
END`;

type HiddenRow = {
  profile_id: string;
  profile_name: string;
  path: string;
  name: string;
  hidden_at_ms: number;
  repo_id: string | null;
  wt_count: number;
};

/** The per-profile hide list (0041_hidden_repos.sql). */
export class HiddenRepoStore {
  constructor(
    private readonly db: DB,
    private readonly now: () => number = Date.now,
    private readonly pathExists: (path: string) => boolean = existsSync
  ) {}

  /** Hide the repository by its path. Re-hiding keeps the first timestamp. */
  hide(profileId: ProfileId, repoId: RepoId): HiddenRepo | null {
    const repo = this.db
      .prepare("SELECT path, name FROM repos WHERE id = ? AND profile_id = ?")
      .get(repoId, profileId) as { path: string; name: string } | undefined;
    if (repo === undefined) return null;
    this.db
      .prepare(
        `INSERT INTO hidden_repos (profile_id, path, name, hidden_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (profile_id, path) DO UPDATE SET name = excluded.name`
      )
      .run(profileId, repo.path, repo.name, this.now());
    return this.list(profileId).find((h) => h.path === repo.path) ?? null;
  }

  unhide(profileId: ProfileId, path: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM hidden_repos WHERE profile_id = ? AND path = ?")
        .run(profileId, path).changes > 0
    );
  }

  /** One profile's entries, or every profile's when `profileId` is null. */
  list(profileId: ProfileId | null): HiddenRepo[] {
    const rows = this.db
      .prepare(
        `SELECT h.profile_id, p.name AS profile_name, h.path, h.name, h.hidden_at_ms,
                r.id AS repo_id,
                (SELECT COUNT(*) FROM worktrees w WHERE w.repo_id = r.id) AS wt_count
         FROM hidden_repos h
         JOIN profiles p ON p.id = h.profile_id
         LEFT JOIN repos r ON r.profile_id = h.profile_id AND r.path = h.path
         WHERE ? IS NULL OR h.profile_id = ?
         ORDER BY p.name COLLATE NOCASE, h.name COLLATE NOCASE, h.path`
      )
      .all(profileId, profileId) as HiddenRow[];
    return rows.map((row) => ({
      profileId: row.profile_id,
      profileName: row.profile_name,
      path: row.path,
      name: row.name,
      hiddenAt: new Date(row.hidden_at_ms).toISOString(),
      repoId: row.repo_id,
      worktreeCount: row.wt_count,
      // An indexed row means the last scan found it; only an entry the scan
      // has dropped is worth a stat, and only to tell "not found" apart from
      // "not scanned yet".
      missing: row.repo_id === null && !this.pathExists(row.path)
    }));
  }

  /** Ids of the indexed repositories hidden in `profileId` (every profile's
   *  when null), for queries that cannot join on the path. */
  hiddenRepoIds(profileId: ProfileId | null): RepoId[] {
    return (
      this.db
        .prepare(
          `SELECT r.id FROM repos r
           JOIN hidden_repos h ON h.profile_id = r.profile_id AND h.path = r.path
           WHERE ? IS NULL OR r.profile_id = ?`
        )
        .all(profileId, profileId) as { id: string }[]
    ).map((row) => row.id);
  }

  isHidden(repoId: RepoId): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM repos r
           JOIN hidden_repos h ON h.profile_id = r.profile_id AND h.path = r.path
           WHERE r.id = ?`
        )
        .get(repoId) !== undefined
    );
  }
}
