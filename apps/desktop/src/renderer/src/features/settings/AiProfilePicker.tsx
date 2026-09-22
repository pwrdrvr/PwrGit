import type { Profile, ProfileId } from "@pwrgit/shared";

/**
 * Which profile the AI panes are editing.
 *
 * The Settings window is one window for every profile, and AI settings are
 * per profile — a work profile and a personal one usually sign in to
 * different Codex accounts — so the panes say whose settings they show, in
 * the pane head where the reader looks first. A picker rather than a caption,
 * because the other profiles' settings are one choice away, not a trip to a
 * different window.
 */
export function AiProfilePicker(props: {
  profiles: readonly Profile[];
  value: ProfileId | null;
  onChange: (profileId: ProfileId) => void;
}) {
  if (props.profiles.length === 0 || props.value === null) return null;
  return (
    <label className="settings-inline-field">
      <span className="settings-inline-field__label">Profile</span>
      <select
        aria-label="Profile these AI settings belong to"
        className="settings-select"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export type AiProfileSelection = {
  profiles: readonly Profile[];
  value: ProfileId | null;
  onChange: (profileId: ProfileId) => void;
};
