import type { ReactElement } from "react";
import { formatElapsed } from "../remote/remote-activity";
import { useSecondsClock } from "../../state/useRemoteActivity";
import {
  BULK_SYNC_OUTCOMES,
  estimateRemainingMs,
  finishedCount,
  formatRemaining,
  progressValueText,
  repositoryNoun,
  type BulkSyncOutcomeCounts
} from "./bulk-sync-progress";

export type BulkSyncStatusPhase =
  | "running"
  | "cancelling"
  | "finished"
  | "cancelled";

type StatusMarkKind = "ok" | "failed" | "cancelled";

/**
 * The run status card: one element from the first repository to the receipt.
 *
 * It stays mounted when the run ends and only trades its live parts — the
 * spinner for a mark, the clock for the duration, the in-flight stripes for
 * nothing — so the finished bar is the same picture the user watched fill.
 * Design: `design/Bulk Sync Progress - UX Review.dc.html`, option 2b.
 */
export function BulkSyncStatus({
  phase,
  hasFailures,
  title,
  detail,
  counts,
  inFlight,
  queued,
  startedAt,
  durationMs
}: {
  phase: BulkSyncStatusPhase;
  /** Whether the ended run failed anywhere; picks the mark that replaces the spinner. */
  hasFailures: boolean;
  title: string;
  /** The lone in-flight repository's path, or the finished summary. */
  detail: { kind: "path" | "summary"; text: string } | null;
  counts: BulkSyncOutcomeCounts;
  inFlight: number;
  queued: number;
  /** `Date.now()` when the run was launched; drives the live clock. */
  startedAt: number;
  /** Main's own measure of the finished run; read only once it has ended. */
  durationMs: number | null;
}): ReactElement {
  const live = phase === "running" || phase === "cancelling";
  const finished = finishedCount(counts);
  const total = finished + inFlight + queued;

  return (
    <div className={`bulk-sync__status${live ? " is-live" : ""}`}>
      <div className="bulk-sync__status-top">
        {live ? (
          <span className="bulk-sync__spinner" aria-hidden="true" />
        ) : (
          <StatusMark
            mark={
              phase === "cancelled"
                ? "cancelled"
                : hasFailures
                  ? "failed"
                  : "ok"
            }
          />
        )}
        {/* The live region is the words alone. The clock sits outside it:
            inside an atomic region, every tick would be read out again. */}
        <div
          className="bulk-sync__status-copy"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <strong>{title}</strong>
          {detail !== null && (
            <span
              className={
                detail.kind === "path" ? "selectable" : "is-summary"
              }
            >
              {detail.text}
            </span>
          )}
        </div>
        {live ? (
          <LiveClock
            startedAt={startedAt}
            finished={finished}
            total={total}
            estimate={phase === "running"}
          />
        ) : (
          durationMs !== null && (
            <span className="bulk-sync__time">
              took <strong>{formatElapsed(durationMs)}</strong>
            </span>
          )
        )}
      </div>

      {total > 0 && (
        <>
          <div
            className="bulk-sync__bar"
            role="progressbar"
            aria-label="Repositories finished"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={finished}
            aria-valuetext={progressValueText(counts, total)}
          >
            {/* Every segment stays mounted, so a count leaving zero grows
                in rather than popping in. */}
            {BULK_SYNC_OUTCOMES.map((outcome) => (
              <i
                key={outcome}
                className={segmentClass(outcome, counts[outcome])}
                style={{ flexGrow: counts[outcome] }}
              />
            ))}
            <i
              className={`${segmentClass("in-flight", inFlight)}${
                phase === "cancelling" ? " is-halted" : ""
              }`}
              style={{ flexGrow: inFlight }}
            />
            <i className="is-queued" style={{ flexGrow: queued }} />
          </div>
          <div className="bulk-sync__legend">
            <span>
              <strong>{finished}</strong>{" "}
              {live
                ? `of ${total} ${repositoryNoun(total)}`
                : repositoryNoun(total)}
            </span>
            {BULK_SYNC_OUTCOMES.filter((outcome) => counts[outcome] > 0).map(
              (outcome) => (
                <span
                  key={outcome}
                  className={`bulk-sync__legend-item is-${outcome}`}
                >
                  {/* One inline run, so the flex gap spaces the swatch from
                      the words and not the count from its label. */}
                  <span>
                    <strong>{counts[outcome]}</strong> {outcome}
                  </span>
                </span>
              )
            )}
            {live && (
              <span className="bulk-sync__legend-tail">
                {phase === "cancelling" ? (
                  `${inFlight} stopping · ${queued} won't start`
                ) : (
                  <>
                    <strong>{inFlight}</strong> in flight · {queued} queued
                  </>
                )}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function segmentClass(name: string, count: number): string {
  return count === 0 ? `is-${name} is-empty` : `is-${name}`;
}

/**
 * The only part of the card that changes every second, so it is the only
 * part that re-renders every second — not the card, and not the dialog's
 * list of repositories beside it.
 */
function LiveClock({
  startedAt,
  finished,
  total,
  estimate
}: {
  startedAt: number;
  finished: number;
  total: number;
  estimate: boolean;
}): ReactElement {
  const now = useSecondsClock(true);
  const elapsed = Math.max(0, now - startedAt);
  const remaining = estimate
    ? estimateRemainingMs(elapsed, finished, total)
    : null;
  return (
    <span className="bulk-sync__time">
      <strong>{formatElapsed(elapsed)}</strong> elapsed
      {remaining !== null && ` · ${formatRemaining(remaining)}`}
    </span>
  );
}

function StatusMark({ mark }: { mark: StatusMarkKind }): ReactElement {
  return (
    <span className={`bulk-sync__mark is-${mark}`} aria-hidden="true">
      <svg
        viewBox="0 0 10 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {mark === "ok" && <path d="M2.4 5.3l1.8 1.8 3.5-3.9" />}
        {mark === "failed" && (
          <>
            <path d="M5 2.2v3.4" />
            <path d="M5 7.8v.01" />
          </>
        )}
        {mark === "cancelled" && <path d="M2.6 5h4.8" />}
      </svg>
    </span>
  );
}
