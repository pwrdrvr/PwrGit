import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import type {
  BulkSyncMode,
  BulkSyncRepoResult,
  BulkSyncRemoteResult,
  BulkSyncSummary,
  BulkSyncWorktreeResult,
  Repo
} from "@pwrgit/shared";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { displayPath } from "../../lib/platform";
import { useModal } from "../../lib/useModal";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import { MinimizeGlyph } from "../../lib/MinimizeGlyph";
import { BulkSyncStatus, type BulkSyncStatusPhase } from "./BulkSyncStatus";
import { BulkSyncToast } from "./BulkSyncToast";
import type { BulkSyncView, FetchScope } from "./bulk-sync-prefs";
import { countOutcomes, finishedCount } from "./bulk-sync-progress";

type RepoProgress =
  | { phase: "waiting" }
  | {
      phase: "running";
      detail?: string;
      worktreePath?: string | undefined;
      totalWorktrees?: number | undefined;
      remotes: BulkSyncRemoteResult[];
      worktrees: BulkSyncWorktreeResult[];
    }
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
 * Whether a finished run failed anywhere, at the level its summary sentence
 * counts. A fetch reports a broken remote inside a `partial` repository, so
 * repository outcomes alone would draw a green mark beside "1 failed".
 */
function summaryHasFailures(summary: BulkSyncSummary): boolean {
  const nested =
    summary.mode === "fetch"
      ? summary.counts.remotes.failed
      : summary.counts.worktrees.failed;
  return summary.counts.repos.failed + nested > 0;
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

function RepoResultDetails({ result, includeAll = false }: {
  result: Pick<BulkSyncRepoResult, "remotes" | "worktrees">;
  includeAll?: boolean;
}) {
  const remoteDetails = result.remotes.filter(
    (remote) => includeAll || remote.outcome !== "fetched"
  );
  const worktreeDetails = result.worktrees.filter(
    (worktree) => includeAll || worktree.outcome !== "up_to_date"
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
            : worktree.outcome === "up_to_date"
              ? "already current"
              : worktree.reason === undefined
                ? worktree.outcome
                : WORKTREE_REASON[worktree.reason]}
          {worktree.message === undefined ? "" : ` — ${worktree.message}`}
        </li>
      ))}
    </ul>
  );
}

/**
 * The status card's second line while a run is live. It is drawn on every
 * render, never only when exactly one repository is in flight: a line that
 * came and went as repositories started and finished moved the bar and the
 * whole list under it, several times a second (layout shift).
 *
 * It names the repository that started last, with a count of the others in
 * flight beside it. Between repositories, when nothing is in flight for a
 * moment, it keeps the last path rather than going blank.
 */
export function livePathLine(
  running: ReadonlyArray<{ id: string; path: string }>,
  newestStartedId: string | null,
  previous: string | null,
  platform: string
): string | null {
  if (running.length === 0) return previous;
  const lead =
    running.find((repo) => repo.id === newestStartedId) ?? running[0]!;
  const others = running.length - 1;
  const path = displayPath(lead.path, platform);
  return others > 0 ? `${path} · +${others} more` : path;
}

/** The run's title, which names its scope. */
export function runTitle(mode: BulkSyncMode, scope: FetchScope = "all"): string {
  if (mode === "soft-pull") {
    return scope === "recent"
      ? "Try to pull recent repositories safely"
      : "Try to pull all safely";
  }
  return scope === "recent"
    ? "Fetch recent repositories"
    : "Fetch all repositories";
}

/** Where a run is drawn. `hidden` is a timed fetch nobody has asked to see. */
export type BulkSyncPresentation = BulkSyncView | "hidden";

/** How long a clean finish stays in the toast before it leaves by itself. */
export const TOAST_DISMISS_MS = 6_000;

const FLY_MS = 300;
const FLY_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * The dialog-to-toast motion (design/Fetch Toast and Scope - UX Review.dc.html,
 * 2b). An empty card flies from the view being left to the view arriving, and
 * the arriving view fades in under it, so the eye follows the run into the
 * corner and back. Scaling the real content instead would stretch its text
 * eight times over on the way. Reduced motion gets the fade alone.
 */
function flyBetween(from: DOMRect, target: HTMLElement): void {
  if (typeof target.animate !== "function") return;
  const reduce =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  if (reduce) {
    target.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
    return;
  }
  const to = target.getBoundingClientRect();
  if (to.width === 0 || from.width === 0) return;
  const ghost = document.createElement("div");
  ghost.className = "bulk-sync-ghost";
  ghost.setAttribute("aria-hidden", "true");
  document.body.append(ghost);
  const frame = (rect: DOMRect) => ({
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    opacity: 1
  });
  const flight = ghost.animate([frame(from), { ...frame(to), opacity: 0.4 }], {
    duration: FLY_MS,
    easing: FLY_EASING,
    fill: "forwards"
  });
  const land = (): void => ghost.remove();
  flight.onfinish = land;
  flight.oncancel = land;
  target.animate([{ opacity: 0 }, { opacity: 0 }, { opacity: 1 }], {
    duration: FLY_MS + 80,
    easing: "ease-out"
  });
}

/**
 * Fetch all, Fetch recent and Try pull all: one run, drawn as a dialog, a
 * toast, or not at all.
 *
 * The run lives here and not in either view, so minimising the dialog does
 * not stop it. That is why closing is no longer the only way back to the
 * app: while the run is live, Escape and a backdrop click minimise, and the
 * dialog's own button says so. Unmounting this component still cancels the
 * run. Design: `design/Fetch Toast and Scope - UX Review.dc.html`, turn 2.
 */
export function BulkSyncDialog({
  profileId,
  repos,
  repoIds,
  scope = "all",
  mode,
  platform,
  view = "dialog",
  autoMinimizeMs = null,
  onViewChange,
  onFinished,
  onClose
}: {
  profileId: string;
  /** The repositories the run covers, for the list drawn before results. */
  repos: Repo[];
  /** Limit the run to these repositories (Fetch recent). */
  repoIds?: string[];
  scope?: FetchScope;
  mode: BulkSyncMode;
  platform: string;
  view?: BulkSyncPresentation;
  /** Minimise the dialog by itself after this long, unless the reader has
   *  touched it — the first run's lesson in where the toast lives. */
  autoMinimizeMs?: number | null;
  /** Without it the run has no toast, and Escape closes as it always did. */
  onViewChange?: (view: BulkSyncView) => void;
  onFinished?: (summary: BulkSyncSummary | null) => void;
  onClose: () => void;
}) {
  const tip = useViewportTooltip();
  const repoSnapshot = useRef(repos).current;
  const repoIdsRef = useRef(repoIds);
  // The repository that started last, and the path line last drawn, so the
  // status card's second line always has something to say. See livePathLine.
  const newestStartedRef = useRef<string | null>(null);
  const lastPathRef = useRef<string | null>(null);
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
          newestStartedRef.current = event.repoId!;
          next.set(event.repoId!, { phase: "running", remotes: [], worktrees: [] });
        } else if (event.phase === "repo_progress") {
          const current = previous.get(event.repoId!);
          if (current?.phase === "complete") return previous;
          const state = current?.phase === "running"
            ? current
            : { phase: "running" as const, remotes: [], worktrees: [] };
          next.set(event.repoId!, {
            ...state,
            ...(event.detail === undefined ? {} : {
              detail: event.detail,
              worktreePath: event.worktreePath
            }),
            totalWorktrees: event.totalWorktrees ?? state.totalWorktrees,
            remotes: event.remoteResult === undefined ? state.remotes : [
              ...state.remotes.filter((remote) => remote.remote !== event.remoteResult!.remote),
              event.remoteResult
            ],
            worktrees: event.worktreeResult === undefined ? state.worktrees : [
              ...state.worktrees.filter((worktree) => worktree.worktreeId !== event.worktreeResult!.worktreeId),
              event.worktreeResult
            ]
          });
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
      void dispatch("remote:bulkSync", {
        operationId,
        profileId,
        mode,
        ...(repoIdsRef.current === undefined
          ? {}
          : { repoIds: repoIdsRef.current })
      }).then(
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
  const title = runTitle(mode, scope);
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

  const livePath = livePathLine(
    runningRepos.map(({ repo }) => repo),
    newestStartedRef.current,
    lastPathRef.current,
    platform
  );
  lastPathRef.current = livePath;
  const canMinimize = running && onViewChange !== undefined;

  // The surface on screen, so a view change knows where to fly from.
  const surfaceRef = useRef<HTMLElement | null>(null);
  const flyFromRef = useRef<DOMRect | null>(null);
  const setSurface = useCallback((el: HTMLElement | null) => {
    surfaceRef.current = el;
  }, []);
  const switchView = useCallback(
    (next: BulkSyncView) => {
      flyFromRef.current = surfaceRef.current?.getBoundingClientRect() ?? null;
      onViewChange?.(next);
    },
    [onViewChange]
  );
  useLayoutEffect(() => {
    const from = flyFromRef.current;
    flyFromRef.current = null;
    if (from !== null && surfaceRef.current !== null) {
      flyBetween(from, surfaceRef.current);
    }
  }, [view]);

  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const ended = !running;
  // Once per run: `summary` and the end are set in the same render, and
  // neither changes again.
  useEffect(() => {
    if (ended) onFinishedRef.current?.(summary);
  }, [ended, summary]);

  // The first run's dialog minimises itself unless the reader has moved
  // over it or typed in it. Focus is not a signal: the dialog takes focus
  // itself when it opens.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (
      autoMinimizeMs === null ||
      view !== "dialog" ||
      !canMinimize ||
      touched
    ) {
      return;
    }
    const timer = window.setTimeout(() => switchView("toast"), autoMinimizeMs);
    return () => window.clearTimeout(timer);
  }, [autoMinimizeMs, canMinimize, switchView, touched, view]);

  // A clean finish in the toast leaves by itself; a failure stays until
  // someone has read it. Hovering holds it.
  const [toastHeld, setToastHeld] = useState(false);
  const cleanFinish =
    summary !== null && !summary.cancelled && !summaryHasFailures(summary);
  useEffect(() => {
    if (view !== "toast" || !cleanFinish || toastHeld) return;
    const timer = window.setTimeout(onClose, TOAST_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [cleanFinish, onClose, toastHeld, view]);

  if (view === "hidden") return null;

  if (view === "toast") {
    return (
      <BulkSyncToast
        title={title}
        surfaceRef={setSurface}
        phase={statusPhase}
        hasFailures={summary !== null && summaryHasFailures(summary)}
        activity={activityTitle}
        counts={outcomeCounts}
        inFlight={runningRepos.length}
        queued={queuedCount}
        startedAt={startedAt}
        durationMs={summary === null ? null : runDurationMs(summary)}
        error={error}
        cancelling={cancelling}
        onExpand={() => switchView("dialog")}
        onCancel={() => void cancel()}
        onDismiss={onClose}
        onHold={setToastHeld}
      />
    );
  }

  return (
    <ModalSurface
      label={title}
      onSurface={setSurface}
      onTouch={() => setTouched(true)}
      onEscape={canMinimize ? () => switchView("toast") : onClose}
      onBackdrop={
        canMinimize ? () => switchView("toast") : running ? undefined : onClose
      }
      after={tip.tooltipNode}
    >
          <div className="bulk-sync__head">
            <div>
              <h2>{title}</h2>
              <p>
                {mode === "fetch"
                  ? "Configured remotes are fetched with --prune once per repository. This removes stale remote-tracking references; local branches are kept. One failure does not stop the rest."
                  : "Only clean, attached branches with a proven fast-forward are updated. PwrGit never stashes, merges histories, rebases, resets, or discards work here."}
              </p>
            </div>
            <span className="bulk-sync__count" aria-live="polite">
              {completed} / {total}
            </span>
            {canMinimize && (
              <button
                type="button"
                className="bulk-sync__minimize"
                aria-label="Minimise to a toast"
                {...hoverTooltip(tip, "Minimise — the run keeps going in a toast")}
                onClick={() => switchView("toast")}
              >
                <MinimizeGlyph />
              </button>
            )}
          </div>

          {(running || summary !== null) && (
            <BulkSyncStatus
              phase={statusPhase}
              hasFailures={summary !== null && summaryHasFailures(summary)}
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
                  : { kind: "path", text: livePath ?? "\u00a0" }
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
              const pathLabel = displayPath(repo.path, platform);
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
                        {...hoverTooltip(tip, pathLabel)}
                      >
                        {pathLabel}
                      </small>
                    </div>
                    <span className={`bulk-sync__repo-status is-${stateClass}`}>
                      {status}
                    </span>
                  </div>
                  {result === null ? (
                    state?.phase === "running" ? (
                      <>
                        <p role="status">{state.detail ?? "Preparing repository…"}</p>
                        {state.worktreePath !== undefined && (
                          <small className="bulk-sync__worktree-path selectable">{state.worktreePath}</small>
                        )}
                        {mode === "soft-pull" && state.totalWorktrees !== undefined && (
                          <p>{state.worktrees.length} of {state.totalWorktrees} worktrees checked</p>
                        )}
                        {(state.remotes.length > 0 || state.worktrees.length > 0) && (
                          <details className="bulk-sync__completed">
                            <summary>Completed tasks ({state.remotes.length + state.worktrees.length})</summary>
                            <RepoResultDetails result={state} includeAll />
                          </details>
                        )}
                        <div className="bulk-sync__recent">
                          <RepoResultDetails result={{
                            remotes: state.worktrees.length === 0 ? state.remotes.slice(-3) : [],
                            worktrees: state.worktrees.slice(-3)
                          }} includeAll />
                        </div>
                      </>
                    ) : <p>Queued</p>
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
    </ModalSurface>
  );
}

/**
 * The dialog's frame. Its own component so `useModal` — Escape, the focus
 * trap and focus restore — is mounted only while the dialog is: a minimised
 * run must not keep trapping focus in a dialog that is not there.
 */
function ModalSurface({
  label,
  onSurface,
  onTouch,
  onEscape,
  onBackdrop,
  after,
  children
}: {
  label: string;
  onSurface: (el: HTMLElement | null) => void;
  onTouch: () => void;
  onEscape: () => void;
  onBackdrop: (() => void) | undefined;
  after: ReactNode;
  children: ReactNode;
}) {
  const modalRef = useModal<HTMLElement>({ onClose: onEscape });
  return (
    <div className="overlay-backdrop bulk-sync-backdrop" onClick={onBackdrop}>
      <section
        ref={(el) => {
          modalRef.current = el;
          onSurface(el);
        }}
        tabIndex={-1}
        className="modal bulk-sync"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
        onPointerMove={onTouch}
        onKeyDown={onTouch}
      >
        {children}
      </section>
      {after}
    </div>
  );
}
