import type { RootOptions } from "react-dom/client";
import type { RendererErrorReport } from "@pwrgit/shared";
import { dispatch } from "./pwrgit";

// Every renderer error ends up in main.log through `logs:reportRendererError`.
// A render error unmounts the React root and leaves a blank window while the
// renderer process stays alive, so main's `render-process-gone` never fires and
// — without this — the log says nothing at all.
//
// An IPC command rather than main listening to `console-message`: React 19's
// default uncaught-error handler hands the error to `reportError` with no
// component stack, and a console line arrives in main as one flattened string
// — every `console.error` in every window, dev warnings included — that main
// would have to parse back apart. Code has to run here regardless to get the
// component stack out, so it sends the fields themselves. Main applies the
// rate limit (renderer-errors.ts there), since a reload resets anything kept
// here.

type Source = RendererErrorReport["source"];

// The same Error object can surface twice — a promise rejected with an error
// a boundary already caught, a recoverable error React rethrows. Once is enough.
const reported = new WeakSet<object>();

function describe(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) {
    return {
      message: `${value.name}: ${value.message}`,
      ...(value.stack === undefined ? {} : { stack: value.stack })
    };
  }
  if (typeof value === "string") return { message: value };
  try {
    return { message: JSON.stringify(value) ?? String(value) };
  } catch {
    return { message: String(value) };
  }
}

/** Forward one error to the app log. Never throws, never rejects. */
export function reportRendererError(
  source: Source,
  error: unknown,
  componentStack?: string | null
): void {
  if (typeof error === "object" && error !== null) {
    if (reported.has(error)) return;
    reported.add(error);
  }
  const view = typeof window === "undefined" ? "" : window.location.hash;
  const report: RendererErrorReport = {
    source,
    ...describe(error),
    ...(componentStack == null || componentStack === "" ? {} : { componentStack }),
    ...(view === "" ? {} : { view })
  };
  try {
    // A failed report has nowhere better to go; it must not become an
    // unhandled rejection that reports itself.
    void dispatch("logs:reportRendererError", report).catch(() => undefined);
  } catch {
    // No bridge (a test, or a preload that failed) — nothing to report to.
  }
}

/**
 * React 19 root callbacks. Passing these replaces React's own console output,
 * so each one still writes to the console for DevTools.
 */
type RootErrorInfo = { componentStack?: string | undefined };

export const rendererRootErrorOptions = {
  onUncaughtError(error: unknown, info: RootErrorInfo) {
    console.error("Uncaught render error — the window's React tree unmounted", error, info.componentStack);
    reportRendererError("react-uncaught", error, info.componentStack);
  },
  onCaughtError(error: unknown, info: RootErrorInfo) {
    console.error("Render error caught by an error boundary", error, info.componentStack);
    reportRendererError("react-caught", error, info.componentStack);
  },
  onRecoverableError(error: unknown, info: RootErrorInfo) {
    console.warn("Recoverable render error", error, info.componentStack);
    reportRendererError("react-recoverable", error, info.componentStack);
  }
} satisfies Pick<
  RootOptions,
  "onUncaughtError" | "onCaughtError" | "onRecoverableError"
>;

/** Window-level listeners for errors outside React's render: event handlers,
 *  timers, workers' message handlers, and promises nobody awaited. */
export function installRendererErrorReporting(target: Window = window): () => void {
  const onError = (event: ErrorEvent): void => {
    reportRendererError(
      "window-error",
      event.error ?? `${event.message} (${event.filename}:${event.lineno}:${event.colno})`
    );
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    reportRendererError("unhandled-rejection", event.reason);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
