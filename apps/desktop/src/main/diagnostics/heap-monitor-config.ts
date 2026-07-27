// Ported from PwrAgnt (diagnostics/heap-monitor-config.ts). PwrGit resolves
// from Settings first (options.enabled/outputRoot); PWRGIT_* env vars override
// individual knobs, and PWRGIT_HEAP_DIAGNOSTICS can force-enable without
// touching settings.
import path from "node:path";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_SETTLE_DELAY_MS = 1_000;
const DEFAULT_DELTA_THRESHOLD_BYTES = 100 * 1024 * 1024;
const DEFAULT_SNAPSHOT_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_SNAPSHOTS = 5;

export type HeapMonitorConfig =
  | { enabled: false }
  | {
      enabled: true;
      outputRoot: string;
      intervalMs: number;
      settleDelayMs: number;
      deltaThresholdBytes: number;
      snapshotCooldownMs: number;
      maxSnapshots: number;
    };

function isEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveHeapMonitorConfig(options: {
  /** Settings-driven enable; env PWRGIT_HEAP_DIAGNOSTICS also enables. */
  enabled?: boolean;
  outputRoot: string;
  env?: NodeJS.ProcessEnv;
}): HeapMonitorConfig {
  const env = options.env ?? process.env;
  if (options.enabled !== true && !isEnabled(env["PWRGIT_HEAP_DIAGNOSTICS"])) {
    return { enabled: false };
  }

  return {
    enabled: true,
    outputRoot: path.resolve(
      env["PWRGIT_HEAP_DIAGNOSTICS_DIR"] ?? options.outputRoot
    ),
    intervalMs: parsePositiveInteger(
      env["PWRGIT_HEAP_DIAGNOSTICS_INTERVAL_MS"],
      DEFAULT_INTERVAL_MS
    ),
    settleDelayMs: parseNonNegativeInteger(
      env["PWRGIT_HEAP_DIAGNOSTICS_SETTLE_MS"],
      DEFAULT_SETTLE_DELAY_MS
    ),
    deltaThresholdBytes: parsePositiveInteger(
      env["PWRGIT_HEAP_DIAGNOSTICS_DELTA_BYTES"],
      DEFAULT_DELTA_THRESHOLD_BYTES
    ),
    snapshotCooldownMs: parseNonNegativeInteger(
      env["PWRGIT_HEAP_DIAGNOSTICS_COOLDOWN_MS"],
      DEFAULT_SNAPSHOT_COOLDOWN_MS
    ),
    maxSnapshots: parsePositiveInteger(
      env["PWRGIT_HEAP_DIAGNOSTICS_MAX_SNAPSHOTS"],
      DEFAULT_MAX_SNAPSHOTS
    )
  };
}
