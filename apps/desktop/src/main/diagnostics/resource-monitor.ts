import { readAppMetrics } from "./app-metrics";
import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, powerMonitor } from "electron";
import { logMain } from "../logs";
import { gitResourceUsage, ProcessResourceUsage, startGitResourceRecording } from "./resource-usage";

export const RESOURCE_SAMPLE_MS = 60_000;
const RETAIN_HOURS = 24;
const FILE_PATTERN = /^resource-usage-(\d{4}-\d{2}-\d{2}T\d{2})\.ndjson$/;

/** One file per UTC hour, retained for 24 hours independently of noisy main.log. */
export async function appendResourceSample(directory: string, at: Date, sample: unknown): Promise<void> {
  await mkdir(directory, { recursive: true });
  const hour = at.toISOString().slice(0, 13);
  await appendFile(join(directory, `resource-usage-${hour}.ndjson`), `${JSON.stringify(sample)}\n`);
  const cutoff = Date.parse(`${hour}:00:00Z`) - RETAIN_HOURS * 60 * 60_000;
  for (const name of await readdir(directory)) {
    const match = FILE_PATTERN.exec(name);
    if (match?.[1] !== undefined && Date.parse(`${match[1]}:00:00Z`) < cutoff) {
      await unlink(join(directory, name));
    }
  }
}

/** One unreferenced timer, no profiling or Git probes. Files contain numeric
 * counters and fixed labels only, so a day's work can be compared offline. */
export function watchResourceUsage(directory: string): () => Promise<void> {
  const processes = new ProcessResourceUsage();
  processes.sample(readAppMetrics().metrics);
  let previous = Date.now();
  const sessionStartedAt = new Date(previous).toISOString();
  const stopRecording = startGitResourceRecording();
  let pendingWrite = Promise.resolve();
  let writing = false;
  let warned = false;
  const timer = setInterval(() => {
    if (writing) return;
    writing = true;
    const at = new Date();
    try {
      const sample = {
        version: 1,
        at: at.toISOString(),
        appVersion: app.getVersion(),
        mainPid: process.pid,
        sessionStartedAt,
        intervalMs: at.getTime() - previous,
        focused: BrowserWindow.getFocusedWindow() !== null,
        visibleWindows: BrowserWindow.getAllWindows().filter((w) => w.isVisible() && !w.isMinimized()).length,
        onBattery: powerMonitor.isOnBatteryPower(),
        processes: processes.sample(readAppMetrics().metrics),
        git: gitResourceUsage.sample()
      };
      previous = at.getTime();
      pendingWrite = appendResourceSample(directory, at, sample)
        .catch((cause: unknown) => {
          if (!warned) logMain("warn", "resources", "resource sample write failed", cause);
          warned = true;
        })
        .finally(() => { writing = false; });
    } catch (cause) {
      writing = false;
      if (!warned) logMain("warn", "resources", "resource sampling failed", cause);
      warned = true;
    }
  }, RESOURCE_SAMPLE_MS);
  timer.unref();
  logMain("info", "resources", "minute resource samples (24h retention):", directory);
  return () => {
    clearInterval(timer);
    stopRecording();
    return pendingWrite;
  };
}
