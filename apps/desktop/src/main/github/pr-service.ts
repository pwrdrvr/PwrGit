import type { PrSummary } from "@pwrgit/shared";
import type { GitExec } from "../git/dugite";
import type { DB } from "../persistence/db";
import { fetchPrsForRepo, getGitHubToken } from "./pr-client";
import { parseGitHubRemote, type GitHubRepo } from "./remote";

const REPO_REFRESH_TTL_MS = 10 * 60_000;
const SCHEDULED_BRANCH_REFRESH_TTL_MS = 60_000;
const USER_BRANCH_REFRESH_TTL_MS = 10_000;
const TERMINAL_USER_BRANCH_REFRESH_TTL_MS = 60_000;

type PrRefreshTrigger = "scheduled" | "user";

type PrServiceDeps = {
  getGitHubToken?: typeof getGitHubToken;
  fetchPrsForRepo?: typeof fetchPrsForRepo;
  now?: () => number;
};

type CachedPr = {
  number: number | null;
  url: string | null;
  title: string | null;
  state: string | null;
  is_draft: number;
};

/**
 * Fetches GitHub PR status for a repo's branches and caches it in branch_pr.
 * Best-effort: silently no-ops when origin isn't github.com, gh isn't logged in,
 * or the network fails — cached data just stays put.
 */
export class PrService {
  private readonly getToken: typeof getGitHubToken;
  private readonly fetchPrs: typeof fetchPrsForRepo;
  private readonly now: () => number;
  // A bulk lookup and a focused branch lookup may overlap for the same repo.
  // They must share one request: otherwise an older bulk response can land
  // after the focused response and overwrite its newer PR state.
  private readonly pendingRepoRefreshes = new Map<
    string,
    Promise<Map<string, PrSummary | null>>
  >();

  constructor(
    private readonly db: DB,
    private readonly git: GitExec,
    deps: PrServiceDeps = {}
  ) {
    this.getToken = deps.getGitHubToken ?? getGitHubToken;
    this.fetchPrs = deps.fetchPrsForRepo ?? fetchPrsForRepo;
    this.now = deps.now ?? (() => Date.now());
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
    const branches = this.branchesToCheck(repoId, opts.branches);
    if (branches.length === 0) return new Map();
    const pending = this.pendingRepoRefreshes.get(repoId);
    if (pending !== undefined) return await pending;

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

  private branchesToCheck(repoId: string, requested?: string[]): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT branch FROM worktrees WHERE repo_id = ?")
      .all(repoId) as { branch: string }[];
    const branches = rows
      .map((r) => r.branch)
      .filter((b) => b !== "" && b !== "HEAD" && !b.startsWith("detached@"));
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
}
