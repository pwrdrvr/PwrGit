import { useEffect, useState, type KeyboardEvent } from "react";
import type { Profile } from "@pwrgit/shared";
import { ProfileModal } from "../sidebar/ProfileModal";
import { reorder, type DropPosition } from "../sidebar/repo-view";
import { useListReorder } from "../sidebar/useListReorder";
import { shortcutLabel } from "../../lib/platform";
import { SettingsSwitch } from "./SettingsSwitch";
import { ReadError } from "../shell/ReadError";
import { useProfiles } from "../../state/useProfiles";
import {
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack
} from "./SettingsLayout";
import { useModal } from "../../lib/useModal";
import {
  hoverTooltip,
  useViewportTooltip
} from "../../lib/useViewportTooltip";

/** Drag payload type, so a profile drag never lands in another list. */
const PROFILE_MIME = "application/x-pwrgit-profile";

/** How many profiles the Profiles menu gives a ⌘-number shortcut. */
const MENU_SHORTCUT_SLOTS = 9;

/**
 * Profiles pane (PwrAgnt's ProfilesSettings pattern, on PwrGit's profile
 * model): list every profile with its theme, identity + scan roots, open a
 * profile's window, and create/edit through the existing ProfileModal (which
 * owns the roots editor). Deletion is exact-name guarded and removes only
 * PwrGit-owned profile/index state; repository and worktree directories stay
 * on disk.
 *
 * The list's order IS the Profiles menu's order: dragging a row (or moving
 * it with the arrow keys from its grip) changes which profile gets which
 * ⌘1–⌘9 shortcut, and each row shows the shortcut it has right now. A
 * profile switched out of the menu keeps its place here but takes no menu
 * row and no shortcut, so the next shown profile moves up into its number.
 */
export function ProfilesSettings() {
  const profiles = useProfiles();
  const [modal, setModal] = useState<
    { mode: "create" } | { mode: "edit"; profile: Profile } | null
  >(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [savingMenu, setSavingMenu] = useState<string | null>(null);
  // The order the user just asked for, shown until main's profile:changed
  // catches up, so a second move builds on the first instead of on the
  // order from before it.
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);

  const savedIds = profiles.profiles.map((p) => p.id);
  const pendingStillFits =
    pendingOrder !== null &&
    pendingOrder.length === savedIds.length &&
    savedIds.every((id) => pendingOrder.includes(id));
  const ids = pendingStillFits ? pendingOrder : savedIds;
  const byId = new Map(profiles.profiles.map((p) => [p.id, p] as const));
  const ordered = ids.flatMap((id) => byId.get(id) ?? []);

  const savedKey = savedIds.join("\n");
  useEffect(() => {
    // Drop the pending order once main has it, or once profiles were added
    // or removed under it (that save is refused as stale anyway).
    setPendingOrder((pending) =>
      pending === null ||
      pending.join("\n") === savedKey ||
      pending.length !== savedKey.split("\n").length
        ? null
        : pending
    );
  }, [savedKey]);

  const commitOrder = (next: string[]): void => {
    if (next.every((id, i) => id === ids[i])) return;
    setListError(null);
    setPendingOrder(next);
    void profiles.reorderProfiles(next).then((error) => {
      if (error !== null) {
        setPendingOrder(null);
        setListError(error);
      }
    });
  };
  const drag = useListReorder({
    mime: PROFILE_MIME,
    onCommit: (dragId: string, targetId: string, position: DropPosition) =>
      commitOrder(reorder(ids, dragId, targetId, position))
  });
  const moveBy = (id: string, delta: -1 | 1): void => {
    const target = ids[ids.indexOf(id) + delta];
    if (target === undefined) return;
    commitOrder(reorder(ids, id, target, delta < 0 ? "before" : "after"));
  };
  const setShowInMenu = (profile: Profile, showInMenu: boolean): void => {
    setSavingMenu(profile.id);
    setListError(null);
    void profiles
      .updateProfile({ profileId: profile.id, showInMenu })
      .then((error) => {
        setSavingMenu(null);
        if (error !== null) setListError(error);
      });
  };

  // The shortcut each shown profile has today, numbered over the shown ones.
  const shortcutFor = new Map<string, string>();
  ordered
    .filter((p) => p.showInMenu)
    .slice(0, MENU_SHORTCUT_SLOTS)
    .forEach((p, i) => shortcutFor.set(p.id, shortcutLabel({ key: String(i + 1) })));

  return (
    <SettingsSectionStack aria-label="Profile settings" paneId="profiles">
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
        description={`Drag a profile, or use the arrow keys on its grip, to change the order. The Profiles menu lists them in this order, and the first nine it shows get ${shortcutLabel({ key: "1" })} through ${shortcutLabel({ key: "9" })}.`}
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
          <>
            {listError !== null ? (
              <p className="settings-profile-list__error" role="alert">
                {listError}
              </p>
            ) : null}
            <div className="settings-profile-list">
              {ordered.map((profile, index) => (
                <ProfileRow
                  key={profile.id}
                  active={profile.id === profiles.activeProfileId}
                  profile={profile}
                  shortcut={shortcutFor.get(profile.id) ?? null}
                  dragProps={drag.rowProps(profile.id, profiles.profiles.length > 1)}
                  dragging={drag.dragId === profile.id}
                  dropPosition={
                    drag.target?.id === profile.id ? drag.target.position : null
                  }
                  canMoveUp={index > 0}
                  canMoveDown={index < ordered.length - 1}
                  onMove={(delta) => moveBy(profile.id, delta)}
                  savingMenu={savingMenu === profile.id}
                  onShowInMenu={(next) => setShowInMenu(profile, next)}
                  onEdit={() => setModal({ mode: "edit", profile })}
                  onOpen={() => void profiles.openProfile(profile.id)}
                  onDelete={() => setDeleting(profile)}
                  canDelete={profiles.profiles.length > 1}
                />
              ))}
            </div>
          </>
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
    </SettingsSectionStack>
  );
}

function ProfileRow(props: {
  active: boolean;
  profile: Profile;
  /** The menu shortcut this profile has now; null when it has none. */
  shortcut: string | null;
  dragProps: ReturnType<ReturnType<typeof useListReorder>["rowProps"]>;
  dragging: boolean;
  dropPosition: DropPosition | null;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: -1 | 1) => void;
  savingMenu: boolean;
  onShowInMenu: (next: boolean) => void;
  onEdit: () => void;
  onOpen: () => void;
  onDelete: () => void;
  canDelete: boolean;
}) {
  const tip = useViewportTooltip();
  const profile = props.profile;
  const identity =
    profile.email !== "" ? profile.email : "no commit email set";
  const rootsSummary =
    profile.roots.length === 0
      ? "No repo folders"
      : profile.roots.length === 1
        ? profile.roots[0]
        : `${profile.roots[0]} +${profile.roots.length - 1} more`;

  const arrangeable = props.canMoveUp || props.canMoveDown;
  const onGripKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "ArrowUp" && props.canMoveUp) {
      event.preventDefault();
      props.onMove(-1);
    } else if (event.key === "ArrowDown" && props.canMoveDown) {
      event.preventDefault();
      props.onMove(1);
    }
  };

  return (
    <div
      className={[
        "settings-profile-row",
        props.active ? "is-active" : "",
        props.dragging ? "is-dragging" : "",
        props.dropPosition === "before" ? "is-drop-before" : "",
        props.dropPosition === "after" ? "is-drop-after" : ""
      ]
        .filter((c) => c !== "")
        .join(" ")}
      data-profile-id={profile.id}
      {...props.dragProps}
    >
      {arrangeable ? (
        <button
          className="settings-profile-row__grip"
          type="button"
          aria-label={`Move ${profile.name}. Use the up and down arrow keys.`}
          onKeyDown={onGripKey}
          {...hoverTooltip(tip, "Drag to reorder — or ↑ / ↓ while this grip has focus")}
        >
          <svg width="9" height="14" viewBox="0 0 9 14" fill="currentColor" aria-hidden="true">
            <circle cx="2" cy="2" r="1.3" />
            <circle cx="7" cy="2" r="1.3" />
            <circle cx="2" cy="7" r="1.3" />
            <circle cx="7" cy="7" r="1.3" />
            <circle cx="2" cy="12" r="1.3" />
            <circle cx="7" cy="12" r="1.3" />
          </svg>
        </button>
      ) : null}
      <span className="settings-profile-row__mono" aria-hidden="true">
        {profile.mono !== "" ? profile.mono : profile.name.slice(0, 2)}
      </span>
      <div className="settings-profile-row__body">
        <span className="settings-profile-row__name">
          <span className="settings-profile-row__name-text">{profile.name}</span>
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
          {/* A hidden profile shows no cap; its Off switch says why. */}
          {props.shortcut !== null ? (
            <span
              className="kbd settings-profile-row__shortcut"
              aria-label={`Profiles menu shortcut ${props.shortcut}`}
            >
              {props.shortcut}
            </span>
          ) : null}
        </span>
        <span className="settings-profile-row__meta">{identity}</span>
        <span
          className="settings-profile-row__meta"
          {...hoverTooltip(tip, profile.roots.join("\n"))}
        >
          {rootsSummary}
        </span>
      </div>
      <div className="settings-profile-row__actions">
        <span className="settings-profile-row__menu-toggle">
          <span aria-hidden="true">In Profiles menu</span>
          <SettingsSwitch
            checked={profile.showInMenu}
            busy={props.savingMenu}
            label={`Show ${profile.name} in the Profiles menu`}
            onChange={props.onShowInMenu}
          />
        </span>
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
          /* The refusal is the NAME as well as the card: a disabled button
             still announces its name, and AT reads that over a card. */
          aria-label={
            props.canDelete
              ? undefined
              : `Delete… ${profile.name} — unavailable, PwrGit must keep at least one profile`
          }
          {...hoverTooltip(
            tip,
            props.canDelete
              ? `Delete ${profile.name}`
              : "PwrGit must keep at least one profile"
          )}
          onClick={props.onDelete}
        >
          Delete…
        </button>
      </div>
      {tip.tooltipNode}
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
  // Escape is refused mid-delete, matching the backdrop.
  const modalRef = useModal<HTMLDivElement>({
    onClose: () => {
      if (!busy) props.onClose();
    }
  });
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
        ref={modalRef}
        aria-modal="true"
        tabIndex={-1}
        className="modal modal--delete-profile"
        role="alertdialog"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
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
