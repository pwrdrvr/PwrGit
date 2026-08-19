import {
  parseForgeRemote,
  type ForgeHost,
  type ProfileId,
  type Repo,
  type RepoIdentity
} from "@pwrgit/shared";
import type { DB } from "../persistence/db";
import type { GitExec } from "../git/dugite";
import { mapLimit } from "../util/map-limit";
import { logMain } from "../logs";
import type { ForgeRegistry } from "./provider";

/** How long a stored identity is trusted before a background refresh. A repo's
 *  visibility and fork status change rarely and never silently break anything
 *  when stale by an hour — the cost of asking is a network round trip per
 *  repository, so this is deliberately long. */
const IDENTITY_TTL_MS = 6 * 60 * 60_000;
const REMOTE_CONCURRENCY = 8;
const FORGE_CONCURRENCY = 4;
/** Ceiling on one refresh pass, so a pathologically large profile cannot spend
 *  minutes of CLI calls on a single launch. Concurrency is already bounded by
 *  FORGE_CONCURRENCY, so this bounds total work, not parallel load — set high
 *  enough that an ordinary profile finishes in one pass rather than converging
 *  over several launches. Truncation is logged, never silent. */
const REFRESH_BATCH = 200;

export type IdentityChange = { repoId: string; identity: RepoIdentity };

type OriginRef = {
  repoId: string;
  host: ForgeHost;
  hostname: string;
  nameWithOwner: string;
};

/** Read `origin` for one repository. `origin` specifically, not the first
 *  forge remote found: a fork checkout has `origin` (the fork) and `upstream`
 *  (the original), and the identity marks describe what you push to. */
export async function readOrigin(
  git: GitExec,
  repo: Repo
): Promise<OriginRef | null> {
  const result = await git(["remote", "get-url", "origin"], repo.path);
  if (!result.ok || result.value.exitCode !== 0) return null;
  const parsed = parseForgeRemote(result.value.stdout.trim());
  if (parsed === null) return null;
  return {
    repoId: repo.id,
    host: parsed.host,
    hostname: parsed.hostname,
    nameWithOwner: parsed.nameWithOwner
  };
}

export class IdentityService {
  constructor(
    private readonly db: DB,
    private readonly git: GitExec,
    private readonly forges: ForgeRegistry
  ) {}

  /** Identities already stored, for the repositories given. */
  read(repoIds: string[]): Map<string, RepoIdentity> {
    if (repoIds.length === 0) return new Map();
    const placeholders = repoIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT repo_id, host, hostname, owner, name, visibility,
                parent_slug, parent_url, root_slug, root_url, fetched_at
         FROM repo_identity WHERE repo_id IN (${placeholders})`
      )
      .all(...repoIds) as {
      repo_id: string;
      host: string;
      hostname: string;
      owner: string;
      name: string;
      visibility: string;
      parent_slug: string | null;
      parent_url: string | null;
      root_slug: string | null;
      root_url: string | null;
      fetched_at: string;
    }[];
    return new Map(
      rows.map((row) => [
        row.repo_id,
        {
          host: (row.host === "github" || row.host === "gitlab"
            ? row.host
            : "other") as ForgeHost,
          hostname: row.hostname,
          owner: row.owner,
          name: row.name,
          nameWithOwner: `${row.owner}/${row.name}`,
          visibility:
            row.visibility === "public" ||
            row.visibility === "private" ||
            row.visibility === "internal"
              ? row.visibility
              : "unknown",
          ...(row.parent_slug === null
            ? {}
            : {
                parent: {
                  nameWithOwner: row.parent_slug,
                  url: row.parent_url ?? ""
                }
              }),
          ...(row.root_slug === null
            ? {}
            : {
                root: { nameWithOwner: row.root_slug, url: row.root_url ?? "" }
              }),
          fetchedAt: row.fetched_at
        } satisfies RepoIdentity
      ])
    );
  }

  /**
   * Re-read identities for a profile's repositories and return only the ones
   * that actually changed, so the renderer can patch rows in place rather than
   * reloading the whole tree (the same shape `pr:changed` uses).
   *
   * Best-effort throughout: a repo with no `origin`, an `origin` on a host
   * with no provider, or a CLI that is not signed in simply yields no change.
   * Nothing here is allowed to fail a profile load.
   */
  async refresh(
    repos: Repo[],
    options: { force?: boolean } = {}
  ): Promise<IdentityChange[]> {
    const stored = this.read(repos.map((repo) => repo.id));
    const due = repos.filter((repo) => {
      if (options.force === true) return true;
      const existing = stored.get(repo.id);
      if (existing?.fetchedAt === undefined) return true;
      const age = Date.now() - Date.parse(`${existing.fetchedAt}Z`);
      return !Number.isFinite(age) || age > IDENTITY_TTL_MS;
    });
    if (due.length === 0) return [];

    const batch = due.slice(0, REFRESH_BATCH);
    if (due.length > batch.length) {
      logMain(
        "info",
        "forge",
        `identity refresh covering ${batch.length} of ${due.length} repositories this pass`
      );
    }
    const origins: OriginRef[] = [];
    await mapLimit(batch, REMOTE_CONCURRENCY, async (repo) => {
      const origin = await readOrigin(this.git, repo);
      // `other` hosts have no provider to ask, and recording an unknown row
      // for them would suppress the retry if a provider is added later.
      if (origin !== null && origin.host !== "other") origins.push(origin);
    });

    const changes: IdentityChange[] = [];
    await mapLimit(origins, FORGE_CONCURRENCY, async (origin) => {
      const provider = this.forges.get(origin.host);
      if (provider === null) return;
      let identity: RepoIdentity;
      try {
        const repository = await provider.viewRepo(origin.nameWithOwner);
        identity = {
          host: repository.host,
          hostname: repository.hostname,
          owner: repository.owner,
          name: repository.name,
          nameWithOwner: repository.nameWithOwner,
          visibility: repository.visibility,
          ...(repository.parent === undefined
            ? {}
            : { parent: repository.parent }),
          ...(repository.root === undefined ? {} : { root: repository.root })
        };
      } catch (cause) {
        // A forge that will not answer is recorded as `unknown` rather than
        // left absent: absent means "not looked up", and re-asking a private
        // repo we have no access to on every pass is pure noise.
        if (!provider.isAuthError(cause)) {
          logMain(
            "debug",
            "forge",
            `identity lookup failed for ${origin.nameWithOwner}:`,
            provider.errorMessage(cause)
          );
          identity = {
            host: origin.host,
            hostname: origin.hostname,
            owner: origin.nameWithOwner.slice(
              0,
              origin.nameWithOwner.lastIndexOf("/")
            ),
            name: origin.nameWithOwner.slice(
              origin.nameWithOwner.lastIndexOf("/") + 1
            ),
            nameWithOwner: origin.nameWithOwner,
            visibility: "unknown"
          };
        } else {
          // Not signed in is a transient, fixable state — leave the row alone
          // so signing in produces a fresh read rather than a cached "unknown".
          return;
        }
      }
      const previous = stored.get(origin.repoId);
      this.write(origin.repoId, identity);
      if (!sameIdentity(previous, identity)) {
        changes.push({ repoId: origin.repoId, identity });
      }
    });
    return changes;
  }

  /** Drop stored identities for repositories that no longer exist. The FK
   *  cascade covers deletes through `repos`; this covers a direct call. */
  forget(repoId: string): void {
    this.db.prepare("DELETE FROM repo_identity WHERE repo_id = ?").run(repoId);
  }

  private write(repoId: string, identity: RepoIdentity): void {
    this.db
      .prepare(
        `INSERT INTO repo_identity (repo_id, host, hostname, owner, name,
           visibility, parent_slug, parent_url, root_slug, root_url, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(repo_id) DO UPDATE SET
           host = excluded.host,
           hostname = excluded.hostname,
           owner = excluded.owner,
           name = excluded.name,
           visibility = excluded.visibility,
           parent_slug = excluded.parent_slug,
           parent_url = excluded.parent_url,
           root_slug = excluded.root_slug,
           root_url = excluded.root_url,
           fetched_at = datetime('now')`
      )
      .run(
        repoId,
        identity.host,
        identity.hostname,
        identity.owner,
        identity.name,
        identity.visibility,
        identity.parent?.nameWithOwner ?? null,
        identity.parent?.url ?? null,
        identity.root?.nameWithOwner ?? null,
        identity.root?.url ?? null
      );
  }
}

/** `fetchedAt` is deliberately excluded — a refresh that confirms the same
 *  facts is not a change the renderer needs to repaint for. */
export function sameIdentity(
  a: RepoIdentity | undefined,
  b: RepoIdentity
): boolean {
  return (
    a !== undefined &&
    a.host === b.host &&
    a.hostname === b.hostname &&
    a.nameWithOwner === b.nameWithOwner &&
    a.visibility === b.visibility &&
    a.parent?.nameWithOwner === b.parent?.nameWithOwner &&
    a.root?.nameWithOwner === b.root?.nameWithOwner
  );
}

export type { ProfileId };
