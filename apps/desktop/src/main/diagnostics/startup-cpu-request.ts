import type { AppSettings } from "../settings/settings-service";

type SettingsStore = {
  get: () => AppSettings;
  update: (patch: Partial<AppSettings>) => unknown;
};

/**
 * Settings arms startup profiling for ONE launch. The launch that sees the
 * request takes it: the stored flag is cleared before profiling begins, so the
 * next launch is not profiled unless someone arms it again. Clearing first
 * also means a launch that crashes mid-capture cannot repeat itself.
 *
 * `PWRGIT_STARTUP_CPU_PROFILING` is separate and unchanged: scripts that set
 * it profile every launch that carries it, without touching this setting.
 */
export function takeStartupCpuProfileRequest(settings: SettingsStore): boolean {
  const diagnostics = settings.get().diagnostics;
  if (diagnostics?.startupCpuProfilingEnabled !== true) return false;
  settings.update({ diagnostics: { ...diagnostics, startupCpuProfilingEnabled: false } });
  return true;
}
