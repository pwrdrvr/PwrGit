import {
  DIAGNOSTICS_DEFAULTS,
  EXPERIMENTAL_DEFAULTS,
  GENERAL_DEFAULTS,
  HOT_CPU_HEAP_SNAPSHOT_LIMIT_MAX,
  isHotCpuStartDelayMs,
  isHotCpuTriggerMode,
  ok,
  type AppSettingsPatch,
  type AppSettingsSnapshot,
  type DiagnosticsSettings,
  type ExperimentalSettings,
  type GeneralSettings
} from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { SettingsService } from "./settings-service";

/** Stored settings are sparse; snapshots are fully defaulted. */
export function settingsSnapshot(
  settings: SettingsService,
  diagnosticsOutputRoot: string
): AppSettingsSnapshot {
  const stored = settings.get();
  return {
    general: { ...GENERAL_DEFAULTS, ...stored.general },
    experimental: { ...EXPERIMENTAL_DEFAULTS, ...stored.experimental },
    diagnostics: { ...DIAGNOSTICS_DEFAULTS, ...stored.diagnostics },
    diagnosticsOutputRoot
  };
}

/** Keep only known keys with in-range values — the patch crosses IPC. */
function sanitizePatch(patch: AppSettingsPatch): {
  general: Partial<GeneralSettings>;
  experimental: Partial<ExperimentalSettings>;
  diagnostics: Partial<DiagnosticsSettings>;
} {
  const general: Partial<GeneralSettings> = {};
  const experimental: Partial<ExperimentalSettings> = {};
  const diagnostics: Partial<DiagnosticsSettings> = {};

  const gen = patch.general;
  if (gen !== undefined && typeof gen.developerMode === "boolean") {
    general.developerMode = gen.developerMode;
  }

  const exp = patch.experimental;
  if (exp !== undefined && typeof exp.lineageAllBranches === "boolean") {
    experimental.lineageAllBranches = exp.lineageAllBranches;
  }

  const diag = patch.diagnostics;
  if (diag !== undefined) {
    if (typeof diag.heapMonitorEnabled === "boolean") {
      diagnostics.heapMonitorEnabled = diag.heapMonitorEnabled;
    }
    if (typeof diag.hotCpuProfilingEnabled === "boolean") {
      diagnostics.hotCpuProfilingEnabled = diag.hotCpuProfilingEnabled;
    }
    if (
      typeof diag.hotCpuProfilingStartDelayMs === "number" &&
      isHotCpuStartDelayMs(diag.hotCpuProfilingStartDelayMs)
    ) {
      diagnostics.hotCpuProfilingStartDelayMs = diag.hotCpuProfilingStartDelayMs;
    }
    if (
      typeof diag.hotCpuProfilingTriggerMode === "string" &&
      isHotCpuTriggerMode(diag.hotCpuProfilingTriggerMode)
    ) {
      diagnostics.hotCpuProfilingTriggerMode = diag.hotCpuProfilingTriggerMode;
    }
    if (typeof diag.hotCpuProfilingCaptureHeapSnapshot === "boolean") {
      diagnostics.hotCpuProfilingCaptureHeapSnapshot =
        diag.hotCpuProfilingCaptureHeapSnapshot;
    }
    if (typeof diag.hotCpuProfilingHeapSnapshotLimit === "number") {
      diagnostics.hotCpuProfilingHeapSnapshotLimit = Math.min(
        Math.max(Math.round(diag.hotCpuProfilingHeapSnapshotLimit), 1),
        HOT_CPU_HEAP_SNAPSHOT_LIMIT_MAX
      );
    }
    if (typeof diag.startupCpuProfilingEnabled === "boolean") {
      diagnostics.startupCpuProfilingEnabled = diag.startupCpuProfilingEnabled;
    }
  }

  return { general, experimental, diagnostics };
}

export function registerSettingsHandlers(
  bus: CommandBus,
  settings: SettingsService,
  options: {
    diagnosticsOutputRoot: string;
    /** Fired after a successful write with the fresh snapshot — index.ts
     *  broadcasts settings:changed and re-syncs diagnostics from it. */
    onChanged: (snapshot: AppSettingsSnapshot) => void;
  }
): void {
  bus.register("settings:read", () =>
    ok(settingsSnapshot(settings, options.diagnosticsOutputRoot))
  );

  bus.register("settings:update", (req) => {
    const sanitized = sanitizePatch(req.patch);
    const stored = settings.get();
    settings.update({
      general: { ...stored.general, ...sanitized.general },
      experimental: { ...stored.experimental, ...sanitized.experimental },
      diagnostics: { ...stored.diagnostics, ...sanitized.diagnostics }
    });
    const snapshot = settingsSnapshot(settings, options.diagnosticsOutputRoot);
    options.onChanged(snapshot);
    return ok(snapshot);
  });
}
