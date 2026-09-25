import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BulkSyncMode,
  BulkSyncRepoResult,
  BulkSyncSummary,
  BulkSyncWorktreeResult,
  Repo
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { useModal } from "../../lib/useModal";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import {
  BulkSyncStatus,
  type BulkSyncStatusMark,
  type BulkSyncStatusPhase
} from "./BulkSyncStatus";
import { countOutcomes, finishedCount } from "./bulk-sync-progress";

type RepoProgress =
  | { phase: "waiting" | "running" }
  | { phase: "complete"; result: BulkSyncRepoResult };

const WORKTREE_REASON: Record<
  NonNullable<BulkSyncWorktreeResult["reason"]>,
  string
> = {
  dirty: "uncommitted changes",
  conflicts: "unresolved conflicts",
  detached_head: "detached HEAD",
  no_head: "no commit",
  no_upstream: "no upstream",
  in_progress: "Git operation in progress",
  diverged: "diverged",
  ahead: "local branch ahead",
  authentication: "authentication required",
  fetch_failed: "upstream fetch failed",
  upstream_not_fetched: "upstream not fetched",
  unsafe_state: "state changed or could not be verified",
  merge_failed: "fast-forward failed",
  cancelled: "cancelled"
};

function repoSummary(result: BulkSyncRepoResult, mode: BulkSyncMode): string {
  if (result.message !== undefined) return result.message;
  if (mode === "fetch") {
    const fetched = result.remotes.filter((remote) => remote.outcome === "fetched").length;
    const failed = result.remotes.filter((remote) => remote.outcome === "failed").length;
    const skipped = result.remotes.filter((remote) => remote.outcome === "skipped").length;
    const cancelled = result.remotes.filter(
      (remote) => remote.outcome === "cancelled"
    ).length;
    if (result.remotes.length === 0) return "No configured remotes.";
    return [
      `${fetched} fetched`,
      failed > 0 ? `${failed} failed` : null,
      skipped > 0 ? `${skipped} skipped` : null,
      cancelled > 0 ? `${cancelled} cancelled` : null
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const updated = result.worktrees.filter(
    (worktree) => worktree.outcome === "updated"
  ).length;
  const current = result.worktrees.filter(
    (worktree) => worktree.outcome === "up_to_date"
  ).length;
  const skipped = result.worktrees.filter(
    (worktree) => worktree.outcome === "skipped"
  ).length;
  const failed = result.worktrees.filter(
    (worktree) => worktree.outcome === "failed"
  ).length;
  const cancelled = result.worktrees.filter(
    (worktree) => worktree.outcome === "cancelled"
  ).length;
  return [
    `${updated} updated`,
    `${current} already current`,
    skipped > 0 ? `${skipped} skipped` : null,
    failed > 0 ? `${failed} failed` : null,
    cancelled > 0 ? `${cancelled} cancelled` : null
  ]
    .filter(Boolean)
    .join(" · ");
}

function overallSummary(summary: BulkSyncSummary): string {
  if (summary.mode === "fetch") {
    const { fetched, failed, skipped, cancelled } = summary.counts.remotes;
    return [
      `${fetched} remote${fetched === 1 ? "" : "s"} fetched`,
      failed > 0 ? `${failed} failed` : null,
      skipped > 0 ? `${skipped} skipped by configuration` : null,
      cancelled > 0 ? `${cancelled} cancelled` : null
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const { updated, upToDate, skipped, failed, cancelled } =
    summary.counts.worktrees;
  return [
    `${updated} worktree${updated === 1 ? "" : "s"} updated`,
    `${upToDate} already current`,
    skipped > 0 ? `${skipped} safely skipped` : null,
    failed > 0 ? `${failed} failed` : null,
    cancelled > 0 ? `${cancelled} cancelled` : null
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The finished card's mark, judged at the level its summary sentence counts.
 * A fetch reports a broken remote inside a `partial` repository, so repository
 * outcomes alone would draw a green mark beside "1 failed".
 */
function summaryMark(summary: BulkSyncSummary): BulkSyncStatusMark {
  if (summary.cancelled) return "cancelled";
  const nested =
    summary.mode === "fetch"
      ? summary.counts.remotes.failed
      : summary.counts.worktrees.failed;
  return summary.counts.repos.failed + nested > 0 ? "failed" : "ok";
}

/** Main's own start and finish, so "took" is the run and not the dialog. */
function runDurationMs(summary: BulkSyncSummary): number | null {
  const ms = Date.parse(summary.finishedAt) - Date.parse(summary.startedAt);
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

function repoStatus(
  state: RepoProgress | undefined,
  mode: BulkSyncMode
): string {
  if (state?.phase === "running") {
    return mode === "fetch" ? "Fetching…" : "Checking…";
  }
  if (state?.phase !== "complete") return "Queued";
  return state.result.outcome.replace("_", " ");
}

function RepoResultDetails({ result }: { result: BulkSyncRepoResult }) {
  const remoteDetails = result.remotes.filter(
    (remote) => remote.outcome !== "fetched"
  );
  const worktreeDetails = result.worktrees.filter(
    (worktree) => worktree.outcome !== "up_to_date"
  );
  if (remoteDetails.length === 0 && worktreeDetails.length === 0) return null;
  return (
    <ul className="bulk-sync__details">
      {remoteDetails.map((remote) => (
        <li key={`remote:${remote.remote}`}>
          <strong>{remote.remote}</strong>: {remote.message ?? remote.outcome}
        </li>
      ))}
      {worktreeDetails.map((worktree) => (
        <li key={worktree.worktreeId}>
          <strong>{worktree.branch}</strong>: {worktree.outcome === "updated"
            ? "fast-forwarded"
            : worktree.reason === undefined
              ? worktree.outcome
              : WORKTREE_REASON[worktree.reason]}
          {worktree.message === undefined ? "" : ` — ${worktree.message}`}
        </li>
      ))}
    </ul>
  );
}

export function BulkSyncDialog({
  profileId,
  repos,
  mode,
  onClose
}: {
  profileId: string;
  repos: Repo[];
  mode: BulkSyncMode;
  onClose: () => void;
}) {
  const tip = useViewportTooltip();
  const repoSnapshot = useRef(repos).current;
  const operationIdRef = useRef("");
  const [completed, setCompleted] = useState(0);
  const [total, setTotal] = useState(repoSnapshot.length);
  const [cancelling, setCancelling] = useState(false);
  const [summary, setSummary] = useState<BulkSyncSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Map<string, RepoProgress>>(
    () => new Map(repoSnapshot.map((repo) => [repo.id, { phase: "waiting" }]))
  );
  // The live clock's origin. The operation launches one microtask after
  // mount, so this is its start to well inside the clock's one-second grain.
  const [startedAt] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    let started = false;
    let settled = false;
    const operationId = crypto.randomUUID();
    operationIdRef.current = operationId;
    const off = subscribe("remote:bulkSyncProgress", (event) => {
      if (!live || event.operationId !== operationId) return;
      setCompleted(event.completedRepos);
      setTotal(event.totalRepos);
      if (event.repoId === undefined) return;
      setProgress((previous) => {
        const next = new Map(previous);
        if (event.phase === "repo_started") {
          next.set(event.repoId!, { phase: "running" });
        } else if (event.phase === "repo_completed" && event.result !== undefined) {
          next.set(event.repoId!, { phase: "complete", result: event.result });
        }
        return next;
      });
    });
    // StrictMode mounts, cleans up, then mounts an effect again in development.
    // Deferring launch by one microtask lets the throwaway pass disappear
    // without starting and immediately cancelling a real Git operation.
    queueMicrotask(() => {
      if (!live) return;
      started = true;
      void dispatch("remote:bulkSync", { operationId, profileId, mode }).then(
        (result) => {
          settled = true;
          if (!live) return;
          if (result.ok) {
            setSummary(result.value);
            setCompleted(result.value.results.length);
            setTotal(result.value.results.length);
            setProgress(
              new Map(
                result.value.results.map((repo) => [
                  repo.repoId,
                  { phase: "complete", result: repo } as const
                ])
              )
            );
          } else {
            setError(result.error.message);
          }
        }
      );
    });
    return () => {
      live = false;
      off();
      if (started && !settled) {
        void dispatch("remote:cancelBulkSync", { operationId });
      }
    };
  }, [mode, profileId]);

  const ordered = useMemo(
    () =>
      summary === null
        ? repoSnapshot.map((repo) => ({
            repo: { id: repo.id, name: repo.name, path: repo.path },
            progress: progress.get(repo.id)
          }))
        : summary.results.map((result) => ({
            repo: { id: result.repoId, name: result.name, path: result.path },
            progress: { phase: "complete", result } as const
          })),
    [progress, repoSnapshot, summary]
  );
  const running = summary === null && error === null;
  const title =
    mode === "fetch" ? "Fetch all repositories" : "Try to pull all safely";
  const runningRepos = ordered.filter(
    ({ progress: state }) => state?.phase === "running"
  );
  const outcomeCounts = countOutcomes(
    ordered.flatMap(({ progress: state }) =>
      state?.phase === "complete" ? [state.result.outcome] : []
    )
  );
  const terminalCount = finishedCount(outcomeCounts);
  const queuedCount = ordered.length - terminalCount - runningRepos.length;
  const operationVerb = mode === "fetch" ? "Fetching" : "Checking";
  const activityTitle = cancelling
    ? "Cancelling after the current Git command…"
    : runningRepos.length > 0
      ? `${operationVerb} ${runningRepos.map(({ repo }) => repo.name).join(", ")}`
      : queuedCount === 0
        ? "Finishing…"
        : "Preparing the next repository…";
  const statusPhase: BulkSyncStatusPhase =
    summary !== null
      ? summary.cancelled
        ? "cancelled"
        : "finished"
      : cancelling
        ? "cancelling"
        : "running";

  const cancel = async (): Promise<void> => {
    setCancelling(true);
    const result = await dispatch("remote:cancelBulkSync", {
      operationId: operationIdRef.current
    });
    if (!result.ok) setError(result.error.message);
  };

  const modalRef = useModal<HTMLDivElement>({ onClose });

  return (
    <div
      className="overlay-backdrop bulk-sync-backdrop"
      onClick={running ? undefined : onClose}
    >
      <section
        ref={modalRef}
        tabIndex={-1}
        className="modal bulk-sync"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="bulk-sync__head">
          <div>
            <h2>{title}</h2>
            <p>
              {mode === "fetch"
                ? "Configured remotes are fetched once per repository; one failure does not stop the rest."
                : "Only clean, attached branches with a proven fast-forward are updated. PwrGit never stashes, merges histories, rebases, resets, or discards work here."}
            </p>
          </div>
          <span className="bulk-sync__count" aria-live="polite">
            {completed} / {total}
          </span>
        </div>

        {(running || summary !== null) && (
          <BulkSyncStatus
            phase={statusPhase}
            mark={summary === null ? null : summaryMark(summary)}
            title={
              summary === null
                ? activityTitle
                : summary.cancelled
                  ? "Cancelled"
                  : "Finished"
            }
            detail={
              summary !== null
                ? { kind: "summary", text: overallSummary(summary) }
                : runningRepos.length === 1 && runningRepos[0] !== undefined
                  ? { kind: "path", text: runningRepos[0].repo.path }
                  : null
            }
            counts={outcomeCounts}
            inFlight={runningRepos.length}
            queued={queuedCount}
            startedAt={startedAt}
            durationMs={summary === null ? null : runDurationMs(summary)}
          />
        )}
        {error !== null && <div className="modal__error">{error}</div>}

        <div className="bulk-sync__repos" aria-label="Repository results">
          {ordered.map(({ repo, progress: state }) => {
            const result = state?.phase === "complete" ? state.result : null;
            const status = repoStatus(state, mode);
            const stateClass =
              state?.phase === "running"
                ? "running"
                : result === null
                  ? "queued"
                  : result.outcome;
            return (
              <article
                className={`bulk-sync__repo is-${stateClass}`}
                key={repo.id}
              >
                <div className="bulk-sync__repo-head">
                  <div>
                    <strong>{repo.name}</strong>
                    <small
                      className="selectable"
                      {...hoverTooltip(tip, repo.path)}
                    >
                      {repo.path}
                    </small>
                  </div>
                  <span className={`bulk-sync__repo-status is-${stateClass}`}>
                    {status}
                  </span>
                </div>
                {result === null ? (
                  <p>{state?.phase === "running" ? "Git is working…" : "Queued"}</p>
                ) : (
                  <>
                    <p>{repoSummary(result, mode)}</p>
                    <RepoResultDetails result={result} />
                  </>
                )}
              </article>
            );
          })}
        </div>

        <div className="modal__actions">
          {running ? (
            <button
              className="modal__cancel"
              disabled={cancelling}
              onClick={() => void cancel()}
              autoFocus
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          ) : (
            <button className="modal__create" onClick={onClose} autoFocus>
              Close
            </button>
          )}
        </div>
      </section>
      {tip.tooltipNode}
    </div>
  );
}
