import { useEffect, useRef } from "react";
import { errorSummary } from "../../lib/ErrorBoundary";
import { dispatch } from "../../lib/pwrgit";
import { hoverTooltip, useViewportTooltip } from "../../lib/useViewportTooltip";

const openLogs = (): void => {
  void dispatch("logs:openWindow", undefined).catch(() => undefined);
};

/**
 * What a main-column pane (diff, file details) shows in place of itself when
 * it threw while rendering. It keeps the pane's head and its close button, so
 * the reader leaves the way they would have from the pane itself — Escape
 * included, scoped to focus being inside, as DiffPane scopes its own.
 */
export function PaneErrorFallback({
  title,
  error,
  hidden = false,
  onRetry,
  onClose
}: {
  title: string;
  error: unknown;
  hidden?: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  const tip = useViewportTooltip();
  const paneRef = useRef<HTMLDivElement>(null);
  // Focus came from inside the pane that just unmounted; without this it
  // falls to <body> and Escape would have nothing to land on.
  useEffect(() => {
    if (!hidden) paneRef.current?.focus({ preventScroll: true });
  }, [hidden]);

  return (
    <div
      className="diff-pane pane-error"
      ref={paneRef}
      tabIndex={-1}
      style={hidden ? { display: "none" } : undefined}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className="diff-pane__head">
        <div className="diff-pane__row">
          <span className="diff-pane__scope">{title}</span>
          <button
            className="diff-pane__close"
            onClick={onClose}
            aria-label="Close"
            {...hoverTooltip(tip, "Close (Esc)")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      </div>
      <div className="pane-error__body" role="alert">
        <p className="pane-error__title">This pane hit an error and stopped drawing.</p>
        <p className="pane-error__detail">{errorSummary(error)}</p>
        <p className="pane-error__hint">The full error is in the log.</p>
        <div className="pane-error__actions">
          <button
            type="button"
            className="settings-button settings-button--primary"
            onClick={onRetry}
          >
            Try again
          </button>
          <button type="button" className="settings-button" onClick={openLogs}>
            Show logs
          </button>
        </div>
      </div>
      {tip.tooltipNode}
    </div>
  );
}

/**
 * The last resort, around the whole window: anything that reaches it would
 * otherwise have unmounted the root and left the window blank. Deliberately
 * plain — no app state, no tooltip portal — so it can still draw when the
 * thing that broke is shared.
 */
export function RootErrorFallback({
  error,
  showLogs
}: {
  error: unknown;
  /** Off in the Logs window itself, where it would only focus this window. */
  showLogs: boolean;
}) {
  return (
    <div className="app-error" role="alert">
      <div className="app-error__card">
        <h1 className="app-error__title">PwrGit hit an error</h1>
        <p className="app-error__text">
          This window stopped drawing. Reloading it usually brings it back; the
          full error is in the log.
        </p>
        <p className="app-error__detail">{errorSummary(error)}</p>
        <div className="app-error__actions">
          <button
            type="button"
            className="settings-button settings-button--primary"
            autoFocus
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
          {showLogs && (
            <button type="button" className="settings-button" onClick={openLogs}>
              Show logs
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
