import { app, type ProcessMetric } from "electron";

export type AppMetricsSample = {
  metrics: ProcessMetric[];
  atMs: number;
  previousAtMs: number | null;
};

let previous: AppMetricsSample | undefined;

/**
 * Electron's percentage fallback shares a clock across every getAppMetrics
 * caller. Track the app's reads, and share a poll between nearby profiler
 * ticks so a main-process read does not invalidate a renderer's interval.
 */
export function readAppMetrics(reuseForMs = 0): AppMetricsSample {
  const atMs = performance.now();
  const elapsedMs = previous === undefined ? Infinity : atMs - previous.atMs;
  if (previous && elapsedMs >= 0 && elapsedMs < reuseForMs) return previous;
  const sample = { metrics: app.getAppMetrics(), atMs, previousAtMs: elapsedMs > 0 ? previous?.atMs ?? null : null };
  previous = sample;
  return sample;
}
