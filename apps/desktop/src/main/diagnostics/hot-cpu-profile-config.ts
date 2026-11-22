// Ported from PwrAgnt (diagnostics/hot-cpu-profile-config.ts). Settings drive
// the user-facing knobs (enable, start delay, trigger mode, heap snapshots);
// PWRGIT_* env vars override individual values for scripted runs.
import path from "node:path";
import type { HotCpuCaptureRules, HotCpuEffectiveRule, HotCpuTriggerMode } from "@pwrgit/shared";
import {
  DIAGNOSTICS_DEFAULTS,
  HOT_CPU_HEAP_SNAPSHOT_LIMIT_MAX,
  HOT_CPU_TUNING,
  hotCpuRuleIntervalMs,
  isHotCpuTriggerMode,
  legacyHotCpuMode,
  readHotCpuRules
} from "@pwrgit/shared";

const DEFAULT_INTERVAL_MS = HOT_CPU_TUNING.intervalMs;
const DEFAULT_CONSECUTIVE_SAMPLES = 2;
const DEFAULT_PROFILE_DURATION_MS = HOT_CPU_TUNING.profileDurationMs;
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
      rules: HotCpuEffectiveRule[];
      overrides: string[];
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

export function resolveHotCpuRules(
  settings: HotCpuCaptureRules, env: NodeJS.ProcessEnv, legacySettings = false
) {
  const overrides: string[] = [];
  const override = <T>(suffix: string, parse: (value: string) => T | undefined): T | undefined => {
    const key = `PWRGIT_HOT_CPU_PROFILING_${suffix}`;
    const raw = env[key];
    if (raw === undefined) return undefined;
    const value = parse(raw);
    if (value === undefined) return undefined;
    overrides.push(key);
    return value;
  };
  const positiveInt = (value: string) => parsePositiveInteger(value, 0) || undefined;
  const positiveNumber = (value: string) => parsePositiveNumber(value, 0) || undefined;
  const mode = override("TRIGGER_MODE", (value) => {
    const parsed = value.trim().toLowerCase();
    return isHotCpuTriggerMode(parsed) ? parsed : undefined;
  });
  const intervalOverride = override("INTERVAL_MS", positiveInt);
  const highThreshold = override("THRESHOLD_PERCENT", positiveNumber);
  const slowThreshold = override("SLOWBURN_THRESHOLD_PERCENT", positiveNumber);
  const countOverride = override("CONSECUTIVE_SAMPLES", positiveInt);
  const profileDurationMs = override("DURATION_MS", positiveInt) ?? DEFAULT_PROFILE_DURATION_MS;

  // A scripted mode opts into the original single-rule CLI defaults.
  const selected = mode === undefined ? settings : readHotCpuRules(undefined, mode, settings.slowburn.thresholdPercent);
  const intervalMs = intervalOverride ?? (mode === undefined ? hotCpuRuleIntervalMs(selected) : DEFAULT_INTERVAL_MS);
  const enabled: HotCpuTriggerMode[] = [];
  if (selected.high.enabled) enabled.push(selected.high.mode);
  if (selected.slowburn.enabled) enabled.push("slowburn");
  const thresholdPercent = highThreshold ?? selected[selected.high.mode].thresholdPercent;
  const slowburnThresholdPercent = slowThreshold === undefined
    ? selected.slowburn.thresholdPercent : clampPercent(slowThreshold);
  const rules = enabled.flatMap((id): HotCpuEffectiveRule[] => {
    const threshold = id === "slowburn" ? slowburnThresholdPercent : thresholdPercent;
    const requestedMs = selected[id].durationMs;
    const legacyTiming = mode !== undefined || (legacySettings && intervalOverride !== undefined);
    const overrideCount = id === "spike" ? (legacyTiming ? 1 : undefined)
      : countOverride ?? (legacyTiming ? DEFAULT_CONSECUTIVE_SAMPLES : undefined);
    const sampleCount = overrideCount ?? requestedMs / intervalMs;
    if (id === "spike" ? sampleCount !== 1 : !Number.isInteger(sampleCount) || sampleCount < 1 ||
      (overrideCount === undefined && sampleCount < 2)) return [];
    const durationMs = overrideCount === undefined ? requestedMs : intervalMs * sampleCount;
    return [{ id, thresholdPercent: threshold, durationMs, sampleCount }];
  });
  return {
    intervalMs, rules, overrides, profileDurationMs, thresholdPercent, slowburnThresholdPercent,
    triggerMode: rules[0]?.id ?? legacyHotCpuMode(selected),
    consecutiveSamples: rules[0]?.sampleCount ?? countOverride ?? DEFAULT_CONSECUTIVE_SAMPLES
  };
}

export function resolveHotCpuProfileConfig(options: {
  enabled?: boolean;
  outputRoot: string;
  startDelayMs?: number;
  triggerMode?: HotCpuTriggerMode;
  rules?: HotCpuCaptureRules;
  legacySettings?: boolean;
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
    ...resolveHotCpuRules(
      options.rules ?? readHotCpuRules(undefined, options.triggerMode), env,
      options.legacySettings ?? options.rules === undefined
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
