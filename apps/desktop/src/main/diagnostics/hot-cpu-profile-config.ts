// Ported from PwrAgnt (diagnostics/hot-cpu-profile-config.ts). Settings drive
// the user-facing knobs (enable, start delay, trigger mode, heap snapshots);
// PWRGIT_* env vars override individual values for scripted runs.
import path from "node:path";
import type { HotCpuTriggerMode } from "@pwrgit/shared";
import {
  DIAGNOSTICS_DEFAULTS,
  HOT_CPU_HEAP_SNAPSHOT_LIMIT_MAX,
  isHotCpuTriggerMode
} from "@pwrgit/shared";

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_THRESHOLD_PERCENT = 50;
const DEFAULT_SLOWBURN_THRESHOLD_PERCENT = 15;
const DEFAULT_CONSECUTIVE_SAMPLES = 2;
const DEFAULT_PROFILE_DURATION_MS = 15_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_PROFILES = 5;

export type HotCpuProfileConfig =
  | { enabled: false }
  | {
      enabled: true;
      outputRoot: string;
      startDelayMs: number;
      triggerMode: HotCpuTriggerMode;
      intervalMs: number;
      thresholdPercent: number;
      slowburnThresholdPercent: number;
      consecutiveSamples: number;
      profileDurationMs: number;
      cooldownMs: number;
      maxProfiles: number;
      captureHeapSnapshot: boolean;
      heapSnapshotLimit: number;
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

function parsePositiveNumber(
  value: string | undefined,
  fallback: number
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampHeapSnapshotLimit(value: number): number {
  return Math.min(
    Math.max(Math.round(value), 1),
    HOT_CPU_HEAP_SNAPSHOT_LIMIT_MAX
  );
}

function clampPercent(value: number): number {
  return Math.min(Math.max(value, 1), 100);
}

function parseTriggerMode(
  value: string | undefined,
  fallback: HotCpuTriggerMode
): HotCpuTriggerMode {
  if (value === undefined || value === "") return fallback;
  const normalized = value.trim().toLowerCase();
  return isHotCpuTriggerMode(normalized) ? normalized : fallback;
}

export function resolveHotCpuProfileConfig(options: {
  enabled?: boolean;
  outputRoot: string;
  startDelayMs?: number;
  triggerMode?: HotCpuTriggerMode;
  captureHeapSnapshot?: boolean;
  heapSnapshotLimit?: number;
  env?: NodeJS.ProcessEnv;
}): HotCpuProfileConfig {
  const env = options.env ?? process.env;
  if (options.enabled !== true && !isEnabled(env["PWRGIT_HOT_CPU_PROFILING"])) {
    return { enabled: false };
  }

  return {
    enabled: true,
    outputRoot: path.resolve(
      env["PWRGIT_HOT_CPU_PROFILING_DIR"] ?? options.outputRoot
    ),
    startDelayMs: parseNonNegativeInteger(
      env["PWRGIT_HOT_CPU_PROFILING_START_DELAY_MS"],
      options.startDelayMs ?? DIAGNOSTICS_DEFAULTS.hotCpuProfilingStartDelayMs
    ),
    triggerMode: parseTriggerMode(
      env["PWRGIT_HOT_CPU_PROFILING_TRIGGER_MODE"],
      options.triggerMode ?? DIAGNOSTICS_DEFAULTS.hotCpuProfilingTriggerMode
    ),
    intervalMs: parsePositiveInteger(
      env["PWRGIT_HOT_CPU_PROFILING_INTERVAL_MS"],
      DEFAULT_INTERVAL_MS
    ),
    thresholdPercent: parsePositiveNumber(
      env["PWRGIT_HOT_CPU_PROFILING_THRESHOLD_PERCENT"],
      DEFAULT_THRESHOLD_PERCENT
    ),
    slowburnThresholdPercent: clampPercent(
      parsePositiveNumber(
        env["PWRGIT_HOT_CPU_PROFILING_SLOWBURN_THRESHOLD_PERCENT"],
        DEFAULT_SLOWBURN_THRESHOLD_PERCENT
      )
    ),
    consecutiveSamples: parsePositiveInteger(
      env["PWRGIT_HOT_CPU_PROFILING_CONSECUTIVE_SAMPLES"],
      DEFAULT_CONSECUTIVE_SAMPLES
    ),
    profileDurationMs: parsePositiveInteger(
      env["PWRGIT_HOT_CPU_PROFILING_DURATION_MS"],
      DEFAULT_PROFILE_DURATION_MS
    ),
    cooldownMs: parsePositiveInteger(
      env["PWRGIT_HOT_CPU_PROFILING_COOLDOWN_MS"],
      DEFAULT_COOLDOWN_MS
    ),
    maxProfiles: parsePositiveInteger(
      env["PWRGIT_HOT_CPU_PROFILING_MAX_PROFILES"],
      DEFAULT_MAX_PROFILES
    ),
    captureHeapSnapshot:
      env["PWRGIT_HOT_CPU_PROFILING_HEAP_SNAPSHOT"] === undefined
        ? (options.captureHeapSnapshot ??
          DIAGNOSTICS_DEFAULTS.hotCpuProfilingCaptureHeapSnapshot)
        : isEnabled(env["PWRGIT_HOT_CPU_PROFILING_HEAP_SNAPSHOT"]),
    heapSnapshotLimit: clampHeapSnapshotLimit(
      parsePositiveInteger(
        env["PWRGIT_HOT_CPU_PROFILING_HEAP_SNAPSHOT_LIMIT"],
        options.heapSnapshotLimit ??
          DIAGNOSTICS_DEFAULTS.hotCpuProfilingHeapSnapshotLimit
      )
    )
  };
}
