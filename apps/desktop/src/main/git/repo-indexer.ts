import { createHash } from "node:crypto";
import { type Dirent, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  err,
  ok,
  type BranchRef,
  type Profile,
  type ProfileId,
  type PrSummary,
  type Repo,
  type RepoSearchHit,
  type RepoWorktreeRefresh,
  type Result,
  type Worktree
} from "@pwrgit/shared";
import type { DB } from "../persistence/db";
import { mapLimit } from "../util/map-limit";
import type { GitExec } from "./dugite";
import { buildFtsQuery } from "./fts-query";
import { listBranches, listRemoteNames, listWorktrees } from "./git-service";
import { claimWorktreeOwnership } from "./repo-ownership";

const MAX_SCAN_DEPTH = 5;
const GIT_CONCURRENCY = 12;
const HYDRATION_GIT_CONCURRENCY = 4;
const BRANCH_WRITE_CHUNK_SIZE = 100;
const DISCOVERY_YIELD_EVERY = 32;
const PROFILE_RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HYDRATION_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;
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
  custom_order: number | null;
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
  default_branch: string | null;
  merged_into_default: number | null;
  diverged_from_default: number | null;
  is_default_branch: number | null;
  last_activity_at: string | null;
  custom_order: number | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_title: string | null;
  pr_state: string | null;
  pr_is_draft: number | null;
};

type IndexedBranches = {
  branches: BranchRef[];
  remoteNames: string[];
};

async function listIndexedBranches(
  git: GitExec,
  cwd: string
): Promise<Result<IndexedBranches>> {
  const [branches, remoteNames] = await Promise.all([
    listBranches(git, cwd),
    listRemoteNames(git, cwd)
  ]);
  if (!branches.ok) return branches;
  if (!remoteNames.ok) return remoteNames;
  return ok({ branches: branches.value, remoteNames: remoteNames.value });
}

export type RepoIndexerOptions = {
  yieldToEventLoop?: () => Promise<void>;
  branchWriteChunkSize?: number;
  discoveryYieldEvery?: number;
  profileRescanIntervalMs?: number;
  hydrationRetryIntervalMs?: number;
  now?: () => number;
};

const defaultYieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/**
 * Discovers git repositories under a profile's root folders and persists a
 * repo/worktree index the sidebar reads. Read-only with respect to git.
 * The GitExec is injected so the scan logic is testable against system git.
 */
export class RepoIndexer {
  private readonly yieldToEventLoop: () => Promise<void>;
  private readonly branchWriteChunkSize: number;
  private readonly discoveryYieldEvery: number;
  private readonly profileRescanIntervalMs: number;
  private readonly hydrationRetryIntervalMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: DB,
    private readonly git: GitExec,
    options: RepoIndexerOptions = {}
  ) {
    this.yieldToEventLoop =
      options.yieldToEventLoop ?? defaultYieldToEventLoop;
    this.branchWriteChunkSize = Math.max(
      1,
      options.branchWriteChunkSize ?? BRANCH_WRITE_CHUNK_SIZE
    );
    this.discoveryYieldEvery = Math.max(
      1,
      options.discoveryYieldEvery ?? DISCOVERY_YIELD_EVERY
    );
    this.profileRescanIntervalMs = Math.max(
      1,
      options.profileRescanIntervalMs ?? PROFILE_RESCAN_INTERVAL_MS
    );
    this.hydrationRetryIntervalMs = Math.max(
      1,
      options.hydrationRetryIntervalMs ?? HYDRATION_RETRY_INTERVAL_MS
    );
    this.now = options.now ?? Date.now;
  }

  /** Full root discovery is periodic; explicit user rescans bypass this gate. */
  shouldRescanProfile(profileId: ProfileId): boolean {
    const pendingBranchIndex = this.db
      .prepare(
        `SELECT 1
         FROM repos r
         LEFT JOIN remote_branch_index_state s ON s.repo_id = r.id
         WHERE r.profile_id = ?
           AND r.source = 'scan'
           AND s.repo_id IS NULL
         LIMIT 1`
      )
      .get(profileId);
    if (pendingBranchIndex !== undefined) return true;

    const state = this.db
      .prepare(
        `SELECT scanned_at_ms
         FROM profile_scan_state
         WHERE profile_id = ?`
      )
      .get(profileId) as { scanned_at_ms: number } | undefined;
    return (
      state === undefined ||
      this.now() - state.scanned_at_ms >= this.profileRescanIntervalMs
    );
  }

  /** Rescan a profile's roots; upsert discovered repos, prune vanished ones. */
  async rescanProfile(profile: Profile): Promise<Repo[]> {
    const found = new Set<string>();
    for (const root of profile.roots) {
      const dirs = await findRepoDirsAsync(root, MAX_SCAN_DEPTH, {
        yieldEvery: this.discoveryYieldEvery,
        yieldToEventLoop: this.yieldToEventLoop
      });
      for (const dir of dirs) found.add(dir);
    }

    // Resolve each found dir to its canonical (primary worktree) path via git,
    // deduping repos reachable from more than one worktree dir.
    const canonical = new Map<
      string,
      {
        path: string;
        worktrees: Worktree[];
        indexedBranches: IndexedBranches | null;
      }
    >();
    await mapLimit([...found], GIT_CONCURRENCY, async (dir) => {
      const [listed, listedBranches] = await Promise.all([
        listWorktrees(this.git, dir),
        listIndexedBranches(this.git, dir)
      ]);
      if (!listed.ok || listed.value.length === 0) return;
      const primary = listed.value[0];
      if (primary === undefined || primary.bare) return;
      if (canonical.has(primary.path)) return;
      canonical.set(primary.path, {
        path: primary.path,
        worktrees: listed.value
          .filter((w) => !w.bare)
          .map((w, i) => worktreeShape(w.path, w.branch, i === 0)),
        indexedBranches: listedBranches.ok ? listedBranches.value : null
      });
    });

    const seenRepoIds: string[] = [];
    for (const { path, worktrees, indexedBranches } of canonical.values()) {
      const repoId = this.db.transaction(() => {
        const repoId = this.upsertRepoRow(
          profile.id,
          basename(path),
          path,
          "scan"
        );
        this.syncWorktrees(repoId, worktrees);
        return repoId;
      })();
      seenRepoIds.push(repoId);
      if (indexedBranches !== null) {
        await this.syncBranchIndexChunked(
          repoId,
          indexedBranches.branches,
          indexedBranches.remoteNames
        );
      } else {
        // Record the attempt so one temporarily unreadable repo does not turn
        // the one-time migration repair into an every-launch full rescan. The
        // daily scan (or an explicit refresh) retries it normally.
        this.markRemoteBranchesIndexed(repoId);
      }
      await this.yieldToEventLoop();
    }
    this.db.transaction(() => {
      this.pruneScannedRepos(profile.id, seenRepoIds);
      this.markProfileScanned(profile.id);
    })();

    return this.listRepos(profile.id);
  }

  /** Index a single repo path (manual add) under the given profile. */
  async indexRepoAt(
    profileId: ProfileId,
    path: string
  ): Promise<Result<Repo>> {
    const [listed, listedBranches] = await Promise.all([
      listWorktrees(this.git, path),
      listIndexedBranches(this.git, path)
    ]);
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
      this.upsertRepoRow(
        profileId,
        basename(primary.path),
        primary.path,
        "manual"
      );
      this.syncWorktrees(repoId, worktrees);
    });
    run();
    if (listedBranches.ok) {
      await this.syncBranchIndexChunked(
        repoId,
        listedBranches.value.branches,
        listedBranches.value.remoteNames
      );
    }

    const repo = this.getRepo(repoId);
    return repo === null
      ? err({ kind: "repo", code: "insert_failed", message: "repo did not persist" })
      : ok(repo);
  }

  listRepos(profileId: ProfileId): Repo[] {
    // NOCASE so "apple" sorts next to "Apple" rather than after "Zebra" —
    // SQLite's default TEXT collation is binary (all uppercase before any
    // lowercase). The trailing `name` breaks NOCASE ties deterministically.
    const repoRows = this.db
      .prepare(
        // Hand-arranged repos lead, in their arranged order; everything the
        // user hasn't touched follows by name. `(custom_order IS NULL)` sorts
        // 0 before 1, which is how NULLs go last without a dialect-specific
        // NULLS LAST. `sort_order` is dropped from the key: it has only ever
        // held its DEFAULT 0, so it contributed nothing but a false suggestion
        // that repo ordering already existed.
        `SELECT id, profile_id, name, path, pinned, custom_order FROM repos
         WHERE profile_id = ?
         ORDER BY pinned DESC, (custom_order IS NULL), custom_order,
                  name COLLATE NOCASE, name`
      )
      .all(profileId) as RepoRow[];
    // Ownership filter: a fossil DB (older builds) can hold the same worktree
    // under two repos, which renders as two "selected" rows at once.
    return claimWorktreeOwnership(repoRows.map((r) => this.repoFromRow(r)));
  }

  getRepo(repoId: string): Repo | null {
    const row = this.db
      .prepare(
        "SELECT id, profile_id, name, path, pinned, custom_order FROM repos WHERE id = ?"
      )
      .get(repoId) as RepoRow | undefined;
    return row === undefined ? null : this.repoFromRow(row);
  }

  /** Refresh only the derived branch search rows (remote-only + local-only)
   *  for one repository — what a fetch or a remote edit can change. */
  async refreshRepoRemoteBranches(repoId: string): Promise<Result<void>> {
    const repo = this.db
      .prepare("SELECT path FROM repos WHERE id = ?")
      .get(repoId) as { path: string } | undefined;
    if (repo === undefined) {
      return err({ kind: "repo", code: "not_found", message: "repo not found" });
    }
    const listed = await listIndexedBranches(this.git, repo.path);
    if (!listed.ok) return listed;
    await this.syncBranchIndexChunked(
      repoId,
      listed.value.branches,
      listed.value.remoteNames
    );
    return ok(undefined);
  }

  /**
   * Backfill the derived branch index for persisted repositories. The
   * completion marker makes this migration repair a one-time operation;
   * routine profile scans and remote mutations maintain the index afterward.
   */
  async hydrateRemoteBranches(options: {
    excludeScannedProfileId?: ProfileId | null;
  } = {}): Promise<{ refreshed: number; failed: number }> {
    const repos = this.db
      .prepare(
        `SELECT r.id, r.path
         FROM repos r
         LEFT JOIN remote_branch_index_state s ON s.repo_id = r.id
         LEFT JOIN remote_branch_hydration_retry h ON h.repo_id = r.id
         WHERE s.repo_id IS NULL
           AND (h.repo_id IS NULL OR h.retry_after_ms <= ?)
           AND (? IS NULL OR r.profile_id <> ? OR r.source <> 'scan')
         ORDER BY r.id`
      )
      .all(
        this.now(),
        options.excludeScannedProfileId ?? null,
        options.excludeScannedProfileId ?? null
      ) as { id: string; path: string }[];
    let refreshed = 0;
    let failed = 0;
    for (
      let offset = 0;
      offset < repos.length;
      offset += HYDRATION_GIT_CONCURRENCY
    ) {
      const batch = repos.slice(offset, offset + HYDRATION_GIT_CONCURRENCY);
      const inspected: {
        repoId: string;
        result: Result<IndexedBranches>;
      }[] = [];
      await mapLimit(batch, HYDRATION_GIT_CONCURRENCY, async (repo) => {
        inspected.push({
          repoId: repo.id,
          result: await listIndexedBranches(this.git, repo.path)
        });
      });
      for (const item of inspected) {
        if (!item.result.ok) {
          failed += 1;
          this.scheduleRemoteBranchHydrationRetry(item.repoId);
          continue;
        }
        await this.syncBranchIndexChunked(
          item.repoId,
          item.result.value.branches,
          item.result.value.remoteNames
        );
        refreshed += 1;
      }
      await this.yieldToEventLoop();
    }
    return { refreshed, failed };
  }

  /**
   * Unpinning also drops the manual order. Only pinned repos are numbered (the
   * Pinned lens is the arrangeable one), so an unpinned repo's index goes stale
   * the moment its former neighbors are rearranged without it — and re-pinning
   * would then reinsert it at an index another repo already holds, landing it
   * somewhere the user never chose. Clearing on the way out means a re-pinned
   * repo arrives unarranged, sorting by name behind the arranged ones.
   */
  setRepoPinned(repoId: string, pinned: boolean): void {
    this.db
      .prepare(
        pinned
          ? "UPDATE repos SET pinned = 1 WHERE id = ?"
          : "UPDATE repos SET pinned = 0, custom_order = NULL WHERE id = ?"
      )
      .run(repoId);
  }

  setWorktreePinned(worktreeId: string, pinned: boolean): void {
    this.db
      .prepare("UPDATE worktrees SET pinned = ? WHERE id = ?")
      .run(pinned ? 1 : 0, worktreeId);
  }

  /**
   * Persist a manual drag order for a profile's repos. Only the ids handed in
   * are numbered; repos left out keep their NULL custom_order and sort by name
   * behind the arranged ones (see the ORDER BY in listRepos). That is what lets
   * the user arrange their pinned shelf without implicitly freezing the order
   * of the other hundred repos in the profile.
   */
  setRepoOrder(profileId: string, orderedIds: string[]): void {
    const stmt = this.db.prepare(
      "UPDATE repos SET custom_order = ? WHERE id = ? AND profile_id = ?"
    );
    const run = this.db.transaction(() => {
      orderedIds.forEach((id, i) => stmt.run(i, id, profileId));
    });
    run();
  }

  /** Persist a manual drag order for a repo's worktrees (U14). */
  setWorktreeOrder(repoId: string, orderedIds: string[]): void {
    const stmt = this.db.prepare(
      "UPDATE worktrees SET custom_order = ? WHERE id = ? AND repo_id = ?"
    );
    const run = this.db.transaction(() => {
      orderedIds.forEach((id, i) => stmt.run(i, id, repoId));
    });
    run();
  }

  /** Re-list an existing repo's worktrees (after create/remove), preserving
   *  its source, pins, and custom order (syncWorktrees only touches identity). */
  async refreshRepoWorktrees(
    repoId: string
  ): Promise<Result<RepoWorktreeRefresh>> {
    const repo = this.getRepo(repoId);
    if (repo === null) {
      return err({
        kind: "repo",
        code: "not_found",
        message: "repo not found"
      });
    }
    const [listed, listedBranches] = await Promise.all([
      listWorktrees(this.git, repo.path),
      listIndexedBranches(this.git, repo.path)
    ]);
    if (!listed.ok) return listed;
    const primary = listed.value[0];
    // A repo row whose dir is actually a LINKED worktree of another repo (its
    // listed primary path isn't its own path) is a fossil — older builds could
    // index one. Syncing it would steal the whole family back and forth with
    // the canonical repo; delete it instead (worktrees cascade, and the
    // canonical repo reclaims its rows whenever a scan reaches it). Dropping
    // the row is the completed refresh, so report it as one — an error here
    // reaches the renderer as "Couldn't refresh …" while the row visibly
    // disappears. Hand back the owning path too: reclaim needs that repo to be
    // under a scan root, which we cannot promise, so the UI names where the
    // worktree went instead of asserting it is already listed.
    if (primary !== undefined && !primary.bare && primary.path !== repo.path) {
      this.db.prepare("DELETE FROM repos WHERE id = ?").run(repoId);
      return ok({
        outcome: "deindexed",
        profileId: repo.profileId,
        ownerPath: primary.path
      });
    }
    const worktrees = listed.value
      .filter((w) => !w.bare)
      .map((w, i) => worktreeShape(w.path, w.branch, i === 0));
    this.db.transaction(() => this.syncWorktrees(repoId, worktrees))();
    if (listedBranches.ok) {
      await this.syncBranchIndexChunked(
        repoId,
        listedBranches.value.branches,
        listedBranches.value.remoteNames
      );
    }

    const refreshed = this.getRepo(repoId);
    if (refreshed === null) {
      return err({
        kind: "repo",
        code: "refresh_failed",
        message: "refreshed repo did not persist"
      });
    }

    const before = new Map(repo.worktrees.map((w) => [w.id, w]));
    const after = new Map(refreshed.worktrees.map((w) => [w.id, w]));
    const added = refreshed.worktrees.filter((w) => !before.has(w.id)).length;
    const removed = repo.worktrees.filter((w) => !after.has(w.id)).length;
    const updated = refreshed.worktrees.filter((w) => {
      const old = before.get(w.id);
      return (
        old !== undefined &&
        (old.branch !== w.branch ||
          old.path !== w.path ||
          old.isPrimary !== w.isPrimary)
      );
    }).length;

    return ok({
      outcome: "reconciled",
      repo: refreshed,
      added,
      removed,
      updated
    });
  }

  /** ⌘F search: repos, worktrees (by branch/path), and branches with no
   *  worktree — remote-only (0019) and local-only (0022) — across all profiles,
   *  through the FTS5 index (0008_search_fts) — prefix matching per token,
   *  any token order, diacritic/punctuation-insensitive, one bm25-ranked
   *  mixed list with names weighted above paths. Empty/junk queries fall
   *  back to browsing repos by name (the overlay's initial state). */
  searchAll(query: string): RepoSearchHit[] {
    const fts = buildFtsQuery(query);
    if (fts === null) return this.browseRepos();

    // Exact literal names come first so the intended row survives the result
    // cap. Within exact/fuzzy groups, bm25 weights per column (entity_id,
    // kind, name, path, repo_name, pr): a hit in the repo/branch name outranks
    // one buried in a path; PR number/title hits rank just under names.
    const matches = this.db
      .prepare(
        `SELECT entity_id, kind FROM search_fts
         WHERE search_fts MATCH ?
         ORDER BY CASE WHEN name = ? COLLATE NOCASE THEN 0 ELSE 1 END,
                  bm25(search_fts, 0.0, 0.0, 10.0, 2.0, 4.0, 8.0)
         LIMIT 60`
      )
      .all(fts, query.trim()) as {
      entity_id: string;
      kind: RepoSearchHit["kind"];
    }[];
    if (matches.length === 0) return [];

    // One hit per entity: a dirty index (fossil DBs could double-insert via
    // the 0008 backfill) must not emit duplicate hits — they become duplicate
    // React keys in the overlay and leave ghost rows behind on re-render.
    const seen = new Set<string>();
    const unique = matches.filter((m) => {
      const key = `${m.kind}:${m.entity_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const repoIds = unique.filter((m) => m.kind === "repo").map((m) => m.entity_id);
    const wtIds = unique
      .filter((m) => m.kind === "worktree")
      .map((m) => m.entity_id);
    const remoteBranchIds = unique
      .filter((m) => m.kind === "remote_branch")
      .map((m) => m.entity_id);
    const localBranchIds = unique
      .filter((m) => m.kind === "local_branch")
      .map((m) => m.entity_id);

    const marks = (n: number): string => Array(n).fill("?").join(",");
    const repoHits = new Map<string, RepoSearchHit>();
    if (repoIds.length > 0) {
      const rows = this.db
        .prepare(
          `SELECT r.id, r.name, r.path, r.profile_id, r.pinned, p.name AS profile_name,
                  (SELECT COUNT(*) FROM worktrees w WHERE w.repo_id = r.id) AS wt_count
           FROM repos r JOIN profiles p ON p.id = r.profile_id
           WHERE r.id IN (${marks(repoIds.length)})`
        )
        .all(...repoIds) as {
        id: string;
        name: string;
        path: string;
        profile_id: string;
        pinned: number;
        profile_name: string;
        wt_count: number;
      }[];
      for (const r of rows) {
        repoHits.set(r.id, {
          kind: "repo",
          repoId: r.id,
          name: r.name,
          path: r.path,
          profileId: r.profile_id,
          profileName: r.profile_name,
          worktreeCount: r.wt_count,
          pinned: r.pinned === 1
        });
      }
    }

    const wtHits = new Map<string, RepoSearchHit>();
    if (wtIds.length > 0) {
      const rows = this.db
        .prepare(
          `SELECT w.id, w.branch, w.path, w.pinned, r.id AS repo_id, r.name AS repo_name,
                  r.profile_id, p.name AS profile_name,
                  pr.number AS pr_number, pr.url AS pr_url, pr.title AS pr_title,
                  pr.state AS pr_state, pr.is_draft AS pr_is_draft
           FROM worktrees w
           JOIN repos r ON r.id = w.repo_id
           JOIN profiles p ON p.id = r.profile_id
           LEFT JOIN branch_pr pr
             ON pr.repo_id = w.repo_id AND pr.branch = w.branch
           WHERE w.id IN (${marks(wtIds.length)})`
        )
        .all(...wtIds) as {
        id: string;
        branch: string;
        path: string;
        pinned: number;
        repo_id: string;
        repo_name: string;
        profile_id: string;
        profile_name: string;
        pr_number: number | null;
        pr_url: string | null;
        pr_title: string | null;
        pr_state: string | null;
        pr_is_draft: number | null;
      }[];
      for (const w of rows) {
        const hit: RepoSearchHit = {
          kind: "worktree",
          repoId: w.repo_id,
          name: w.branch,
          path: w.path,
          profileId: w.profile_id,
          profileName: w.profile_name,
          worktreeCount: 0,
          pinned: w.pinned === 1,
          worktreeId: w.id,
          repoName: w.repo_name
        };
        if (w.pr_number !== null) {
          hit.pr = {
            number: w.pr_number,
            url: w.pr_url ?? "",
            title: w.pr_title ?? "",
            state: (w.pr_state ?? "open") as PrSummary["state"],
            isDraft: w.pr_is_draft === 1
          };
        }
        wtHits.set(w.id, hit);
      }
    }

    const remoteBranchHits = new Map<string, RepoSearchHit>();
    if (remoteBranchIds.length > 0) {
      const rows = this.db
        .prepare(
          `SELECT b.id, b.repo_id, b.name, b.full_name, b.remote_name,
                  r.name AS repo_name, r.path, r.profile_id,
                  p.name AS profile_name
           FROM remote_branches b
           JOIN repos r ON r.id = b.repo_id
           JOIN profiles p ON p.id = r.profile_id
           WHERE b.id IN (${marks(remoteBranchIds.length)})`
        )
        .all(...remoteBranchIds) as {
        id: string;
        repo_id: string;
        name: string;
        full_name: string;
        remote_name: string;
        repo_name: string;
        path: string;
        profile_id: string;
        profile_name: string;
      }[];
      for (const branch of rows) {
        remoteBranchHits.set(branch.id, {
          kind: "remote_branch",
          repoId: branch.repo_id,
          name: branch.name,
          path: branch.path,
          profileId: branch.profile_id,
          profileName: branch.profile_name,
          worktreeCount: 0,
          pinned: false,
          repoName: branch.repo_name,
          remoteRef: branch.full_name,
          remoteName: branch.remote_name
        });
      }
    }

    const localBranchHits = new Map<string, RepoSearchHit>();
    if (localBranchIds.length > 0) {
      const rows = this.db
        .prepare(
          `SELECT b.id, b.repo_id, b.name,
                  r.name AS repo_name, r.path, r.profile_id,
                  p.name AS profile_name
           FROM local_branches b
           JOIN repos r ON r.id = b.repo_id
           JOIN profiles p ON p.id = r.profile_id
           WHERE b.id IN (${marks(localBranchIds.length)})`
        )
        .all(...localBranchIds) as {
        id: string;
        repo_id: string;
        name: string;
        repo_name: string;
        path: string;
        profile_id: string;
        profile_name: string;
      }[];
      for (const branch of rows) {
        localBranchHits.set(branch.id, {
          kind: "local_branch",
          repoId: branch.repo_id,
          name: branch.name,
          path: branch.path,
          profileId: branch.profile_id,
          profileName: branch.profile_name,
          worktreeCount: 0,
          pinned: false,
          repoName: branch.repo_name
        });
      }
    }

    // Emit in bm25 order; hydration misses (an index row whose entity vanished
    // mid-flight) are simply skipped. An exact name is stronger intent than
    // term frequency, though: without this promotion a branch containing the
    // query tokens repeatedly can outrank the literal branch the user pasted.
    const out: RepoSearchHit[] = [];
    for (const m of unique) {
      const hit =
        m.kind === "repo"
          ? repoHits.get(m.entity_id)
          : m.kind === "worktree"
            ? wtHits.get(m.entity_id)
            : m.kind === "remote_branch"
              ? remoteBranchHits.get(m.entity_id)
              : localBranchHits.get(m.entity_id);
      if (hit !== undefined) out.push(hit);
    }
    const exactName = normalizeExactSearchName(query);
    out.sort(
      (left, right) =>
        Number(normalizeExactSearchName(right.name) === exactName) -
        Number(normalizeExactSearchName(left.name) === exactName)
    );
    return out;
  }

  /** The overlay's empty-query state: all repos, pinned first, alphabetical. */
  private browseRepos(): RepoSearchHit[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.name, r.path, r.profile_id, r.pinned, p.name AS profile_name,
                (SELECT COUNT(*) FROM worktrees w WHERE w.repo_id = r.id) AS wt_count
         FROM repos r JOIN profiles p ON p.id = r.profile_id
         ORDER BY r.pinned DESC, r.name COLLATE NOCASE, r.name LIMIT 50`
      )
      .all() as {
      id: string;
      name: string;
      path: string;
      profile_id: string;
      pinned: number;
      profile_name: string;
      wt_count: number;
    }[];
    return rows.map((r) => ({
      kind: "repo",
      repoId: r.id,
      name: r.name,
      path: r.path,
      profileId: r.profile_id,
      profileName: r.profile_name,
      worktreeCount: r.wt_count,
      pinned: r.pinned === 1
    }));
  }

  private repoFromRow(r: RepoRow): Repo {
    const worktrees = (
      this.db
        .prepare(
          `SELECT w.id, w.repo_id, w.branch, w.path, w.is_primary, w.pinned,
                  w.custom_order AS custom_order,
                  s.dirty AS dirty, s.ahead AS ahead, s.behind AS behind,
                  s.behind_default AS behind_default,
                  s.default_branch AS default_branch,
                  s.merged_into_default AS merged_into_default,
                  s.diverged_from_default AS diverged_from_default,
                  s.is_default_branch AS is_default_branch,
                  s.last_activity_at AS last_activity_at,
                  p.number AS pr_number, p.url AS pr_url, p.title AS pr_title,
                  p.state AS pr_state, p.is_draft AS pr_is_draft
           FROM worktrees w
           LEFT JOIN worktree_state s ON s.worktree_id = w.id
           LEFT JOIN branch_pr p ON p.repo_id = w.repo_id AND p.branch = w.branch
           WHERE w.repo_id = ?
           ORDER BY (w.custom_order IS NULL), w.custom_order, w.is_primary DESC,
                    w.branch COLLATE NOCASE, w.branch`
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
        defaultBranch: w.default_branch ?? "",
        mergedIntoDefault: w.merged_into_default === 1,
        divergedFromDefault: w.diverged_from_default === 1,
        isDefaultBranch: w.is_default_branch === 1,
        pinned: w.pinned === 1,
        isPrimary: w.is_primary === 1
      };
      if (w.last_activity_at !== null) wt.lastActivityAt = w.last_activity_at;
      if (w.custom_order !== null) wt.order = w.custom_order;
      if (w.pr_number !== null && w.pr_url !== null) {
        const state =
          w.pr_state === "merged"
            ? "merged"
            : w.pr_state === "closed"
              ? "closed"
              : "open";
        wt.pr = {
          number: w.pr_number,
          url: w.pr_url,
          title: w.pr_title ?? "",
          state,
          isDraft: w.pr_is_draft === 1
        };
      }
      return wt;
    });
    const repo: Repo = {
      id: r.id,
      name: r.name,
      path: r.path,
      profileId: r.profile_id,
      pinned: r.pinned === 1,
      worktrees
    };
    if (r.custom_order !== null) repo.order = r.custom_order;
    return repo;
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
    // repo_id is reclaimed on conflict: the repo currently listing a path owns
    // it. Without this, a row minted under an older/wrong repo (e.g. a linked
    // worktree once indexed as its own repo) stays stranded there forever.
    const stmt = this.db.prepare(
      `INSERT INTO worktrees (id, repo_id, branch, path, is_primary, last_seen_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         repo_id = excluded.repo_id,
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

  /**
   * Refresh both derived branch tables for one repo from a single ref listing:
   * remote-only branches (0019) and local branches no worktree has checked out
   * (0022). Chunked writes keep the main process responsive on repos with
   * thousands of refs; the shared completion marker covers both tables.
   */
  private async syncBranchIndexChunked(
    repoId: string,
    branches: BranchRef[],
    remoteNames: string[]
  ): Promise<void> {
    await this.syncRemoteBranchRows(repoId, branches, remoteNames);
    await this.syncLocalBranchRows(repoId, branches);
    this.markRemoteBranchesIndexed(repoId);
  }

  private async syncRemoteBranchRows(
    repoId: string,
    branches: BranchRef[],
    remoteNames: string[]
  ): Promise<void> {
    const localNames = new Set(
      branches.filter((branch) => !branch.isRemote).map((branch) => branch.name)
    );
    const rows: {
      id: string;
      name: string;
      fullName: string;
      remoteName: string;
    }[] = [];
    const remotePrefixes = remoteNames
      .slice()
      .sort((left, right) => right.length - left.length)
      .map((remoteName) => ({ remoteName, prefix: `${remoteName}/` }));
    for (const branch of branches) {
      if (!branch.isRemote) continue;
      const remote = remotePrefixes.find(({ prefix }) =>
        branch.name.startsWith(prefix)
      );
      if (remote === undefined) continue;
      const { remoteName, prefix } = remote;
      const name = branch.name.slice(prefix.length);
      if (name === "") continue;
      if (localNames.has(name)) continue;
      const fullName = `refs/remotes/${branch.name}`;
      rows.push({
        id: `${repoId}:${fullName}`,
        name,
        fullName,
        remoteName
      });
    }

    await this.replaceDerivedBranchRows(
      "remote_branches",
      repoId,
      rows.map((row) => ({
        id: row.id,
        args: [row.id, repoId, row.name, row.fullName, row.remoteName]
      })),
      `INSERT INTO remote_branches (id, repo_id, name, full_name, remote_name)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         repo_id = excluded.repo_id,
         name = excluded.name,
         full_name = excluded.full_name,
         remote_name = excluded.remote_name
       WHERE remote_branches.repo_id <> excluded.repo_id
          OR remote_branches.name <> excluded.name
          OR remote_branches.full_name <> excluded.full_name
          OR remote_branches.remote_name <> excluded.remote_name`
    );
  }

  /**
   * Local branches with no worktree of their own. A branch that IS checked out
   * already has a kind='worktree' row in the FTS index — indexing it here too
   * would put the same branch in the palette twice, so those are skipped.
   *
   * The exclusion reads the worktrees table rather than git because that table
   * IS the set of kind='worktree' rows we are deduplicating against: agreeing
   * with it is what keeps a branch to exactly one hit, even when it has drifted
   * from the repo on disk. Callers that re-list worktrees (rescanProfile,
   * indexRepoAt, refreshRepoWorktrees) do so before calling in, so they dedupe
   * against fresh rows; the ref-only callers (refreshRepoRemoteBranches,
   * hydrateRemoteBranches) dedupe against the app's current view, which is
   * exactly what the palette is showing.
   */
  private async syncLocalBranchRows(
    repoId: string,
    branches: BranchRef[]
  ): Promise<void> {
    const checkedOut = new Set(
      (
        this.db
          .prepare("SELECT branch FROM worktrees WHERE repo_id = ?")
          .all(repoId) as { branch: string }[]
      ).map((row) => row.branch)
    );
    const rows: { id: string; name: string; fullName: string }[] = [];
    for (const branch of branches) {
      if (branch.isRemote) continue;
      if (branch.name === "") continue;
      if (checkedOut.has(branch.name)) continue;
      const fullName = `refs/heads/${branch.name}`;
      rows.push({ id: `${repoId}:${fullName}`, name: branch.name, fullName });
    }

    await this.replaceDerivedBranchRows(
      "local_branches",
      repoId,
      rows.map((row) => ({
        id: row.id,
        args: [row.id, repoId, row.name, row.fullName]
      })),
      `INSERT INTO local_branches (id, repo_id, name, full_name)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         repo_id = excluded.repo_id,
         name = excluded.name,
         full_name = excluded.full_name
       WHERE local_branches.repo_id <> excluded.repo_id
          OR local_branches.name <> excluded.name
          OR local_branches.full_name <> excluded.full_name`
    );
  }

  /**
   * Make one repo's rows in a derived branch table exactly `rows`: chunked
   * upserts, then chunked deletes of whatever the listing no longer contains
   * (a deleted branch, a removed remote, a branch that just gained a
   * worktree). Yielding between chunks keeps a repo with thousands of refs
   * from blocking IPC; each chunk is its own transaction, so the FTS triggers
   * commit alongside the rows they mirror.
   */
  private async replaceDerivedBranchRows(
    table: "remote_branches" | "local_branches",
    repoId: string,
    rows: { id: string; args: unknown[] }[],
    upsertSql: string
  ): Promise<void> {
    const upsert = this.db.prepare(upsertSql);
    for (
      let offset = 0;
      offset < rows.length;
      offset += this.branchWriteChunkSize
    ) {
      const chunk = rows.slice(offset, offset + this.branchWriteChunkSize);
      this.db.transaction(() => {
        for (const row of chunk) upsert.run(...row.args);
      })();
      await this.yieldToEventLoop();
    }

    const wanted = new Set(rows.map((row) => row.id));
    const stale = (
      this.db
        .prepare(`SELECT id FROM ${table} WHERE repo_id = ?`)
        .all(repoId) as { id: string }[]
    ).filter((row) => !wanted.has(row.id));
    for (
      let offset = 0;
      offset < stale.length;
      offset += this.branchWriteChunkSize
    ) {
      const chunk = stale.slice(offset, offset + this.branchWriteChunkSize);
      const placeholders = chunk.map(() => "?").join(",");
      this.db.transaction(() => {
        this.db
          .prepare(
            `DELETE FROM ${table}
             WHERE repo_id = ? AND id IN (${placeholders})`
          )
          .run(repoId, ...chunk.map((row) => row.id));
      })();
      await this.yieldToEventLoop();
    }
  }

  private markRemoteBranchesIndexed(repoId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO remote_branch_index_state (repo_id)
           VALUES (?)`
        )
        .run(repoId);
      this.db
        .prepare("DELETE FROM remote_branch_hydration_retry WHERE repo_id = ?")
        .run(repoId);
    })();
  }

  private scheduleRemoteBranchHydrationRetry(repoId: string): void {
    this.db
      .prepare(
        `INSERT INTO remote_branch_hydration_retry (repo_id, retry_after_ms)
         VALUES (?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET
           retry_after_ms = excluded.retry_after_ms`
      )
      .run(repoId, this.now() + this.hydrationRetryIntervalMs);
  }

  private markProfileScanned(profileId: ProfileId): void {
    this.db
      .prepare(
        `INSERT INTO profile_scan_state (profile_id, scanned_at_ms)
         VALUES (?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET
           scanned_at_ms = excluded.scanned_at_ms`
      )
      .run(profileId, this.now());
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

const normalizeExactSearchName = (value: string): string =>
  value
    .trim()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

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
    defaultBranch: "",
    mergedIntoDefault: false,
    divergedFromDefault: false,
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

/**
 * Non-blocking counterpart used by startup rescans. Directory IO happens off
 * the main thread, and explicit bounded yields keep Electron IPC responsive
 * even when cached filesystem reads resolve in a tight loop.
 */
export async function findRepoDirsAsync(
  root: string,
  maxDepth: number = MAX_SCAN_DEPTH,
  options: {
    yieldEvery?: number;
    yieldToEventLoop?: () => Promise<void>;
  } = {}
): Promise<string[]> {
  const results: string[] = [];
  const pending: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  const yieldEvery = Math.max(1, options.yieldEvery ?? DISCOVERY_YIELD_EVERY);
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop;
  let visited = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;

    let entries: Dirent[];
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    visited += 1;
    if (entries.some((entry) => entry.name === ".git")) {
      results.push(current.dir);
    } else if (current.depth < maxDepth) {
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        pending.push({
          dir: join(current.dir, entry.name),
          depth: current.depth + 1
        });
      }
    }

    if (visited % yieldEvery === 0) await yieldToEventLoop();
  }

  return results;
}
