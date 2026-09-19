import {
  changeRequestHeadRef,
  changeRequestLocalBranch,
  err,
  ok,
  type ChangeRequestEntry,
  type ChangeRequestList,
  type ChangeRequestLocation,
  type OpenChangeRequest,
  type PrSummary,
  type Result
} from "@pwrgit/shared";
import type { GitExec } from "../git/dugite";
import { fetchRefspec } from "../git/git-service";
import type { DB } from "../persistence/db";
import {
  checkoutRefsFromRefnames,
  locateChangeRequest,
  type CheckoutRefs
} from "../forge/change-request-location";
import { resolveForge, type ResolvedForge } from "../forge/providers";
import { OPEN_PR_COLUMNS, openPrFromRow, openPrSelect } from "../forge/pr-row";
import { connectForge, type OpenPrList } from "../forge/types";

/** A list refresh riding the repo sweep (repo expand, lineage load). */
const SCHEDULED_OPEN_LIST_TTL_MS = 10 * 60_000;
/** A list refresh asked for by opening the refs browser. */
const USER_OPEN_LIST_TTL_MS = 60_000;
/** A number looked up because the open list could not answer it. */
const LOOKUP_TTL_MS = 5 * 60_000;

export type OpenListTrigger = "scheduled" | "user";

type OpenPrServiceDeps = {
  resolveForge?: typeof resolveForge;
  now?: () => number;
};

type StoredRow = Record<(typeof OPEN_PR_COLUMNS)[number], unknown>;

const COLUMN_LIST = OPEN_PR_COLUMNS.join(", ");
const COLUMN_PARAMS = OPEN_PR_COLUMNS.map((column) => `@${column}`).join(", ");
const COLUMN_UPDATES = OPEN_PR_COLUMNS.filter((column) => column !== "number")
  .map((column) => `${column} = excluded.${column}`)
  .join(", ");

/**
 * A repository's open change requests: the one forge read not keyed by a local
 * ref, so the only one that can find a PR whose head this checkout has never
 * seen. Sibling of `PrService`, and built the same way — one resolved provider
 * per call, a TTL for freshness, an in-memory mark for a refresh that failed,
 * and a generation that profile deletion bumps so a response already in
 * flight cannot write into a deleted profile.
 *
 * It does not share `PrService`'s tables or backoff: the list is a different
 * question with a different cost (a page walk, not a batch of keys), and a
 * forge that refuses one routinely answers the other.
 */
export class OpenPrService {
  private readonly resolveForge: typeof resolveForge;
  private readonly now: () => number;
  private writeGeneration = 0;
  private readonly pending = new Map<string, Promise<boolean>>();
  /** See `PrService.lastFailedAt`: never cache a failure, but remember it. */
  private readonly lastFailedAt = new Map<string, number>();
  private readonly lookups = new Map<
    string,
    { at: number; pr: OpenChangeRequest | null }
  >();

  constructor(
    private readonly db: DB,
    private readonly git: GitExec,
    deps: OpenPrServiceDeps = {}
  ) {
    this.resolveForge = deps.resolveForge ?? resolveForge;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Profile deletion: nothing in flight may write, and no backoff survives. */
  invalidatePendingWrites(): void {
    this.writeGeneration += 1;
    this.lastFailedAt.clear();
    this.lookups.clear();
  }

  /**
   * Re-list the repository's open change requests unless the cached list is
   * fresh enough for `trigger`. Resolves true only when the stored list
   * changed, so the caller knows whether to announce it. A caller that arrives
   * while a refresh is in flight waits for it and resolves false — the first
   * caller announces.
   */
  async refresh(
    repoId: string,
    opts: { trigger?: OpenListTrigger; force?: boolean } = {}
  ): Promise<boolean> {
    const inFlight = this.pending.get(repoId);
    if (inFlight !== undefined) {
      await inFlight;
      return false;
    }
    const ttl =
      opts.trigger === "user" ? USER_OPEN_LIST_TTL_MS : SCHEDULED_OPEN_LIST_TTL_MS;
    if (opts.force !== true && (this.failedWithin(repoId, ttl) || this.isFresh(repoId, ttl))) {
      return false;
    }
    const run = this.refreshNow(repoId, this.writeGeneration);
    this.pending.set(repoId, run);
    try {
      return await run;
    } finally {
      this.pending.delete(repoId);
    }
  }

  /** The cached list, each entry located in this checkout. */
  async list(repoId: string): Promise<ChangeRequestList> {
    const none: ChangeRequestList = {
      forge: null,
      fetchedAt: null,
      truncated: false,
      entries: []
    };
    const path = this.repoPath(repoId);
    if (path === undefined) return none;
    const forge = await this.originForge(path);
    if (forge === null) return none;
    const state = this.db
      .prepare(
        "SELECT fetched_at, truncated FROM repo_open_pr_state WHERE repo_id = ?"
      )
      .get(repoId) as { fetched_at: number; truncated: number } | undefined;
    const refs = await this.checkoutRefs(repoId, path);
    return {
      forge: forge.repo.kind,
      fetchedAt: state?.fetched_at ?? null,
      truncated: state?.truncated === 1,
      entries: this.cachedOpen(repoId).map((pr) => ({
        pr,
        location: locateChangeRequest(pr, forge.repo.kind, refs)
      }))
    };
  }

  /**
   * One change request by number: from the open list when it is there, else
   * asked of the forge — a merged PR, or one opened since the last list. An
   * answer (including "no such number") is remembered briefly; a failure is
   * not, so the next keystroke may try again.
   */
  async lookup(
    repoId: string,
    number: number
  ): Promise<ChangeRequestEntry | null> {
    const path = this.repoPath(repoId);
    if (path === undefined || !Number.isSafeInteger(number) || number < 1) {
      return null;
    }
    const forge = await this.originForge(path);
    if (forge === null) return null;
    const pr = await this.findByNumber(repoId, number, forge);
    if (pr === null) return null;
    const refs = await this.checkoutRefs(repoId, path);
    return { pr, location: locateChangeRequest(pr, forge.repo.kind, refs) };
  }

  /**
   * Bring change request `number`'s head into this checkout, and say where it
   * landed. A head already here is returned as-is — nothing is re-fetched over
   * a branch someone may have committed on.
   *
   * - Same repository, not fetched: `origin`'s branch into its ordinary
   *   remote-tracking ref, so the branch verbs treat it like any fetched branch.
   * - A fork: the forge's change-request ref into the numbered local branch,
   *   with `branch.<name>.merge` pointing back at that ref so a later pull
   *   follows the change request. There is no push target, deliberately: the
   *   fork is somebody else's repository.
   */
  async fetchHead(
    repoId: string,
    number: number
  ): Promise<Result<ChangeRequestLocation>> {
    const path = this.repoPath(repoId);
    if (path === undefined) {
      return err({ kind: "repo", code: "not_found", message: "Repository not found." });
    }
    const forge = await this.originForge(path);
    if (forge === null) {
      return err({
        kind: "remote",
        code: "no_forge",
        message: "This repository's origin is not on a forge PwrGit can ask."
      });
    }
    const kind = forge.repo.kind;
    const pr = await this.findByNumber(repoId, number, forge);
    if (pr === null) {
      return err({
        kind: "remote",
        code: "not_found",
        message: `No change request #${number} was found for this repository.`
      });
    }
    const location = locateChangeRequest(
      pr,
      kind,
      await this.checkoutRefs(repoId, path)
    );
    if (location.kind === "unfetched") {
      const valid = await this.isBranchName(path, location.branch);
      if (!valid) return invalidHead(location.branch);
      const fullName = `refs/remotes/origin/${location.branch}`;
      const fetched = await fetchRefspec(
        this.git,
        path,
        "origin",
        `+refs/heads/${location.branch}:${fullName}`
      );
      if (!fetched.ok) return fetched;
      return ok({ kind: "remote", branch: location.branch, fullName });
    }
    if (location.kind === "fork") {
      const ref = changeRequestHeadRef(kind, number);
      if (ref === null || !location.fetchable) {
        return err({
          kind: "remote",
          code: "unsupported",
          message: "This forge publishes no ref PwrGit can check a fork's change request out from."
        });
      }
      const valid = await this.isBranchName(path, location.localBranch);
      if (!valid) return invalidHead(location.localBranch);
      // No `+`: the branch does not exist (the location says so), and if it
      // appeared since, refusing is right — it may hold someone's commits.
      const fetched = await fetchRefspec(
        this.git,
        path,
        "origin",
        `${ref}:refs/heads/${location.localBranch}`
      );
      if (!fetched.ok) return fetched;
      for (const [key, value] of [
        ["remote", "origin"],
        ["merge", ref]
      ] as const) {
        await this.git(
          ["config", `branch.${location.localBranch}.${key}`, value],
          path
        );
      }
      return ok({ kind: "local", branch: location.localBranch });
    }
    if (location.kind === "missing") {
      return err({
        kind: "remote",
        code: "branch_gone",
        message: "This change request's branch no longer exists."
      });
    }
    return ok(location);
  }

  /**
   * The open list keyed by the branch names that hold each head, for
   * decorating branch rows: `origin` by head name (same-repository only), and
   * `local` by head name plus each fork's numbered branch (`pr/121`). Newest
   * update wins when two change requests share a head.
   *
   * Answered from the cache alone — no forge, no git — so a refs browser can
   * paint with it on open.
   */
  branchPrs(repoId: string): {
    local: Map<string, OpenChangeRequest>;
    origin: Map<string, OpenChangeRequest>;
  } {
    const local = new Map<string, OpenChangeRequest>();
    const origin = new Map<string, OpenChangeRequest>();
    const claim = (
      map: Map<string, OpenChangeRequest>,
      branch: string,
      pr: OpenChangeRequest
    ): void => {
      if (!map.has(branch)) map.set(branch, pr);
    };
    for (const pr of this.cachedOpen(repoId)) {
      if (pr.headRepoPath !== undefined) {
        if (pr.forge !== undefined) {
          claim(local, changeRequestLocalBranch(pr.forge, pr.number), pr);
        }
        continue;
      }
      if (pr.headRefName === undefined) continue;
      claim(local, pr.headRefName, pr);
      claim(origin, pr.headRefName, pr);
    }
    return { local, origin };
  }

  private async refreshNow(repoId: string, generation: number): Promise<boolean> {
    const path = this.repoPath(repoId);
    if (path === undefined) return false;
    const forge = await this.originForge(path);
    if (forge === null || !this.isCurrent(generation)) return false;
    const connection = await connectForge(forge.provider, forge.repo.host);
    if (connection === null || !this.isCurrent(generation)) return false;
    let list: OpenPrList;
    try {
      list = await connection.fetchOpenPrs(forge.repo);
    } catch {
      if (this.isCurrent(generation)) this.lastFailedAt.set(repoId, this.now());
      return false;
    }
    if (!this.isCurrent(generation)) return false;
    this.lastFailedAt.delete(repoId);
    return this.write(repoId, list);
  }

  /**
   * Store a complete list by diff: rows that left are deleted, rows that moved
   * are rewritten, and untouched rows are not written at all — each write
   * re-indexes that PR's search row, and a busy repository's list is mostly
   * unchanged from one refresh to the next.
   */
  private write(repoId: string, list: OpenPrList): boolean {
    if (this.db.prepare("SELECT 1 FROM repos WHERE id = ?").get(repoId) === undefined) {
      return false;
    }
    const before = new Map(
      (
        this.db
          .prepare(`SELECT ${COLUMN_LIST} FROM repo_open_pr WHERE repo_id = ?`)
          .all(repoId) as StoredRow[]
      ).map((row) => [Number(row.number), row] as const)
    );
    const next = new Map<number, StoredRow>();
    for (const item of list.items) {
      if (!next.has(item.number)) next.set(item.number, storedFromOpen(item));
    }
    const remove = this.db.prepare(
      "DELETE FROM repo_open_pr WHERE repo_id = ? AND number = ?"
    );
    const upsert = this.db.prepare(
      `INSERT INTO repo_open_pr (repo_id, ${COLUMN_LIST})
       VALUES (@repo_id, ${COLUMN_PARAMS})
       ON CONFLICT(repo_id, number) DO UPDATE SET ${COLUMN_UPDATES}`
    );
    let changed = false;
    this.db.transaction(() => {
      for (const number of before.keys()) {
        if (next.has(number)) continue;
        remove.run(repoId, number);
        changed = true;
      }
      for (const [number, row] of next) {
        if (sameRow(before.get(number), row)) continue;
        upsert.run({ repo_id: repoId, ...row });
        changed = true;
      }
      const priorState = this.db
        .prepare("SELECT truncated FROM repo_open_pr_state WHERE repo_id = ?")
        .get(repoId) as { truncated: number } | undefined;
      const truncated = list.truncated ? 1 : 0;
      if (priorState === undefined || priorState.truncated !== truncated) {
        changed = true;
      }
      this.db
        .prepare(
          `INSERT INTO repo_open_pr_state (repo_id, fetched_at, truncated)
           VALUES (?, ?, ?)
           ON CONFLICT(repo_id) DO UPDATE SET
             fetched_at = excluded.fetched_at, truncated = excluded.truncated`
        )
        .run(repoId, this.now(), truncated);
    })();
    return changed;
  }

  private cachedOpen(repoId: string): OpenChangeRequest[] {
    return (
      this.db
        .prepare(
          `SELECT ${openPrSelect("p")} FROM repo_open_pr p
            WHERE p.repo_id = ?
            ORDER BY COALESCE(p.updated_at, p.opened_at, 0) DESC, p.number DESC`
        )
        .all(repoId) as Record<string, unknown>[]
    )
      .map((row) => openPrFromRow(row))
      .filter((pr): pr is OpenChangeRequest => pr !== undefined);
  }

  private async findByNumber(
    repoId: string,
    number: number,
    forge: ResolvedForge
  ): Promise<OpenChangeRequest | null> {
    const open = this.db
      .prepare(
        `SELECT ${openPrSelect("p")} FROM repo_open_pr p WHERE p.repo_id = ? AND p.number = ?`
      )
      .get(repoId, number) as Record<string, unknown> | undefined;
    const cached = open === undefined ? undefined : openPrFromRow(open);
    if (cached !== undefined) return cached;
    const key = `${repoId}:${number}`;
    const memo = this.lookups.get(key);
    const now = this.now();
    if (memo !== undefined && memo.at <= now && memo.at > now - LOOKUP_TTL_MS) {
      return memo.pr;
    }
    const generation = this.writeGeneration;
    const connection = await connectForge(forge.provider, forge.repo.host);
    if (connection === null) return null;
    let answer: Map<number, PrSummary | null>;
    try {
      answer = await connection.fetchPrsByNumbers(forge.repo, [number]);
    } catch {
      return null;
    }
    // An omitted number is "never asked", not "does not exist" — do not
    // remember it.
    if (!answer.has(number)) return null;
    const pr = answer.get(number) ?? null;
    if (this.isCurrent(generation)) this.lookups.set(key, { at: now, pr });
    return pr;
  }

  private async checkoutRefs(repoId: string, path: string): Promise<CheckoutRefs> {
    const worktrees = new Map(
      (
        this.db
          .prepare(
            "SELECT id, branch FROM worktrees WHERE repo_id = ? AND missing = 0"
          )
          .all(repoId) as { id: string; branch: string }[]
      ).map((row) => [row.branch, row.id] as const)
    );
    const out = await this.git(
      ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"],
      path
    );
    return checkoutRefsFromRefnames(
      out.ok && out.value.exitCode === 0 ? out.value.stdout : "",
      worktrees
    );
  }

  /** A forge-supplied name goes into a refspec only once git accepts it as a branch. */
  private async isBranchName(path: string, name: string): Promise<boolean> {
    if (name.startsWith("-")) return false;
    const out = await this.git(["check-ref-format", "--branch", name], path);
    return out.ok && out.value.exitCode === 0;
  }

  private repoPath(repoId: string): string | undefined {
    return (
      this.db.prepare("SELECT path FROM repos WHERE id = ?").get(repoId) as
        | { path: string }
        | undefined
    )?.path;
  }

  private async originForge(repoPath: string): Promise<ResolvedForge | null> {
    const out = await this.git(["remote", "get-url", "origin"], repoPath);
    if (!out.ok || out.value.exitCode !== 0) return null;
    return this.resolveForge(out.value.stdout);
  }

  private isFresh(repoId: string, ttlMs: number): boolean {
    const row = this.db
      .prepare("SELECT fetched_at FROM repo_open_pr_state WHERE repo_id = ?")
      .get(repoId) as { fetched_at: number } | undefined;
    if (row === undefined) return false;
    const now = this.now();
    // A stamp from the future is a backward clock step, not a fresh list.
    return row.fetched_at <= now && row.fetched_at > now - ttlMs;
  }

  private failedWithin(repoId: string, ttlMs: number): boolean {
    const failedAt = this.lastFailedAt.get(repoId);
    if (failedAt === undefined) return false;
    const now = this.now();
    return failedAt <= now && failedAt > now - ttlMs;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.writeGeneration;
  }
}

function invalidHead(name: string): Result<ChangeRequestLocation> {
  return err({
    kind: "validation",
    code: "invalid_branch",
    message: `"${name}" is not a branch name git accepts.`
  });
}

function storedFromOpen(pr: OpenChangeRequest): StoredRow {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    is_draft: pr.isDraft ? 1 : 0,
    check_state: pr.checkState ?? null,
    checks_still_running:
      pr.checksStillRunning === undefined ? null : Number(pr.checksStillRunning),
    merge_state: pr.mergeState ?? null,
    forge: pr.forge ?? null,
    host: pr.host ?? null,
    repo_path: pr.repoPath ?? null,
    head_ref: pr.headRefName ?? null,
    base_ref: pr.baseRefName ?? null,
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    changed_files: pr.changedFiles ?? null,
    commit_count: pr.commitCount ?? null,
    opened_at: pr.createdAt ?? null,
    merged_at: pr.mergedAt ?? null,
    closed_at: pr.closedAt ?? null,
    author: pr.author ?? null,
    head_repo_path: pr.headRepoPath ?? null,
    updated_at: pr.updatedAt ?? null
  };
}

function sameRow(before: StoredRow | undefined, next: StoredRow): boolean {
  if (before === undefined) return false;
  return OPEN_PR_COLUMNS.every((column) => before[column] === next[column]);
}
