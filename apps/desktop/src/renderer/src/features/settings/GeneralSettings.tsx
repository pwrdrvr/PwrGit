import type { AppSettingsSnapshot } from "@pwrgit/shared";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection
} from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

/** General pane (PwrAgnt's GeneralSettings pattern, PwrGit-sized). */
export function GeneralSettings(props: {
  saving: boolean;
  snapshot: AppSettingsSnapshot;
  onDeveloperModeChange: (enabled: boolean) => void;
}) {
  const developerMode = props.snapshot.general.developerMode;

  return (
    <div className="settings-stack" aria-label="General settings">
      <SettingsPanelHead
        eyebrow="General"
        title="General settings"
        help="Defaults that apply across PwrGit windows."
      />

      <SettingsSection
        eyebrow="General"
        title="Developer mode"
        description="Electron development helpers stay hidden unless you opt in."
        chip={developerMode ? "On" : "Off"}
        chipKind={developerMode ? "ok" : "default"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Developer Mode"
            sub="Expose Reload, Force Reload, and Developer Tools in the View menu."
            help="Also enables their shortcuts (⌘R, ⇧⌘R, ⌥⌘I). Takes effect immediately in every window."
            control={
              <SettingsSwitch
                checked={developerMode}
                disabled={props.saving}
                label="Developer Mode"
                onChange={props.onDeveloperModeChange}
              />
            }
          />
        </div>
      </SettingsSection>
    </div>
  );
}
