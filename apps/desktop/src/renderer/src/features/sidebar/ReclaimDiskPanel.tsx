import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatBytes,
  RECLAIM_DEFAULT_EXCLUDES,
  type PruneCandidate,
  type ReclaimPlan,
  type ReclaimSummary,
  type ReclaimWorktreeResult
} from "@pwrgit/shared";
import { confirmDialog } from "../shell/dialogs";
import { dispatch, subscribe } from "../../lib/pwrgit";
import {
  describeReclaimBytes,
  formatExcludeLines,
  parseExcludeLines,
  reclaimConfirmMessage,
  reclaimTotals
} from "./prune-view";

const OUTCOME_LABEL: Record<ReclaimWorktreeResult["outcome"], string> = {
  reclaimed: "reclaimed",
  nothing_to_reclaim: "already clean",
  skipped: "skipped",
  failed: "failed",
  cancelled: "cancelled"
};

/** Rows shown per worktree before the tail is summarized. */
const VISIBLE_PATHS = 8;

type Stage =
  | { kind: "previewing"; done: number }
  | { kind: "review" }
  | { kind: "running" }
  | { kind: "done"; summary: ReclaimSummary };

/**
 * The gentle half of the pruner: delete what `.gitignore` covers and keep the
 * worktree.
 *
 * It is still destructive, and the whole design of this panel is about that
 * one fact. Ignored files have no git object behind them — a `.env`, a local
 * SQLite database, scratch notes — so:
 *
 * - the preview is git's own `clean -Xdn` dry run, biggest first, never a
 *   guess assembled from `.gitignore`;
 * - the exclude list is visible, editable and applied by re-previewing, so
 *   what the user reads is what git was asked;
 * - the confirm names the byte total, the path count and what is being spared.
 *
 * There is no `-x` anywhere in this flow. That flag also deletes untracked
 * files no rule covers, which is uncommitted work.
 */
export function ReclaimDiskPanel({
  candidates,
  onBack,
  onFinished,
  onRunningChange
}: {
  /** The worktrees the review step selected. */
  candidates: PruneCandidate[];
  onBack: () => void;
  /** Reclaim finished — the caller may want to re-sweep sizes. */
  onFinished: (summary: ReclaimSummary) => void;
  /**
   * Files are being deleted right now. The host dialog owns Escape and the
   * backdrop, and neither may dismiss a `git clean` that is already running.
   */
  onRunningChange?: (running: boolean) => void;
}) {
  const worktrees = useRef(candidates).current;
  const [excludeText, setExcludeText] = useState(() =>
    formatExcludeLines(RECLAIM_DEFAULT_EXCLUDES)
  );
  const [appliedExcludes, setAppliedExcludes] = useState<string[]>(() =>
    parseExcludeLines(formatExcludeLines(RECLAIM_DEFAULT_EXCLUDES))
  );
  const [plans, setPlans] = useState<ReclaimPlan[]>([]);
  const [stage, setStage] = useState<Stage>({ kind: "previewing", done: 0 });
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<
    Map<string, ReclaimWorktreeResult | "running">
  >(new Map());
  const operationIdRef = useRef("");
  const previewRunRef = useRef(0);
  /** The id the in-flight preview run is registered under, so it can be
   *  cancelled when the run is superseded or the panel goes away. */
  const previewOperationRef = useRef("");

  /** Stop whatever preview walk main is still doing for a superseded run. */
  const cancelPreview = useCallback((): void => {
    const operationId = previewOperationRef.current;
    if (operationId === "") return;
    previewOperationRef.current = "";
    void dispatch("prune:cancelReclaim", { operationId });
  }, []);

  const runPreview = useCallback(
    async (excludes: string[]): Promise<void> => {
      cancelPreview();
      const run = ++previewRunRef.current;
      const operationId = crypto.randomUUID();
      previewOperationRef.current = operationId;
      setAppliedExcludes(excludes);
      setPlans([]);
      setError(null);
      setStage({ kind: "previewing", done: 0 });
      const collected: ReclaimPlan[] = [];
      const failures: string[] = [];
      // One worktree at a time: each preview is a Git dry run plus a bounded
      // stat walk, and main serializes per worktree anyway. Asking for all of
      // them at once would only queue in the main process while this side
      // pretended to be faster.
      for (const candidate of worktrees) {
        const result = await dispatch("prune:reclaimPreview", {
          worktreeId: candidate.worktreeId,
          excludes,
          operationId
        });
        if (previewRunRef.current !== run) return;
        if (result.ok) collected.push(result.value);
        else {
          // Every failure, not just the last: five selected worktrees can fail
          // for five different reasons, and overwriting leaves the successful
          // plans looking like the whole answer.
          failures.push(result.error.message);
          setError(
            failures.length === 1
              ? failures[0]!
              : `${failures.length} worktrees could not be previewed:\n${failures
                  .map((message) => `• ${message}`)
                  .join("\n")}`
          );
        }
        setPlans([...collected]);
        setStage({ kind: "previewing", done: collected.length });
      }
      if (previewRunRef.current !== run) return;
      previewOperationRef.current = "";
      setStage({ kind: "review" });
    },
    [cancelPreview, worktrees]
  );

  useEffect(() => {
    // StrictMode mounts, cleans up, then mounts again in development, and each
    // pass here is a Git dry run per worktree. Deferring by a microtask lets
    // the throwaway pass disappear instead of doubling the IPC (the same
    // reason BulkSyncDialog does it).
    let live = true;
    queueMicrotask(() => {
      if (!live) return;
      void runPreview(
        parseExcludeLines(formatExcludeLines(RECLAIM_DEFAULT_EXCLUDES))
      );
    });
    return () => {
      live = false;
      previewRunRef.current += 1;
      // Leaving the panel must stop the walk, not just stop reading its
      // answer: the in-flight preview holds a worktree lock until it finishes.
      cancelPreview();
    };
  }, [cancelPreview, runPreview]);

  const totals = useMemo(() => reclaimTotals(plans), [plans]);
  const pendingExcludes = parseExcludeLines(excludeText);
  const excludesDiffer =
    pendingExcludes.join("\n") !== appliedExcludes.join("\n");

  const reclaim = async (): Promise<void> => {
    const go = await confirmDialog({
      title: `Delete ignored files in ${totals.worktrees} worktree${
        totals.worktrees === 1 ? "" : "s"
      }?`,
      message: reclaimConfirmMessage(totals, appliedExcludes),
      confirmLabel: `Delete, free ${describeReclaimBytes(totals)}`,
      danger: true
    });
    if (!go) return;
    const operationId = crypto.randomUUID();
    operationIdRef.current = operationId;
    setProgress(new Map());
    setStage({ kind: "running" });
    onRunningChange?.(true);
    try {
      const result = await dispatch("prune:reclaim", {
        operationId,
        worktreeIds: plans.map((plan) => plan.worktreeId),
        excludes: appliedExcludes
      });
      if (!result.ok) {
        setError(result.error.message);
        setStage({ kind: "review" });
        return;
      }
      setStage({ kind: "done", summary: result.value });
      onFinished(result.value);
    } finally {
      onRunningChange?.(false);
    }
  };

  useEffect(() => {
    return subscribe("prune:reclaimProgress", (event) => {
      if (event.operationId !== operationIdRef.current) return;
      if (event.worktreeId === undefined) return;
      const worktreeId = event.worktreeId;
      setProgress((previous) => {
        const next = new Map(previous);
        if (event.phase === "worktree_started") next.set(worktreeId, "running");
        else if (event.result !== undefined) next.set(worktreeId, event.result);
        return next;
      });
    });
  }, []);

  const cancel = async (): Promise<void> => {
    await dispatch("prune:cancelReclaim", {
      operationId: operationIdRef.current
    });
  };

  const summary = stage.kind === "done" ? stage.summary : null;

  return (
    <>
      <div className="prune__head">
        <div>
          <h2>Reclaim disk space</h2>
          <p>
            Deletes only what <code>.gitignore</code> covers — node_modules,
            build output, caches. Tracked files, branches and commits stay, and
            each worktree stays usable after a reinstall or rebuild. Ignored
            files have no commit behind them, so this cannot be undone.
          </p>
        </div>
        <span className="prune__count" aria-live="polite">
          {stage.kind === "previewing"
            ? `${stage.done} / ${worktrees.length}`
            : describeReclaimBytes(totals)}
        </span>
      </div>

      {stage.kind === "previewing" && (
        <div className="prune__activity" role="status" aria-live="polite">
          <span className="prune__spinner" aria-hidden="true" />
          <div className="prune__activity-copy">
            <strong>Asking Git what it would delete…</strong>
            <span>
              {stage.done} of {worktrees.length} worktrees previewed
            </span>
          </div>
        </div>
      )}

      {summary !== null && (
        <div className="prune__summary" role="status">
          <strong>{summary.cancelled ? "Cancelled" : "Finished"}</strong>
          <span>
            {summary.counts.worktrees.reclaimed} reclaimed ·{" "}
            {formatBytes(summary.counts.freedBytes)} freed
            {summary.counts.worktrees.failed > 0
              ? ` · ${summary.counts.worktrees.failed} failed`
              : ""}
            {summary.counts.worktrees.nothing_to_reclaim > 0
              ? ` · ${summary.counts.worktrees.nothing_to_reclaim} already clean`
              : ""}
          </span>
        </div>
      )}
      {error !== null && <div className="modal__error">{error}</div>}

      {(stage.kind === "previewing" || stage.kind === "review") && (
        <div className="prune__excludes">
          <label htmlFor="prune-excludes">
            Spare these patterns (one per line)
          </label>
          <textarea
            id="prune-excludes"
            className="prune__excludes-field"
            spellCheck={false}
            rows={6}
            value={excludeText}
            onChange={(event) => setExcludeText(event.target.value)}
          />
          <div className="prune__excludes-foot">
            {/* Two different facts, and the dangerous one must not be hidden
                by the procedural one: what the field currently says, then
                whether git has been asked for it yet. */}
            <span>
              {pendingExcludes.length === 0
                ? "Nothing spared — local config and databases will be deleted too."
                : `${pendingExcludes.length} patterns spared.`}
              {excludesDiffer
                ? " Not applied yet — update the preview to use them."
                : ""}
            </span>
            <button
              type="button"
              className="prune__ghost"
              disabled={!excludesDiffer || stage.kind === "previewing"}
              onClick={() => void runPreview(pendingExcludes)}
            >
              Update preview
            </button>
          </div>
        </div>
      )}

      <div className="prune__rows" aria-label="What would be deleted">
        {plans.length === 0 && stage.kind !== "previewing" && (
          <p className="prune__empty">
            Git reports nothing ignored to delete in these worktrees.
          </p>
        )}
        {plans.map((plan) => {
          const state = progress.get(plan.worktreeId);
          const outcome =
            state === undefined || state === "running" ? null : state.outcome;
          return (
            <article
              className={`prune__plan${outcome === null ? "" : ` is-${outcome}`}`}
              key={plan.worktreeId}
            >
              <div className="prune__plan-head">
                <div>
                  <strong>
                    {plan.repoName} <span aria-hidden="true">·</span>{" "}
                    {plan.branch}
                  </strong>
                  <small className="selectable" title={plan.path}>
                    {plan.path}
                  </small>
                </div>
                <span className="prune__plan-size">
                  {state === "running"
                    ? "deleting…"
                    : outcome === null
                      ? `${plan.sizesPartial === true ? "≥ " : ""}${formatBytes(
                          plan.totalBytes
                        )} · ${plan.pathCount} paths`
                      : OUTCOME_LABEL[outcome]}
                </span>
              </div>
              {plan.entries.length > 0 && (
                <ul className="prune__paths">
                  {plan.entries.slice(0, VISIBLE_PATHS).map((entry) => (
                    <li key={entry.path}>
                      <span className="selectable">{entry.path}</span>
                      <em>
                        {entry.sizePartial === true ? "≥ " : ""}
                        {formatBytes(entry.sizeBytes)}
                      </em>
                    </li>
                  ))}
                  {plan.pathCount > VISIBLE_PATHS && (
                    <li className="prune__paths-more">
                      …and {plan.pathCount - VISIBLE_PATHS} more
                      {plan.truncated ? " (list truncated)" : ""}
                    </li>
                  )}
                </ul>
              )}
              {state !== undefined &&
                state !== "running" &&
                state.message !== undefined && (
                  <p className="prune__plan-message">{state.message}</p>
                )}
            </article>
          );
        })}
      </div>

      <div className="modal__actions">
        {stage.kind === "running" ? (
          <button className="modal__cancel" onClick={() => void cancel()} autoFocus>
            Cancel
          </button>
        ) : stage.kind === "done" ? (
          <button className="modal__create" onClick={onBack} autoFocus>
            Back to candidates
          </button>
        ) : (
          <>
            <button className="modal__cancel" onClick={onBack}>
              Back
            </button>
            {/* Deleting is refused while the spare list has unapplied edits.
                `reclaim()` sends `appliedExcludes`, so a pattern the user just
                typed to protect something would be silently dropped and the
                file it names deleted — the field would promise one thing and
                git be asked another. "Update preview" is the only way to move
                the two together. */}
            <button
              className="modal__create modal__create--danger"
              disabled={
                stage.kind === "previewing" ||
                totals.paths === 0 ||
                excludesDiffer
              }
              title={
                excludesDiffer
                  ? "Update the preview first — the spare list has unapplied edits."
                  : undefined
              }
              onClick={() => void reclaim()}
            >
              Delete ignored files…
            </button>
          </>
        )}
      </div>
    </>
  );
}
