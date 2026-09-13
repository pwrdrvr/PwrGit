import {
  prunableReason,
  type PruneCandidate,
  type PruneScanProgress,
  type PruneScanRepoOutcome,
  type PruneScanRepoResult,
  type PruneScanSummary,
  type Repo
} from "@pwrgit/shared";

/**
 * The pruner's own pass over a whole profile.
 *
 * Why it exists at all: per-worktree Git state is computed lazily, one repo at
 * a time, when a sidebar row is expanded (`repo:computeState`) — computing all
 * ~150 at launch storms git. The consequence is that on a profile nobody has
 * browsed, the Stale lens is **empty by construction**: there is no state to
 * filter. So a pruner cannot read the current tree; it has to go and compute
 * one, which is this file.
 *
 * Three properties make that safe to offer as a button:
 *
 * - **Bounded.** Repos are the concurrency unit, capped at
 *   `PRUNE_SCAN_CONCURRENCY`, which sits inside the indexer's own hydration
 *   budget (`HYDRATION_GIT_CONCURRENCY`, 4). Main decides how many Git
 *   processes exist — see src/main/git/AGENTS.md.
 * - **Cancellable.** The signal stops the repo loop and the size walks.
 * - **Resumable.** Everything the sweep computes is written to the
 *   `worktree_state` cache, so a cancelled sweep is not wasted: the next run
 *   reports the repos it already reached as `cached` and spawns no git for
 *   them. That is also why a re-run right after a full sweep is nearly free.
 */
export const PRUNE_SCAN_CONCURRENCY = 4;

/** How recent a cached state snapshot has to be for the sweep to trust it. */
export const PRUNE_STATE_FRESH_MS = 5 * 60 * 1000;

/** Candidates measured at once during the sizing phase. */
const PRUNE_SIZE_CONCURRENCY = 4;

/** Candidates sized between sizing-progress events, at most. */
const SIZING_PROGRESS_STRIDE = 8;
/** …and at least this many events over the whole phase, for small sets. */
const SIZING_PROGRESS_STEPS = 20;

export type PruneScanRepoInput = {
  id: string;
  name: string;
  path: string;
  /**
   * Linked, present worktrees this repo could offer — the primary checkout and
   * a missing checkout are never prunable, so neither is worth a git spawn.
   */
  worktreeIds: string[];
  /**
   * Oldest `worktree_state.updated_at` across `worktreeIds`, in epoch ms, or
   * null when any of them has no snapshot at all. The *oldest* is the one that
   * decides: one un-computed worktree means the repo's answer is incomplete.
   */
  stateComputedAt: number | null;
};

type LockRunner = <T>(id: string, operation: () => Promise<T>) => Promise<T>;

export type PruneScanOptions = {
  operationId: string;
  signal?: AbortSignal;
  concurrency?: number;
  /** Recompute even where a fresh snapshot exists. */
  force?: boolean;
  freshMs?: number;
  now?: () => Date;
  /** Run git for one repo's worktrees (in production, the state refresher). */
  computeRepoState: (repoId: string) => Promise<void>;
  /** Re-read the repo's projection after computing. Null means it is gone. */
  readRepo: (repoId: string) => Repo | null;
  /** Measure one candidate's checkout. Omitted ⇒ sizes stay null. */
  sizeOf?: (
    path: string,
    signal?: AbortSignal
  ) => Promise<{ bytes: number; partial: boolean }>;
  onProgress?: (progress: PruneScanProgress) => void;
  /** Serialize per-repository git through the app's repository lock. */
  runRepository?: LockRunner;
};

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted ?? false;

/**
 * Whether this repo needs git run against it, or its cached state is good
 * enough. Pure so the decision is testable without a filesystem: it is the
 * whole of the sweep's "resumable" claim.
 */
export function needsStateCompute(
  repo: PruneScanRepoInput,
  now: number,
  freshMs = PRUNE_STATE_FRESH_MS,
  force = false
): boolean {
  if (repo.worktreeIds.length === 0) return false;
  if (force) return true;
  if (repo.stateComputedAt === null) return true;
  return now - repo.stateComputedAt > freshMs;
}

/**
 * Every prunable worktree in one repo's projection, as candidates.
 *
 * The rule is `prunableReason` from `@pwrgit/shared` — the same call the Stale
 * lens makes in the renderer. Loosening or tightening it moves both.
 */
export function candidatesForRepo(
  repo: Repo,
  now: number = Date.now()
): PruneCandidate[] {
  const out: PruneCandidate[] = [];
  for (const worktree of repo.worktrees) {
    const reason = prunableReason(worktree, now);
    if (reason === null) continue;
    const candidate: PruneCandidate = {
      worktreeId: worktree.id,
      repoId: repo.id,
      repoName: repo.name,
      branch: worktree.branch,
      path: worktree.path,
      reason,
      sizeBytes: null
    };
    if (worktree.lastActivityAt !== undefined) {
      candidate.lastActivityAt = worktree.lastActivityAt;
    }
    out.push(candidate);
  }
  return out;
}

function emptyCounts(): Record<PruneScanRepoOutcome, number> {
  return { scanned: 0, cached: 0, skipped: 0, failed: 0, cancelled: 0 };
}

function cancelledRepo(repo: PruneScanRepoInput): PruneScanRepoResult {
  return {
    repoId: repo.id,
    name: repo.name,
    path: repo.path,
    outcome: "cancelled",
    computed: 0,
    candidates: []
  };
}

/** Sweep a profile's repos for prunable worktrees, then measure what it found. */
export async function sweepPrunableWorktrees(
  repos: PruneScanRepoInput[],
  options: PruneScanOptions
): Promise<PruneScanSummary> {
  const clock = options.now ?? (() => new Date());
  const startedAt = clock().toISOString();
  const totalRepos = repos.length;
  const results: Array<PruneScanRepoResult | undefined> = new Array(totalRepos);
  const runRepository: LockRunner =
    options.runRepository ?? ((_id, operation) => operation());
  let nextIndex = 0;
  let completedRepos = 0;
  let worktreesConsidered = 0;

  options.onProgress?.({
    operationId: options.operationId,
    phase: "starting",
    totalRepos,
    completedRepos
  });

  const complete = (
    index: number,
    result: PruneScanRepoResult,
    announce = true
  ): void => {
    results[index] = result;
    completedRepos += 1;
    if (!announce) return;
    options.onProgress?.({
      operationId: options.operationId,
      phase: "repo_completed",
      totalRepos,
      completedRepos,
      repoId: result.repoId,
      repoName: result.name,
      result
    });
  };

  const sweepRepo = async (
    repo: PruneScanRepoInput
  ): Promise<PruneScanRepoResult> => {
    const compute = needsStateCompute(
      repo,
      clock().getTime(),
      options.freshMs,
      options.force
    );
    let computed = 0;
    if (compute) {
      // The repository lock is the app's serialization point for git in one
      // repo; taking it here is what keeps the sweep from racing a pull the
      // user started, rather than merely being polite.
      await runRepository(repo.id, async () => {
        await options.computeRepoState(repo.id);
      });
      computed = repo.worktreeIds.length;
    }
    const fresh = options.readRepo(repo.id);
    if (fresh === null) {
      return {
        repoId: repo.id,
        name: repo.name,
        path: repo.path,
        outcome: "failed",
        computed,
        candidates: [],
        message: "The repository is no longer indexed."
      };
    }
    const candidates = candidatesForRepo(fresh, clock().getTime());
    worktreesConsidered += repo.worktreeIds.length;
    const outcome: PruneScanRepoOutcome =
      repo.worktreeIds.length === 0 ? "skipped" : compute ? "scanned" : "cached";
    return {
      repoId: repo.id,
      name: repo.name,
      path: repo.path,
      outcome,
      computed,
      candidates
    };
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (isAborted(options.signal)) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= repos.length) return;
      const repo = repos[index]!;
      options.onProgress?.({
        operationId: options.operationId,
        phase: "repo_started",
        totalRepos,
        completedRepos,
        repoId: repo.id,
        repoName: repo.name
      });
      let result: PruneScanRepoResult;
      try {
        result = await sweepRepo(repo);
      } catch {
        result = {
          repoId: repo.id,
          name: repo.name,
          path: repo.path,
          outcome: "failed",
          computed: 0,
          candidates: [],
          message:
            "Could not read this repository's Git state. See Logs for details."
        };
      }
      complete(index, result);
    }
  };

  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? PRUNE_SCAN_CONCURRENCY, totalRepos || 1)
  );
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  // Silently, on purpose. Cancelling a 150-repo sweep after 4 would otherwise
  // emit 146 progress events in one synchronous burst — a renderer state
  // update each — to report repos that were never started. The summary's
  // `counts.repos.cancelled` already carries it.
  for (let index = 0; index < repos.length; index += 1) {
    if (results[index] !== undefined) continue;
    complete(index, cancelledRepo(repos[index]!), false);
  }
  const ordered = results as PruneScanRepoResult[];

  // Sizing is its own phase because it is the slow half and it is not git:
  // measuring one checkout means walking its node_modules. Doing it after the
  // candidate set is known means the progress line can say how many are left,
  // and a cancel here still returns every candidate — just without its size.
  const candidates = ordered.flatMap((repo) => repo.candidates);
  if (options.sizeOf !== undefined && candidates.length > 0) {
    const sizeOf = options.sizeOf;
    let sized = 0;
    let at = 0;
    const emit = (): void =>
      options.onProgress?.({
        operationId: options.operationId,
        phase: "sizing",
        totalRepos,
        completedRepos,
        sizedCandidates: sized,
        totalCandidates: candidates.length
      });
    // One event per candidate is one renderer re-render per candidate, to move
    // a counter nobody reads at that resolution. Report at most every
    // SIZING_PROGRESS_STRIDE, plus the last one so the line always lands on
    // "n of n".
    const stride = Math.max(
      1,
      Math.min(
        SIZING_PROGRESS_STRIDE,
        Math.ceil(candidates.length / SIZING_PROGRESS_STEPS)
      )
    );
    emit();
    const sizeWorker = async (): Promise<void> => {
      for (;;) {
        if (isAborted(options.signal)) return;
        const index = at;
        at += 1;
        if (index >= candidates.length) return;
        const candidate = candidates[index]!;
        try {
          const measured = await sizeOf(candidate.path, options.signal);
          candidate.sizeBytes = measured.bytes;
          if (measured.partial) candidate.sizePartial = true;
        } catch {
          candidate.sizeBytes = null;
        }
        sized += 1;
        if (sized % stride === 0 || sized === candidates.length) emit();
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(PRUNE_SIZE_CONCURRENCY, candidates.length) },
        () => sizeWorker()
      )
    );
  }

  const counts = emptyCounts();
  let sizeBytes = 0;
  for (const repo of ordered) counts[repo.outcome] += 1;
  for (const candidate of candidates) sizeBytes += candidate.sizeBytes ?? 0;

  return {
    operationId: options.operationId,
    cancelled: isAborted(options.signal),
    startedAt,
    finishedAt: clock().toISOString(),
    counts: {
      repos: counts,
      worktreesConsidered,
      candidates: candidates.length,
      sizeBytes
    },
    results: ordered
  };
}
