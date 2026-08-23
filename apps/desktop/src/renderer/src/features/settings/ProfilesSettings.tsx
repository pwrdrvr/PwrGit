import { useState } from "react";
import type { Profile } from "@pwrgit/shared";
import { ProfileModal } from "../sidebar/ProfileModal";
import { useProfiles } from "../../state/useProfiles";
import { SettingsPanelHead, SettingsSection } from "./SettingsLayout";

/**
 * Profiles pane (PwrAgnt's ProfilesSettings pattern, on PwrGit's profile
 * model): list every profile with its theme, identity + scan roots, open a
 * profile's window, and create/edit through the existing ProfileModal (which
 * owns the roots editor). PwrGit has no profile delete command, so no delete.
 */
export function ProfilesSettings() {
  const profiles = useProfiles();
  const [modal, setModal] = useState<
    { mode: "create" } | { mode: "edit"; profile: Profile } | null
  >(null);

  return (
    <div className="settings-stack" aria-label="Profile settings">
      <SettingsPanelHead
        eyebrow="Profiles"
        title="PwrGit profiles"
        help="Profiles are workspaces: each has its own window theme, commit identity, and repo folders. Picking one from the Profiles menu opens its window."
        action={
          <button
            className="settings-button settings-button--primary"
            type="button"
            onClick={() => setModal({ mode: "create" })}
          >
            Add profile
          </button>
        }
      />

      <SettingsSection
        eyebrow="Profiles"
        title="Profile list"
        description="The active profile is the one most recently used; each profile opens in its own window."
        chip={`${profiles.profiles.length} profile${profiles.profiles.length === 1 ? "" : "s"}`}
      >
        {profiles.profiles.length === 0 ? (
          <p className="settings-empty">No profiles yet.</p>
        ) : (
          <div className="settings-profile-list">
            {profiles.profiles.map((profile) => (
              <ProfileRow
                key={profile.id}
                active={profile.id === profiles.activeProfileId}
                profile={profile}
                onEdit={() => setModal({ mode: "edit", profile })}
                onOpen={() => void profiles.openProfile(profile.id)}
              />
            ))}
          </div>
        )}
      </SettingsSection>

      {modal !== null && (
        <ProfileModal
          mode={modal.mode}
          profile={modal.mode === "edit" ? modal.profile : undefined}
          onCreate={profiles.createProfile}
          onUpdate={profiles.updateProfile}
          onSetRoots={profiles.setRoots}
          pickDirectories={profiles.pickDirectories}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function ProfileRow(props: {
  active: boolean;
  profile: Profile;
  onEdit: () => void;
  onOpen: () => void;
}) {
  const profile = props.profile;
  const identity =
    profile.email !== "" ? profile.email : "no commit email set";
  const rootsSummary =
    profile.roots.length === 0
      ? "No repo folders"
      : profile.roots.length === 1
        ? profile.roots[0]
        : `${profile.roots[0]} +${profile.roots.length - 1} more`;

  return (
    <div
      className={`settings-profile-row${props.active ? " is-active" : ""}`}
    >
      <span className="settings-profile-row__mono" aria-hidden="true">
        {profile.mono !== "" ? profile.mono : profile.name.slice(0, 2)}
      </span>
      <div className="settings-profile-row__body">
        <span className="settings-profile-row__name">
          {profile.name}
          {props.active ? (
            <span className="settings-card__chip settings-card__chip--ok">
              Active
            </span>
          ) : null}
          {profile.theme !== undefined ? (
            <span className="settings-card__chip">
              {profile.theme === "light" ? "Light" : "Dark"}
            </span>
          ) : null}
        </span>
        <span className="settings-profile-row__meta">{identity}</span>
        <span
          className="settings-profile-row__meta"
          title={profile.roots.join("\n")}
        >
          {rootsSummary}
        </span>
      </div>
      <div className="settings-profile-row__actions">
        <button
          className="settings-button"
          type="button"
          onClick={props.onEdit}
        >
          Edit…
        </button>
        <button
          className="settings-button"
          type="button"
          onClick={props.onOpen}
        >
          Open window
        </button>
      </div>
    </div>
  );
}
