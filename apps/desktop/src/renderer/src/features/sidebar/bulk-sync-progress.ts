import type { BulkSyncRepoResult } from "@pwrgit/shared";

export type BulkSyncOutcome = BulkSyncRepoResult["outcome"];

/**
 * Finished outcomes in the order the progress bar stacks them: the good news
 * first, then the conservative skips, then what went wrong, then what never
 * ran. The legend reads in the same order, in the cards' own words.
 */
export const BULK_SYNC_OUTCOMES: readonly BulkSyncOutcome[] = [
  "success",
  "partial",
  "skipped",
  "failed",
  "cancelled"
];

export type BulkSyncOutcomeCounts = Record<BulkSyncOutcome, number>;

export function countOutcomes(
  outcomes: Iterable<BulkSyncOutcome>
): BulkSyncOutcomeCounts {
  const counts: BulkSyncOutcomeCounts = {
    success: 0,
    partial: 0,
    skipped: 0,
    failed: 0,
    cancelled: 0
  };
  for (const outcome of outcomes) counts[outcome] += 1;
  return counts;
}

export function finishedCount(counts: BulkSyncOutcomeCounts): number {
  return BULK_SYNC_OUTCOMES.reduce((sum, outcome) => sum + counts[outcome], 0);
}

/**
 * Before this much evidence, one fast repository at the head of the queue
 * makes the estimate wildly optimistic, so none is offered.
 */
export const ESTIMATE_MIN_FINISHED = 3;
export const ESTIMATE_MIN_ELAPSED_MS = 5_000;

/**
 * Time left at the run's observed throughput. `finished / elapsed` is already
 * a rate for the whole worker pool, so the pool size never appears here.
 */
export function estimateRemainingMs(
  elapsedMs: number,
  finished: number,
  total: number
): number | null {
  if (finished < ESTIMATE_MIN_FINISHED) return null;
  if (elapsedMs < ESTIMATE_MIN_ELAPSED_MS) return null;
  if (finished >= total) return null;
  return ((total - finished) * elapsedMs) / finished;
}

/**
 * Deliberately coarse — five-second steps under a minute, whole minutes above
 * — because an estimate that ticks down one second at a time claims a
 * precision a queue of unequal repositories cannot deliver.
 */
export function formatRemaining(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 5) return "a few seconds left";
  const stepped = Math.ceil(seconds / 5) * 5;
  if (stepped < 60) return `about ${stepped}s left`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `about ${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  return `about ${hours}h ${String(minutes % 60).padStart(2, "0")}m left`;
}

export function repositoryNoun(count: number): string {
  return count === 1 ? "repository" : "repositories";
}

/** The progress bar's `aria-valuetext`: position first, trouble second. */
export function progressValueText(
  counts: BulkSyncOutcomeCounts,
  total: number
): string {
  const finished = finishedCount(counts);
  return [
    `${finished} of ${total} ${repositoryNoun(total)} finished`,
    counts.failed > 0 ? `${counts.failed} failed` : null,
    counts.cancelled > 0 ? `${counts.cancelled} cancelled` : null
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * A live run's progress, as the run's own fold has it. The dialog folds
 * `remote:bulkSyncProgress` and reports this up, so the sync button's face,
 * its hover card and the Sync options hint read the same numbers the dialog
 * and toast draw, even while a timed run is hidden.
 * Design: `design/Sync Progress on the Button - UX Review.dc.html`.
 */
export type BulkSyncLiveProgress = {
  counts: BulkSyncOutcomeCounts;
  inFlight: number;
  queued: number;
  /** `Date.now()` when the run was launched. */
  startedAt: number;
  /** The repository being worked on, as the status card's second line. */
  path: string | null;
};

export function liveTotal(progress: BulkSyncLiveProgress): number {
  return finishedCount(progress.counts) + progress.inFlight + progress.queued;
}

/** "12/27": the face's count, short enough to survive the icon-only step. */
export function faceCount(progress: BulkSyncLiveProgress): string {
  return `${finishedCount(progress.counts)}/${liveTotal(progress)}`;
}

/**
 * Sync options → Show the running sync's hint, the same shape as Show last
 * run's: position, trouble, then who started it and the clock.
 */
export function runningSyncHint(
  progress: BulkSyncLiveProgress,
  auto: boolean,
  elapsed: string
): string {
  const total = liveTotal(progress);
  return [
    `${finishedCount(progress.counts)} of ${total}`,
    progress.counts.failed > 0 ? `${progress.counts.failed} failed` : null,
    `${auto ? "automatic, " : ""}${elapsed}`
  ]
    .filter(Boolean)
    .join(" · ");
}
