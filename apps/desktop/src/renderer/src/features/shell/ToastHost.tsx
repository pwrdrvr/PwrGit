import { useEffect, useState } from "react";
import { AppUpdateToast } from "../update/AppUpdateToast";
import { RemoteActivityToast } from "../remote/RemoteActivityToast";
import { dispatch } from "../../lib/pwrgit";
import { dismissToast, subscribeToasts, type Toast } from "../../lib/toast";

const AUTO_DISMISS_MS = 9_000;

/** Bottom-right stack of error toasts (adapted from PwrAgnt's AppNoticeToast).
 *  Always visible regardless of pane widths — the fallback surface for errors
 *  whose inline chrome may be collapsed away.
 *
 *  The update toast rides at the bottom of the same stack: it outlives every
 *  transient notice, so anchoring it to the corner keeps it from being shoved
 *  around as errors come and go. The container is rendered even when empty —
 *  a childless flex column at a fixed corner has no size and paints nothing. */
export function ToastHost({
  selectedWorktreeId = null
}: {
  /** The checkout on screen — its own toolbar reports its operations, so the
   *  activity cards below skip it. */
  selectedWorktreeId?: string | null;
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  return (
    <div className="toast-host">
      {/* Keyed by `key` where there is one, so a replacement updates the card
          in place: remounting would drop the hover-pause of a pointer that is
          already resting on it and never fires onMouseEnter again.

          Sticky cards sort after the transients for the same reason the
          update toast anchors the corner: a card that outlives the come-and-go
          must not be shoved around by it. In this bottom-anchored column the
          later children sit nearer the corner, and growth above them leaves
          them still. */}
      {[...toasts]
        .sort((a, b) => Number(a.sticky === true) - Number(b.sticky === true))
        .map((toast) => (
          <ToastCard key={toast.key ?? toast.id} toast={toast} />
        ))}
      {/* Live operations sit below the transient notices and above the update
          card, for the reason the sort above gives: they outlive the come-and-go
          and must not be shoved around by it. */}
      <RemoteActivityToast selectedWorktreeId={selectedWorktreeId} />
      <AppUpdateToast />
    </div>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || toast.sticky === true) return;
    const timer = window.setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [paused, toast.id, toast.sticky]);

  return (
    <aside
      className="app-toast"
      role="status"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="app-toast__content">
        <p
          className={
            toast.tone === "error"
              ? "app-toast__eyebrow"
              : "app-toast__eyebrow app-toast__eyebrow--info"
          }
        >
          {toast.title}
        </p>
        <p className="app-toast__message">{toast.message}</p>
        {toast.detail !== undefined && toast.detail !== toast.message && (
          <p className="app-toast__detail">{toast.detail}</p>
        )}
      </div>
      <div className="app-toast__actions">
        {toast.showLogsAction !== false && (
          <button
            className="app-toast__button"
            type="button"
            title="Open the Logs window"
            onClick={() => void dispatch("logs:openWindow", undefined)}
          >
            Logs
          </button>
        )}
        {toast.showCopyAction !== false && (
          <button
            className="app-toast__button"
            type="button"
            aria-label={toast.copyLabel ?? "Copy error"}
            title={toast.copyLabel ?? "Copy error"}
            onClick={() => {
              void navigator.clipboard.writeText(
                toast.copyText ?? [toast.title, toast.message, toast.detail]
                  .filter(Boolean)
                  .join("\n")
              );
            }}
          >
            {toast.copyLabel ?? "Copy"}
          </button>
        )}
        <button
          className="app-toast__button"
          type="button"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => dismissToast(toast.id)}
        >
          ✕
        </button>
      </div>
      {/* Keyed by id so a replacement restarts the countdown animation, which
          runs on mount, in step with the timer effect above. A sticky toast
          has no countdown, so it shows no bar draining toward one. */}
      {toast.sticky !== true && (
        <span
          key={toast.id}
          className="app-toast__timer"
          aria-hidden="true"
          data-paused={paused ? "true" : undefined}
        />
      )}
    </aside>
  );
}
