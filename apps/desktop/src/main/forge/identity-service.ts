import {
  parseForgeRemote,
  type ForgeHost,
  type ForgeValueSource,
  type Repo,
  type RepoIdentity,
  type RepoIdentityRefreshOutcome
} from "@pwrgit/shared";
import type { DB } from "../persistence/db";
import type { GitExec } from "../git/dugite";
import { logMain } from "../logs";
import type { ForgeRepoRegistry } from "./repo-provider";

/** How long a stored identity is trusted before a background refresh. A repo's
 *  visibility and fork status change rarely and never silently break anything
 *  when stale by an hour — the cost of asking is a network round trip per
 *  repository, so this is deliberately long. */
const IDENTITY_TTL_MS = 6 * 60 * 60_000;
/** Unknown responses and signed-out attempts should recover promptly. */
const IDENTITY_RETRY_MS = 5 * 60_000;
const REMOTE_CONCURRENCY = 8;
const FORGE_CONCURRENCY = 4;
/** Ceiling on one refresh pass, so a pathologically large profile cannot spend
 *  minutes of CLI calls on a single launch. Concurrency is already bounded by
 *  FORGE_CONCURRENCY, so this bounds total work, not parallel load — set high
 *  enough that an ordinary profile finishes in one pass rather than converging
 *  over several launches. Truncation is logged, never silent. */
const REFRESH_BATCH = 200;

type IdentityLookup = {
  outcome: RepoIdentityRefreshOutcome;
  change?: IdentityChange;
};

export type IdentityChange = { repoId: string; identity: RepoIdentity };

/** `ForgeHosts.isEnabled`, injected. The `source` matters as much as the
 *  answer: "off" from config or env is a durable decision worth backing off
 *  on, while "off" from `auto` only means no CLI has reported this host YET —
 *  enumeration is two subprocesses that land after the first refresh. Backing
 *  off on the latter would turn a boot race into minutes of missing marks. */
export type ForgeHostGate = (
  hostname: string
) => { enabled: boolean; source: ForgeValueSource };

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

/** One FIFO semaphore per service, shared by every refresh invocation. */
class IdentitySlots {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) this.active -= 1;
      else next();
    }
  }
}

export class IdentityService {
  private readonly remoteSlots = new IdentitySlots(REMOTE_CONCURRENCY);
  private readonly forgeSlots = new IdentitySlots(FORGE_CONCURRENCY);
  private readonly refreshing = new Map<string, Promise<IdentityLookup>>();
  /**
   * Per-repo "do not ask again before" stamps. Two maps, not one, because the
   * two reasons recover differently and merging them gets both wrong.
   *
   * A signed-out CLI is transient and fixable from outside the app, so its
   * window is short and nothing but a successful read may clear it — dropping
   * it on an unrelated settings write is how a theme toggle turns into a burst
   * of spawns against a CLI we already know is logged out.
   *
   * A host the user switched off is the opposite: the answer cannot change
   * without a settings write or an env change, and the settings write clears
   * `gateRetryAfter` outright. Its window therefore exists only to re-notice a
   * re-pointed `origin`, which is the identity TTL's job, not the retry one's.
   * At `IDENTITY_RETRY_MS` a profile of 300 repos on a switched-off host costs
   * ~3,600 `git remote` spawns an hour to re-derive an answer that is pinned
   * in the settings file; at `IDENTITY_TTL_MS` it costs 50, the same as a host
   * that is on.
   *
   * Neither may write a row, and an explicit refresh bypasses both.
   */
  private readonly authRetryAfter = new Map<string, number>();
  private readonly gateRetryAfter = new Map<string, number>();

  constructor(
    private readonly db: DB,
    private readonly git: GitExec,
    private readonly forges: ForgeRepoRegistry,
    /** Required, with no permissive default — see `AGENTS.md`. */
    private readonly hostGate: ForgeHostGate
  ) {}

  private backedOff(repoId: string): boolean {
    const now = Date.now();
    return (
      now < (this.authRetryAfter.get(repoId) ?? 0) ||
      now < (this.gateRetryAfter.get(repoId) ?? 0)
    );
  }

  /** Whether the switch is off AND somebody actually decided that, rather than
   *  the host merely not being recognized yet. Only a decided "off" is stable
   *  enough to cache against. */
  private switchedOff(hostname: string): boolean {
    const { enabled, source } = this.hostGate(hostname);
    return !enabled && (source === "config" || source === "env");
  }

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
    return (await this.refreshWithOutcomes(repos, options)).changes;
  }

  /** Explicit callers join ongoing work and receive its outcome; background
   *  callers skip duplicates. Only the caller starting a lookup owns its delta. */
  async refreshWithOutcomes(
    repos: Repo[],
    options: { force?: boolean } = {}
  ): Promise<{ changes: IdentityChange[]; outcomes: RepoIdentityRefreshOutcome[] }> {
    const stored = this.read(repos.map((repo) => repo.id));
    const due = repos.filter((repo) => {
      if (this.refreshing.has(repo.id)) return options.force === true;
      if (options.force === true) return true;
      if (this.backedOff(repo.id)) return false;
      const existing = stored.get(repo.id);
      // The stored row already names the host, so a switched-off one is
      // answered here without spawning `git remote get-url origin` at all.
      if (existing !== undefined && this.switchedOff(existing.hostname)) {
        return false;
      }
      if (existing?.fetchedAt === undefined) return true;
      const age = Date.now() - Date.parse(`${existing.fetchedAt}Z`);
      const ttl = existing.visibility === "unknown"
        ? IDENTITY_RETRY_MS
        : IDENTITY_TTL_MS;
      return !Number.isFinite(age) || age > ttl;
    });
    const batch = due.slice(0, REFRESH_BATCH);
    if (due.length > batch.length) {
      logMain(
        "info",
        "forge",
        `identity refresh covering ${batch.length} of ${due.length} repositories this pass`
      );
    }
    const results = await Promise.all(
      batch.map((repo): Promise<IdentityLookup> => {
        const ongoing = this.refreshing.get(repo.id);
        if (ongoing !== undefined) {
          return ongoing.then(({ outcome }) => ({ outcome }));
        }
        const lookup = this.lookup(repo, stored.get(repo.id));
        this.refreshing.set(repo.id, lookup);
        return lookup.finally(() => {
          if (this.refreshing.get(repo.id) === lookup) {
            this.refreshing.delete(repo.id);
          }
        });
      })
    );
    return {
      changes: results.flatMap(({ change }) => change === undefined ? [] : [change]),
      outcomes: results.map(({ outcome }) => outcome)
    };
  }

  private async lookup(
    repo: Repo,
    previous: RepoIdentity | undefined
  ): Promise<IdentityLookup> {
    const unavailable: IdentityLookup = {
      outcome: {
        repoId: repo.id,
        status: "unavailable",
        ...(previous === undefined ? {} : { identity: previous })
      }
    };
    const origin = await this.remoteSlots.run(() => readOrigin(this.git, repo));
    if (origin === null || origin.host === "other") return unavailable;
    // Gated on the hostname, not the kind, so the pane and this transport
    // agree about self-managed instances. Reported as its own status rather
    // than `unavailable`: nothing failed, the user turned it off. Backed off
    // like a signed-out attempt so a repo that has no row yet stops re-reading
    // its remote on every pass — the answer cannot change without a settings
    // write, which resets the backoff by writing a row on the next success.
    if (this.switchedOff(origin.hostname)) {
      this.gateRetryAfter.set(origin.repoId, Date.now() + IDENTITY_TTL_MS);
      return {
        outcome: {
          repoId: repo.id,
          status: "host_disabled",
          ...(previous === undefined ? {} : { identity: previous })
        }
      };
    }
    if (!this.hostGate(origin.hostname).enabled) return unavailable;
    // `origin.hostname` is right here and used below — dropping it read this
    // repo's identity off github.com/gitlab.com instead of its own instance,
    // which for a same-named SaaS slug reports a STRANGER's visibility and
    // fork lineage as this repo's.
    const provider = this.forges.get(origin.host, origin.hostname);
    if (provider === null) return unavailable;
    let identity: RepoIdentity;
    try {
      const repository = await this.forgeSlots.run(() =>
        provider.viewRepo(origin.nameWithOwner)
      );
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
        // so signing in can recover. Back off briefly in memory so fetches
        // do not repeatedly spawn a signed-out CLI. Explicit refresh bypasses it.
        this.authRetryAfter.set(origin.repoId, Date.now() + IDENTITY_RETRY_MS);
        return {
          outcome: {
            repoId: repo.id,
            status: "signed_out",
            ...(previous === undefined ? {} : { identity: previous })
          }
        };
      }
    }
    this.authRetryAfter.delete(origin.repoId);
    this.gateRetryAfter.delete(origin.repoId);
    this.write(origin.repoId, identity);
    return {
      outcome: {
        repoId: repo.id,
        status: identity.visibility === "unknown" ? "unknown" : "resolved",
        identity
      },
      ...(sameIdentity(previous, identity) ? {} : {
        change: { repoId: repo.id, identity }
      })
    };
  }

  /**
   * Forget every "do not ask again before" stamp.
   *
   * The stamps encode an answer the gate gave, so anything that can change the
   * gate's answer — host enumeration landing, or a forge setting being written
   * — has to clear them or a repo sits out its backoff for a decision that no
   * longer applies. Deliberately not a `force` refresh: the six-hour TTL on
   * rows that DID resolve is still right, and re-reading every repository on
   * every settings write is the cost this whole gate exists to avoid.
   */
  clearGateBackoff(): void {
    this.gateRetryAfter.clear();
  }

  /** Drop stored identities for repositories that no longer exist. The FK
   *  cascade covers deletes through `repos`; this covers a direct call. */
  forget(repoId: string): void {
    this.authRetryAfter.delete(repoId);
    this.gateRetryAfter.delete(repoId);
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
