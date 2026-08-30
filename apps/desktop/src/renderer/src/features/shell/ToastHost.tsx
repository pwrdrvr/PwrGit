import { useEffect, useState } from "react";
import { AppUpdateToast } from "../update/AppUpdateToast";
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
export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  return (
    <div className="toast-host">
      {/* Keyed by `key` where there is one, so a replacement updates the card
          in place: remounting would drop the hover-pause of a pointer that is
          already resting on it and never fires onMouseEnter again. */}
      {toasts.map((toast) => (
        <ToastCard key={toast.key ?? toast.id} toast={toast} />
      ))}
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
            aria-label="Copy error"
            title="Copy error"
            onClick={() => {
              void navigator.clipboard.writeText(
                [toast.title, toast.message, toast.detail]
                  .filter(Boolean)
                  .join("\n")
              );
            }}
          >
            Copy
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
