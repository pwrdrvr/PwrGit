import { Menu, type MenuItemConstructorOptions } from "electron";
import type { Profile } from "@pwrgit/shared";

/**
 * Application menu with a Profiles submenu (PwrAgnt-style): every profile
 * listed with ⌘1…⌘9, a checkmark on the focused window's profile, and
 * New/Manage actions. Picking a profile opens (or focuses) its window.
 * Rebuild whenever profiles change or window focus moves the checkmark.
 */
export function rebuildAppMenu(opts: {
  profiles: Profile[];
  currentProfileId: string | null;
  onOpenProfile: (profileId: string) => void;
  onNewProfile: () => void;
  onManageProfiles: () => void;
}): void {
  // Email-disambiguate duplicate profile names — otherwise the menu (and the
  // matching window titles) list indistinguishable twins.
  const nameCounts = new Map<string, number>();
  for (const p of opts.profiles) {
    nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);
  }
  const profileItems: MenuItemConstructorOptions[] = opts.profiles.map(
    (p, i) => ({
      label:
        (nameCounts.get(p.name) ?? 0) > 1 && p.email !== ""
          ? `${p.name} (${p.email})`
          : p.name,
      type: "checkbox",
      checked: p.id === opts.currentProfileId,
      ...(i < 9 ? { accelerator: `CmdOrCtrl+${i + 1}` } : {}),
      click: () => opts.onOpenProfile(p.id)
    })
  );

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" } as MenuItemConstructorOptions]
      : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "Profiles",
      submenu: [
        ...profileItems,
        { type: "separator" },
        { label: "New Profile…", click: () => opts.onNewProfile() },
        { label: "Manage Profiles…", click: () => opts.onManageProfiles() }
      ]
    },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
