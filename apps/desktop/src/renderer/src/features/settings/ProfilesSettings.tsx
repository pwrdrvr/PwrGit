import { useState } from "react";
import type { Profile } from "@pwrgit/shared";
import { ProfileModal } from "../sidebar/ProfileModal";
import { ReadError } from "../shell/ReadError";
import { useProfiles } from "../../state/useProfiles";
import { SettingsPanelHead, SettingsSection } from "./SettingsLayout";

/**
 * Profiles pane (PwrAgnt's ProfilesSettings pattern, on PwrGit's profile
 * model): list every profile with its theme, identity + scan roots, open a
 * profile's window, and create/edit through the existing ProfileModal (which
 * owns the roots editor). Deletion is exact-name guarded and removes only
 * PwrGit-owned profile/index state; repository and worktree directories stay
 * on disk.
 */
export function ProfilesSettings() {
  const profiles = useProfiles();
  const [modal, setModal] = useState<
    { mode: "create" } | { mode: "edit"; profile: Profile } | null
  >(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);

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
            disabled={profiles.loadState.status !== "ready"}
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
        chip={
          profiles.loadState.status === "loading"
            ? "Loading"
            : profiles.loadState.status === "error"
              ? "Unavailable"
              : `${profiles.profiles.length} profile${profiles.profiles.length === 1 ? "" : "s"}`
        }
      >
        {profiles.loadState.status === "loading" ? (
          <p className="settings-empty" role="status">
            Loading profiles…
          </p>
        ) : profiles.loadState.status === "error" ? (
          <ReadError
            title="Profiles couldn’t be loaded"
            message={profiles.loadState.message}
            onRetry={() => void profiles.retry()}
          />
        ) : profiles.profiles.length === 0 ? (
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
                onDelete={() => setDeleting(profile)}
                canDelete={profiles.profiles.length > 1}
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

      {deleting !== null && (
        <DeleteProfileDialog
          profile={deleting}
          onDelete={profiles.deleteProfile}
          onClose={() => setDeleting(null)}
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
  onDelete: () => void;
  canDelete: boolean;
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
        <button
          className="settings-button settings-button--danger"
          type="button"
          disabled={!props.canDelete}
          title={
            props.canDelete
              ? `Delete ${profile.name}`
              : "PwrGit must keep at least one profile"
          }
          onClick={props.onDelete}
        >
          Delete…
        </button>
      </div>
    </div>
  );
}

function DeleteProfileDialog(props: {
  profile: Profile;
  onDelete: (req: {
    profileId: string;
    expectedName: string;
  }) => Promise<string | null>;
  onClose: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = `delete-profile-${props.profile.id}-title`;
  const matches = confirmation === props.profile.name;

  const remove = async (): Promise<void> => {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    const message = await props.onDelete({
      profileId: props.profile.id,
      expectedName: confirmation
    });
    setBusy(false);
    if (message === null) props.onClose();
    else setError(message);
  };

  return (
    <div
      className="overlay-backdrop"
      onClick={() => {
        if (!busy) props.onClose();
      }}
    >
      <div
        className="modal modal--delete-profile"
        role="alertdialog"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) props.onClose();
        }}
      >
        <div className="modal__title" id={titleId}>
          Delete “{props.profile.name}”?
        </div>
        <p className="delete-profile__copy">
          This removes the profile’s commit identity, repo-folder list, indexed
          records for repositories, worktrees and branches, clone history, and
          profile-scoped selections from PwrGit. Any window showing this profile
          will close.
        </p>
        <p className="delete-profile__kept">
          Not deleted: repository folders, Git repositories, worktrees,
          branches, commits, or files on disk.
        </p>
        <label className="field delete-profile__confirm">
          <span className="field__label">
            Type {props.profile.name} to confirm
          </span>
          <input
            className="modal__input"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
        {error !== null ? (
          <div className="modal__error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="modal__actions">
          <button
            className="modal__cancel"
            type="button"
            disabled={busy}
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            className="modal__create modal__create--danger"
            type="button"
            disabled={busy || !matches}
            onClick={() => void remove()}
          >
            {busy ? "Deleting…" : "Delete profile"}
          </button>
        </div>
      </div>
    </div>
  );
}
