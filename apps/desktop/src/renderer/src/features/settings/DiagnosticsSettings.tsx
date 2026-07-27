import type {
  AppSettingsSnapshot,
  HotCpuStartDelayMs,
  HotCpuTriggerMode
} from "@pwrgit/shared";
import { HEAP_MONITOR_TUNING, HOT_CPU_TUNING } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSegmented
} from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

const START_DELAY_OPTIONS: Array<{
  value: HotCpuStartDelayMs;
  label: string;
  meta: string;
}> = [
  { value: 0, label: "Immediate", meta: "sample right away" },
  { value: 5_000, label: "5s", meta: "time to stage a repro" },
  { value: 10_000, label: "10s", meta: "longer setup window" }
];

const TRIGGER_MODE_OPTIONS: Array<{
  value: HotCpuTriggerMode;
  label: string;
  meta: string;
}> = [
  { value: "spike", label: "Spike", meta: "one hot sample" },
  { value: "sustained", label: "Sustained", meta: "consecutive hot samples" },
  { value: "slowburn", label: "Slow burn", meta: "low threshold, long tail" }
];

const HEAP_SNAPSHOT_LIMIT_OPTIONS: Array<{
  value: number;
  label: string;
  meta: string;
}> = [
  { value: 1, label: "1", meta: "start only" },
  { value: 2, label: "2", meta: "start + stop" },
  { value: 3, label: "3", meta: "start + mid + stop" }
];

/**
 * Memory / CPU profiling pane — the settings face of the diagnostics port
 * from PwrAgnt (heap monitor, hot renderer CPU profiler, startup profiler).
 * Sessions land in `diagnosticsOutputRoot`; heap monitor and hot-CPU changes
 * apply live, the startup profiler applies on the next launch.
 */
export function DiagnosticsSettings(props: {
  saving: boolean;
  snapshot: AppSettingsSnapshot;
  onHeapMonitorEnabledChange: (enabled: boolean) => void;
  onHotCpuEnabledChange: (enabled: boolean) => void;
  onHotCpuStartDelayChange: (delayMs: HotCpuStartDelayMs) => void;
  onHotCpuTriggerModeChange: (mode: HotCpuTriggerMode) => void;
  onHotCpuCaptureHeapSnapshotChange: (enabled: boolean) => void;
  onHotCpuHeapSnapshotLimitChange: (limit: number) => void;
  onStartupCpuEnabledChange: (enabled: boolean) => void;
}) {
  const diag = props.snapshot.diagnostics;
  const env = props.snapshot.diagnosticsEnv;
  // Env vars (PWRGIT_*) can force a monitor on regardless of the switch —
  // chips say so instead of showing a misleading "Off".
  const heapOn = diag.heapMonitorEnabled || env.heapMonitorForcedOn;
  const hotCpuOn = diag.hotCpuProfilingEnabled || env.hotCpuProfilingForcedOn;
  const startupOn =
    diag.startupCpuProfilingEnabled || env.startupCpuProfilingForcedOn;
  const bothCapturePathsOn = heapOn && hotCpuOn;

  const heapIntervalSeconds = HEAP_MONITOR_TUNING.intervalMs / 1_000;
  const heapDeltaMb = HEAP_MONITOR_TUNING.deltaThresholdBytes / (1024 * 1024);
  const hotIntervalSeconds = HOT_CPU_TUNING.intervalMs / 1_000;
  const hotDurationSeconds = HOT_CPU_TUNING.profileDurationMs / 1_000;

  return (
    <div className="settings-stack" aria-label="Memory and CPU profiling settings">
      <SettingsPanelHead
        eyebrow="Diagnostics"
        title="Memory / CPU profiling"
        help={
          <>
            Capture heap snapshots and CPU profiles for slow or leaky sessions.
            Artifacts are written to{" "}
            <button
              className="settings-pathlink"
              type="button"
              title="Reveal in file manager"
              onClick={() => {
                void dispatch("shell:revealPath", {
                  path: props.snapshot.diagnosticsOutputRoot
                });
              }}
            >
              {props.snapshot.diagnosticsOutputRoot}
            </button>{" "}
            and open in Chrome DevTools.
          </>
        }
      />

      <SettingsSection
        eyebrow="Memory"
        title="Heap Monitor"
        description="Sample the main process and every window's heap on an interval; automatically capture a heap snapshot when usage jumps by more than the growth threshold. Starts and stops live."
        chip={
          env.heapMonitorForcedOn ? "On (env)" : heapOn ? "On" : "Off"
        }
        chipKind={env.heapMonitorForcedOn ? "warn" : heapOn ? "ok" : "default"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Enable heap monitoring"
            sub={`Samples every ${heapIntervalSeconds}s; snapshots on a ${heapDeltaMb} MB jump, max ${HEAP_MONITOR_TUNING.maxSnapshots} per session.`}
            help={
              env.heapMonitorForcedOn
                ? "Forced on by PWRGIT_HEAP_DIAGNOSTICS in this app's environment — the switch only controls the setting, not the running monitor."
                : "Sampling is cheap; snapshots briefly pause the process being captured. Leave off unless chasing a leak."
            }
            control={
              <SettingsSwitch
                checked={diag.heapMonitorEnabled}
                disabled={props.saving}
                label="Enable heap monitoring"
                onChange={props.onHeapMonitorEnabledChange}
              />
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="CPU"
        title="Hot Renderer CPU Profiling"
        description={`Watch each window's CPU usage; when it stays above the trigger threshold, capture a ${hotDurationSeconds}-second CPU profile of that renderer. Arms and disarms live.`}
        chip={
          env.hotCpuProfilingForcedOn
            ? "Armed (env)"
            : hotCpuOn
              ? "Armed"
              : "Off"
        }
        chipKind={
          env.hotCpuProfilingForcedOn ? "warn" : hotCpuOn ? "ok" : "default"
        }
      >
        {bothCapturePathsOn ? (
          <p className="settings-callout settings-callout--warn" role="status">
            Heap monitoring keeps each window's debugger attached, so hot-CPU
            captures are skipped while both are on. Turn the heap monitor off
            to let profiles trigger.
          </p>
        ) : null}
        <div className="settings-fields">
          <SettingsField
            label="Arm hot CPU capture"
            sub={`Monitoring samples CPU every ${hotIntervalSeconds}s; profiles trigger at ${HOT_CPU_TUNING.thresholdPercent}% (${HOT_CPU_TUNING.slowburnThresholdPercent}% for slow burn).`}
            help={
              env.hotCpuProfilingForcedOn
                ? "Forced on by PWRGIT_HOT_CPU_PROFILING in this app's environment — the switch only controls the setting, not the running profiler."
                : undefined
            }
            control={
              <SettingsSwitch
                checked={diag.hotCpuProfilingEnabled}
                disabled={props.saving}
                label="Arm hot CPU capture"
                onChange={props.onHotCpuEnabledChange}
              />
            }
          />
          <SettingsField
            label="Start delay"
            sub="Wait before sampling starts so you can stage the scenario."
            control={
              <SettingsSegmented
                aria-label="Profiling start delay"
                disabled={props.saving}
                options={START_DELAY_OPTIONS}
                value={diag.hotCpuProfilingStartDelayMs}
                onChange={props.onHotCpuStartDelayChange}
              />
            }
          />
          <SettingsField
            label="Trigger mode"
            sub="How aggressively a hot reading starts a profile."
            help="Spike fires on a single hot sample. Sustained needs consecutive hot samples. Slow burn lowers the threshold to catch steady background churn."
            control={
              <SettingsSegmented
                aria-label="Trigger mode"
                disabled={props.saving}
                options={TRIGGER_MODE_OPTIONS}
                value={diag.hotCpuProfilingTriggerMode}
                onChange={props.onHotCpuTriggerModeChange}
              />
            }
          />
          <SettingsField
            label="Heap snapshots during profiles"
            sub="Bracket each CPU profile with renderer heap snapshots."
            help="Turns itself off when a session reaches the snapshot limit — snapshots are large."
            control={
              <SettingsSwitch
                checked={diag.hotCpuProfilingCaptureHeapSnapshot}
                disabled={props.saving || !diag.hotCpuProfilingEnabled}
                label="Heap snapshots during profiles"
                onChange={props.onHotCpuCaptureHeapSnapshotChange}
              />
            }
          />
          <SettingsField
            label="Snapshot limit"
            sub="Heap snapshots kept per capture session."
            control={
              <SettingsSegmented
                aria-label="Heap snapshot limit"
                disabled={
                  props.saving ||
                  !diag.hotCpuProfilingEnabled ||
                  !diag.hotCpuProfilingCaptureHeapSnapshot
                }
                options={HEAP_SNAPSHOT_LIMIT_OPTIONS}
                value={diag.hotCpuProfilingHeapSnapshotLimit}
                onChange={props.onHotCpuHeapSnapshotLimitChange}
              />
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection
        eyebrow="CPU"
        title="Startup CPU Profiling"
        description="Profile the main process and the first window from launch until shortly after first paint. Applies on the next launch and stays on for every launch until turned off."
        chip={
          env.startupCpuProfilingForcedOn
            ? "On (env)"
            : startupOn
              ? "Next launch"
              : "Off"
        }
        chipKind={startupOn ? "warn" : "default"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Profile startup"
            sub="Writes main.cpuprofile and renderer.cpuprofile per launch."
            help={
              env.startupCpuProfilingForcedOn
                ? "Forced on by PWRGIT_STARTUP_CPU_PROFILING in this app's environment — the switch only controls the setting."
                : "Remember to turn this back off — every launch writes a new session directory while it's on."
            }
            control={
              <SettingsSwitch
                checked={diag.startupCpuProfilingEnabled}
                disabled={props.saving}
                label="Profile startup"
                onChange={props.onStartupCpuEnabledChange}
              />
            }
          />
        </div>
      </SettingsSection>
    </div>
  );
}
