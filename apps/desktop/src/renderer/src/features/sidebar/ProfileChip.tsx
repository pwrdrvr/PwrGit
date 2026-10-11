import { useCallback, useRef, useState } from "react";
import type { Profile } from "@pwrgit/shared";
import { useDismissable } from "../../lib/useDismissable";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import { SettingsGlyph } from "../../lib/SettingsGlyph";
import { PlusGlyph } from "../../lib/PlusGlyph";
import { ChevronGlyph } from "../../lib/ChevronGlyph";
import { TerminalGlyph } from "../../lib/TerminalGlyph";
import { folderRowView } from "../identity/folder-view";
import { useFolderIdentity } from "../identity/useCommitIdentity";

function monogram(p: Profile): string {
  return p.mono !== "" ? p.mono : p.name.slice(0, 1).toUpperCase();
}

export function ProfileChip({
  profiles,
  activeProfile,
  onSwitch,
  onNewProfile,
  onManageProfile,
  onOpenGitIdentity
}: {
  profiles: Profile[];
  activeProfile: Profile | null;
  onSwitch: (profileId: string) => void;
  onNewProfile: () => void;
  onManageProfile: () => void;
  /** Settings › Profiles › By folder. */
  onOpenGitIdentity: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Asked only while the menu is open: one Git process per repository.
  const folders = useFolderIdentity({
    active: open && activeProfile !== null,
    ...(activeProfile === null ? {} : { profileId: activeProfile.id })
  });
  const folderProfile =
    folders.report?.profiles.find((p) => p.profileId === activeProfile?.id) ?? null;
  const gitRow =
    folders.report !== null && folderProfile !== null
      ? folderRowView(folderProfile, folders.report.machine)
      : null;
  const chipRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  // Escape dismisses and hands focus back to the chip; arrows, Home/End and
  // typeahead walk the items. Activating an item is deliberately left alone —
  // each action hands off to a modal or to another profile's window, and those
  // place focus themselves.
  useDismissable({ open, onDismiss: close, triggerRef: chipRef, surfaceRef: menuRef });
  useMenuNavigation({ open, menuRef, onClose: close });

  if (activeProfile === null) return null;

  return (
    <div className="profile-chip-wrap">
      <button
        ref={chipRef}
        type="button"
        className={`profile-chip${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {/* The monogram is the name's first letter; announcing it would just
            stutter the name that follows. Same for the caret. */}
        <span className="mono-tile" aria-hidden="true">
          {monogram(activeProfile)}
        </span>
        <span className="profile-chip__text">
          <span className="profile-chip__name">{activeProfile.name}</span>
          <span className="profile-chip__email">
            {activeProfile.email !== "" ? activeProfile.email : "no commit email set"}
          </span>
        </span>
        <span
          className={`profile-caret${open ? " is-open" : ""}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          className="profile-menu__backdrop"
          onClick={() => setOpen(false)}
        />
      )}
      {open && (
        <div ref={menuRef} className="profile-menu" role="menu" aria-label="Profiles">
          <div className="profile-menu__label" aria-hidden="true">
            Profiles
          </div>
          {profiles.map((p) => {
            const isActive = p.id === activeProfile.id;
            return (
              <button
                key={p.id}
                type="button"
                // One of the set is always current, which is what the green dot
                // says visually — `menuitemradio` is how that reaches a screen
                // reader, so the dot itself can stay decorative.
                role="menuitemradio"
                aria-checked={isActive}
                className={`profile-menu__item${isActive ? " is-active" : ""}`}
                onClick={() => {
                  onSwitch(p.id);
                  setOpen(false);
                }}
              >
                <span className="mono-tile mono-tile--sm" aria-hidden="true">
                  {monogram(p)}
                </span>
                <span className="profile-chip__text">
                  <span className="profile-menu__name">{p.name}</span>
                  <span className="profile-chip__email">
                    {p.email !== "" ? p.email : "—"}
                  </span>
                </span>
                {isActive && (
                  <span className="profile-menu__dot" aria-hidden="true" />
                )}
              </button>
            );
          })}
          <div className="profile-menu__sep" role="separator" />
          {/* What Terminal and coding agents commit as in this profile's
              folders. The dot rides on the icon so the text column lines up
              with the profile names above. */}
          <button
            type="button"
            role="menuitem"
            className={`profile-menu__git profile-menu__git--${gitRow?.tone ?? "wait"}`}
            onClick={() => {
              onOpenGitIdentity();
              setOpen(false);
            }}
          >
            <span className="profile-menu__action-icon profile-menu__git-icon" aria-hidden="true">
              <TerminalGlyph />
            </span>
            <span className="profile-menu__git-text">
              <span className="profile-menu__git-label">Git outside PwrGit</span>
              <span className="profile-menu__git-value">{gitRow?.text ?? "Checking…"}</span>
            </span>
            <span className="profile-menu__git-chevron" aria-hidden="true">
              <ChevronGlyph right />
            </span>
          </button>
          <div className="profile-menu__sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="profile-menu__action"
            onClick={() => {
              onManageProfile();
              setOpen(false);
            }}
          >
            <span className="profile-menu__action-icon" aria-hidden="true">
              <SettingsGlyph />
            </span>
            Edit “{activeProfile.name}”…
          </button>
          <button
            type="button"
            role="menuitem"
            className="profile-menu__action"
            onClick={() => {
              onNewProfile();
              setOpen(false);
            }}
          >
            <span className="profile-menu__action-icon" aria-hidden="true">
              <PlusGlyph />
            </span>
            New profile…
          </button>
          <div className="profile-menu__sep" role="separator" />
          <div className="profile-menu__hint">
            Same GitHub identity · theme, commit email &amp; org per profile
          </div>
        </div>
      )}
    </div>
  );
}
