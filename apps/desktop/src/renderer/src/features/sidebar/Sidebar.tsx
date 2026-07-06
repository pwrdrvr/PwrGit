import { useProfiles } from "../../state/useProfiles";
import { ProfileChip } from "./ProfileChip";

/**
 * Left pane. U5 wires the profile chip/menu; U6-U7 add repo search, lens
 * filters, and the expandable repo→worktree list below.
 */
export function Sidebar() {
  const { profiles, activeProfile, switchProfile } = useProfiles();

  return (
    <aside className="pane pane--sidebar" data-testid="sidebar">
      <div className="sidebar__profile">
        <ProfileChip
          profiles={profiles}
          activeProfile={activeProfile}
          onSwitch={switchProfile}
        />
      </div>
      <div className="pane__placeholder">Repos · lenses · ⌘K (U6-U7)</div>
    </aside>
  );
}
