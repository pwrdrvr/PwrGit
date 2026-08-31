import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BulkSyncMode,
  BulkSyncRepoResult,
  BulkSyncSummary,
  BulkSyncWorktreeResult,
  Repo
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";

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
  const terminalCount = ordered.filter(
    ({ progress: state }) => state?.phase === "complete"
  ).length;
  const queuedCount = ordered.length - terminalCount - runningRepos.length;
  const operationVerb = mode === "fetch" ? "Fetching" : "Checking";
  const activityTitle = cancelling
    ? "Cancelling after the current Git command…"
    : runningRepos.length === 0
      ? "Preparing the next repository…"
      : `${operationVerb} ${runningRepos.map(({ repo }) => repo.name).join(", ")}`;

  const cancel = async (): Promise<void> => {
    setCancelling(true);
    const result = await dispatch("remote:cancelBulkSync", {
      operationId: operationIdRef.current
    });
    if (!result.ok) setError(result.error.message);
  };

  return (
    <div
      className="overlay-backdrop bulk-sync-backdrop"
      onClick={running ? undefined : onClose}
    >
      <section
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

        {running && (
          <div
            className="bulk-sync__activity"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-busy="true"
          >
            <span className="bulk-sync__spinner" aria-hidden="true" />
            <div className="bulk-sync__activity-copy">
              <strong>{activityTitle}</strong>
              <span>
                {runningRepos.length === 1
                  ? runningRepos[0]?.repo.path
                  : "The current repository remains visible while results scroll below."}
              </span>
            </div>
            <div
              className="bulk-sync__state-counts"
              aria-label={`${terminalCount} terminal, ${runningRepos.length} in progress, ${queuedCount} queued`}
            >
              <span className="is-terminal">
                <strong>{terminalCount}</strong> terminal
              </span>
              <span className="is-running">
                <strong>{runningRepos.length}</strong> in progress
              </span>
              <span>
                <strong>{queuedCount}</strong> queued
              </span>
            </div>
          </div>
        )}

        {summary !== null && (
          <div className="bulk-sync__summary" role="status">
            <strong>{summary.cancelled ? "Cancelled" : "Finished"}</strong>
            <span>{overallSummary(summary)}</span>
          </div>
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
                    <small className="selectable" title={repo.path}>
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
    </div>
  );
}
