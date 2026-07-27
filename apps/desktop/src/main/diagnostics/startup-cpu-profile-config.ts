// Ported from PwrAgnt (diagnostics/startup-cpu-profile-config.ts). Enabled by
// the Settings toggle (profiles every launch while on) or PWRGIT_STARTUP_CPU_PROFILING.
import path from "node:path";

const DEFAULT_POST_LOAD_DURATION_MS = 5_000;
const DEFAULT_HARD_TIMEOUT_MS = 15_000;

export type StartupCpuProfileConfig =
  | { enabled: false }
  | {
      enabled: true;
      outputRoot: string;
      postLoadDurationMs: number;
      hardTimeoutMs: number;
      quitOnComplete: boolean;
      captureHeapSnapshots: boolean;
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

export function resolveStartupCpuProfileConfig(options: {
  enabled?: boolean;
  outputRoot: string;
  env?: NodeJS.ProcessEnv;
}): StartupCpuProfileConfig {
  const env = options.env ?? process.env;
  if (
    options.enabled !== true &&
    !isEnabled(env["PWRGIT_STARTUP_CPU_PROFILING"])
  ) {
    return { enabled: false };
  }

  return {
    enabled: true,
    outputRoot: path.resolve(
      env["PWRGIT_STARTUP_CPU_PROFILING_DIR"] ?? options.outputRoot
    ),
    postLoadDurationMs: parsePositiveInteger(
      env["PWRGIT_STARTUP_CPU_PROFILING_POST_LOAD_MS"],
      DEFAULT_POST_LOAD_DURATION_MS
    ),
    hardTimeoutMs: parsePositiveInteger(
      env["PWRGIT_STARTUP_CPU_PROFILING_HARD_TIMEOUT_MS"],
      DEFAULT_HARD_TIMEOUT_MS
    ),
    quitOnComplete: isEnabled(
      env["PWRGIT_STARTUP_CPU_PROFILING_QUIT_ON_COMPLETE"]
    ),
    captureHeapSnapshots: isEnabled(
      env["PWRGIT_STARTUP_CPU_PROFILING_HEAP_SNAPSHOTS"]
    )
  };
}
