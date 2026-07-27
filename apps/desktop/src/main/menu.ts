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
  onOpenSettings: () => void;
  /** Settings → General → Developer Mode: expose Reload / Force Reload /
   *  Toggle Developer Tools (and their shortcuts) in the View menu. */
  developerMode: boolean;
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

  const settingsItem: MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: () => opts.onOpenSettings()
  };

  const template: MenuItemConstructorOptions[] = [
    // macOS: Settings… lives in the app menu (standard position, after About);
    // elsewhere it goes at the top of the File menu.
    ...(process.platform === "darwin"
      ? [
          {
            role: "appMenu",
            submenu: [
              { role: "about" },
              { type: "separator" },
              settingsItem,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" }
            ]
          } as MenuItemConstructorOptions
        ]
      : []),
    process.platform === "darwin"
      ? { role: "fileMenu" }
      : {
          label: "File",
          submenu: [
            settingsItem,
            { type: "separator" },
            { role: "close" },
            { role: "quit" }
          ]
        },
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
    // Custom View menu on every platform: the Electron developer items
    // (Reload / Force Reload / Toggle Developer Tools) only exist while
    // Developer Mode is on. macOS additionally omits togglefullscreen — the
    // system auto-inserts its own full-screen item (🌐F) and the stock one
    // would show up as a duplicate.
    {
      label: "View",
      submenu: [
        ...(opts.developerMode
          ? ([
              { role: "reload" },
              { role: "forceReload" },
              { role: "toggleDevTools" },
              { type: "separator" }
            ] as MenuItemConstructorOptions[])
          : []),
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        ...(process.platform === "darwin"
          ? []
          : ([
              { type: "separator" },
              { role: "togglefullscreen" }
            ] as MenuItemConstructorOptions[]))
      ]
    },
    { role: "windowMenu" }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
