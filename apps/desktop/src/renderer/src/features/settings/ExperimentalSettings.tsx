import type { AppSettingsSnapshot } from "@pwrgit/shared";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection
} from "./SettingsLayout";
import { SettingsSwitch } from "./SettingsSwitch";

/** Experimental features pane (PwrAgnt's ExperimentalSettings pattern). */
export function ExperimentalSettings(props: {
  saving: boolean;
  snapshot: AppSettingsSnapshot;
  onLineageAllBranchesChange: (enabled: boolean) => void;
}) {
  const lineageAllBranches = props.snapshot.experimental.lineageAllBranches;

  return (
    <div className="settings-stack" aria-label="Experimental settings">
      <SettingsPanelHead
        eyebrow="Experimental"
        title="Experimental features"
        help="Features that may change shape or be removed without notice."
      />

      <SettingsSection
        eyebrow="Experimental"
        title="Lineage Graph Scope"
        description="Open the lineage graph showing every branch instead of only the active ones. The in-graph scope toggle still works either way."
        chip={lineageAllBranches ? "On" : "Off"}
        chipKind={lineageAllBranches ? "ok" : "default"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Default to all branches"
            sub="New graph views start in the All branches scope."
            help="Applies to newly opened worktree views; the toggle in the graph header overrides per view."
            control={
              <SettingsSwitch
                checked={lineageAllBranches}
                disabled={props.saving}
                label="Default to all branches"
                onChange={props.onLineageAllBranchesChange}
              />
            }
          />
        </div>
      </SettingsSection>
    </div>
  );
}
