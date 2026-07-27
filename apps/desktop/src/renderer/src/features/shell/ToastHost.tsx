import { useEffect, useState } from "react";
import { dispatch } from "../../lib/pwrgit";
import { dismissToast, subscribeToasts, type Toast } from "../../lib/toast";

const AUTO_DISMISS_MS = 9_000;

/** Bottom-right stack of error toasts (adapted from PwrAgnt's AppNoticeToast).
 *  Always visible regardless of pane widths — the fallback surface for errors
 *  whose inline chrome may be collapsed away. */
export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-host">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [paused, toast.id]);

  return (
    <aside
      className="app-toast"
      role="status"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="app-toast__content">
        <p className="app-toast__eyebrow">{toast.title}</p>
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
      <span
        className="app-toast__timer"
        aria-hidden="true"
        data-paused={paused ? "true" : undefined}
      />
    </aside>
  );
}
