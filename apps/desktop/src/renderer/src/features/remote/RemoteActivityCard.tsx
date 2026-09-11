import { useEffect, useRef, useState } from "react";
import type { RemoteActivity } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import {
  formatElapsed,
  remoteActivityMeter,
  remoteActivityReport,
  remoteActivityStatus,
  remoteActivityTitle
} from "./remote-activity";

/**
 * What one running remote operation is doing, in enough detail to act on.
 *
 * Shown in the toolbar's hover popover and in the toast that keeps an
 * operation reachable after you navigate away from its repository. Both need
 * the same four things — scope, health, Git's own words, and a way out — so
 * they share this card rather than growing two dialects of it.
 */
export function RemoteActivityCard({
  activity,
  now,
  compact = false
}: {
  activity: RemoteActivity;
  /** Caller-owned clock, so every card in a stack reads the same second. */
  now: number;
  /** Toast placement: tighter, and without the repeated Git output block. */
  compact?: boolean;
}) {
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
  const status = remoteActivityStatus(activity, now);
  const meter = remoteActivityMeter(activity);
  const elapsed = formatElapsed(now - activity.startedAt);

  const copyReport = async (): Promise<void> => {
    const result = await dispatch("remote:activityLog", {
      operationId: activity.id
    });
    const lines = result.ok && result.value !== null ? result.value.lines : [];
    await navigator.clipboard.writeText(
      remoteActivityReport(activity, lines, now)
    );
    setCopied(true);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div
      className={`remote-activity${compact ? " remote-activity--compact" : ""}`}
    >
      <div className="remote-activity__header">
        <span className="remote-activity__title">
          {remoteActivityTitle(activity)}
        </span>
        <span className="remote-activity__elapsed">{elapsed}</span>
      </div>

      <p
        className={`remote-activity__status remote-activity__status--${status.tone}`}
      >
        {status.label}
      </p>

      {meter !== null && activity.progress !== null && (
        <div className="remote-activity__meter">
          <div
            className="remote-activity__bar"
            role="progressbar"
            aria-label={meter}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={activity.progress.percent}
          >
            <span style={{ width: `${activity.progress.percent}%` }} />
          </div>
          <span className="remote-activity__meter-label">{meter}</span>
        </div>
      )}

      {activity.command !== null && (
        <p className="remote-activity__command">{activity.command}</p>
      )}

      {!compact && (
        // Git's own words, verbatim. Everything above is PwrGit's reading of
        // the operation; this is the evidence behind it, and the only thing
        // that explains an unfamiliar failure.
        <pre className="remote-activity__output" aria-label="Recent Git output">
          {activity.tail.length === 0
            ? "Git has produced no output yet."
            : activity.tail.join("\n")}
        </pre>
      )}

      <div className="remote-activity__actions">
        {/* aria-disabled, never `disabled` (styles/AGENTS.md): Chromium blurs
            an element the moment it becomes disabled, and this card is an
            interactive tooltip whose blur handler schedules its own dismissal
            — so `disabled` would take the status off screen at the instant
            the user asked to stop, and drop keyboard focus to <body>
            (SC 2.4.3). The handler guards instead. */}
        <button
          className="remote-activity__button remote-activity__button--stop"
          type="button"
          onClick={() => {
            if (activity.canceling) return;
            void dispatch("remote:cancelActivity", {
              operationId: activity.id
            });
          }}
          aria-disabled={activity.canceling}
        >
          {activity.canceling ? "Stopping…" : "Cancel"}
        </button>
        <button
          className="remote-activity__button"
          type="button"
          title="Open the Logs window"
          onClick={() => void dispatch("logs:openWindow", undefined)}
        >
          Logs
        </button>
        <button
          className="remote-activity__button"
          type="button"
          title="Copy this status and the full Git output"
          onClick={() => void copyReport()}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
