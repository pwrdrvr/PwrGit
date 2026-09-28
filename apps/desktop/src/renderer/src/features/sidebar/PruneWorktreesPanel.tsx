import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatBytes,
  STALE_AGE_DAYS,
  type PruneCandidate,
  type PruneScanSummary
} from "@pwrgit/shared";
import { confirmDialog } from "../shell/dialogs";
import { dispatch, subscribe } from "../../lib/pwrgit";
import { currentPlatform } from "../../lib/platform";
import { relativeAge } from "../../lib/relativeAge";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import { ReclaimDiskPanel } from "./ReclaimDiskPanel";
import { MaintenanceRulesApplied } from "./MaintenancePlan";
import {
  describeBytes,
  emptyReviewCopy,
  reasonLabel,
  protectedFromPruning,
  removalConfirmMessage,
  selectionTotals,
  sortCandidates
} from "./prune-view";

type Stage =
  | { kind: "idle" }
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
export function PruneWorktreesPanel({
  profileId,
  onRemove,
  onClose,
  onBusyChange,
  onCandidateCount,
  autoStart = false,
  onContinue,
  step = false,
  onChangeRules,
  protectRecent: initialProtectRecent = true,
  protectionDays: initialProtectionDays = 7
}: {
  profileId: string;
  /**
   * Bulk removal — `useRepoTree.removeWorktrees`, already confirmed here.
   * Reusing it keeps one removal path: it streams `worktree:removed`, prunes
   * the sidebar rows live, and owns the dirty/force retry.
   */
  onRemove: (worktreeIds: string[]) => Promise<void>;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
  onCandidateCount?: (count: number) => void;
  /** Only the combined workflow sets this, after an explicit Analyze. */
  autoStart?: boolean;
  onContinue?: (removedCount: number, size: string, items: { label: string; detail: string }[]) => void;
  step?: boolean;
  onChangeRules?: () => void;
  protectRecent?: boolean;
  protectionDays?: number;
}) {
  const [protectRecent, setProtectRecent] = useState(initialProtectRecent);
  const [protectionDays, setProtectionDays] = useState(initialProtectionDays);
  const [stage, setStage] = useState<Stage>({ kind: autoStart ? "sweeping" : "idle" });
  const [summary, setSummary] = useState<PruneScanSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const removedRef = useRef(new Set<string>());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [sweep, setSweep] = useState<{
    completedRepos: number;
    totalRepos: number;
    repoName: string | null;
    sizing: { done: number; total: number } | null;
  }>({ completedRepos: 0, totalRepos: 0, repoName: null, sizing: null });
  const [cancelling, setCancelling] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showKept, setShowKept] = useState(false);
  const footerRef = useRef<HTMLDivElement>(null);
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
      removedRef.current.clear();
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
      ).catch((cause: unknown) => {
        if (sweepRunRef.current !== run) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStage({ kind: "review" });
      });
    },
    [profileId]
  );

  useEffect(() => {
    // StrictMode mounts, cleans up, then mounts again in development. Deferring
    // by a microtask lets the throwaway pass disappear without starting and
    // immediately cancelling a real sweep (BulkSyncDialog does the same).
    let live = true;
    queueMicrotask(() => {
      if (live && autoStart) runSweep(false);
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
  }, [runSweep, autoStart]);

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
      removedRef.current.add(worktreeId);
      setRemoved((previous) => new Set(previous).add(worktreeId));
    });
  }, []);

  const swept = useMemo(
    () =>
      summary === null
        ? []
        : sortCandidates(summary.results.flatMap((repo) => repo.candidates)),
    [summary]
  );
  const remaining = useMemo(
    () => swept.filter((candidate) => !removed.has(candidate.worktreeId)),
    [removed, swept]
  );
  const candidates = useMemo(
    () => remaining.filter((candidate) => !protectedFromPruning(
      candidate,
      protectRecent ? protectionDays : 0,
      Date.parse(summary?.finishedAt ?? "")
    )),
    [remaining, protectRecent, protectionDays, summary]
  );
  useEffect(() => {
    if (summary !== null) onCandidateCount?.(candidates.length);
  }, [summary, candidates.length, onCandidateCount]);
  const protectedCandidates = remaining.filter((candidate) => !candidates.includes(candidate));
  const protectedCount = protectedCandidates.length;
  const unreadableCount = protectedCandidates.filter((candidate) => candidate.activityComplete !== true ||
    !Number.isFinite(Date.parse(candidate.lastTouchedAt ?? "")) ||
    !Number.isFinite(Date.parse(candidate.lastActivityAt ?? ""))).length;
  const recentCount = protectedCount - unreadableCount;
  const proposedTotals = selectionTotals(
    candidates,
    new Set(candidates.map((c) => c.worktreeId))
  );
  const totals = useMemo(
    () => selectionTotals(candidates, selected),
    [candidates, selected]
  );
  // What this sweep has already removed, so an emptied list can report the
  // removal instead of reading as "nothing was ever here".
  const removedTotals = useMemo(
    () => selectionTotals(swept, removed),
    [removed, swept]
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

  const continueWithRemoved = (): void => {
    const removedCandidates = swept.filter((candidate) => removedRef.current.has(candidate.worktreeId));
    const removedIds = new Set(removedCandidates.map((candidate) => candidate.worktreeId));
    onContinue?.(
      removedCandidates.length,
      describeBytes(selectionTotals(removedCandidates, removedIds)),
      removedCandidates.map((candidate) => ({
        label: `${candidate.repoName} · ${candidate.branch}`,
        detail: candidate.path
      }))
    );
  };

  const remove = async (): Promise<void> => {
    const picked = candidates.filter((candidate) =>
      selected.has(candidate.worktreeId)
    );
    if (picked.length === 0) return;
    const go = await confirmDialog({
      title: `Remove ${picked.length} worktree${picked.length === 1 ? "" : "s"}?`,
      message: removalConfirmMessage(picked, totals, currentPlatform()),
      confirmLabel: `Remove ${picked.length}`,
      danger: true
    });
    if (!go) return;
    const ids = picked.map((candidate) => candidate.worktreeId);
    setStage({ kind: "removing" });
    try {
      await onRemove(ids);
      setSelected(new Set());
      if (onContinue !== undefined) {
        if (ids.every((id) => removedRef.current.has(id))) {
          continueWithRemoved();
        } else {
          setError("Some worktrees were not removed. Review the remaining worktrees or continue without further pruning.");
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStage({ kind: "review" });
    }
  };

  const busy =
    stage.kind === "sweeping" || stage.kind === "removing" || reclaiming;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  useEffect(() => {
    if (stage.kind !== "idle") {
      footerRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    }
  }, [stage.kind]);

  const selectedCandidates = candidates.filter((candidate) =>
    selected.has(candidate.worktreeId)
  );

  return (
    <div className="prune__panel">
        <span className="prune__count" aria-live="polite">{stage.kind === "sweeping" ? `${sweep.completedRepos} / ${sweep.totalRepos}` : removedTotals.count > 0 ? `${removedTotals.count} removed` : `${candidates.length} found`}</span>
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
            {!step && stage.kind === "idle" && <div className="prune__head">
              <div>
                <p>Every repository in this window’s profile.</p>
              </div>
            </div>}

            {!step && stage.kind === "idle" && <fieldset className="prune__protection">
              <legend>Finished worktrees</legend>
              <div className="prune__fixed"><span className="prune__fixed-mark" aria-hidden="true" /><strong>Finished means merged</strong><p>A merged pull request, or merged into the default branch with no commits for {STALE_AGE_DAYS} days. Worktrees that share no history with the default branch count too.</p></div>
              <div className="prune__protection-controls">
                <label>
                  <input type="checkbox" checked={protectRecent} disabled={busy}
                    onChange={(event) => {
                      setProtectRecent(event.target.checked);
                      setSelected(new Set());
                    }} />
                  Keep worktrees touched in the last
                </label>
                  <select aria-label="Protection window" value={protectionDays}
                    disabled={busy || !protectRecent}
                    onChange={(event) => {
                      setProtectionDays(Number(event.target.value));
                      setSelected(new Set());
                    }}>
                    {[1, 3, 7, 14, 30, 90].map((days) => (
                      <option key={days} value={days}>{days} {days === 1 ? "day" : "days"}</option>
                    ))}
                  </select>
              </div>
              <p>Touched is the newest commit or file change, ignored files included. Resets to 7 days each time you open this tab.</p>
            </fieldset>}
            {!step && stage.kind === "idle" && <div className="maintenance__never prune__never"><em>Never offered</em><span>Worktrees with uncommitted or untracked changes</span><span>The repository’s main checkout, and worktrees on the default branch</span><span>Worktrees whose activity could not be fully read</span></div>}
            {!step && stage.kind === "idle" && <p className="prune__intro-note">Removing a worktree deletes its folder. Its branch is kept, and so are the commits.</p>}

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
                <span className="prune__summary-mark">✓</span><div>
                <strong>
                  {summary.cancelled ? "Stopped early" : "Sweep finished"}
                </strong>
                <span>
                  {summary.counts.repos.scanned} read ·{" "}
                  {summary.counts.repos.cached} reused ·{" "}
                  {summary.counts.worktreesConsidered} worktrees considered ·{" "}
                  {candidates.length} finished · {formatBytes(proposedTotals.bytes)}
                  {summary.counts.repos.failed > 0
                    ? ` · ${summary.counts.repos.failed} unreadable`
                    : ""}
                </span>
                </div><time>{Math.max(0, Math.round((Date.parse(summary.finishedAt) - Date.parse(summary.startedAt)) / 1000))}s</time>
              </div>
            )}
            {error !== null && <div className="modal__error">{error}</div>}
            {summary !== null && stage.kind === "review" && <MaintenanceRulesApplied kind="worktrees" protectRecent={protectRecent} protectionDays={protectionDays}
              onChange={() => { if (step) onChangeRules?.(); else { setSummary(null); setStage({ kind: "idle" }); setSelected(new Set()); } }} />}

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
                  Select all {candidates.length} finished worktree{candidates.length === 1 ? "" : "s"}
                </label>
              </div>
            )}

            <div className="prune__rows" aria-label="Prunable worktrees">
              {stage.kind === "review" &&
                candidates.length === 0 &&
                error === null && (
                  <p
                    className={`prune__empty${
                      removedTotals.count > 0 ? " is-done" : ""
                    }`}
                  >
                    {protectedCount > 0
                      ? `No worktrees are proposed. ${protectedCount} finished worktree${protectedCount === 1 ? " is" : "s are"} protected. Recent worktrees can be reviewed by changing the age guard; unreadable activity stays protected.`
                      : emptyReviewCopy(removedTotals)}
                  </p>
                )}
              {candidates.length > 0 && <div className="prune__list-card"><div className="maintenance__group"><span>Finished <b>{candidates.length}</b></span>{candidates.length > 20 && <button onClick={() => setShowAll((old) => !old)}>{showAll ? "Show fewer" : "Show all"}</button>}</div>
              {(showAll ? candidates : candidates.slice(0, 20)).map((candidate) => (
                <PruneRow
                  key={candidate.worktreeId}
                  candidate={candidate}
                  checked={selected.has(candidate.worktreeId)}
                  disabled={stage.kind === "removing"}
                  onToggle={() => toggle(candidate.worktreeId)}
                />
              ))}
              {protectedCount > 0 && <><div className="maintenance__group"><span>Kept <b>{protectedCount}</b></span><button onClick={() => setShowKept((old) => !old)}>{showKept ? "Hide" : "Show"}</button></div>
                <div className="maintenance__kept-reasons">{recentCount > 0 && <span><b>{recentCount}</b> touched in the last {protectionDays} days</span>}{unreadableCount > 0 && <span><b>{unreadableCount}</b> activity could not be read</span>}</div>
                {showKept && protectedCandidates.map((candidate) => <p className="prune__kept-row" key={candidate.worktreeId}>{candidate.repoName} · {candidate.branch}</p>)}
              </>}</div>}
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

            <div className="modal__actions" ref={footerRef}>
              {stage.kind === "review" && <span className="maintenance__footer-lead">{totals.count === 0 ? "Nothing selected" : `${totals.count} selected · ${describeBytes(totals)}`}{step && " · then local branches"}</span>}
              {stage.kind === "idle" ? (
                <>
                  <button className="modal__cancel" onClick={onClose}>Close</button>
                  <button className="modal__create" onClick={() => runSweep(false)}>Find finished worktrees</button>
                </>
              ) : stage.kind === "sweeping" ? (
                <button
                  className="modal__cancel"
                  disabled={cancelling}
                  onClick={() => void cancelSweep()}
                >
                  {cancelling ? "Stopping…" : "Cancel"}
                </button>
              ) : (
                <>
                  {!step && <button className="modal__cancel" disabled={busy} onClick={onClose}>
                    Close
                  </button>}
                  <button
                    className="prune__ghost"
                    disabled={stage.kind === "removing"}
                    onClick={() => runSweep(true)}
                  >
                    Re-read all
                  </button>
                  {onContinue === undefined ? (
                    <button
                      className="modal__create"
                      disabled={totals.count === 0 || busy}
                      onClick={() => setStage({ kind: "reclaiming" })}
                    >Reclaim disk space…</button>
                  ) : (
                    <button className="modal__cancel" disabled={busy}
                      onClick={continueWithRemoved}>
                      Skip worktrees
                    </button>
                  )}
                  <button
                    className="modal__create modal__create--danger"
                    disabled={totals.count === 0 || stage.kind === "removing"}
                    onClick={() => void remove()}
                  >
                    {stage.kind === "removing"
                      ? "Removing…"
                      : onContinue !== undefined ? `Remove ${totals.count} worktree${totals.count === 1 ? "" : "s"} and continue`
                      : `Remove ${totals.count === 0 ? "" : totals.count} worktree${
                          totals.count === 1 ? "" : "s"
                        }…`}
                  </button>
                </>
              )}
            </div>
          </>
        )}
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
  const tip = useViewportTooltip();
  return (
    <label className="prune__row">
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
        <span className="prune__row-evidence"><span className={`prune__reason is-${candidate.reason.kind}`}>
          {reasonLabel(candidate.reason)}
        </span> · {candidate.lastActivityAt === undefined ? "no commits" : `commit ${relativeAge(candidate.lastActivityAt)}`}
          {candidate.activityComplete !== true ? " · activity incomplete" : candidate.lastTouchedAt === undefined ? " · activity unknown" : ` · touched ${relativeAge(candidate.lastTouchedAt)}`}</span>
        <small
          className="selectable"
          {...hoverTooltip(tip, candidate.path)}
        >
          {candidate.path}
        </small>
      </span>
      <span className="prune__row-size">{candidate.sizeBytes === null ? "size unknown" : `${candidate.sizePartial === true ? "≥ " : ""}${formatBytes(candidate.sizeBytes)}`}</span>
      {tip.tooltipNode}
    </label>
  );
}
