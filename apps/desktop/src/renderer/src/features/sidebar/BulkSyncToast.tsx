import type { ReactElement } from "react";
import type { BulkSyncMode } from "@pwrgit/shared";
import { CloseGlyph } from "../../lib/CloseGlyph";
import { ExpandGlyph } from "../../lib/ExpandGlyph";
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
  onHold
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
}): ReactElement {
  const tip = useViewportTooltip();
  const live = phase === "running" || phase === "cancelling";
  const finished = finishedCount(counts);
  const total = finished + inFlight + queued;
  const headline = error !== null
    ? `${title} stopped`
    : live
      ? activity
      : phase === "cancelled"
        ? `${title} — cancelled`
        : finishedHeadline(mode, total, counts.failed, hasFailures);
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
            ) : (
              <>
                {durationMs !== null && `took ${formatElapsed(durationMs)}`}
                {hasFailures && " · click for details"}
              </>
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
      {tip.tooltipNode}
    </section>
  );
}

export function finishedHeadline(
  mode: BulkSyncMode,
  total: number,
  failed: number,
  hasFailures: boolean
): string {
  const verb = mode === "fetch"
    ? `Fetched ${total} ${total === 1 ? "repository" : "repositories"}`
    : `Pulled safely across ${total} ${total === 1 ? "repository" : "repositories"}`;
  if (failed > 0) return `${verb} · ${failed} failed`;
  return hasFailures ? `${verb} · with failures` : verb;
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
