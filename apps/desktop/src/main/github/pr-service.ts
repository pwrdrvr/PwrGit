import type { PrSummary } from "@pwrgit/shared";
import type { GitExec } from "../git/dugite";
import type { DB } from "../persistence/db";
import {
  fetchPrsByNumbers,
  fetchPrsForCommits,
  fetchPrsForRepo,
  getGitHubToken
} from "./pr-client";
import { parseGitHubRemote, type GitHubRepo } from "./remote";

const REPO_REFRESH_TTL_MS = 10 * 60_000;
const SCHEDULED_BRANCH_REFRESH_TTL_MS = 60_000;
const USER_BRANCH_REFRESH_TTL_MS = 10_000;
const TERMINAL_USER_BRANCH_REFRESH_TTL_MS = 60_000;

type PrRefreshTrigger = "scheduled" | "user";

type PrServiceDeps = {
  getGitHubToken?: typeof getGitHubToken;
  fetchPrsForRepo?: typeof fetchPrsForRepo;
  fetchPrsForCommits?: typeof fetchPrsForCommits;
  fetchPrsByNumbers?: typeof fetchPrsByNumbers;
  now?: () => number;
};

type CachedPr = {
  number: number | null;
  url: string | null;
  title: string | null;
  state: string | null;
  is_draft: number;
};

export type PrStatusDeltas = {
  branches: Map<string, PrSummary | null>;
  commits: Map<string, PrSummary | null>;
};

/**
 * Fetches GitHub PR status for a repo's branches and caches it in branch_pr.
 * Best-effort: silently no-ops when origin isn't github.com, gh isn't logged in,
 * or the network fails — cached data just stays put.
 */
export class PrService {
  private readonly getToken: typeof getGitHubToken;
  private readonly fetchPrs: typeof fetchPrsForRepo;
  private readonly fetchCommitPrs: typeof fetchPrsForCommits;
  private readonly fetchPrNumbers: typeof fetchPrsByNumbers;
  private readonly now: () => number;
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

  constructor(
    private readonly db: DB,
    private readonly git: GitExec,
    deps: PrServiceDeps = {}
  ) {
    this.getToken = deps.getGitHubToken ?? getGitHubToken;
    this.fetchPrs = deps.fetchPrsForRepo ?? fetchPrsForRepo;
    this.fetchCommitPrs = deps.fetchPrsForCommits ?? fetchPrsForCommits;
    this.fetchPrNumbers = deps.fetchPrsByNumbers ?? fetchPrsByNumbers;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Exact commit hashes whose PR association/status changed. */
  async refreshCommits(
    repoId: string,
    commitHashes: string[],
    opts: { trigger?: PrRefreshTrigger; force?: boolean } = {}
  ): Promise<Map<string, PrSummary | null>> {
    const hashes = normalizeCommitHashes(commitHashes);
    if (hashes.length === 0) return new Map();

    const pendingStatus = this.pendingPrNumberRefreshes.get(repoId);
    if (pendingStatus !== undefined) {
      await pendingStatus;
      return await this.refreshCommits(repoId, hashes, opts);
    }

    // Serialize per repo. A hover arriving during a viewport batch waits for
    // that batch, then its TTL check fetches only anything the batch missed.
    const pending = this.pendingCommitRefreshes.get(repoId);
    if (pending !== undefined) {
      await pending;
      return await this.refreshCommits(repoId, hashes, opts);
    }

    const refresh = this.refreshCommitHashes(repoId, hashes, opts);
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
        `SELECT commit_sha, number, url, title, state, is_draft
         FROM commit_pr WHERE repo_id = ? AND commit_sha IN (${marks})`
      )
      .all(repoId, ...hashes) as (CachedPr & { commit_sha: string })[];
    return new Map(rows.map((row) => [row.commit_sha, summaryFromCached(row)]));
  }

  cachedBranchPr(repoId: string, branch: string): PrSummary | null | undefined {
    const row = this.db
      .prepare(
        `SELECT number, url, title, state, is_draft
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
    const unique = [...new Set(numbers)].filter(
      (number) => Number.isSafeInteger(number) && number > 0
    );
    if (unique.length === 0) return emptyPrStatusDeltas();

    const pending: Promise<unknown>[] = [];
    const pendingRepo = this.pendingRepoRefreshes.get(repoId);
    const pendingCommits = this.pendingCommitRefreshes.get(repoId);
    const pendingNumbers = this.pendingPrNumberRefreshes.get(repoId);
    if (pendingRepo !== undefined) pending.push(pendingRepo);
    if (pendingCommits !== undefined) pending.push(pendingCommits);
    if (pendingNumbers !== undefined) pending.push(pendingNumbers);
    if (pending.length > 0) {
      await Promise.all(pending);
      return await this.refreshPrNumbers(repoId, unique);
    }

    const refresh = this.refreshPrNumberStatuses(repoId, unique);
    this.pendingPrNumberRefreshes.set(repoId, refresh);
    try {
      return await refresh;
    } finally {
      this.pendingPrNumberRefreshes.delete(repoId);
    }
  }

  private async refreshPrNumberStatuses(
    repoId: string,
    numbers: number[]
  ): Promise<PrStatusDeltas> {
    const repo = this.db
      .prepare("SELECT path FROM repos WHERE id = ?")
      .get(repoId) as { path: string } | undefined;
    if (repo === undefined) return emptyPrStatusDeltas();
    const remote = await this.originRemote(repo.path);
    if (remote === null) return emptyPrStatusDeltas();
    const token = await this.getToken();
    if (token === null) return emptyPrStatusDeltas();
    try {
      const prs = await this.fetchPrNumbers(token, remote.owner, remote.repo, numbers);
      return this.upsertPrNumberStatuses(repoId, prs);
    } catch {
      return emptyPrStatusDeltas();
    }
  }

  private async refreshCommitHashes(
    repoId: string,
    commitHashes: string[],
    opts: { trigger?: PrRefreshTrigger; force?: boolean }
  ): Promise<Map<string, PrSummary | null>> {
    const repo = this.db
      .prepare("SELECT path FROM repos WHERE id = ?")
      .get(repoId) as { path: string } | undefined;
    if (repo === undefined) return new Map();
    const stale = opts.force === true
      ? commitHashes
      : this.staleCommitHashes(repoId, commitHashes, opts.trigger);
    if (stale.length === 0) return new Map();

    const remote = await this.originRemote(repo.path);
    if (remote === null) return new Map();
    const token = await this.getToken();
    if (token === null) return new Map();

    try {
      const prs = await this.fetchCommitPrs(
        token,
        remote.owner,
        remote.repo,
        stale
      );
      return this.upsertCommits(repoId, prs);
    } catch {
      return new Map();
    }
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
    const branches = await this.branchesToCheck(repoId, opts.branches);
    if (branches.length === 0) return new Map();
    const pendingStatus = this.pendingPrNumberRefreshes.get(repoId);
    if (pendingStatus !== undefined) {
      await pendingStatus;
      return await this.refreshRepo(repoId, opts);
    }
    const pending = this.pendingRepoRefreshes.get(repoId);
    if (pending !== undefined) {
      await pending;
      return await this.refreshRepo(repoId, opts);
    }

    const refresh = this.refreshBranches(repoId, branches, opts);
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
    }
  ): Promise<Map<string, PrSummary | null>> {
    const empty = new Map<string, PrSummary | null>();
    const repo = this.db
      .prepare("SELECT path FROM repos WHERE id = ?")
      .get(repoId) as { path: string } | undefined;
    if (repo === undefined) return empty;
    if (
      opts.force !== true &&
      this.isFresh(repoId, branches, this.refreshTtlMs(repoId, branches, opts))
    ) {
      return empty;
    }

    const remote = await this.originRemote(repo.path);
    if (remote === null) return empty;
    const token = await this.getToken();
    if (token === null) return empty;

    let prs: Map<string, PrSummary | null>;
    try {
      prs = await this.fetchPrs(token, remote.owner, remote.repo, branches);
    } catch {
      return empty; // best-effort; keep whatever's cached
    }
    return this.upsert(repoId, prs);
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

  private async originRemote(repoPath: string): Promise<GitHubRepo | null> {
    const out = await this.git(["remote", "get-url", "origin"], repoPath);
    if (!out.ok || out.value.exitCode !== 0) return null;
    return parseGitHubRemote(out.value.stdout);
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
    prs: Map<string, PrSummary | null>
  ): Map<string, PrSummary | null> {
    const prev = new Map<string, CachedPr>(
      (
        this.db
          .prepare(
            "SELECT branch, number, url, title, state, is_draft FROM branch_pr WHERE repo_id = ?"
          )
          .all(repoId) as {
          branch: string;
          number: CachedPr["number"];
          url: CachedPr["url"];
          title: CachedPr["title"];
          state: CachedPr["state"];
          is_draft: CachedPr["is_draft"];
        }[]
      ).map(({ branch, ...pr }) => [branch, pr] as const)
    );
    const stmt = this.db.prepare(
      `INSERT INTO branch_pr (repo_id, branch, number, url, title, state, is_draft, fetched_at)
       VALUES (@repo_id, @branch, @number, @url, @title, @state, @is_draft, @fetched_at)
       ON CONFLICT(repo_id, branch) DO UPDATE SET
         number = excluded.number, url = excluded.url, title = excluded.title,
         state = excluded.state, is_draft = excluded.is_draft,
         fetched_at = excluded.fetched_at`
    );
    const now = new Date(this.now()).toISOString();
    const changed = new Map<string, PrSummary | null>();
    this.db.transaction(() => {
      for (const [branch, pr] of prs) {
        const before = prev.get(branch);
        const number = pr?.number ?? null;
        const state = pr?.state ?? null;
        const next: CachedPr = {
          number,
          url: pr?.url ?? null,
          title: pr?.title ?? null,
          state,
          is_draft: pr?.isDraft === true ? 1 : 0
        };
        if (
          before === undefined ||
          before.number !== next.number ||
          before.url !== next.url ||
          before.title !== next.title ||
          before.state !== next.state ||
          before.is_draft !== next.is_draft
        ) {
          changed.set(branch, pr);
        }
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
    prs: Map<string, PrSummary | null>
  ): Map<string, PrSummary | null> {
    const hashes = [...prs.keys()];
    const prev = new Map<string, CachedPr>();
    if (hashes.length > 0) {
      const marks = hashes.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT commit_sha, number, url, title, state, is_draft
           FROM commit_pr WHERE repo_id = ? AND commit_sha IN (${marks})`
        )
        .all(repoId, ...hashes) as (CachedPr & { commit_sha: string })[];
      for (const { commit_sha, ...cached } of rows) prev.set(commit_sha, cached);
    }
    const stmt = this.db.prepare(
      `INSERT INTO commit_pr
         (repo_id, commit_sha, number, url, title, state, is_draft, fetched_at)
       VALUES
         (@repo_id, @commit_sha, @number, @url, @title, @state, @is_draft, @fetched_at)
       ON CONFLICT(repo_id, commit_sha) DO UPDATE SET
         number = excluded.number, url = excluded.url, title = excluded.title,
         state = excluded.state, is_draft = excluded.is_draft,
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
    prs: Map<number, PrSummary | null>
  ): PrStatusDeltas {
    const numbers = [...prs.keys()];
    if (numbers.length === 0) return emptyPrStatusDeltas();
    const marks = numbers.map(() => "?").join(", ");
    const branchRows = this.db
      .prepare(
        `SELECT branch, number, url, title, state, is_draft
         FROM branch_pr WHERE repo_id = ? AND number IN (${marks})`
      )
      .all(repoId, ...numbers) as (CachedPr & { branch: string; number: number })[];
    const commitRows = this.db
      .prepare(
        `SELECT commit_sha, number, url, title, state, is_draft
         FROM commit_pr WHERE repo_id = ? AND number IN (${marks})`
      )
      .all(repoId, ...numbers) as (CachedPr & {
        commit_sha: string;
        number: number;
      })[];
    const updateBranch = this.db.prepare(
      `UPDATE branch_pr SET url = @url, title = @title, state = @state,
         is_draft = @is_draft
       WHERE repo_id = @repo_id AND branch = @key`
    );
    const updateCommit = this.db.prepare(
      `UPDATE commit_pr SET url = @url, title = @title, state = @state,
         is_draft = @is_draft
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
    is_draft: pr?.isDraft === true ? 1 : 0
  };
}

function sameCachedPr(before: CachedPr | undefined, next: CachedPr): boolean {
  return before !== undefined &&
    before.number === next.number &&
    before.url === next.url &&
    before.title === next.title &&
    before.state === next.state &&
    before.is_draft === next.is_draft;
}

function summaryFromCached(cached: CachedPr): PrSummary | null {
  if (cached.number === null) return null;
  return {
    number: cached.number,
    url: cached.url ?? "",
    title: cached.title ?? "",
    state: (cached.state ?? "open") as PrSummary["state"],
    isDraft: cached.is_draft === 1
  };
}

function emptyPrStatusDeltas(): PrStatusDeltas {
  return { branches: new Map(), commits: new Map() };
}
