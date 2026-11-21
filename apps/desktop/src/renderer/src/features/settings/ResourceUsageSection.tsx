import { RESOURCE_USAGE_RECORDING_MS } from "@pwrgit/shared";
import { SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

const RECORDING_HOURS = RESOURCE_USAGE_RECORDING_MS / 3_600_000;

/** "Sat, Nov 22, 3:42 PM" in the reader's locale and zone. */
function formatStopTime(iso: string): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

export function ResourceUsageSection(props: {
  enabled: boolean;
  /** Main-owned stop time of the current recording; null when off. */
  expiresAt: string | null;
  saving: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const stopsAt = props.enabled && props.expiresAt !== null ? formatStopTime(props.expiresAt) : null;
  return (
    <SettingsSection
      sectionId="resource-usage"
      eyebrow="CPU and energy"
      title="Resource Usage Recording"
      description={`Record ${RECORDING_HOURS} hours of CPU and Git workload samples to investigate energy use. Starts live and turns itself off ${RECORDING_HOURS} hours after it starts, including across restarts. Off by default.`}
      chip={props.enabled ? "Recording" : "Off"}
      chipKind={props.enabled ? "ok" : "default"}
    >
      <div className="settings-fields">
        <SettingsField
          label={`Record resource usage for ${RECORDING_HOURS} hours`}
          sub={
            stopsAt !== null
              ? `Recording one sample per minute. Stops automatically ${stopsAt}.`
              : `One sample per minute for ${RECORDING_HOURS} hours, written to the diagnostics folder's resources subfolder.`
          }
          help={`Saved locally; nothing is uploaded. Records process CPU and Git workload counts without repository paths, command arguments or output. Samples stay on disk after recording stops; files older than ${RECORDING_HOURS} hours are pruned the next time a recording writes. Turning it off early stops it now.`}
          control={
            <SettingsSwitch
              checked={props.enabled}
              disabled={props.saving}
              label={`Record resource usage for ${RECORDING_HOURS} hours`}
              onChange={props.onChange}
            />
          }
        />
      </div>
    </SettingsSection>
  );
}
