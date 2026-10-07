import type { WorktreeForkSource, WorktreeState } from "@pwrgit/shared";
import type { DB } from "../persistence/db";
import { mapLimit } from "../util/map-limit";
import { NO_OPTIONAL_LOCKS, requireExit0, type GitExec } from "./dugite";
import { checkoutExists } from "./worktree-liveness";
import { WorktreeOperationQueue } from "./worktree-operation-queue";

/** A probe found `branch`'s configured upstream deleted. */
export type UpstreamGoneChange = {
  worktreeId: string;
  repoId: string;
  branch: string;
  /** The last snapshot did not say gone: this probe saw it happen. */
  firstSeen: boolean;
};

export type ParsedStatus = {
  head: string;
  branch: string;
  hasUpstream: boolean;
  ahead: number;
  behind: number;
  dirty: number;
  /** An upstream is configured but its ref is gone (see below). */
  upstreamGone: boolean;
};

/**
 * Parse `git status --porcelain=v2 --branch`. Header lines start with `#`;
 * every non-header line is a changed/renamed/unmerged/untracked entry.
 *
 * A configured upstream whose remote branch was pruned still prints
 * `# branch.upstream`, but Git omits `# branch.ab` because there is nothing
 * to count against. Reading that as 0/0 reported a finished branch as "up to
 * date"; `upstreamGone` says what actually happened.
 */
export function parseStatus(stdout: string): ParsedStatus {
  let head = "";
  let branch = "";
  let hasUpstream = false;
  let ahead = 0;
  let behind = 0;
  let dirty = 0;
  let sawCounts = false;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("# branch.oid ")) head = line.slice(13).trim();
    else if (line.startsWith("# branch.head ")) branch = line.slice(14).trim();
    else if (line.startsWith("# branch.upstream ")) hasUpstream = true;
    else if (line.startsWith("# branch.ab ")) {
      sawCounts = true;
      const m = /\+(-?\d+)\s+-(-?\d+)/.exec(line);
      if (m !== null) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.length > 0 && !line.startsWith("#")) {
      dirty += 1;
    }
  }

  return {
    head,
    branch,
    hasUpstream,
    ahead,
    behind,
    dirty,
    upstreamGone: hasUpstream && !sawCounts
  };
}

type WorktreeRow = {
  id: string;
  branch: string;
  path: string;
  repo_id: string;
  repo_path: string;
  missing: number;
  is_primary: number;
};
type StateRow = {
  worktree_id: string;
  /** Joined from `worktrees.missing`, the one home of that flag. */
  missing: number;
  branch: string;
  head: string;
  has_upstream: number;
  ahead: number;
  behind: number;
  dirty: number;
  behind_default: number;
  default_branch: string;
  merged_into_default: number;
  diverged_from_default: number;
  is_default_branch: number;
  last_activity_at: string | null;
  updated_at: string;
  upstream_gone: number;
  source_remote: string | null;
  source_label: string | null;
  source_parent: string | null;
  source_ahead: number | null;
  source_behind: number | null;
};
type ResolvedDefaultBranch = { ref: string; name: string };
type CachedDefaultBranch = {
  value: ResolvedDefaultBranch;
  /** Exact ref used to avoid Git's shorthand revision DWIM during validation. */
  verifyRef: string;
};

function rowToState(r: StateRow): WorktreeState {
  // A gone checkout has nothing dirty, ahead, behind or merged: the stored
  // counts are what was true before it went, and reading them as live is the
  // stale badge the flag exists to retire. Zero them at read time — the row
  // itself is kept, so a remounted volume resumes from a real snapshot — in
  // the same way `RepoIndexer` zeroes the sidebar's `Worktree` projection.
  const missing = r.missing === 1;
  const s: WorktreeState = {
    worktreeId: r.worktree_id,
    branch: r.branch,
    head: r.head,
    hasUpstream: r.has_upstream === 1,
    ahead: missing ? 0 : r.ahead,
    behind: missing ? 0 : r.behind,
    dirty: missing ? 0 : r.dirty,
    behindDefault: missing ? 0 : r.behind_default,
    defaultBranch: r.default_branch,
    mergedIntoDefault: !missing && r.merged_into_default === 1,
    divergedFromDefault: !missing && r.diverged_from_default === 1,
    isDefaultBranch: r.is_default_branch === 1,
    updatedAt: r.updated_at
  };
  if (r.last_activity_at !== null) s.lastActivityAt = r.last_activity_at;
  if (missing) s.missing = true;
  if (!missing && r.upstream_gone === 1) s.upstreamGone = true;
  const source = missing ? undefined : forkSourceFromRow(r);
  if (source !== undefined) s.source = source;
  return s;
}

/** The stored fork-source columns (0038), or undefined when there is none. */
export function forkSourceFromRow(r: {
  source_remote: string | null;
  source_label: string | null;
  source_parent: string | null;
  source_ahead: number | null;
  source_behind: number | null;
}): WorktreeForkSource | undefined {
  if (r.source_remote === null || r.source_label === null) return undefined;
  const source: WorktreeForkSource = {
    remote: r.source_remote,
    label: r.source_label,
    ahead: r.source_ahead ?? 0,
    behind: r.source_behind ?? 0
  };
  if (r.source_parent !== null) source.parent = r.source_parent;
  return source;
}

/**
 * Answers the branch's counterpart on the fork's source for one checkout, or
 * null when there is none. Injected so this service needs no forge identity
 * of its own (`fork-source-probe.ts`).
 */
export type ForkSourceProbe = (
  repoId: string,
  repoPath: string,
  worktreePath: string
) => Promise<WorktreeForkSource | null>;

/** Did anything a surface draws move between two snapshots? */
export function stateChanged(a: WorktreeState, b: WorktreeState): boolean {
  return (
    a.hasUpstream !== b.hasUpstream ||
    a.dirty !== b.dirty ||
    a.upstreamGone !== b.upstreamGone ||
    // The fork source moves on its own — an agent fetching `upstream` changes
    // nothing else here — so it has to count as a move by itself.
    a.source?.remote !== b.source?.remote ||
    a.source?.label !== b.source?.label ||
    a.source?.parent !== b.source?.parent ||
    a.source?.ahead !== b.source?.ahead ||
    a.source?.behind !== b.source?.behind ||
    a.ahead !== b.ahead ||
    a.behind !== b.behind ||
    a.head !== b.head ||
    a.branch !== b.branch ||
    a.behindDefault !== b.behindDefault ||
    a.defaultBranch !== b.defaultBranch ||
    a.mergedIntoDefault !== b.mergedIntoDefault ||
    a.divergedFromDefault !== b.divergedFromDefault ||
    a.isDefaultBranch !== b.isDefaultBranch ||
    a.lastActivityAt !== b.lastActivityAt ||
    a.missing !== b.missing
  );
}

/**
 * Computes and caches per-worktree state. `getState` never blocks on git; it
 * returns the cached snapshot and the caller schedules a background refresh.
 * GitExec is injected (tests drive it against system git).
 */
export class WorktreeStateService {
  /** Per-repo default branch (ref + name), cached while its ref resolves. */
  private readonly defaultBranch = new Map<string, CachedDefaultBranch>();

  /** Probes currently running git for a worktree (removal drains these). */
  private readonly inFlight = new Map<string, Set<Promise<unknown>>>();

  /** One queued/running state probe per worktree; overlapping polls share it. */
  private readonly pendingComputes = new Map<
    string,
    Promise<WorktreeState | null>
  >();

  /** Worktrees whose removal is underway; counted so overlapping batches nest. */
  private readonly removalLocks = new Map<string, number>();

  constructor(
    private readonly db: DB,
    private readonly git: GitExec,
    private readonly operations = new WorktreeOperationQueue()
  ) {}

  private repoPathMissing: ((repoId: string) => void) | null = null;
  private upstreamGone: ((change: UpstreamGoneChange) => void) | null = null;
  private forkSource: ForkSourceProbe | null = null;

  /** Count each branch against its fork's source as part of every probe. */
  setForkSourceProbe(probe: ForkSourceProbe): void {
    this.forkSource = probe;
  }

  /**
   * Hear about a probe that finds a repository's OWN checkout gone — the
   * primary, not a linked worktree. A linked worktree's row is the thing to
   * flag; a missing primary usually means the whole repository was deleted
   * or moved, and only a profile rescan can drop its row (see index.ts).
   */
  onRepoPathMissing(listener: (repoId: string) => void): void {
    this.repoPathMissing = listener;
  }

  /**
   * Hear about every probe that finds a branch's upstream gone. `fetch
   * --prune` deletes the ref the moment the remote branch goes, but the
   * branch's change request is cached on its own, longer TTL — so for up to
   * that window the row read "gone" beside an open-looking PR that had in fact
   * merged. The listener is how the PR cache hears that its answer is now in
   * doubt (index.ts). Called on every such probe, not just the first:
   * `firstSeen` tells the transition apart from a branch that stays gone.
   */
  onUpstreamGone(listener: (change: UpstreamGoneChange) => void): void {
    this.upstreamGone = listener;
  }

  getCached(worktreeId: string): WorktreeState | null {
    const row = this.db
      .prepare(
        `SELECT s.*, w.missing AS missing
         FROM worktree_state s JOIN worktrees w ON w.id = s.worktree_id
         WHERE s.worktree_id = ?`
      )
      .get(worktreeId) as StateRow | undefined;
    return row === undefined ? null : rowToState(row);
  }

  private worktreeRow(worktreeId: string): WorktreeRow | null {
    const row = this.db
      .prepare(
        `SELECT w.id, w.branch, w.path, w.repo_id, w.missing, w.is_primary,
                r.path AS repo_path
         FROM worktrees w JOIN repos r ON r.id = w.repo_id
         WHERE w.id = ?`
      )
      .get(worktreeId) as WorktreeRow | undefined;
    return row ?? null;
  }

  /**
   * The probe found no checkout behind the row. Flag it; `rowToState` reads
   * the counts as zero while the flag is set, and the stored snapshot is kept
   * so a remounted volume resumes from it. Not pruned: a volume that is
   * merely unmounted reads the same way, and the next successful probe
   * clears the flag. A row that never had a snapshot gets a blank one — the
   * refresher announces a flip by comparing snapshots, and null-to-null is
   * not a change it can see.
   */
  private markMissing(wt: WorktreeRow): WorktreeState | null {
    // A background rescan may already have pruned this row while Git ran.
    if (this.worktreeRow(wt.id) === null) return null;
    if (wt.is_primary === 1) this.repoPathMissing?.(wt.repo_id);
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE worktrees SET missing = 1 WHERE id = ?")
        .run(wt.id);
      if (this.getCached(wt.id) === null) {
        this.upsert({
          worktreeId: wt.id,
          branch: wt.branch,
          head: "",
          hasUpstream: false,
          ahead: 0,
          behind: 0,
          dirty: 0,
          behindDefault: 0,
          defaultBranch: "",
          mergedIntoDefault: false,
          divergedFromDefault: false,
          isDefaultBranch: false,
          updatedAt: new Date().toISOString()
        });
      }
    })();
    return this.getCached(wt.id);
  }

  private cachedUnlessMissing(wt: WorktreeRow): WorktreeState | null {
    return checkoutExists(wt.path)
      ? this.getCached(wt.id)
      : this.markMissing(wt);
  }

  /**
   * Resolve a repo's default branch: prefer the remote default
   * (`origin/HEAD` → `origin/<name>`), then a local `main`/`master`, then the
   * currently checked-out branch. Repositories materialized at a commit with
   * no branch refs (for example, build/test sandboxes) use `HEAD` itself so
   * history remains readable instead of passing a nonexistent `main` to Git.
   * Cached per repo while the chosen ref continues to resolve to a commit.
   */
  async resolveDefaultBranch(
    repoId: string,
    repoPath: string
  ): Promise<ResolvedDefaultBranch> {
    const cached = this.defaultBranch.get(repoId);
    if (cached !== undefined) {
      const stillExists = await this.git(
        ["rev-parse", "--verify", "--quiet", `${cached.verifyRef}^{commit}`],
        repoPath
      );
      // `rev-parse --quiet` uses 1 for an unresolved ref. Preserve the last
      // known answer for operational failures such as an inaccessible cwd,
      // which start Git successfully but exit 128.
      if (!stillExists.ok || stillExists.value.exitCode !== 1) {
        return cached.value;
      }
      this.defaultBranch.delete(repoId);
    }

    let resolved: ResolvedDefaultBranch | null = null;
    let verifyRef = "";
    const sym = await this.git(
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      repoPath
    );
    if (sym.ok && sym.value.exitCode === 0) {
      const fullRef = sym.value.stdout.trim();
      const prefix = "refs/remotes/origin/";
      const name = fullRef.startsWith(prefix)
        ? fullRef.slice(prefix.length)
        : "";
      const ref = `origin/${name}`;
      // `fetch --prune` removes a deleted remote branch but can leave
      // origin/HEAD pointing at it. A symbolic-ref lookup still succeeds in
      // that state, so verify the target before caching it as the graph base.
      const target =
        name === ""
          ? null
          : await this.git(
              ["rev-parse", "--verify", "--quiet", `${fullRef}^{commit}`],
              repoPath
            );
      if (target?.ok === true && target.value.exitCode === 0) {
        resolved = { ref, name };
        verifyRef = fullRef;
      }
    }
    if (resolved === null) {
      for (const cand of ["main", "master"]) {
        const fullRef = `refs/heads/${cand}`;
        const v = await this.git(
          ["rev-parse", "--verify", "--quiet", `${fullRef}^{commit}`],
          repoPath
        );
        if (v.ok && v.value.exitCode === 0) {
          resolved = { ref: cand, name: cand };
          verifyRef = fullRef;
          break;
        }
      }
    }
    if (resolved === null) {
      const current = await this.git(
        ["symbolic-ref", "--quiet", "HEAD"],
        repoPath
      );
      if (current.ok && current.value.exitCode === 0) {
        const fullRef = current.value.stdout.trim();
        const prefix = "refs/heads/";
        const name = fullRef.startsWith(prefix)
          ? fullRef.slice(prefix.length)
          : "";
        if (name !== "") {
          resolved = { ref: name, name };
          verifyRef = fullRef;
        }
      }
    }
    if (resolved === null) {
      resolved = { ref: "HEAD", name: "HEAD" };
      verifyRef = "HEAD";
    }
    this.defaultBranch.set(repoId, { value: resolved, verifyRef });
    return resolved;
  }

  /**
   * Run git and cache a fresh snapshot for one worktree. While the worktree is
   * locked for removal the probe is dropped (cached state is returned, no git
   * spawns): on Windows a directory that is any process's cwd cannot be
   * deleted, so a probe racing the removal would make the delete fail.
   */
  async compute(worktreeId: string): Promise<WorktreeState | null> {
    if (this.removalLocks.has(worktreeId)) return this.getCached(worktreeId);

    const pending = this.pendingComputes.get(worktreeId);
    if (pending !== undefined) return pending;

    const run = this.operations.run(worktreeId, () =>
      this.computeFresh(worktreeId)
    );
    this.pendingComputes.set(worktreeId, run);
    let running = this.inFlight.get(worktreeId);
    if (running === undefined) {
      running = new Set();
      this.inFlight.set(worktreeId, running);
    }
    running.add(run);
    try {
      return await run;
    } finally {
      if (this.pendingComputes.get(worktreeId) === run) {
        this.pendingComputes.delete(worktreeId);
      }
      running.delete(run);
      if (running.size === 0) this.inFlight.delete(worktreeId);
    }
  }

  /**
   * Lock a worktree for removal: from now until the returned release fn runs,
   * compute() is a no-op for it. Resolves once every already-running probe has
   * finished, i.e. once no git process has its cwd inside the worktree.
   */
  async lockForRemoval(worktreeId: string): Promise<() => void> {
    this.removalLocks.set(
      worktreeId,
      (this.removalLocks.get(worktreeId) ?? 0) + 1
    );
    const running = this.inFlight.get(worktreeId);
    if (running !== undefined) await Promise.allSettled([...running]);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.removalLocks.get(worktreeId) ?? 0;
      if (count <= 1) this.removalLocks.delete(worktreeId);
      else this.removalLocks.set(worktreeId, count - 1);
    };
  }

  private async computeFresh(
    worktreeId: string
  ): Promise<WorktreeState | null> {
    const wt = this.worktreeRow(worktreeId);
    if (wt === null) return null;

    // Ask the filesystem before asking git. A missing checkout needs no
    // process spawned into it — and the exit code alone cannot be trusted
    // either way: `git status` from a directory whose own `.git` link is gone
    // resolves some PARENT repository (a linked worktree nested in the
    // primary's tree, reduced to a plain folder) and succeeds, reporting
    // that repo's branch and dirt as this row's.
    if (!checkoutExists(wt.path)) return this.markMissing(wt);

    const statusRaw = await this.git(
      [
        "status",
        "--porcelain=v2",
        "--branch",
        // Coarse dirtiness is also a checkout-safety signal. Dirty initialized
        // children must keep this count nonzero or a cached clean state can
        // suppress the branch-switch confirmation.
        "--ignore-submodules=none"
      ],
      wt.path,
      NO_OPTIONAL_LOCKS
    );
    // Preserve cached state for transient Git failures, but check for deletion
    // again: a focus refresh can share this in-flight probe rather than start
    // another one after the checkout disappeared.
    const status = statusRaw.ok
      ? requireExit0(statusRaw.value, ["status"])
      : statusRaw;
    if (!status.ok) return this.cachedUnlessMissing(wt);
    if (wt.missing === 1) {
      this.db
        .prepare("UPDATE worktrees SET missing = 0 WHERE id = ?")
        .run(worktreeId);
    }
    const parsed = parseStatus(status.value.stdout);

    // Without a tracker Git omits branch.ab; zero then hides local commits.
    // Exclude every fetched remote branch, so a push without -u (or to a
    // different remote/name) does not make published history look unpushed.
    // This remains a local snapshot; the bounded background remote check
    // refreshes same-name remote tips separately, as it does for trackers.
    let ahead = parsed.ahead;
    if (!parsed.hasUpstream && parsed.branch !== "(detached)" &&
        parsed.head !== "(initial)" && parsed.head !== "") {
      const unpublished = await this.git(
        ["rev-list", "--count", parsed.head, "--not", "--remotes"], wt.path
      );
      if (!unpublished.ok || unpublished.value.exitCode !== 0) {
        return this.cachedUnlessMissing(wt);
      }
      const count = Number(unpublished.value.stdout.trim());
      if (!Number.isSafeInteger(count) || count < 0) return this.cachedUnlessMissing(wt);
      ahead = count;
    }

    let lastActivityAt: string | undefined;
    const logRaw = await this.git(["log", "-1", "--format=%cI"], wt.path);
    if (logRaw.ok && logRaw.value.exitCode === 0) {
      const iso = logRaw.value.stdout.trim();
      if (iso !== "") lastActivityAt = iso;
    }

    // Agents and terminal git switch branches without going through PwrGit,
    // and only a full rescan rewrites the worktrees.branch column the sidebar
    // and header labels read — so every state refresh (poll, focus, activate)
    // reconciles that column with the live checkout. Detached HEADs get the
    // same label the indexer writes.
    const liveBranch =
      parsed.branch === "(detached)"
        ? `detached@${parsed.head.slice(0, 7)}`
        : parsed.branch;
    if (liveBranch !== "" && liveBranch !== wt.branch) {
      this.db
        .prepare("UPDATE worktrees SET branch = ? WHERE id = ?")
        .run(liveBranch, worktreeId);
    }

    // Staleness vs the repo's default branch.
    const branchName = liveBranch !== "" ? liveBranch : wt.branch;
    const def = await this.resolveDefaultBranch(wt.repo_id, wt.repo_path);
    const isDefaultBranch = branchName === def.name;
    let behindDefault = 0;
    let mergedIntoDefault = false;
    let divergedFromDefault = false;
    if (!isDefaultBranch) {
      // With no common ancestor (rewritten/orphaned history), `HEAD..default`
      // counts the *entire* default branch — a misleading "behind" number. Flag
      // it as diverged instead of reporting the inflated count.
      const mergeBase = await this.git(["merge-base", "HEAD", def.ref], wt.path);
      const hasMergeBase = mergeBase.ok && mergeBase.value.exitCode === 0;
      if (!hasMergeBase) {
        divergedFromDefault = true;
      } else {
        const bd = await this.git(
          ["rev-list", "--count", `HEAD..${def.ref}`],
          wt.path
        );
        if (bd.ok && bd.value.exitCode === 0) {
          behindDefault = Number(bd.value.stdout.trim()) || 0;
        }
        const anc = await this.git(
          ["merge-base", "--is-ancestor", "HEAD", def.ref],
          wt.path
        );
        mergedIntoDefault = anc.ok && anc.value.exitCode === 0;
      }
    }

    // Best-effort: a fork probe that fails leaves the branch without a source
    // count rather than failing the snapshot the rest of the row needs.
    const source =
      this.forkSource === null
        ? null
        : await this.forkSource(wt.repo_id, wt.repo_path, wt.path).catch(
            () => null
          );

    // Even successful commands can have read the checkout just before it went.
    // Never publish those counts as live once the probe can see it is gone.
    if (!checkoutExists(wt.path)) return this.markMissing(wt);

    const state: WorktreeState = {
      worktreeId,
      branch: branchName,
      head: parsed.head,
      hasUpstream: parsed.hasUpstream,
      ahead,
      behind: parsed.behind,
      dirty: parsed.dirty,
      behindDefault,
      defaultBranch: def.name,
      mergedIntoDefault,
      divergedFromDefault,
      isDefaultBranch,
      updatedAt: new Date().toISOString()
    };
    if (lastActivityAt !== undefined) state.lastActivityAt = lastActivityAt;
    if (parsed.upstreamGone) state.upstreamGone = true;
    if (source !== null) state.source = source;

    // Read before the upsert overwrites it, and only when it can matter.
    const previous =
      state.upstreamGone === true && this.upstreamGone !== null
        ? this.getCached(worktreeId)
        : null;
    this.upsert(state);
    if (state.upstreamGone === true && this.upstreamGone !== null) {
      // A listener's failure is the PR cache's problem; this snapshot is
      // already written and the caller is owed it.
      try {
        this.upstreamGone({
          worktreeId,
          repoId: wt.repo_id,
          branch: branchName,
          firstSeen: previous?.upstreamGone !== true
        });
      } catch {
        // Best-effort.
      }
    }
    return state;
  }

  /** Background refresh for many worktrees, concurrency-bounded. */
  async refreshMany(worktreeIds: string[], concurrency = 8): Promise<void> {
    await mapLimit(worktreeIds, concurrency, async (id) => {
      await this.compute(id);
    });
  }

  private upsert(s: WorktreeState): void {
    this.db
      .prepare(
        `INSERT INTO worktree_state
           (worktree_id, branch, head, has_upstream, ahead, behind, dirty,
            behind_default, default_branch, merged_into_default, diverged_from_default,
            is_default_branch, last_activity_at, updated_at, upstream_gone,
            source_remote, source_label, source_parent, source_ahead, source_behind)
         VALUES (@worktree_id, @branch, @head, @has_upstream, @ahead, @behind, @dirty,
                 @behind_default, @default_branch, @merged_into_default, @diverged_from_default,
                 @is_default_branch, @last_activity_at, @updated_at, @upstream_gone,
                 @source_remote, @source_label, @source_parent, @source_ahead, @source_behind)
         ON CONFLICT(worktree_id) DO UPDATE SET
           branch = excluded.branch, head = excluded.head,
           has_upstream = excluded.has_upstream, ahead = excluded.ahead,
           behind = excluded.behind, dirty = excluded.dirty,
           behind_default = excluded.behind_default,
           default_branch = excluded.default_branch,
           merged_into_default = excluded.merged_into_default,
           diverged_from_default = excluded.diverged_from_default,
           is_default_branch = excluded.is_default_branch,
           last_activity_at = excluded.last_activity_at, updated_at = excluded.updated_at,
           upstream_gone = excluded.upstream_gone,
           source_remote = excluded.source_remote, source_label = excluded.source_label,
           source_parent = excluded.source_parent, source_ahead = excluded.source_ahead,
           source_behind = excluded.source_behind`
      )
      .run({
        worktree_id: s.worktreeId,
        branch: s.branch,
        head: s.head,
        has_upstream: s.hasUpstream ? 1 : 0,
        ahead: s.ahead,
        behind: s.behind,
        dirty: s.dirty,
        behind_default: s.behindDefault,
        default_branch: s.defaultBranch,
        merged_into_default: s.mergedIntoDefault ? 1 : 0,
        diverged_from_default: s.divergedFromDefault ? 1 : 0,
        is_default_branch: s.isDefaultBranch ? 1 : 0,
        last_activity_at: s.lastActivityAt ?? null,
        updated_at: s.updatedAt,
        upstream_gone: s.upstreamGone === true ? 1 : 0,
        source_remote: s.source?.remote ?? null,
        source_label: s.source?.label ?? null,
        source_parent: s.source?.parent ?? null,
        source_ahead: s.source?.ahead ?? null,
        source_behind: s.source?.behind ?? null
      });
  }
}
