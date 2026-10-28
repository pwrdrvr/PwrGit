import { useEffect, useState, type ReactElement } from "react";
import type { BulkSyncMode } from "@pwrgit/shared";
import { CloseGlyph } from "../../lib/CloseGlyph";
import { ExpandGlyph } from "../../lib/ExpandGlyph";
import { prefersReducedMotion } from "../../lib/reducedMotion";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";
import { formatElapsed } from "../remote/remote-activity";
import { useSecondsClock } from "../../state/useRemoteActivity";
import { StatusMark, type BulkSyncStatusPhase } from "./BulkSyncStatus";
import {
  BULK_SYNC_OUTCOMES,
  finishedCount,
  type BulkSyncOutcomeCounts
} from "./bulk-sync-progress";

/**
 * A bulk-sync run, minimised: the dialog's status card cut down to one line
 * and the same outcome bar, in the corner under the sidebar that started it.
 *
 * The whole card is a button back to the dialog; Cancel (while running) and
 * Dismiss (once finished) are separate buttons beside it, not inside it, so
 * neither is a button nested in a button. Design:
 * `design/Fetch Toast and Scope - UX Review.dc.html`, 2c–2e.
 */
export function BulkSyncToast({
  title,
  mode,
  surfaceRef,
  phase,
  hasFailures,
  activity,
  counts,
  inFlight,
  queued,
  startedAt,
  durationMs,
  error,
  cancelling,
  onExpand,
  onCancel,
  onDismiss,
  onHold,
  countdown = null
}: {
  title: string;
  mode: BulkSyncMode;
  surfaceRef: (el: HTMLElement | null) => void;
  phase: BulkSyncStatusPhase;
  hasFailures: boolean;
  /** The live line: "Fetching atlas-api, ledger-web". */
  activity: string;
  counts: BulkSyncOutcomeCounts;
  inFlight: number;
  queued: number;
  startedAt: number;
  durationMs: number | null;
  error: string | null;
  cancelling: boolean;
  onExpand: () => void;
  onCancel: () => void;
  onDismiss: () => void;
  /** The pointer is over the toast, so a timed dismiss should wait. */
  onHold: (held: boolean) => void;
  /** A timed dismiss is running: the rail drains with it. Null for a toast
   *  that stays (live, failed, cancelled). */
  countdown?: ToastCountdown | null;
}): ReactElement {
  const tip = useViewportTooltip();
  // Leaving by Show details unmounts the toast under the pointer, with no
  // pointerleave; without this the hold outlived it and a later clean finish
  // never left by itself.
  useEffect(() => () => onHold(false), [onHold]);
  const live = phase === "running" || phase === "cancelling";
  const finished = finishedCount(counts);
  const total = finished + inFlight + queued;
  const headline = error !== null
    ? `${title} stopped`
    : live
      ? activity
      : phase === "cancelled"
        ? `${title} — cancelled`
        : finishedHeadline(mode, total, counts.success + counts.partial);
  const tone = error !== null || (!live && hasFailures)
    ? " is-failed"
    : live
      ? " is-live"
      : "";

  return (
    <section
      ref={surfaceRef}
      className={`bulk-sync-toast${tone}`}
      aria-label={title}
      onPointerEnter={() => onHold(true)}
      onPointerLeave={() => onHold(false)}
    >
      <div className="bulk-sync-toast__top">
        {live ? (
          <span className="bulk-sync__spinner" aria-hidden="true" />
        ) : (
          <StatusMark
            mark={
              phase === "cancelled"
                ? "cancelled"
                : hasFailures || error !== null
                  ? "failed"
                  : "ok"
            }
          />
        )}
        <button
          type="button"
          className="bulk-sync-toast__body"
          onClick={onExpand}
        >
          <span
            className="bulk-sync-toast__headline"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {headline}
          </span>
          <span className="bulk-sync-toast__meta">
            {error !== null ? (
              error
            ) : live ? (
              <LiveMeta
                startedAt={startedAt}
                finished={finished}
                total={total}
                failed={counts.failed}
              />
            ) : phase === "cancelled" ? (
              durationMs !== null && `took ${formatElapsed(durationMs)}`
            ) : (
              <FinishedMeta counts={counts} durationMs={durationMs} />
            )}
          </span>
        </button>
        <button
          type="button"
          className="bulk-sync-toast__icon"
          aria-label="Show details"
          {...hoverTooltip(tip, "Show details")}
          onClick={onExpand}
        >
          <ExpandGlyph size={12} />
        </button>
        {live ? (
          <button
            type="button"
            className="bulk-sync-toast__icon"
            aria-label={cancelling ? "Cancelling…" : "Cancel"}
            {...hoverTooltip(tip, cancelling ? "Cancelling…" : "Cancel")}
            aria-disabled={cancelling}
            onClick={() => {
              if (!cancelling) onCancel();
            }}
          >
            <CloseGlyph size={12} />
          </button>
        ) : (
          <button
            type="button"
            className="bulk-sync-toast__icon"
            aria-label="Dismiss"
            {...hoverTooltip(tip, "Dismiss")}
            onClick={onDismiss}
          >
            <CloseGlyph size={12} />
          </button>
        )}
      </div>
      {total > 0 && (live || hasFailures) && (
        <div className="bulk-sync__bar bulk-sync-toast__bar" aria-hidden="true">
          {BULK_SYNC_OUTCOMES.map((outcome) => (
            <i
              key={outcome}
              className={
                counts[outcome] === 0 ? `is-${outcome} is-empty` : `is-${outcome}`
              }
              style={{ flexGrow: counts[outcome] }}
            />
          ))}
          <i
            className={inFlight === 0 ? "is-in-flight is-empty" : "is-in-flight"}
            style={{ flexGrow: inFlight }}
          />
          <i className="is-queued" style={{ flexGrow: queued }} />
        </div>
      )}
      {countdown !== null && <CountdownRail countdown={countdown} />}
      {tip.tooltipNode}
    </section>
  );
}

/**
 * The finished line names the run and its size only. What went how is the
 * meta line's job, in the bar's colors, so the part that matters is never
 * the part an ellipsis cuts off.
 */
export function finishedHeadline(
  mode: BulkSyncMode,
  total: number,
  succeeded: number = total
): string {
  const repos = `${total} ${total === 1 ? "repository" : "repositories"}`;
  // A run where nothing went through must not read as a success.
  if (succeeded === 0 && total > 0) {
    return mode === "fetch"
      ? `Fetched none of ${repos}`
      : `Pulled none of ${repos}`;
  }
  return mode === "fetch"
    ? `Fetched ${repos}`
    : `Pulled safely across ${repos}`;
}

/**
 * Each outcome in the bar, in the dialog legend's words and swatches, so a
 * yellow segment says "partial" without opening anything.
 */
function FinishedMeta({
  counts,
  durationMs
}: {
  counts: BulkSyncOutcomeCounts;
  durationMs: number | null;
}): ReactElement {
  return (
    <span className="bulk-sync-toast__counts">
      {BULK_SYNC_OUTCOMES.filter((outcome) => counts[outcome] > 0).map(
        (outcome) => (
          <span key={outcome} className={`bulk-sync-toast__count is-${outcome}`}>
            <strong>{counts[outcome]}</strong> {outcome}
          </span>
        )
      )}
      {durationMs !== null && <span>{formatElapsed(durationMs)}</span>}
    </span>
  );
}

export type ToastCountdown = {
  durationMs: number;
  /** Held under the pointer: the rail stops where it is. */
  paused: boolean;
  /** What is left of the timer now. */
  leftMs: () => number;
};

/**
 * The app toast's countdown, as the remote-activity card draws it: green,
 * because a draining bar here also means "this went well". The timer banks
 * what is left while held and the CSS pauses with it, so the two resume
 * together. Under reduced motion the blanket `animation: none` would leave a
 * full rail on a card that then vanished, so it steps once a second instead.
 */
function CountdownRail({ countdown }: { countdown: ToastCountdown }): ReactElement {
  const [reduced] = useState(prefersReducedMotion);
  useSecondsClock(reduced);
  return (
    <span
      className="bulk-sync-toast__rail"
      aria-hidden="true"
      data-paused={countdown.paused ? "true" : undefined}
      style={
        reduced
          ? {
              transform: `scaleX(${(
                countdown.leftMs() / countdown.durationMs
              ).toFixed(3)})`
            }
          : { animationDuration: `${countdown.durationMs}ms` }
      }
    />
  );
}

/** The only part of the toast that changes every second. */
function LiveMeta({
  startedAt,
  finished,
  total,
  failed
}: {
  startedAt: number;
  finished: number;
  total: number;
  failed: number;
}): ReactElement {
  const now = useSecondsClock(true);
  return (
    <>
      {finished} of {total}
      {failed > 0 && ` · ${failed} failed`} ·{" "}
      {formatElapsed(Math.max(0, now - startedAt))}
    </>
  );
}
