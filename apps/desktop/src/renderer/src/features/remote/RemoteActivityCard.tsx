import { useEffect, useRef, useState } from "react";
import { dispatch } from "../../lib/pwrgit";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";
import {
  remoteActivityReport,
  type RemoteActivityView
} from "./remote-activity";

/**
 * What one remote operation is doing — or, once it is over, what it did.
 *
 * Shown in the toolbar's status popover and in the toast that keeps an
 * operation reachable after you navigate away from its repository. Both need
 * the same four things — scope, health, Git's own words, and a way out — so
 * they share this card rather than growing two dialects of it.
 *
 * It takes a `RemoteActivityView` rather than a `RemoteActivity` because the
 * card now outlives the record: the popover keeps it up as the receipt for a
 * finished operation, and by then `finish()` has deleted the record it used to
 * read. `liveActivityView` / `settledActivityView` are where the two sources
 * meet, and they are pure.
 */
export function RemoteActivityCard({
  view,
  compact = false,
  onClose
}: {
  view: RemoteActivityView;
  /** Toast placement: tighter, and without the repeated Git output block. */
  compact?: boolean;
  /**
   * Dismiss this card. Given only where dismissal is the user's to make — the
   * pinned popover — which is also what draws the ✕ and the Close button. The
   * toast has no dismissal of its own: it stands for exactly as long as the
   * operation it reports.
   */
  onClose?: () => void;
}) {
  const tip = useViewportTooltip();
  // Destructured so the two null checks below narrow inside the handlers —
  // TypeScript cannot carry a narrowing on `view.x` into a closure.
  const { canceling, operationId } = view;
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (copiedTimer.current !== undefined) {
        window.clearTimeout(copiedTimer.current);
      }
    },
    []
  );

  const copyReport = async (): Promise<void> => {
    // A finished operation has no log left to ask for — the registry drops it
    // in `finish()` — so the tail the view snapshotted IS the record, and the
    // fetch below is skipped rather than asked and answered `null`.
    const lines =
      operationId === null ? view.output : await fullLog(operationId);
    await navigator.clipboard.writeText(remoteActivityReport(view, lines));
    setCopied(true);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div
      className={`remote-activity${compact ? " remote-activity--compact" : ""}`}
    >
      <div className="remote-activity__header">
        <span className="remote-activity__title">{view.title}</span>
        <span className="remote-activity__header-end">
          <span className="remote-activity__elapsed">{view.elapsed}</span>
          {onClose !== undefined && (
            // Always present on a dismissible card, in every state. A card
            // that can take itself away must never be one the user has to
            // race — and under `prefers-reduced-motion` the countdown rail
            // that says it is going is four discrete steps rather than a
            // sweep, so this is the only unambiguous way out.
            <button
              className="remote-activity__close"
              type="button"
              aria-label="Dismiss status"
              {...hoverTooltip(tip, "Dismiss")}
              onClick={onClose}
            >
              ✕
            </button>
          )}
        </span>
      </div>

      <p
        className={`remote-activity__status remote-activity__status--${view.statusTone}`}
      >
        {view.statusLabel}
      </p>

      {view.meter !== null && view.percent !== null && (
        <div className="remote-activity__meter">
          <div
            className="remote-activity__bar"
            role="progressbar"
            aria-label={view.meter}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={view.percent}
          >
            <span style={{ width: `${view.percent}%` }} />
          </div>
          <span className="remote-activity__meter-label">{view.meter}</span>
        </div>
      )}

      {view.command !== null && (
        <p className="remote-activity__command">{view.command}</p>
      )}

      {!compact && showOutput(view) && (
        // Git's own words, verbatim. Everything above is PwrGit's reading of
        // the operation; this is the evidence behind it, and the only thing
        // that explains an unfamiliar failure. It outlives the command that
        // wrote it now, which is the whole point of a settled card.
        <pre className="remote-activity__output" aria-label="Recent Git output">
          {view.output.length > 0
            ? view.output.join("\n")
            : view.settled === null
              ? "Git has produced no output yet."
              : "Git produced no output."}
        </pre>
      )}

      <div className="remote-activity__actions">
        {/* aria-disabled, never `disabled` (styles/AGENTS.md): Chromium blurs
            an element the moment it becomes disabled, and this card is an
            interactive tooltip whose blur handler schedules its own dismissal
            — so `disabled` would take the status off screen at the instant
            the user asked to stop, and drop keyboard focus to <body>
            (SC 2.4.3). The handler guards instead. */}
        {canceling !== null && operationId !== null && (
          <button
            className="remote-activity__button remote-activity__button--stop"
            type="button"
            onClick={() => {
              if (canceling) return;
              void dispatch("remote:cancelActivity", { operationId });
            }}
            aria-disabled={canceling}
            // Where Tab from the trigger lands, ahead of the ✕ that precedes
            // it in the header. Someone tabbing into a card about a fetch that
            // has said nothing for five minutes came for the way to stop it,
            // not the way to stop looking at it. A settled card marks nothing,
            // so the ✕ is first there — which is right, because by then
            // dismissing is the only thing left to do.
            data-focus-first=""
          >
            {canceling ? "Stopping…" : "Cancel"}
          </button>
        )}
        <button
          className="remote-activity__button"
          type="button"
          {...hoverTooltip(tip, "Open the Logs window")}
          onClick={() => void dispatch("logs:openWindow", undefined)}
        >
          Logs
        </button>
        <button
          className="remote-activity__button"
          type="button"
          {...hoverTooltip(tip, "Copy this status and the full Git output")}
          onClick={() => void copyReport()}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        {/* A failure is read, not glanced at, and the gesture that ends it
            should be as deliberate as the reading. The ✕ above is the quiet
            exit; this is the one a user looking for "I'm done with this"
            finds without hunting in the corner. */}
        {onClose !== undefined && view.settled === "error" && (
          <button
            className="remote-activity__button"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
        )}
      </div>
      {tip.tooltipNode}
    </div>
  );
}

/**
 * Whether the Git-output block earns its place.
 *
 * Silence is evidence while an operation runs — a fetch that has written
 * nothing is the wedged case the card exists for — and it is still evidence
 * once one has failed or been stopped, where "Git produced no output" IS the
 * finding. On a *successful* operation it is neither: an empty block under
 * "Fetched" reports nothing and takes up the room that says so.
 */
function showOutput(view: RemoteActivityView): boolean {
  return view.output.length > 0 || view.settled !== "ok";
}

/** Everything Git wrote, or the empty log of an operation already gone. */
async function fullLog(operationId: string): Promise<string[]> {
  const result = await dispatch("remote:activityLog", { operationId });
  return result.ok && result.value !== null ? result.value.lines : [];
}
