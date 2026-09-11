import { useCallback, useRef, useState } from "react";
import type { Profile } from "@pwrgit/shared";
import { useDismissable } from "../../lib/useDismissable";
import { useMenuNavigation } from "../../lib/useMenuNavigation";

function monogram(p: Profile): string {
  return p.mono !== "" ? p.mono : p.name.slice(0, 1).toUpperCase();
}

export function ProfileChip({
  profiles,
  activeProfile,
  onSwitch,
  onNewProfile,
  onManageProfile
}: {
  profiles: Profile[];
  activeProfile: Profile | null;
  onSwitch: (profileId: string) => void;
  onNewProfile: () => void;
  onManageProfile: () => void;
}) {
  const [open, setOpen] = useState(false);
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
              ⚙
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
              ＋
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
