import { app } from "electron";
import type { ProcessMetric } from "electron";
import { logMain } from "./logs";

// A copied log should answer "which process was that?" on its own. The main
// process id rides on the startup line; this module logs the rest of Electron's
// process table — GPU, renderers, utility helpers — whenever it changes, so the
// pids are already in the file before anyone thinks to open Activity Monitor.

/** Helpers arrive asynchronously; collapse a burst of triggers into one sample. */
const SETTLE_MS = 500;

// Chromium's process types, mapped to the words used to describe them, in the
// order an operator asks about them — every other type sorts alphabetically
// after these. A type named here is labeled by type alone: `name` for a Tab is
// the page title, which would rewrite the line on every navigation without
// naming a new pid. A Map, not an object, so an unexpected type can't resolve
// an inherited key ("constructor", "toString") to something that isn't a label.
const TYPE_LABELS = new Map<string, string>([
  ["Browser", "main"],
  ["GPU", "gpu"],
  ["Tab", "renderer"]
]);

const LEADING_LABELS = [...TYPE_LABELS.values()];

export type ProcessIdSample = Pick<
  ProcessMetric,
  "pid" | "type" | "name" | "serviceName"
>;

function labelFor(metric: Omit<ProcessIdSample, "pid">): string {
  const known = TYPE_LABELS.get(metric.type);
  if (known !== undefined) return known;

  // Utility processes are only distinguishable by service, and `serviceName` is
  // the one Electron documents as non-localized — `name` is "Network Service"
  // in English and something else entirely on a French machine, which would
  // make one operator's log unsearchable with another's label. The leading
  // namespace carries nothing here: network.mojom.NetworkService → NetworkService.
  const base = metric.type.toLowerCase().replace(/\s+/g, "-");
  const service = metric.serviceName ?? metric.name ?? "";
  const detail = (service.split(".").pop() ?? "").replace(/\s+/g, "");
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

/** Named with labelFor's spelling, so a crash and the table that follows grep alike. */
function goneLine(
  gone: Omit<ProcessIdSample, "pid"> & { reason: string; exitCode: number }
): string {
  return `${labelFor(gone)} process gone reason=${gone.reason} exitCode=${gone.exitCode}`;
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
    // A renderer that fails to load still holds a process (it paints Chromium's
    // error page), so the failure path has to sample too or its pid never lands.
    contents.once("did-finish-load", sampleSoon);
    contents.once("did-fail-load", sampleSoon);
    contents.once("destroyed", sampleSoon);
  });

  app.on("child-process-gone", (_event, details) => {
    logMain(
      details.reason === "clean-exit" ? "info" : "warn",
      "process",
      goneLine(details)
    );
    sampleSoon();
  });

  app.on("render-process-gone", (_event, _contents, details) => {
    logMain(
      details.reason === "clean-exit" ? "info" : "warn",
      "process",
      goneLine({ type: "Tab", ...details })
    );
    sampleSoon();
  });
}
