import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatBytes,
  STALE_AGE_DAYS,
  type PruneCandidate,
  type PruneScanSummary
} from "@pwrgit/shared";
import { confirmDialog } from "../shell/dialogs";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { relativeAge } from "../../lib/relativeAge";
import { useModal } from "../../lib/useModal";
import { ReclaimDiskPanel } from "./ReclaimDiskPanel";
import {
  describeBytes,
  reasonLabel,
  removalConfirmMessage,
  selectionTotals,
  sortCandidates
} from "./prune-view";

type Stage =
  | { kind: "sweeping" }
  | { kind: "review" }
  | { kind: "removing" }
  | { kind: "reclaiming" };

/**
 * Find every worktree that is safe to remove, across every repo, and act on
 * them together.
 *
 * The sweep is the engineering here, and it is not optional. Per-worktree Git
 * state is computed lazily when a sidebar row is expanded, so on a profile
 * nobody has browsed the Stale lens is empty by construction — reading the
 * tree the renderer already has would report "nothing to prune" on a disk
 * full of finished worktrees. `prune:scan` goes and computes it, bounded and
 * cancellable in the main process, and reports progress here.
 *
 * Nothing is selected when the sweep lands. This dialog's whole output is a
 * list of things it believes are safe to delete, and a pre-ticked list of
 * those is a dialog that deletes by default.
 */
export function PruneWorktreesDialog({
  profileId,
  onRemove,
  onClose
}: {
  profileId: string;
  /**
   * Bulk removal — `useRepoTree.removeWorktrees`, already confirmed here.
   * Reusing it keeps one removal path: it streams `worktree:removed`, prunes
   * the sidebar rows live, and owns the dirty/force retry.
   */
  onRemove: (worktreeIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "sweeping" });
  const [summary, setSummary] = useState<PruneScanSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [sweep, setSweep] = useState<{
    completedRepos: number;
    totalRepos: number;
    repoName: string | null;
    sizing: { done: number; total: number } | null;
  }>({ completedRepos: 0, totalRepos: 0, repoName: null, sizing: null });
  const [cancelling, setCancelling] = useState(false);
  const operationIdRef = useRef("");
  const sweepRunRef = useRef(0);
  /** Set once ignored files have actually been deleted; see `onBack` below. */
  const reclaimedRef = useRef(false);
  /** The reclaim panel is mid-`git clean`; see `busy` below. */
  const [reclaiming, setReclaiming] = useState(false);

  const runSweep = useCallback(
    (force: boolean): void => {
      const run = ++sweepRunRef.current;
      const operationId = crypto.randomUUID();
      operationIdRef.current = operationId;
      setStage({ kind: "sweeping" });
      setSummary(null);
      setSelected(new Set());
      setRemoved(new Set());
      setError(null);
      setCancelling(false);
      setSweep({
        completedRepos: 0,
        totalRepos: 0,
        repoName: null,
        sizing: null
      });
      void dispatch("prune:scan", { operationId, profileId, force }).then(
        (result) => {
          if (sweepRunRef.current !== run) return;
          if (result.ok) {
            setSummary(result.value);
            setStage({ kind: "review" });
          } else {
            setError(result.error.message);
            setStage({ kind: "review" });
          }
        }
      );
    },
    [profileId]
  );

  useEffect(() => {
    // StrictMode mounts, cleans up, then mounts again in development. Deferring
    // by a microtask lets the throwaway pass disappear without starting and
    // immediately cancelling a real sweep (BulkSyncDialog does the same).
    let live = true;
    queueMicrotask(() => {
      if (live) runSweep(false);
    });
    return () => {
      live = false;
      sweepRunRef.current += 1;
      // Nothing started on the throwaway StrictMode pass, so there is nothing
      // to cancel — and an empty id is a request main would refuse anyway.
      if (operationIdRef.current !== "") {
        void dispatch("prune:cancelScan", {
          operationId: operationIdRef.current
        });
      }
    };
  }, [runSweep]);

  useEffect(() => {
    return subscribe("prune:scanProgress", (event) => {
      if (event.operationId !== operationIdRef.current) return;
      setSweep((previous) => ({
        completedRepos: event.completedRepos,
        totalRepos: event.totalRepos,
        repoName:
          event.phase === "repo_started"
            ? (event.repoName ?? null)
            : previous.repoName,
        sizing:
          event.phase === "sizing"
            ? {
                done: event.sizedCandidates ?? 0,
                total: event.totalCandidates ?? 0
              }
            : previous.sizing
      }));
    });
  }, []);

  // Rows leave as their removal completes, which is the same live feedback the
  // sidebar gets from this event — the dialog stays honest about what is gone.
  useEffect(() => {
    return subscribe("worktree:removed", ({ worktreeId }) => {
      setRemoved((previous) => new Set(previous).add(worktreeId));
    });
  }, []);

  const candidates = useMemo(
    () =>
      summary === null
        ? []
        : sortCandidates(
            summary.results.flatMap((repo) => repo.candidates)
          ).filter((candidate) => !removed.has(candidate.worktreeId)),
    [removed, summary]
  );
  const totals = useMemo(
    () => selectionTotals(candidates, selected),
    [candidates, selected]
  );
  const allSelected =
    candidates.length > 0 && totals.count === candidates.length;
  const failedRepos = useMemo(
    () => (summary?.results ?? []).filter((repo) => repo.outcome === "failed"),
    [summary]
  );

  const toggle = (worktreeId: string): void =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(worktreeId)) next.delete(worktreeId);
      else next.add(worktreeId);
      return next;
    });

  const cancelSweep = async (): Promise<void> => {
    setCancelling(true);
    await dispatch("prune:cancelScan", {
      operationId: operationIdRef.current
    });
  };

  const remove = async (): Promise<void> => {
    const picked = candidates.filter((candidate) =>
      selected.has(candidate.worktreeId)
    );
    if (picked.length === 0) return;
    const go = await confirmDialog({
      title: `Remove ${picked.length} worktree${picked.length === 1 ? "" : "s"}?`,
      message: removalConfirmMessage(picked, totals),
      confirmLabel: `Remove ${picked.length}`,
      danger: true
    });
    if (!go) return;
    const ids = picked.map((candidate) => candidate.worktreeId);
    setStage({ kind: "removing" });
    await onRemove(ids);
    setSelected(new Set());
    setStage({ kind: "review" });
  };

  const busy =
    stage.kind === "sweeping" || stage.kind === "removing" || reclaiming;
  // useModal: "A dialog mid-flight ... should pass an `onClose` that refuses,
  // exactly as its backdrop click already does — this hook does not decide
  // that." Escape during a removal would unmount the dialog while
  // `worktree:removeMany` keeps deleting working directories, taking the
  // progress and the `worktree:removed` subscription with it; the sweep has
  // its own Cancel button, which is the way out that actually stops the work.
  const modalRef = useModal<HTMLDivElement>({
    onClose: () => {
      if (busy) return;
      onClose();
    }
  });
  const selectedCandidates = candidates.filter((candidate) =>
    selected.has(candidate.worktreeId)
  );

  return (
    <div
      className="overlay-backdrop prune-backdrop"
      onClick={busy ? undefined : onClose}
    >
      <section
        ref={modalRef}
        tabIndex={-1}
        className="modal prune"
        role="dialog"
        aria-modal="true"
        aria-label="Prune worktrees"
        onClick={(event) => event.stopPropagation()}
      >
        {stage.kind === "reclaiming" ? (
          <ReclaimDiskPanel
            candidates={selectedCandidates}
            onBack={() => {
              // Reclaiming makes every size on the list wrong by design — the
              // freed bytes are the point. Re-sweep on the way back rather
              // than the moment it finishes, so the panel's own summary is
              // still there to read; cached Git state makes the re-sweep cheap.
              if (reclaimedRef.current) {
                reclaimedRef.current = false;
                runSweep(false);
              } else {
                setStage({ kind: "review" });
              }
            }}
            onFinished={() => {
              reclaimedRef.current = true;
            }}
            onRunningChange={setReclaiming}
          />
        ) : (
          <>
            <div className="prune__head">
              <div>
                <h2>Prune worktrees</h2>
                <p>
                  Every repository is checked for worktrees that are clean, not
                  the default branch, and finished — a merged pull request at
                  any age, or merged into the default branch (or sharing no
                  history with it) and untouched for {STALE_AGE_DAYS} days.
                </p>
              </div>
              <span className="prune__count" aria-live="polite">
                {stage.kind === "sweeping"
                  ? `${sweep.completedRepos} / ${sweep.totalRepos}`
                  : `${candidates.length} found`}
              </span>
            </div>

            {stage.kind === "sweeping" && (
              <div
                className="prune__activity"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <span className="prune__spinner" aria-hidden="true" />
                <div className="prune__activity-copy">
                  <strong>
                    {cancelling
                      ? "Stopping after the current repository…"
                      : sweep.sizing !== null
                        ? "Measuring what each one holds…"
                        : sweep.repoName === null
                          ? "Reading Git state across every repository…"
                          : `Reading ${sweep.repoName}`}
                  </strong>
                  <span>
                    {sweep.sizing !== null
                      ? `${sweep.sizing.done} of ${sweep.sizing.total} candidates measured`
                      : "Repositories already read this session are reused."}
                  </span>
                </div>
              </div>
            )}

            {summary !== null && (
              <div className="prune__summary" role="status">
                <strong>
                  {summary.cancelled ? "Stopped early" : "Sweep finished"}
                </strong>
                <span>
                  {summary.counts.repos.scanned} read ·{" "}
                  {summary.counts.repos.cached} reused ·{" "}
                  {summary.counts.worktreesConsidered} worktrees considered ·{" "}
                  {formatBytes(summary.counts.sizeBytes)} in candidates
                  {summary.counts.repos.failed > 0
                    ? ` · ${summary.counts.repos.failed} unreadable`
                    : ""}
                </span>
              </div>
            )}
            {error !== null && <div className="modal__error">{error}</div>}

            {stage.kind === "review" && candidates.length > 0 && (
              <div className="prune__select">
                <label>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() =>
                      setSelected(
                        allSelected
                          ? new Set()
                          : new Set(candidates.map((c) => c.worktreeId))
                      )
                    }
                  />
                  Select all {candidates.length}
                </label>
                <span aria-live="polite">
                  {totals.count === 0
                    ? "Nothing selected."
                    : `${totals.count} selected · ${describeBytes(totals)}`}
                </span>
              </div>
            )}

            <div className="prune__rows" aria-label="Prunable worktrees">
              {stage.kind === "review" &&
                candidates.length === 0 &&
                error === null && (
                  <p className="prune__empty">
                    Nothing is safe to remove. Worktrees with uncommitted
                    changes, unmerged work, or recent commits are never offered
                    here.
                  </p>
                )}
              {candidates.map((candidate) => (
                <PruneRow
                  key={candidate.worktreeId}
                  candidate={candidate}
                  checked={selected.has(candidate.worktreeId)}
                  disabled={stage.kind === "removing"}
                  onToggle={() => toggle(candidate.worktreeId)}
                />
              ))}
              {failedRepos.length > 0 && (
                <ul className="prune__failures">
                  {failedRepos.map((repo) => (
                    <li key={repo.repoId}>
                      <strong>{repo.name}</strong>: {repo.message ?? "unreadable"}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="modal__actions">
              {stage.kind === "sweeping" ? (
                <button
                  className="modal__cancel"
                  disabled={cancelling}
                  onClick={() => void cancelSweep()}
                  autoFocus
                >
                  {cancelling ? "Stopping…" : "Cancel"}
                </button>
              ) : (
                <>
                  <button className="modal__cancel" onClick={onClose}>
                    Close
                  </button>
                  <button
                    className="prune__ghost"
                    disabled={stage.kind === "removing"}
                    onClick={() => runSweep(true)}
                  >
                    Re-read all
                  </button>
                  <button
                    className="modal__create"
                    disabled={totals.count === 0 || stage.kind === "removing"}
                    onClick={() => setStage({ kind: "reclaiming" })}
                  >
                    Reclaim disk space…
                  </button>
                  <button
                    className="modal__create modal__create--danger"
                    disabled={totals.count === 0 || stage.kind === "removing"}
                    onClick={() => void remove()}
                  >
                    {stage.kind === "removing"
                      ? "Removing…"
                      : `Remove ${totals.count === 0 ? "" : totals.count} worktree${
                          totals.count === 1 ? "" : "s"
                        }…`}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function PruneRow({
  candidate,
  checked,
  disabled,
  onToggle
}: {
  candidate: PruneCandidate;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <label className={`prune__row${checked ? " is-selected" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
      />
      <span className="prune__row-main">
        <strong>
          {candidate.repoName} <span aria-hidden="true">·</span>{" "}
          {candidate.branch}
        </strong>
        <small className="selectable" title={candidate.path}>
          {candidate.path}
        </small>
      </span>
      <span className="prune__row-meta">
        <span className={`prune__reason is-${candidate.reason.kind}`}>
          {reasonLabel(candidate.reason)}
        </span>
        <span className="prune__row-facts">
          {candidate.lastActivityAt === undefined
            ? "no commits"
            : relativeAge(candidate.lastActivityAt)}
          {" · "}
          {candidate.sizeBytes === null
            ? "size unknown"
            : `${candidate.sizePartial === true ? "≥ " : ""}${formatBytes(candidate.sizeBytes)}`}
        </span>
      </span>
    </label>
  );
}
