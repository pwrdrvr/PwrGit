import type { RemoteForgeIdentity } from "@pwrgit/shared";
import type { DB } from "../persistence/db";

type RemoteIdentityRow = {
  hostname: string;
  name_with_owner: string;
  viewer_can_push: number | null;
  parent_slug: string | null;
  root_slug: string | null;
  fetched_at: string;
};

/** Read all cached non-origin remote forge identities for one repository. */
export function readRemoteIdentities(
  db: DB,
  repoId: string
): RemoteForgeIdentity[] {
  const stmt = db.prepare(
    `SELECT hostname, name_with_owner, viewer_can_push, parent_slug, root_slug, fetched_at
     FROM repo_remote_identity
     WHERE repo_id = ?
     ORDER BY hostname, slug_lower`
  );
  if (typeof stmt?.all !== "function") return [];
  const rows = stmt.all(repoId) as RemoteIdentityRow[];
  return rows.map((row) => ({
    hostname: row.hostname,
    nameWithOwner: row.name_with_owner,
    ...(row.viewer_can_push === null
      ? {}
      : { viewerCanPush: row.viewer_can_push !== 0 }),
    ...(row.parent_slug === null ? {} : { parent: row.parent_slug }),
    ...(row.root_slug === null ? {} : { root: row.root_slug }),
    fetchedAt: row.fetched_at
  }));
}

/** Insert or update one cached sibling remote identity row. */
export function writeRemoteIdentity(
  db: DB,
  repoId: string,
  entry: RemoteForgeIdentity
): void {
  const hostname = entry.hostname.toLowerCase();
  const slugLower = entry.nameWithOwner.toLowerCase();
  db.prepare(
    `INSERT INTO repo_remote_identity (
       repo_id, hostname, slug_lower, name_with_owner,
       viewer_can_push, parent_slug, root_slug, fetched_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(repo_id, hostname, slug_lower) DO UPDATE SET
       name_with_owner = excluded.name_with_owner,
       viewer_can_push = excluded.viewer_can_push,
       parent_slug = excluded.parent_slug,
       root_slug = excluded.root_slug,
       fetched_at = datetime('now')`
  ).run(
    repoId,
    hostname,
    slugLower,
    entry.nameWithOwner,
    entry.viewerCanPush === undefined ? null : entry.viewerCanPush ? 1 : 0,
    entry.parent ?? null,
    entry.root ?? null
  );
}

/** Remove cached remote identity rows no longer backed by any remote in the repo. */
export function pruneRemoteIdentities(
  db: DB,
  repoId: string,
  keepKeys: ReadonlySet<string>
): boolean {
  const existing = db
    .prepare(
      `SELECT hostname, slug_lower FROM repo_remote_identity WHERE repo_id = ?`
    )
    .all(repoId) as { hostname: string; slug_lower: string }[];
  let removed = false;
  const del = db.prepare(
    `DELETE FROM repo_remote_identity
     WHERE repo_id = ? AND hostname = ? AND slug_lower = ?`
  );
  for (const row of existing) {
    if (!keepKeys.has(`${row.hostname}\0${row.slug_lower}`)) {
      del.run(repoId, row.hostname, row.slug_lower);
      removed = true;
    }
  }
  return removed;
}

/** Delete all cached remote identity rows for a repository. */
export function forgetRemoteIdentities(db: DB, repoId: string): void {
  db.prepare("DELETE FROM repo_remote_identity WHERE repo_id = ?").run(repoId);
}

/** Read per-remote fork sync overrides for one repository. */
export function readForkSyncPrefs(
  db: DB,
  repoId: string
): Map<string, boolean> {
  const stmt = db.prepare(
    `SELECT remote, enabled FROM fork_sync_remote_prefs WHERE repo_id = ?`
  );
  if (typeof stmt?.all !== "function") return new Map();
  const rows = stmt.all(repoId) as { remote: string; enabled: number }[];
  return new Map(rows.map((row) => [row.remote, row.enabled !== 0]));
}

/** Persist whether fork sync pushes to `remote` on `repoId`. */
export function setForkSyncRemotePref(
  db: DB,
  repoId: string,
  remote: string,
  enabled: boolean
): void {
  const stmt = db.prepare(
    `INSERT INTO fork_sync_remote_prefs (repo_id, remote, enabled)
     VALUES (?, ?, ?)
     ON CONFLICT(repo_id, remote) DO UPDATE SET enabled = excluded.enabled`
  );
  if (typeof stmt?.run !== "function") return;
  stmt.run(repoId, remote, enabled ? 1 : 0);
}

/** Drop a stored override when a remote is removed or re-pointed to another repo. */
export function forgetForkSyncRemotePref(
  db: DB,
  repoId: string,
  remote: string
): void {
  const stmt = db.prepare(
    `DELETE FROM fork_sync_remote_prefs WHERE repo_id = ? AND remote = ?`
  );
  if (typeof stmt?.run !== "function") return;
  stmt.run(repoId, remote);
}

/** Carry a remote's override across a pure rename (same repository). */
export function renameForkSyncRemotePref(
  db: DB,
  repoId: string,
  fromRemote: string,
  toRemote: string
): void {
  if (fromRemote === toRemote) return;
  const lookup = db.prepare(
    `SELECT enabled FROM fork_sync_remote_prefs WHERE repo_id = ? AND remote = ?`
  );
  if (typeof lookup?.get !== "function" || typeof db.transaction !== "function") {
    return;
  }
  const existing = lookup.get(repoId, fromRemote) as { enabled: number } | undefined;
  if (existing === undefined) return;
  db.transaction(() => {
    db.prepare(
      `DELETE FROM fork_sync_remote_prefs WHERE repo_id = ? AND remote = ?`
    ).run(repoId, fromRemote);
    db.prepare(
      `INSERT INTO fork_sync_remote_prefs (repo_id, remote, enabled)
       VALUES (?, ?, ?)
       ON CONFLICT(repo_id, remote) DO UPDATE SET enabled = excluded.enabled`
    ).run(repoId, toRemote, existing.enabled);
  })();
}
