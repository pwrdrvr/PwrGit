import { connectForge } from "../forge/types";
import type { PrSummary } from "@pwrgit/shared";
import type { GitExec } from "../git/dugite";
import type { DB } from "../persistence/db";
import { resolveForge, type ResolvedForge } from "../forge/providers";
import { PR_DETAIL_COLUMNS, prSummaryFromRow } from "../forge/pr-row";

const REPO_REFRESH_TTL_MS = 10 * 60_000;
const SCHEDULED_BRANCH_REFRESH_TTL_MS = 60_000;
const USER_BRANCH_REFRESH_TTL_MS = 10_000;
const TERMINAL_USER_BRANCH_REFRESH_TTL_MS = 60_000;

type PrRefreshTrigger = "scheduled" | "user";

/**
 * Which question failed, not merely which repository.
 *
 * A forge that refuses one query shape routinely answers another — a
 * complexity cap on a 250-branch sweep still answers a single branch — so a
 * repo-wide mark is wrong in both directions: a hover's success would delete
 * the sweep's backoff, and a hover's repeated failure would re-stamp it faster
 * than the sweep's ten-minute window could ever elapse, starving the only
 * refresh that covers every branch. A union rather than a template string, so
 * a mistyped scope cannot compile into a bucket nothing reads.
 */
type FailureScope = "branches:all" | "branches:targeted" | "commits";

type PrServiceDeps = {
  /** Swap in a fake forge; the default reads `origin` and picks a provider. */
  resolveForge?: typeof resolveForge;
  now?: () => number;
};

type CachedPr = {
  number: number | null;
  url: string | null;
  title: string | null;
  state: string | null;
  is_draft: number;
  check_state: string | null;
  checks_still_running: number | null;
  merge_state: string | null;
  forge: string | null;
  host: string | null;
  repo_path: string | null;
  head_ref: string | null;
  base_ref: string | null;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  commit_count: number | null;
  opened_at: number | null;
  merged_at: number | null;
  closed_at: number | null;
};

// Derived from the single column list in ../forge/pr-row, so a new column
// cannot be added there and silently never written here.
const PR_DETAIL_COLUMN_NAMES = PR_DETAIL_COLUMNS;
const PR_DETAIL_COLUMNS_SQL = PR_DETAIL_COLUMN_NAMES.join(", ");
const PR_DETAIL_PARAMS = PR_DETAIL_COLUMN_NAMES.map((c) => `@${c}`).join(", ");
const PR_DETAIL_ASSIGNMENTS = PR_DETAIL_COLUMN_NAMES.map(
  (c) => `${c} = excluded.${c}`
).join(", ");
const PR_DETAIL_SET = PR_DETAIL_COLUMN_NAMES.map((c) => `${c} = @${c}`).join(", ");

export type PrStatusDeltas = {
  branches: Map<string, PrSummary | null>;
  commits: Map<string, PrSummary | null>;
};

/**
 * Fetches change-request status for a repo's branches and caches it in
 * branch_pr. Best-effort: silently no-ops when `origin` is on a host no
 * provider claims, the CLI isn't logged in, or the network fails — cached data
 * just stays put.
 *
 * Everything here is forge-agnostic. Which forge answers is decided once per
 * call by `resolveForge`, and the provider it returns speaks only in
 * `PrSummary`, so GitLab merge requests flow through the same cache, deltas,
 * and TTLs as GitHub pull requests.
 */
export class PrService {
  private readonly resolveForge: typeof resolveForge;
  private readonly now: () => number;
  private writeGeneration = 0;
  // A bulk lookup and a focused branch lookup may overlap for the same repo.
  // They must share one request: otherwise an older bulk response can land
  // after the focused response and overwrite its newer PR state.
  private readonly pendingRepoRefreshes = new Map<
    string,
    Promise<Map<string, PrSummary | null>>
  >();
  private readonly pendingCommitRefreshes = new Map<
    string,
    Promise<Map<string, PrSummary | null>>
  >();
  private readonly pendingPrNumberRefreshes = new Map<
    string,
    Promise<PrStatusDeltas>
  >();
  /**
   * When a repo's last refresh could not finish, per repository and scope.
   *
   * A refusal writes no row — see "A refusal is not an answer" in
   * ../forge/AGENTS.md — so the `fetched_at` every TTL checks reads exactly as
   * it did before the attempt, and nothing throttles the retry: every repo-row
   * expand, hover and worktree-monitor replacement re-enters the network path,
   * and the callers queued behind an in-flight refresh each start an attempt of
   * their own when it settles. Remembering the *attempt* in memory is the fix,
   * rather than writing a row that would claim the branch has no change
   * request. Same shape as the signed-out backoff in
   * ../forge/identity-service.ts, and same reason: never negative-cache a
   * failure, but do remember that you tried.
   *
   * Keyed by repository so `forget` is one delete, and within it by scope
   * because a whole-repo sweep and a one-branch hover are different questions —
   * see `BranchFailureScope`.
   */
  private readonly lastFailedAt = new Map<string, Map<FailureScope, number>>();

  constructor(
    private readonly db: DB,
    private readonly git: GitExec,
    deps: PrServiceDeps = {}
  ) {
    this.resolveForge = deps.resolveForge ?? resolveForge;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Prevent every refresh already in flight from writing its response. Profile
   * deletion calls this after its database transaction; using a generation
   * instead of an existence-only check also protects an immediately recreated
   * profile/repository that reuses the same stable ids.
   */
  invalidatePendingWrites(): void {
    this.writeGeneration += 1;
    // A recreated profile reusing these ids should get a fresh attempt, not
    // the deleted one's backoff. The generation guard on every mark write is
    // the other half: a refresh already in flight must not re-arm what this
    // just cleared.
    this.lastFailedAt.clear();
  }

  /** Exact commit hashes whose PR association/status changed. */
  async refreshCommits(
    repoId: string,
    commitHashes: string[],
    opts: { trigger?: PrRefreshTrigger; force?: boolean } = {}
  ): Promise<Map<string, PrSummary | null>> {
    return await this.refreshCommitsAtGeneration(
      repoId,
      commitHashes,
      opts,
      this.writeGeneration
    );
  }

  private async refreshCommitsAtGeneration(
    repoId: string,
    commitHashes: string[],
    opts: { trigger?: PrRefreshTrigger; force?: boolean },
    generation: number
  ): Promise<Map<string, PrSummary | null>> {
    const hashes = normalizeCommitHashes(commitHashes);
    if (hashes.length === 0 || !this.isCurrent(generation)) return new Map();

    const pendingStatus = this.pendingPrNumberRefreshes.get(repoId);
    if (pendingStatus !== undefined) {
      await pendingStatus;
      if (!this.isCurrent(generation)) return new Map();
      return await this.refreshCommitsAtGeneration(
        repoId,
        hashes,
        opts,
        generation
      );
    }

    // Serialize per repo. A hover arriving during a viewport batch waits for
    // that batch, then its TTL check fetches only anything the batch missed.
    const pending = this.pendingCommitRefreshes.get(repoId);
    if (pending !== undefined) {
      await pending;
      if (!this.isCurrent(generation)) return new Map();
      return await this.refreshCommitsAtGeneration(
        repoId,
        hashes,
        opts,
        generation
      );
    }

    const refresh = this.refreshCommitHashes(repoId, hashes, opts, generation);
    this.pendingCommitRefreshes.set(repoId, refresh);
    try {
      return await refresh;
    } finally {
      this.pendingCommitRefreshes.delete(repoId);
    }
  }

  /** Cached rows only; omitted hashes have never been looked up. */
  cachedCommitPrs(
    repoId: string,
    commitHashes: string[]
  ): Map<string, PrSummary | null> {
    const hashes = normalizeCommitHashes(commitHashes);
    if (hashes.length === 0) return new Map();
    const marks = hashes.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT commit_sha, number, url, title, state, is_draft, ${PR_DETAIL_COLUMNS_SQL}
         FROM commit_pr WHERE repo_id = ? AND commit_sha IN (${marks})`
      )
      .all(repoId, ...hashes) as (CachedPr & { commit_sha: string })[];
    return new Map(rows.map((row) => [row.commit_sha, summaryFromCached(row)]));
  }

  cachedBranchPr(repoId: string, branch: string): PrSummary | null | undefined {
    const row = this.db
      .prepare(
        `SELECT number, url, title, state, is_draft, ${PR_DETAIL_COLUMNS_SQL}
         FROM branch_pr WHERE repo_id = ? AND branch = ?`
      )
      .get(repoId, branch) as CachedPr | undefined;
    return row === undefined ? undefined : summaryFromCached(row);
  }

  ownsWorktree(repoId: string, worktreeId: string): boolean {
    return this.db
      .prepare("SELECT 1 FROM worktrees WHERE id = ? AND repo_id = ?")
      .get(worktreeId, repoId) !== undefined;
  }

  ownsWorktreeBranch(repoId: string, worktreeId: string, branch: string): boolean {
    return this.db
      .prepare(
        "SELECT 1 FROM worktrees WHERE id = ? AND repo_id = ? AND branch = ?"
      )
      .get(worktreeId, repoId, branch) !== undefined;
  }

  /** Refresh each discovered PR once, then fan its status out to every cache key. */
  async refreshPrNumbers(
    repoId: string,
    numbers: number[]
  ): Promise<PrStatusDeltas> {
    return await this.refreshPrNumbersAtGeneration(
      repoId,
      numbers,
      this.writeGeneration
    );
  }

  private async refreshPrNumbersAtGeneration(
    repoId: string,
    numbers: number[],
    generation: number
  ): Promise<PrStatusDeltas> {
    const unique = [...new Set(numbers)].filter(
      (number) => Number.isSafeInteger(number) && number > 0
    );
    if (unique.length === 0 || !this.isCurrent(generation)) {
      return emptyPrStatusDeltas();
    }

    const pending: Promise<unknown>[] = [];
    const pendingRepo = this.pendingRepoRefreshes.get(repoId);
    const pendingCommits = this.pendingCommitRefreshes.get(repoId);
    const pendingNumbers = this.pendingPrNumberRefreshes.get(repoId);
    if (pendingRepo !== undefined) pending.push(pendingRepo);
    if (pendingCommits !== undefined) pending.push(pendingCommits);
    if (pendingNumbers !== undefined) pending.push(pendingNumbers);
    if (pending.length > 0) {
      await Promise.all(pending);
      if (!this.isCurrent(generation)) return emptyPrStatusDeltas();
      return await this.refreshPrNumbersAtGeneration(
        repoId,
        unique,
        generation
      );
    }

    const refresh = this.refreshPrNumberStatuses(repoId, unique, generation);
    this.pendingPrNumberRefreshes.set(repoId, refresh);
    try {
      return await refresh;
    } finally {
      this.pendingPrNumberRefreshes.delete(repoId);
    }
  }

  private async refreshPrNumberStatuses(
    repoId: string,
    numbers: number[],
    generation: number
  ): Promise<PrStatusDeltas> {
    const repo = this.db
      .prepare("SELECT path FROM repos WHERE id = ?")
      .get(repoId) as { path: string } | undefined;
    if (repo === undefined) return emptyPrStatusDeltas();
    const forge = await this.originForge(repo.path);
    if (forge === null || !this.isCurrent(generation)) {
      return emptyPrStatusDeltas();
    }
    const connection = await connectForge(forge.provider, forge.repo.host);
    if (connection === null || !this.isCurrent(generation)) {
      return emptyPrStatusDeltas();
    }
    try {
      const prs = await connection.fetchPrsByNumbers(
        forge.repo,
        numbers
      );
      return this.upsertPrNumberStatuses(repoId, prs, generation);
    } catch {
      return emptyPrStatusDeltas();
    }
  }

  private async refreshCommitHashes(
    repoId: string,
    commitHashes: string[],
    opts: { trigger?: PrRefreshTrigger; force?: boolean },
    generation: number
  ): Promise<Map<string, PrSummary | null>> {
    const repo = this.db
      .prepare("SELECT path FROM repos WHERE id = ?")
      .get(repoId) as { path: string } | undefined;
    if (repo === undefined) return new Map();
    const stale = opts.force === true
      ? commitHashes
      : this.staleCommitHashes(repoId, commitHashes, opts.trigger);
    if (stale.length === 0) return new Map();
    // Same throttle as the branch path, sharing its one TTL spelling. Only a
    // *total* failure is remembered here: commit freshness is per hash, so a
    // partly answered batch writes rows and shrinks the next `stale` set by
    // itself — real forward progress the branch path cannot make.
    if (
      opts.force !== true &&
      this.failedWithin(repoId, "commits", this.failureTtlMs("commits", opts.trigger))
    ) {
      return new Map();
    }

    const forge = await this.originForge(repo.path);
    if (forge === null || !this.isCurrent(generation)) return new Map();
    const connection = await connectForge(forge.provider, forge.repo.host);
    if (connection === null || !this.isCurrent(generation)) return new Map();

    let prs: Map<string, PrSummary | null>;
    try {
      prs = await connection.fetchPrsForCommits(forge.repo, stale);
    } catch {
      this.recordFailure(repoId, "commits", generation);
      return new Map();
    }
    // Only the fetch belongs in the `try`. A SQLITE_BUSY raised inside
    // `upsertCommits` — it transacts over up to 200 hashes while other writers
    // are live — would otherwise be recorded as a refusal by a forge that
    // answered correctly, silencing this repo's associations for the window.
    this.clearFailure(repoId, "commits", generation);
    return this.upsertCommits(repoId, prs, generation);
  }

  private staleCommitHashes(
    repoId: string,
    commitHashes: string[],
    trigger?: PrRefreshTrigger
  ): string[] {
    const marks = commitHashes.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT commit_sha, state, fetched_at FROM commit_pr
         WHERE repo_id = ? AND commit_sha IN (${marks})`
      )
      .all(repoId, ...commitHashes) as {
      commit_sha: string;
      state: string | null;
      fetched_at: string;
    }[];
    const cached = new Map(rows.map((row) => [row.commit_sha, row] as const));
    return commitHashes.filter((hash) => {
      const row = cached.get(hash);
      if (row === undefined) return true;
      const terminal = row.state === "merged" || row.state === "closed";
      const ttl = trigger === "user"
        ? terminal
          ? TERMINAL_USER_BRANCH_REFRESH_TTL_MS
          : USER_BRANCH_REFRESH_TTL_MS
        : SCHEDULED_BRANCH_REFRESH_TTL_MS;
      const fetchedAt = Date.parse(row.fetched_at);
      return !Number.isFinite(fetchedAt) || fetchedAt <= this.now() - ttl;
    });
  }

  /** Returns the branches whose PR state changed (empty = nothing to publish). */
  async refreshRepo(
    repoId: string,
    opts: {
      branches?: string[];
      trigger?: PrRefreshTrigger;
      force?: boolean;
    } = {}
  ): Promise<Map<string, PrSummary | null>> {
    return await this.refreshRepoAtGeneration(
      repoId,
      opts,
      this.writeGeneration
    );
  }

  private async refreshRepoAtGeneration(
    repoId: string,
    opts: {
      branches?: string[];
      trigger?: PrRefreshTrigger;
      force?: boolean;
    },
    generation: number
  ): Promise<Map<string, PrSummary | null>> {
    if (!this.isCurrent(generation)) return new Map();
    // Ahead of `branchesToCheck`, which spawns `git for-each-ref`: a throttled
    // refresh must cost no subprocess either. Every caller queued behind an
    // in-flight refresh recurses back through here when it settles, so this is
    // also where they see a mark the refresh they waited on just wrote.
    const scope = branchFailureScope(opts);
    if (
      opts.force !== true &&
      this.failedWithin(repoId, scope, this.failureTtlMs(scope, opts.trigger))
    ) {
      return new Map();
    }
    const branches = await this.branchesToCheck(repoId, opts.branches);
    if (branches.length === 0 || !this.isCurrent(generation)) return new Map();
    const pendingStatus = this.pendingPrNumberRefreshes.get(repoId);
    if (pendingStatus !== undefined) {
      await pendingStatus;
      if (!this.isCurrent(generation)) return new Map();
      return await this.refreshRepoAtGeneration(repoId, opts, generation);
    }
    const pending = this.pendingRepoRefreshes.get(repoId);
    if (pending !== undefined) {
      await pending;
      if (!this.isCurrent(generation)) return new Map();
      return await this.refreshRepoAtGeneration(repoId, opts, generation);
    }

    const refresh = this.refreshBranches(repoId, branches, opts, generation);
    this.pendingRepoRefreshes.set(repoId, refresh);
    try {
      return await refresh;
    } finally {
      this.pendingRepoRefreshes.delete(repoId);
    }
  }

  private async refreshBranches(
    repoId: string,
    branches: string[],
    opts: {
      branches?: string[];
      trigger?: PrRefreshTrigger;
      force?: boolean;
    },
    generation: number
  ): Promise<Map<string, PrSummary | null>> {
    const empty = new Map<string, PrSummary | null>();
    const repo = this.db
      .prepare("SELECT path FROM repos WHERE id = ?")
      .get(repoId) as { path: string } | undefined;
    if (repo === undefined) return empty;
    // The failure throttle is checked by the caller, above `branchesToCheck`.
    if (
      opts.force !== true &&
      this.isFresh(repoId, branches, this.refreshTtlMs(repoId, branches, opts))
    ) {
      return empty;
    }
    const scope = branchFailureScope(opts);

    const forge = await this.originForge(repo.path);
    if (forge === null || !this.isCurrent(generation)) return empty;
    const connection = await connectForge(forge.provider, forge.repo.host);
    if (connection === null || !this.isCurrent(generation)) return empty;

    let prs: Map<string, PrSummary | null>;
    try {
      prs = await connection.fetchPrsForBranches(
        forge.repo,
        branches
      );
    } catch {
      // Best-effort; keep whatever's cached — but remember the attempt, or
      // nothing throttles the next one.
      this.recordFailure(repoId, scope, generation);
      return empty;
    }
    // A batched client answers what it could and omits the chunks it never
    // reached, so a partial answer counts as a failed attempt too: `isFresh`
    // is all-or-nothing, so one omitted branch leaves the whole repo stale and
    // the next trigger would re-send every batch. The batches that *did*
    // resolve are still written below — that is the forward progress.
    if (branches.every((branch) => prs.has(branch))) {
      this.clearFailure(repoId, scope, generation);
    } else {
      this.recordFailure(repoId, scope, generation);
    }
    return this.upsert(repoId, prs, generation);
  }

  /** Did the last attempt at this scope fail inside the window it earned? */
  private failedWithin(
    repoId: string,
    scope: FailureScope,
    ttlMs: number
  ): boolean {
    const failedAt = this.lastFailedAt.get(repoId)?.get(scope);
    if (failedAt === undefined) return false;
    const now = this.now();
    // A mark from the future is a backward wall-clock step (NTP, a corrected
    // timezone, a wake from sleep), not a fresh failure. Without the upper
    // bound it suppresses every refresh until the clock catches up, which
    // `force` is the only escape from — and nothing in the renderer sends it.
    // `isFresh` guards its stored timestamps the same way.
    return failedAt <= now && failedAt > now - ttlMs;
  }

  /** Generation-guarded, so a refresh that was in flight when the profile was
   *  deleted cannot re-arm the backoff `invalidatePendingWrites` just cleared. */
  private recordFailure(
    repoId: string,
    scope: FailureScope,
    generation: number
  ): void {
    if (!this.isCurrent(generation)) return;
    const scopes = this.lastFailedAt.get(repoId) ?? new Map<FailureScope, number>();
    scopes.set(scope, this.now());
    this.lastFailedAt.set(repoId, scopes);
  }

  private clearFailure(
    repoId: string,
    scope: FailureScope,
    generation: number
  ): void {
    if (!this.isCurrent(generation)) return;
    const scopes = this.lastFailedAt.get(repoId);
    if (scopes === undefined) return;
    scopes.delete(scope);
    if (scopes.size === 0) this.lastFailedAt.delete(repoId);
  }

  /**
   * Drop a removed repository's backoff.
   *
   * Repo ids are `sha1(path)` (`RepoIndexer`), so they are stable and reused: a
   * checkout pruned by a scan and re-indexed minutes later, or removed and
   * re-added by hand, would otherwise inherit the dead row's throttle — the
   * same hazard `IdentityService.forget` exists for.
   */
  forget(repoId: string): void {
    this.lastFailedAt.delete(repoId);
  }

  /**
   * How long an attempt of this shape is not worth repeating once it failed:
   * the TTL a successful one would have earned.
   *
   * `refreshTtlMs`'s terminal-state refinement is deliberately absent. That
   * refinement asks whether the *cached* rows are all merged/closed, and a
   * refusal cached nothing — so there is no terminal state to be slow about,
   * and the unrefined value is the shorter, retry-sooner half anyway. Both the
   * branch and commit paths read this one spelling, so a TTL change cannot
   * reach the freshness check and miss the throttle.
   */
  private failureTtlMs(
    scope: FailureScope,
    trigger?: PrRefreshTrigger
  ): number {
    if (trigger === "user") return USER_BRANCH_REFRESH_TTL_MS;
    // Keyed off the scope, not off `opts.branches` being absent: the commit
    // path has no branch list at all, and reading its absence as "whole repo"
    // would hand commit association the ten-minute sweep window.
    return scope === "branches:all"
      ? REPO_REFRESH_TTL_MS
      : SCHEDULED_BRANCH_REFRESH_TTL_MS;
  }

  private refreshTtlMs(
    repoId: string,
    branches: string[],
    opts: { branches?: string[]; trigger?: PrRefreshTrigger }
  ): number {
    if (opts.trigger === "user") {
      return this.hasOnlyTerminalPrs(repoId, branches)
        ? TERMINAL_USER_BRANCH_REFRESH_TTL_MS
        : USER_BRANCH_REFRESH_TTL_MS;
    }
    return opts.branches === undefined
      ? REPO_REFRESH_TTL_MS
      : SCHEDULED_BRANCH_REFRESH_TTL_MS;
  }

  private isFresh(repoId: string, branches: string[], ttlMs: number): boolean {
    const fetchedAtByBranch = new Map(
      (
        this.db
          .prepare("SELECT branch, fetched_at FROM branch_pr WHERE repo_id = ?")
          .all(repoId) as { branch: string; fetched_at: string }[]
      ).map((row) => [row.branch, Date.parse(row.fetched_at)] as const)
    );
    const oldestAllowed = this.now() - ttlMs;
    return branches.every((branch) => {
      const fetchedAt = fetchedAtByBranch.get(branch);
      return (
        fetchedAt !== undefined &&
        Number.isFinite(fetchedAt) &&
        fetchedAt > oldestAllowed
      );
    });
  }

  private hasOnlyTerminalPrs(repoId: string, branches: string[]): boolean {
    const cached = new Map(
      (
        this.db
          .prepare("SELECT branch, state FROM branch_pr WHERE repo_id = ?")
          .all(repoId) as { branch: string; state: string | null }[]
      ).map((row) => [row.branch, row.state] as const)
    );
    return (
      branches.length > 0 &&
      branches.every((branch) => {
        const state = cached.get(branch);
        return state === "merged" || state === "closed";
      })
    );
  }

  private async originForge(repoPath: string): Promise<ResolvedForge | null> {
    const out = await this.git(["remote", "get-url", "origin"], repoPath);
    if (!out.ok || out.value.exitCode !== 0) return null;
    return this.resolveForge(out.value.stdout);
  }

  private async branchesToCheck(
    repoId: string,
    requested?: string[]
  ): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT DISTINCT branch FROM worktrees WHERE repo_id = ?")
      .all(repoId) as { branch: string }[];
    const worktreeBranches = rows
      .map((r) => r.branch)
      .filter((b) => b !== "" && b !== "HEAD" && !b.startsWith("detached@"));
    const repo = this.db
      .prepare("SELECT path FROM repos WHERE id = ?")
      .get(repoId) as { path: string } | undefined;
    let localBranches: string[] = [];
    if (repo !== undefined) {
      const refs = await this.git(
        ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        repo.path
      );
      if (refs.ok && refs.value.exitCode === 0) {
        localBranches = refs.value.stdout
          .split("\n")
          .map((branch) => branch.trim())
          .filter((branch) => branch !== "");
      }
    }
    // Worktree rows remain a fallback when ref discovery fails, and also cover
    // a branch checked out in a linked worktree whose ref view is momentarily
    // changing. Local non-worktree branches matter because squash/rebase merges
    // cannot be recognized by ancestry alone in the Active graph.
    const branches = [...new Set([...worktreeBranches, ...localBranches])];
    if (requested === undefined) return branches;
    const available = new Set(branches);
    return [...new Set(requested)].filter((branch) => available.has(branch));
  }

  private upsert(
    repoId: string,
    prs: Map<string, PrSummary | null>,
    generation: number
  ): Map<string, PrSummary | null> {
    if (!this.canWrite(repoId, generation)) return new Map();
    const prev = new Map<string, CachedPr>(
      (
        this.db
          .prepare(
            `SELECT branch, number, url, title, state, is_draft, ${PR_DETAIL_COLUMNS_SQL} FROM branch_pr WHERE repo_id = ?`
          )
          .all(repoId) as (CachedPr & { branch: string })[]
      ).map(({ branch, ...pr }) => [branch, pr] as const)
    );
    const stmt = this.db.prepare(
      `INSERT INTO branch_pr
         (repo_id, branch, number, url, title, state, is_draft, ${PR_DETAIL_COLUMNS_SQL}, fetched_at)
       VALUES
         (@repo_id, @branch, @number, @url, @title, @state, @is_draft, ${PR_DETAIL_PARAMS}, @fetched_at)
       ON CONFLICT(repo_id, branch) DO UPDATE SET
         number = excluded.number, url = excluded.url, title = excluded.title,
         state = excluded.state, is_draft = excluded.is_draft,
         ${PR_DETAIL_ASSIGNMENTS},
         fetched_at = excluded.fetched_at`
    );
    const now = new Date(this.now()).toISOString();
    const changed = new Map<string, PrSummary | null>();
    this.db.transaction(() => {
      for (const [branch, pr] of prs) {
        const before = prev.get(branch);
        const next = cachedFromSummary(pr);
        if (!sameCachedPr(before, next)) changed.set(branch, pr);
        stmt.run({
          repo_id: repoId,
          branch,
          ...next,
          fetched_at: now
        });
      }
    })();
    return changed;
  }

  private upsertCommits(
    repoId: string,
    prs: Map<string, PrSummary | null>,
    generation: number
  ): Map<string, PrSummary | null> {
    if (!this.canWrite(repoId, generation)) return new Map();
    const hashes = [...prs.keys()];
    const prev = new Map<string, CachedPr>();
    if (hashes.length > 0) {
      const marks = hashes.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT commit_sha, number, url, title, state, is_draft, ${PR_DETAIL_COLUMNS_SQL}
           FROM commit_pr WHERE repo_id = ? AND commit_sha IN (${marks})`
        )
        .all(repoId, ...hashes) as (CachedPr & { commit_sha: string })[];
      for (const { commit_sha, ...cached } of rows) prev.set(commit_sha, cached);
    }
    const stmt = this.db.prepare(
      `INSERT INTO commit_pr
         (repo_id, commit_sha, number, url, title, state, is_draft, ${PR_DETAIL_COLUMNS_SQL}, fetched_at)
       VALUES
         (@repo_id, @commit_sha, @number, @url, @title, @state, @is_draft, ${PR_DETAIL_PARAMS}, @fetched_at)
       ON CONFLICT(repo_id, commit_sha) DO UPDATE SET
         number = excluded.number, url = excluded.url, title = excluded.title,
         state = excluded.state, is_draft = excluded.is_draft,
         ${PR_DETAIL_ASSIGNMENTS},
         fetched_at = excluded.fetched_at`
    );
    const now = new Date(this.now()).toISOString();
    const changed = new Map<string, PrSummary | null>();
    this.db.transaction(() => {
      for (const [commitSha, pr] of prs) {
        const before = prev.get(commitSha);
        const next = cachedFromSummary(pr);
        if (!sameCachedPr(before, next)) changed.set(commitSha, pr);
        stmt.run({ repo_id: repoId, commit_sha: commitSha, ...next, fetched_at: now });
      }
    })();
    return changed;
  }

  private upsertPrNumberStatuses(
    repoId: string,
    prs: Map<number, PrSummary | null>,
    generation: number
  ): PrStatusDeltas {
    if (!this.canWrite(repoId, generation)) return emptyPrStatusDeltas();
    const numbers = [...prs.keys()];
    if (numbers.length === 0) return emptyPrStatusDeltas();
    const marks = numbers.map(() => "?").join(", ");
    const branchRows = this.db
      .prepare(
        `SELECT branch, number, url, title, state, is_draft, ${PR_DETAIL_COLUMNS_SQL}
         FROM branch_pr WHERE repo_id = ? AND number IN (${marks})`
      )
      .all(repoId, ...numbers) as (CachedPr & { branch: string; number: number })[];
    const commitRows = this.db
      .prepare(
        `SELECT commit_sha, number, url, title, state, is_draft, ${PR_DETAIL_COLUMNS_SQL}
         FROM commit_pr WHERE repo_id = ? AND number IN (${marks})`
      )
      .all(repoId, ...numbers) as (CachedPr & {
        commit_sha: string;
        number: number;
      })[];
    const updateBranch = this.db.prepare(
      `UPDATE branch_pr SET url = @url, title = @title, state = @state,
         is_draft = @is_draft, ${PR_DETAIL_SET}
       WHERE repo_id = @repo_id AND branch = @key`
    );
    const updateCommit = this.db.prepare(
      `UPDATE commit_pr SET url = @url, title = @title, state = @state,
         is_draft = @is_draft, ${PR_DETAIL_SET}
       WHERE repo_id = @repo_id AND commit_sha = @key`
    );
    const changed = emptyPrStatusDeltas();
    this.db.transaction(() => {
      const apply = (
        rows: Array<CachedPr & { number: number }>,
        keyOf: (row: CachedPr & { number: number }) => string,
        output: Map<string, PrSummary | null>,
        update: ReturnType<DB["prepare"]>
      ): void => {
        for (const row of rows) {
          const pr = prs.get(row.number);
          if (pr == null) continue;
          const next = cachedFromSummary(pr);
          const key = keyOf(row);
          if (!sameCachedPr(row, next)) output.set(key, pr);
          update.run({ repo_id: repoId, key, ...next });
        }
      };
      apply(
        branchRows,
        (row) => (row as typeof branchRows[number]).branch,
        changed.branches,
        updateBranch
      );
      apply(
        commitRows,
        (row) => (row as typeof commitRows[number]).commit_sha,
        changed.commits,
        updateCommit
      );
    })();
    return changed;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.writeGeneration;
  }

  private canWrite(repoId: string, generation: number): boolean {
    return (
      this.isCurrent(generation) &&
      this.db.prepare("SELECT 1 FROM repos WHERE id = ?").get(repoId) !==
        undefined
    );
  }
}

/** A whole-repo sweep and a targeted refresh back off independently. */
function branchFailureScope(opts: { branches?: string[] }): FailureScope {
  return opts.branches === undefined ? "branches:all" : "branches:targeted";
}

function normalizeCommitHashes(commitHashes: string[]): string[] {
  return [...new Set(commitHashes.map((hash) => hash.trim().toLowerCase()))]
    .filter((hash) => /^[0-9a-f]{40}$/.test(hash));
}

function cachedFromSummary(pr: PrSummary | null): CachedPr {
  return {
    number: pr?.number ?? null,
    url: pr?.url ?? null,
    title: pr?.title ?? null,
    state: pr?.state ?? null,
    is_draft: pr?.isDraft === true ? 1 : 0,
    check_state: pr?.checkState ?? null,
    checks_still_running: pr?.checksStillRunning === undefined ? null : Number(pr.checksStillRunning),
    merge_state: pr?.mergeState ?? null,
    forge: pr?.forge ?? null,
    host: pr?.host ?? null,
    repo_path: pr?.repoPath ?? null,
    head_ref: pr?.headRefName ?? null,
    base_ref: pr?.baseRefName ?? null,
    additions: pr?.additions ?? null,
    deletions: pr?.deletions ?? null,
    changed_files: pr?.changedFiles ?? null,
    commit_count: pr?.commitCount ?? null,
    opened_at: pr?.createdAt ?? null,
    merged_at: pr?.mergedAt ?? null,
    closed_at: pr?.closedAt ?? null
  };
}

function sameCachedPr(before: CachedPr | undefined, next: CachedPr): boolean {
  if (before === undefined) return false;
  return (
    before.number === next.number &&
    before.url === next.url &&
    before.title === next.title &&
    before.state === next.state &&
    before.is_draft === next.is_draft &&
    PR_DETAIL_COLUMN_NAMES.every((column) => before[column] === next[column])
  );
}

/** One mapper for both tables and for the joined reads in repo-indexer. */
function summaryFromCached(cached: CachedPr): PrSummary | null {
  return prSummaryFromRow(cached as unknown as Record<string, unknown>, "") ?? null;
}

function emptyPrStatusDeltas(): PrStatusDeltas {
  return { branches: new Map(), commits: new Map() };
}
