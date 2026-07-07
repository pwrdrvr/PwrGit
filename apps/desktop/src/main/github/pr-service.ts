import type { PrSummary } from "@pwrgit/shared";
import type { GitExec } from "../git/dugite";
import type { DB } from "../persistence/db";
import { fetchPrsForRepo, getGitHubToken } from "./pr-client";
import { parseGitHubRemote, type GitHubRepo } from "./remote";

const REFRESH_TTL_MS = 10 * 60_000;

/**
 * Fetches GitHub PR status for a repo's branches and caches it in branch_pr.
 * Best-effort: silently no-ops when origin isn't github.com, gh isn't logged in,
 * or the network fails — cached data just stays put.
 */
export class PrService {
  constructor(
    private readonly db: DB,
    private readonly git: GitExec
  ) {}

  /** Returns the branches whose PR state changed (empty = nothing to publish). */
  async refreshRepo(
    repoId: string,
    opts: { force?: boolean } = {}
  ): Promise<Map<string, PrSummary | null>> {
    const empty = new Map<string, PrSummary | null>();
    const repo = this.db
      .prepare("SELECT path FROM repos WHERE id = ?")
      .get(repoId) as { path: string } | undefined;
    if (repo === undefined) return empty;
    if (opts.force !== true && this.isFresh(repoId)) return empty;

    const remote = await this.originRemote(repo.path);
    if (remote === null) return empty;
    const token = await getGitHubToken();
    if (token === null) return empty;
    const branches = this.branchesToCheck(repoId);
    if (branches.length === 0) return empty;

    let prs: Map<string, PrSummary | null>;
    try {
      prs = await fetchPrsForRepo(token, remote.owner, remote.repo, branches);
    } catch {
      return empty; // best-effort; keep whatever's cached
    }
    return this.upsert(repoId, prs);
  }

  private isFresh(repoId: string): boolean {
    const row = this.db
      .prepare("SELECT MAX(fetched_at) AS m FROM branch_pr WHERE repo_id = ?")
      .get(repoId) as { m: string | null };
    if (row.m === null) return false;
    return Date.now() - new Date(row.m).getTime() < REFRESH_TTL_MS;
  }

  private async originRemote(repoPath: string): Promise<GitHubRepo | null> {
    const out = await this.git(["remote", "get-url", "origin"], repoPath);
    if (!out.ok || out.value.exitCode !== 0) return null;
    return parseGitHubRemote(out.value.stdout);
  }

  private branchesToCheck(repoId: string): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT branch FROM worktrees WHERE repo_id = ?")
      .all(repoId) as { branch: string }[];
    return rows
      .map((r) => r.branch)
      .filter((b) => b !== "" && b !== "HEAD" && !b.startsWith("detached@"));
  }

  private upsert(
    repoId: string,
    prs: Map<string, PrSummary | null>
  ): Map<string, PrSummary | null> {
    const prev = new Map(
      (
        this.db
          .prepare("SELECT branch, number, state FROM branch_pr WHERE repo_id = ?")
          .all(repoId) as {
          branch: string;
          number: number | null;
          state: string | null;
        }[]
      ).map((r) => [r.branch, r] as const)
    );
    const stmt = this.db.prepare(
      `INSERT INTO branch_pr (repo_id, branch, number, url, title, state, is_draft, fetched_at)
       VALUES (@repo_id, @branch, @number, @url, @title, @state, @is_draft, @fetched_at)
       ON CONFLICT(repo_id, branch) DO UPDATE SET
         number = excluded.number, url = excluded.url, title = excluded.title,
         state = excluded.state, is_draft = excluded.is_draft,
         fetched_at = excluded.fetched_at`
    );
    const now = new Date().toISOString();
    const changed = new Map<string, PrSummary | null>();
    this.db.transaction(() => {
      for (const [branch, pr] of prs) {
        const before = prev.get(branch);
        const number = pr?.number ?? null;
        const state = pr?.state ?? null;
        if (before === undefined || before.number !== number || before.state !== state) {
          changed.set(branch, pr);
        }
        stmt.run({
          repo_id: repoId,
          branch,
          number,
          url: pr?.url ?? null,
          title: pr?.title ?? null,
          state,
          is_draft: pr?.isDraft === true ? 1 : 0,
          fetched_at: now
        });
      }
    })();
    return changed;
  }
}
