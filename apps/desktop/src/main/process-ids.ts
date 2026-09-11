import { app } from "electron";
import type { ProcessMetric } from "electron";
import { logMain } from "./logs";

// A copied log should answer "which process was that?" on its own. The main
// process id rides on the startup line; this module logs the rest of Electron's
// process table — GPU, renderers, utility helpers — whenever it changes, so the
// pids are already in the file before anyone thinks to open Activity Monitor.

/** Helpers arrive asynchronously; collapse a burst of triggers into one sample. */
const SETTLE_MS = 500;

/** The three an operator actually asks about lead the line; the rest sort after. */
const LEADING_LABELS = ["main", "gpu", "renderer"];

// Chromium's process types, mapped to the words used to describe them. A type
// named here is labeled by type alone: `name` for a Tab is the page title,
// which would rewrite the line on every navigation without naming a new pid.
const TYPE_LABELS: Record<string, string> = {
  Browser: "main",
  GPU: "gpu",
  Tab: "renderer"
};

export type ProcessIdSample = Pick<
  ProcessMetric,
  "pid" | "type" | "name" | "serviceName"
>;

function labelFor(metric: ProcessIdSample): string {
  const known = TYPE_LABELS[metric.type];
  if (known !== undefined) return known;

  // Utility processes are only distinguishable by service ("Network Service",
  // "Audio Service"), and those names are stable for a process's lifetime.
  const base = metric.type.toLowerCase().replace(/\s+/g, "-");
  const detail = (metric.name ?? metric.serviceName ?? "").replace(/\s+/g, "");
  return detail === "" ? base : `${base}:${detail}`;
}

function leadingRank(label: string): number {
  const index = LEADING_LABELS.indexOf(label);
  return index === -1 ? LEADING_LABELS.length : index;
}

/** `main=311 gpu=315 renderer=330,341 utility:NetworkService=317`, or "". */
export function formatProcessIds(metrics: readonly ProcessIdSample[]): string {
  const byLabel = new Map<string, number[]>();
  for (const metric of metrics) {
    if (!Number.isInteger(metric.pid) || metric.pid <= 0) continue;
    const label = labelFor(metric);
    const pids = byLabel.get(label);
    if (pids === undefined) byLabel.set(label, [metric.pid]);
    else pids.push(metric.pid);
  }

  return [...byLabel]
    .sort(
      ([a], [b]) => leadingRank(a) - leadingRank(b) || (a < b ? -1 : a > b ? 1 : 0)
    )
    .map(([label, pids]) => `${label}=${pids.sort((x, y) => x - y).join(",")}`)
    .join(" ");
}

function goneLine(
  kind: string,
  details: { reason: string; exitCode: number; name?: string | undefined }
): string {
  const named = details.name === undefined ? "" : ` (${details.name})`;
  return `${kind} process gone${named} reason=${details.reason} exitCode=${details.exitCode}`;
}

/**
 * Log the process table at startup and on every change, plus a line for each
 * helper that dies. Called once from index.ts after app-ready.
 */
export function watchProcessIds(): void {
  let lastLine: string | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const logTableIfChanged = (): void => {
    const line = formatProcessIds(app.getAppMetrics());
    if (line === "" || line === lastLine) return;
    lastLine = line;
    logMain("info", "process", line);
  };

  // A renderer has no OS process id until its frame loads, and the GPU process
  // starts with the first window — so every trigger waits out the settle window
  // rather than logging a half-built table (and a second line moments later).
  const sampleSoon = (): void => {
    if (settleTimer !== null) return;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      logTableIfChanged();
    }, SETTLE_MS);
    settleTimer.unref();
  };

  sampleSoon();

  app.on("web-contents-created", (_event, contents) => {
    contents.once("did-finish-load", sampleSoon);
    contents.once("destroyed", sampleSoon);
  });

  app.on("child-process-gone", (_event, details) => {
    logMain(
      details.reason === "clean-exit" ? "info" : "warn",
      "process",
      goneLine(details.type, details)
    );
    sampleSoon();
  });

  app.on("render-process-gone", (_event, _contents, details) => {
    logMain(
      details.reason === "clean-exit" ? "info" : "warn",
      "process",
      goneLine("renderer", details)
    );
    sampleSoon();
  });
}
