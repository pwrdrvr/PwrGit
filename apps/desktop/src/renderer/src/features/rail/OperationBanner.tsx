import { useState } from "react";
import type { GitOperation, OperationState } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast, showInfoToast } from "../../lib/toast";
import { confirmDialog } from "../shell/dialogs";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";

/**
 * Tells the user what Git is in the middle of, and offers the two ways out
 * Git itself defines. Resolution happens in their editor or agent, so this
 * never hides the Changes, Commit, or Rebase tabs behind itself — being stuck
 * mid-merge is exactly when the file list matters most.
 */

function noun(operation: GitOperation): string {
  return operation.kind === "cherry-pick" ? "cherry-pick" : operation.kind;
}

function conflictsLabel(count: number): string {
  return `${count} conflicted path${count === 1 ? "" : "s"}`;
}

export function OperationBanner({
  worktreeId,
  state,
  onRefresh
}: {
  worktreeId: string;
  state: OperationState;
  onRefresh: () => void;
}) {
  const tip = useViewportTooltip();
  const [busy, setBusy] = useState<"continue" | "abort" | null>(null);
  const { operation, conflictCount } = state;
  if (operation === null && conflictCount === 0) return null;

  const blocked = conflictCount > 0;

  const runContinue = async (): Promise<void> => {
    if (operation === null) return;
    const verb = noun(operation);
    const yes = await confirmDialog({
      title: `Continue ${verb}?`,
      message: `PwrGit will run git ${verb} --continue. Git hooks may run, and Git may stop again on the next conflict.`,
      confirmLabel: `Continue ${verb}`
    });
    if (!yes) return;
    setBusy("continue");
    const result = await dispatch("operation:continue", {
      worktreeId,
      operation: operation.kind
    });
    setBusy(null);
    onRefresh();
    if (!result.ok) {
      showErrorToast({
        title: `Could not continue ${verb}`,
        message: result.error.message,
        subject: { worktreeId }
      });
      return;
    }
    // A sequencer that applies a step and stops on the next conflict has made
    // progress, even though Git exits non-zero. Say so, rather than crying
    // failure at the most common point of a multi-commit rebase.
    showInfoToast({
      ...(result.value.kind === "completed"
        ? {
            title: `${operation.label} completed`,
            message: `Git finished the ${verb}.`
          }
        : {
            title: `${operation.label} advanced`,
            message: result.value.detail
          }),
      subject: { worktreeId }
    });
  };

  const runAbort = async (): Promise<void> => {
    if (operation === null) return;
    const verb = noun(operation);
    const yes = await confirmDialog({
      title: `Abort ${verb}?`,
      message: `PwrGit will run git ${verb} --abort. Git restores the state from before the ${verb}, and refuses if it cannot do so safely.`,
      confirmLabel: `Abort ${verb}`,
      danger: true
    });
    if (!yes) return;
    setBusy("abort");
    const result = await dispatch("operation:abort", {
      worktreeId,
      operation: operation.kind
    });
    setBusy(null);
    onRefresh();
    if (!result.ok) {
      showErrorToast({
        title: `Could not abort ${verb}`,
        message: result.error.message,
        subject: { worktreeId }
      });
      return;
    }
    showInfoToast({
      title: `${operation.label} aborted`,
      message: `Git restored the state from before the ${verb}.`,
      subject: { worktreeId }
    });
  };

  return (
    <section
      className="op-banner"
      data-testid="operation-banner"
      aria-label={
        operation === null
          ? "Unmerged index"
          : `${operation.label} in progress`
      }
    >
      <div className="op-banner__head">
        <span className="op-banner__eyebrow">
          {operation === null ? "Unmerged index" : operation.label}
          {operation?.progress !== undefined &&
            ` · step ${operation.progress.current} of ${operation.progress.total}`}
        </span>
        <span
          className={`op-banner__count${blocked ? " is-blocked" : " is-clear"}`}
        >
          {blocked ? conflictsLabel(conflictCount) : "No conflicts"}
        </span>
      </div>

      <p className="op-banner__hint">
        {operation === null
          ? "Git has unmerged index entries but no operation in progress — this can follow a conflicted stash apply or a squashed merge. Resolve each path, then stage it."
          : blocked
            ? "Resolve the conflicted files in your editor or agent, then stage each one from the Changes tab."
            : `Everything is staged. Continue to let Git finish the ${noun(operation)}.`}
      </p>

      {operation !== null && (
        <div className="op-banner__actions">
          <button
            className="op-banner__abort"
            onClick={() => void runAbort()}
            disabled={busy !== null}
          >
            {busy === "abort" ? "Aborting…" : `Abort ${noun(operation)}…`}
          </button>
          <button
            className="op-banner__continue"
            onClick={() => void runContinue()}
            disabled={busy !== null || blocked}
            /* The block is the NAME as well as the card: a disabled button
               still announces its name, and AT reads that over a card. */
            aria-label={
              blocked
                ? `Continue ${noun(operation)}… — unavailable, stage all ${conflictsLabel(conflictCount)} first`
                : undefined
            }
            {...hoverTooltip(
              tip,
              blocked
                ? `Stage all ${conflictsLabel(conflictCount)} before continuing.`
                : undefined
            )}
          >
            {busy === "continue"
              ? "Continuing…"
              : `Continue ${noun(operation)}…`}
          </button>
        </div>
      )}
      {tip.tooltipNode}
    </section>
  );
}
