import { useState } from "react";
import type { Profile } from "@pwrgit/shared";

function monogram(p: Profile): string {
  return p.mono !== "" ? p.mono : p.name.slice(0, 1).toUpperCase();
}

export function ProfileChip({
  profiles,
  activeProfile,
  onSwitch
}: {
  profiles: Profile[];
  activeProfile: Profile | null;
  onSwitch: (profileId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (activeProfile === null) return null;

  return (
    <div className="profile-chip-wrap">
      <button
        className={`profile-chip${open ? " is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="mono-tile">{monogram(activeProfile)}</span>
        <span className="profile-chip__text">
          <span className="profile-chip__name">{activeProfile.name}</span>
          <span className="profile-chip__email">
            {activeProfile.email !== "" ? activeProfile.email : "no commit email set"}
          </span>
        </span>
        <span className={`profile-caret${open ? " is-open" : ""}`} />
      </button>

      {open && (
        <div className="profile-menu">
          <div className="profile-menu__label">Profiles</div>
          {profiles.map((p) => {
            const isActive = p.id === activeProfile.id;
            return (
              <button
                key={p.id}
                className={`profile-menu__item${isActive ? " is-active" : ""}`}
                onClick={() => {
                  onSwitch(p.id);
                  setOpen(false);
                }}
              >
                <span className="mono-tile mono-tile--sm">{monogram(p)}</span>
                <span className="profile-chip__text">
                  <span className="profile-menu__name">{p.name}</span>
                  <span className="profile-chip__email">
                    {p.email !== "" ? p.email : "—"}
                  </span>
                </span>
                {isActive && <span className="profile-menu__dot" />}
              </button>
            );
          })}
          <div className="profile-menu__sep" />
          <div className="profile-menu__hint">
            Same GitHub identity · commit email set per profile
          </div>
        </div>
      )}
    </div>
  );
}
