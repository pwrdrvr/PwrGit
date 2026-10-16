import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  formatBytes,
  STALE_AGE_DAYS,
  type PruneCandidate,
  type PruneScanSummary
} from "@pwrgit/shared";
import { confirmDialog } from "../shell/dialogs";
import { revealLabel, revealPath } from "../shell/reveal";
import { dispatch, subscribe } from "../../lib/pwrgit";
import type { RemoveWorktreesOutcome } from "../../state/useRepoTree";
import { currentPlatform } from "../../lib/platform";
import { relativeAge } from "../../lib/relativeAge";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import { ReclaimDiskPanel } from "./ReclaimDiskPanel";
import { MaintenanceRulesApplied } from "./MaintenancePlan";
import { StatusMark } from "./BulkSyncStatus";
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
   * the sidebar rows live, and owns the dirty/force retry. It reports what
   * became of each id, and this panel shows that inline.
   */
  onRemove: (
    worktreeIds: string[],
    options?: { force?: boolean }
  ) => Promise<RemoveWorktreesOutcome>;
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
  /** What the last removal could not do, shown in place of the list's end. */
  const [failures, setFailures] = useState<RemovalFailure[]>([]);
  /** How many the last run removed, for the outcome card's second line. */
  const [removedThisRun, setRemovedThisRun] = useState(0);
  const [keptDirty, setKeptDirty] = useState<PruneCandidate[]>([]);
  /** The delete in flight: which worktree, and how far its folder has gone. */
  const [removing, setRemoving] = useState<{
    ids: string[];
    current: string | null;
    itemsDeleted: number;
  } | null>(null);

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
      setFailures([]);
      setKeptDirty([]);
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

  useEffect(() => {
    return subscribe("worktree:removeProgress", ({ worktreeId, itemsDeleted }) => {
      setRemoving((previous) =>
        previous === null || !previous.ids.includes(worktreeId)
          ? previous
          : { ...previous, current: worktreeId, itemsDeleted }
      );
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
    // A failed sweep still ends in review, so the rail must leave "scanning".
    if (stage.kind === "review") onCandidateCount?.(candidates.length);
  }, [stage.kind, candidates.length, onCandidateCount]);
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

  /**
   * Run a removal and keep what it reports. `force` is only for Retry: those
   * worktrees were already confirmed, and what is left of them is PwrGit's
   * own half-finished delete, which Git reads as uncommitted changes.
   */
  const runRemoval = async (ids: string[], force: boolean): Promise<void> => {
    setStage({ kind: "removing" });
    setError(null);
    setFailures([]);
    setKeptDirty([]);
    setRemoving({ ids, current: ids[0] ?? null, itemsDeleted: 0 });
    try {
      const result = await (force ? onRemove(ids, { force: true }) : onRemove(ids));
      for (const id of result.removed) removedRef.current.add(id);
      setRemoved((previous) => new Set([...previous, ...result.removed]));
      setSelected(new Set());
      const byId = new Map(swept.map((candidate) => [candidate.worktreeId, candidate]));
      setFailures(result.failed.flatMap((failure) => {
        const candidate = byId.get(failure.id);
        return candidate === undefined ? [] : [{ ...failure, candidate }];
      }));
      setRemovedThisRun(result.removed.length);
      setKeptDirty(result.keptDirty.flatMap((id) => byId.get(id) ?? []));
      if (onContinue !== undefined && ids.every((id) => removedRef.current.has(id))) {
        continueWithRemoved();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoving(null);
      setStage({ kind: "review" });
    }
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
    await runRemoval(picked.map((candidate) => candidate.worktreeId), false);
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
                <StatusMark mark={summary.cancelled ? "cancelled" : "ok"} /><div>
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
                </div><time>took {Math.max(0, Math.round((Date.parse(summary.finishedAt) - Date.parse(summary.startedAt)) / 1000))}s</time>
              </div>
            )}
            {stage.kind === "removing" && removing !== null && (
              <RemovalActivity removing={removing} candidates={swept} />
            )}
            {error !== null && <div className="modal__error" role="alert">{error}</div>}
            {stage.kind === "review" && failures.length > 0 && (
              <RemovalFailures
                failures={failures}
                removedCount={removedThisRun}
                canContinue={onContinue !== undefined}
                onRetry={(ids) => void runRemoval(ids, true)}
              />
            )}
            {stage.kind === "review" && keptDirty.length > 0 && (
              <KeptForChanges kept={keptDirty} />
            )}
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
                <div className="maintenance__kept-reasons">{recentCount > 0 && <span><b>{recentCount}</b> touched in the last {protectionDays} {protectionDays === 1 ? "day" : "days"}</span>}{unreadableCount > 0 && <span><b>{unreadableCount}</b> activity could not be read</span>}</div>
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
                      : onContinue !== undefined ? totals.count === 0 ? "Remove worktrees and continue" : `Remove ${totals.count} worktree${totals.count === 1 ? "" : "s"} and continue`
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

const label = (candidate: PruneCandidate): string =>
  `${candidate.repoName} · ${candidate.branch}`;

type RemovalFailure = RemoveWorktreesOutcome["failed"][number] & {
  candidate: PruneCandidate;
};

/** Lucide icons, exact paths, drawn with currentColor. */
function Icon({ name }: { name: "alert" | "info" | "log" | "folder" | "retry" | "chev" | "chevd" }) {
  const paths: Record<typeof name, ReactNode> = {
    alert: <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
    info: <><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></>,
    log: <><path d="M15 12h-5" /><path d="M15 8h-5" /><path d="M19 17V5a2 2 0 0 0-2-2H4" /><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" /></>,
    folder: <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />,
    retry: <><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></>,
    chev: <path d="m9 18 6-6-6-6" />,
    chevd: <path d="m6 9 6 6 6-6" />
  };
  return (
    <svg className="maintenance__problem-icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function RemovalActivity({
  removing,
  candidates
}: {
  removing: { ids: string[]; current: string | null; itemsDeleted: number };
  candidates: PruneCandidate[];
}) {
  const current = candidates.find((c) => c.worktreeId === removing.current);
  const index = removing.current === null ? 0 : removing.ids.indexOf(removing.current);
  return (
    <div className="prune__activity" role="status" aria-live="polite" aria-atomic="true">
      <span className="prune__spinner" aria-hidden="true" />
      <div className="prune__activity-copy">
        <strong>
          {current === undefined
            ? `Removing ${removing.ids.length} worktree${removing.ids.length === 1 ? "" : "s"}`
            : `Removing ${label(current)}`}
        </strong>
        <span>
          {removing.itemsDeleted.toLocaleString()} files deleted
          {removing.ids.length > 1
            ? ` · worktree ${Math.max(0, index) + 1} of ${removing.ids.length}`
            : ""}
        </span>
      </div>
    </div>
  );
}

/** The sentence, with the lead phrase main chose set in bold. */
function Reason({ message, lead }: { message: string; lead: string | undefined }) {
  if (lead === undefined || !message.startsWith(lead)) return <p>{message}</p>;
  return (
    <p>
      <b>{lead}</b>
      {message.slice(lead.length)}
    </p>
  );
}

function ProblemRow({
  failure,
  onRetry
}: {
  failure: RemovalFailure;
  onRetry: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const tip = useViewportTooltip();
  const { candidate } = failure;
  return (
    <li className="maintenance__problem-row">
      <strong>
        <span>{candidate.repoName}</span> · {candidate.branch}
      </strong>
      <Reason message={failure.message} lead={failure.lead} />
      <small className="selectable" {...hoverTooltip(tip, candidate.path)}>
        {candidate.path}
      </small>
      <div className="maintenance__problem-actions">
        <button type="button" onClick={() => revealPath(candidate.path)}>
          <Icon name="folder" />
          {revealLabel(currentPlatform())}
        </button>
        {onRetry !== null && (
          <button type="button" onClick={onRetry}>
            <Icon name="retry" />
            Retry
          </button>
        )}
        {failure.detail !== undefined && (
          <button
            type="button"
            className="maintenance__problem-toggle"
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
          >
            <Icon name={open ? "chevd" : "chev"} />
            Details
          </button>
        )}
      </div>
      {open && failure.detail !== undefined && (
        <pre className="maintenance__problem-raw selectable">{failure.detail}</pre>
      )}
      {tip.tooltipNode}
    </li>
  );
}

/**
 * What a removal could not do, worktree by worktree — the shared outcome card
 * from the "Removal Errors" design board (3a). It replaces a one-line "Some
 * worktrees were not removed" that named neither the worktree nor the reason,
 * and a notice dialog stacked on top of this one. The headline counts, the
 * second line says what is left and whether you can go on, and Node's or
 * Git's own words sit behind Details and in the log.
 */
function RemovalFailures({
  failures,
  removedCount,
  canContinue,
  onRetry
}: {
  failures: RemovalFailure[];
  removedCount: number;
  canContinue: boolean;
  onRetry: (ids: string[]) => void;
}) {
  const count = failures.length;
  const one = count === 1;
  // Retrying a folder Git has disowned, or a lock, would only fail again.
  const retryable = (failure: RemovalFailure): boolean =>
    failure.code !== "not_a_worktree" && failure.code !== "locked";
  const sub = removedCount > 0
    ? `${one ? "Its folder is" : "Their folders are"} still on disk. The other ${removedCount} ${removedCount === 1 ? "was" : "were"} removed${canContinue ? ", and you can continue" : ""}.`
    : `Nothing was removed. You can retry${canContinue ? `, or continue without ${one ? "it" : "them"}` : ""}.`;
  return (
    <section className="maintenance__problem" role="alert">
      <div className="maintenance__problem-head">
        <span className="maintenance__problem-mark"><Icon name="alert" /></span>
        <div>
          <strong>{one ? "1 worktree wasn’t removed" : `${count} worktrees weren’t removed`}</strong>
          <span>{sub}</span>
        </div>
        <button
          type="button"
          className="maintenance__problem-log"
          onClick={() => void dispatch("logs:openWindow", undefined)}
        >
          <Icon name="log" />
          View log
        </button>
      </div>
      <ul>
        {failures.map((failure) => (
          <ProblemRow
            key={failure.candidate.worktreeId}
            failure={failure}
            onRetry={retryable(failure) ? () => onRetry([failure.candidate.worktreeId]) : null}
          />
        ))}
      </ul>
    </section>
  );
}

/** Declining "Remove anyway" is a choice, so this is a note, not an error. */
function KeptForChanges({ kept }: { kept: PruneCandidate[] }) {
  const one = kept.length === 1;
  return (
    <section className="maintenance__problem is-note" role="status">
      <div className="maintenance__problem-head">
        <span className="maintenance__problem-mark"><Icon name="info" /></span>
        <div>
          <strong>
            {one ? "1 worktree kept: it has uncommitted changes" : `${kept.length} worktrees kept: they have uncommitted changes`}
          </strong>
          <span>
            You chose to keep {one ? "it" : "them"} when asked. Nothing in {one ? "it was" : "them was"} deleted, and {one ? "it’s" : "they’re"} still in the sidebar.
          </span>
        </div>
      </div>
      <ul>
        {kept.map((candidate) => (
          <li className="maintenance__problem-row" key={candidate.worktreeId}>
            <strong><span>{candidate.repoName}</span> · {candidate.branch}</strong>
            <small className="selectable">{candidate.path}</small>
            <div className="maintenance__problem-actions">
              <button type="button" onClick={() => revealPath(candidate.path)}>
                <Icon name="folder" />
                {revealLabel(currentPlatform())}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
