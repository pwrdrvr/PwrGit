import {
  DIAGNOSTICS_DEFAULTS,
  EXPERIMENTAL_DEFAULTS,
  GENERAL_DEFAULTS,
  HOT_CPU_HEAP_SNAPSHOT_LIMIT_MAX,
  isAppearanceTheme,
  isHotCpuStartDelayMs,
  isHotCpuTriggerMode,
  isSidebarDensity,
  isSidebarTextSize,
  isUpdateChannel,
  isUpdateTrain,
  ok,
  resolveUpdateSelection,
  type AppSettingsPatch,
  type AppSettingsSnapshot,
  type DiagnosticsSettings,
  type ExperimentalSettings,
  type GeneralSettings,
  type UpdatesSettings
} from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import type { SettingsService } from "./settings-service";
import { resolveHeapMonitorConfig } from "../diagnostics/heap-monitor-config";
import { resolveHotCpuProfileConfig } from "../diagnostics/hot-cpu-profile-config";
import { resolveStartupCpuProfileConfig } from "../diagnostics/startup-cpu-profile-config";

/** Stored settings are sparse; snapshots are fully defaulted. */
export function settingsSnapshot(
  settings: SettingsService,
  diagnosticsOutputRoot: string,
  appVersion = ""
): AppSettingsSnapshot {
  const stored = settings.get();
  // A resolver called with the setting off can only come back enabled when a
  // PWRGIT_* env var forces it — surfaced so the UI never shows "Off" while
  // an env-armed monitor is running.
  const off = { enabled: false, outputRoot: diagnosticsOutputRoot };
  return {
    general: {
      ...GENERAL_DEFAULTS,
      ...stored.general,
      theme: isAppearanceTheme(stored.general?.theme)
        ? stored.general.theme
        : GENERAL_DEFAULTS.theme
    },
    experimental: { ...EXPERIMENTAL_DEFAULTS, ...stored.experimental },
    diagnostics: { ...DIAGNOSTICS_DEFAULTS, ...stored.diagnostics },
    updates: resolveUpdateSelection(stored.updates, appVersion),
    diagnosticsEnv: {
      heapMonitorForcedOn: resolveHeapMonitorConfig(off).enabled,
      hotCpuProfilingForcedOn: resolveHotCpuProfileConfig(off).enabled,
      startupCpuProfilingForcedOn: resolveStartupCpuProfileConfig(off).enabled
    },
    diagnosticsOutputRoot
  };
}

/** Keep only known keys with in-range values — the patch crosses IPC. */
function sanitizePatch(patch: AppSettingsPatch): {
  general: Partial<GeneralSettings>;
  experimental: Partial<ExperimentalSettings>;
  diagnostics: Partial<DiagnosticsSettings>;
  updates: Partial<UpdatesSettings>;
} {
  const general: Partial<GeneralSettings> = {};
  const experimental: Partial<ExperimentalSettings> = {};
  const diagnostics: Partial<DiagnosticsSettings> = {};
  const updates: Partial<UpdatesSettings> = {};

  const gen = patch.general;
  if (gen !== undefined) {
    if (isAppearanceTheme(gen.theme)) {
      general.theme = gen.theme;
    }
    if (typeof gen.developerMode === "boolean") {
      general.developerMode = gen.developerMode;
    }
    // Narrow to the known notches: these cross IPC as plain strings and end up
    // stamped on <html>, so an unvalidated value would ship an attribute no
    // stylesheet answers to.
    if (isSidebarTextSize(gen.sidebarTextSize)) {
      general.sidebarTextSize = gen.sidebarTextSize;
    }
    if (isSidebarDensity(gen.sidebarDensity)) {
      general.sidebarDensity = gen.sidebarDensity;
    }
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

  const upd = patch.updates;
  if (upd !== undefined) {
    if (isUpdateChannel(upd.channel)) {
      updates.channel = upd.channel;
    }
    if (isUpdateTrain(upd.train)) {
      updates.train = upd.train;
    }
  }

  return { general, experimental, diagnostics, updates };
}

export function registerSettingsHandlers(
  bus: CommandBus,
  settings: SettingsService,
  options: {
    diagnosticsOutputRoot: string;
    /** Installed app version — used to seed train/track when both keys are absent. */
    appVersion?: string;
    /** Fired after a successful write with the fresh snapshot — index.ts
     *  broadcasts settings:changed and re-syncs diagnostics from it. */
    onChanged: (snapshot: AppSettingsSnapshot) => void;
  }
): void {
  const appVersion = options.appVersion ?? "";
  bus.register("settings:read", () =>
    ok(settingsSnapshot(settings, options.diagnosticsOutputRoot, appVersion))
  );

  bus.register("settings:update", (req) => {
    const sanitized = sanitizePatch(req.patch);
    const stored = settings.get();
    const next: {
      general: Partial<GeneralSettings>;
      experimental: Partial<ExperimentalSettings>;
      diagnostics: Partial<DiagnosticsSettings>;
      updates?: UpdatesSettings;
    } = {
      general: { ...stored.general, ...sanitized.general },
      experimental: { ...stored.experimental, ...sanitized.experimental },
      diagnostics: { ...stored.diagnostics, ...sanitized.diagnostics }
    };
    // Persist both keys whenever the user touches Updates, including
    // stable/latest, so a Beta binary does not re-infer after they pick Stable.
    if (req.patch.updates !== undefined) {
      const current = resolveUpdateSelection(stored.updates, appVersion);
      next.updates = {
        channel: sanitized.updates.channel ?? current.channel,
        train: sanitized.updates.train ?? current.train
      };
    }
    settings.update(next);
    const snapshot = settingsSnapshot(
      settings,
      options.diagnosticsOutputRoot,
      appVersion
    );
    options.onChanged(snapshot);
    return ok(snapshot);
  });
}
