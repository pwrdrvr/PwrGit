import { SettingsField, SettingsSection } from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

export function ResourceUsageSection(props: {
  enabled: boolean;
  saving: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <SettingsSection
      sectionId="resource-usage"
      eyebrow="CPU and energy"
      title="Resource Usage Recording"
      description="Record a rolling day of CPU and Git workload samples to investigate energy use. Starts and stops live. Off by default."
      chip={props.enabled ? "Recording" : "Off"}
      chipKind={props.enabled ? "ok" : "default"}
    >
      <div className="settings-fields">
        <SettingsField
          label="Record resource usage"
          sub="One sample per minute, retained for 24 hours in the diagnostics folder's resources subfolder."
          help="Saved locally; nothing is uploaded. Records process CPU and Git workload counts without repository paths, command arguments or output. Turn off after collecting a representative session."
          control={
            <SettingsSwitch
              checked={props.enabled}
              disabled={props.saving}
              label="Record resource usage"
              onChange={props.onChange}
            />
          }
        />
      </div>
    </SettingsSection>
  );
}
