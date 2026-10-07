import { useCallback, useEffect, useRef, useState } from "react";
import type { HiddenRepo, Profile } from "@pwrgit/shared";
import { dispatch } from "../../lib/pwrgit";
import { showErrorToast } from "../../lib/toast";
import {
  onShowHiddenRepos,
  unhideRepo,
  useHiddenRepos
} from "../../state/useHiddenRepos";
import { ContextMenu, type MenuItem } from "../shell/ContextMenu";

/** What a hidden entry's second line says: where it is, or that it is not. */
export function hiddenRepoHint(entry: HiddenRepo): string {
  return entry.missing ? "Not found on disk" : entry.path;
}

/**
 * The sidebar's way back to a hidden repository: a footer row reading
 * "Hidden N" that opens the profile's list, one Unhide per entry. Drawn only
 * while something is hidden — an empty "Hidden 0" would advertise a feature
 * on every profile that has never used it.
 */
export function HiddenReposButton({
  profile,
  onUnhidden
}: {
  profile: Profile;
  /** Told the repository that came back, so the sidebar can select it. */
  onUnhidden?: (entry: HiddenRepo) => void;
}) {
  const { hidden } = useHiddenRepos(profile.id);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const open = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    setMenu({ x: rect.left, y: rect.top - 4 });
  }, []);

  useEffect(() => onShowHiddenRepos(open), [open]);

  if (hidden.length === 0) return null;

  const items: MenuItem[] = [
    ...hidden.map(
      (entry): MenuItem => ({
        type: "item",
        label: `Unhide ${entry.name}`,
        hint: hiddenRepoHint(entry),
        onSelect: () =>
          void unhideRepo(entry).then((failure) => {
            if (failure === null) onUnhidden?.(entry);
            else showErrorToast({ title: `Could not unhide ${entry.name}`, message: failure });
          })
      })
    ),
    { type: "sep" },
    {
      type: "item",
      label: "Manage in Settings → Profiles…",
      onSelect: () =>
        void dispatch("settings:open", { page: "profiles", profileId: profile.id })
    }
  ];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="hidden-repos-trigger"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={() => (menu === null ? open() : setMenu(null))}
      >
        <span className="hidden-repos-trigger__label">Hidden</span>
        <span className="hidden-repos-trigger__count">{hidden.length}</span>
      </button>
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          placement="above"
          label={`Hidden in ${profile.name}`}
          triggerRef={triggerRef}
          items={items}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
