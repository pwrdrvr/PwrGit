import { Menu, type MenuItemConstructorOptions } from "electron";
import { PWRGIT_LINKS, type Profile } from "@pwrgit/shared";

/**
 * The application menu, laid out to the PwrSuite menu standard shared with
 * PwrAgent and PwrSnap (Claude Design project "PwrSuite", artboard "Menu
 * Standard - Suite Review"):
 *
 *   [PwrGit] · File · Edit · View · Profiles · Window · Help
 *
 * macOS keeps About, Check for Updates… and Settings… in the app menu.
 * Elsewhere Settings… sits in File, and Check for Updates… and About close
 * out Help, About last. Help is grouped learn → get help → project → legal
 * in every app, so the same item is in the same place whichever one is open.
 */
export type AppMenuOptions = {
  profiles: Profile[];
  /** The profile that gets the checkmark: the focused window's. */
  currentProfileId: string | null;
  /** Profiles with a window open, for the Window menu off macOS. */
  openProfileIds: string[];
  onOpenProfile: (profileId: string) => void;
  onNewProfile: () => void;
  onManageProfiles: () => void;
  onAbout: () => void;
  onCheckForUpdates: () => void;
  onOpenSettings: () => void;
  onOpenLogs: () => void;
  onOpenChangelog: () => void;
  onOpenLicense: () => void;
  onOpenThirdPartyNotices: () => void;
  onCopyDiagnostics: () => void;
  onOpenExternalLink: (label: string, url: string) => void;
  onReplayOnboarding: () => void;
  /** Settings → General → Developer Mode: expose Force Reload and Toggle
   *  Developer Tools in the View menu. Reload Window is always there. */
  developerMode: boolean;
};

/** Rebuild whenever profiles change or window focus moves the checkmark. */
export function rebuildAppMenu(opts: AppMenuOptions): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(buildAppMenuTemplate(opts, process.platform))
  );
}

/**
 * Menu labels for every profile, email-disambiguated when two share a name —
 * otherwise the menu (and the matching window titles) list indistinguishable
 * twins. Computed over all profiles, hidden ones included, so a label does
 * not change when a twin is hidden from the menu.
 */
function profileLabels(profiles: Profile[]): Map<string, string> {
  const nameCounts = new Map<string, number>();
  for (const p of profiles) {
    nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);
  }
  return new Map(
    profiles.map((p) => [
      p.id,
      (nameCounts.get(p.name) ?? 0) > 1 && p.email !== ""
        ? `${p.name} (${p.email})`
        : p.name
    ])
  );
}

export function buildAppMenuTemplate(
  opts: AppMenuOptions,
  platform: NodeJS.Platform
): MenuItemConstructorOptions[] {
  const isMac = platform === "darwin";
  const labels = profileLabels(opts.profiles);
  const separator: MenuItemConstructorOptions = { type: "separator" };

  const settingsItem: MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: () => opts.onOpenSettings()
  };
  const aboutItem: MenuItemConstructorOptions = {
    label: "About PwrGit",
    click: () => opts.onAbout()
  };
  const checkForUpdatesItem: MenuItemConstructorOptions = {
    label: "Check for Updates…",
    click: () => opts.onCheckForUpdates()
  };
  const link = (
    label: string,
    url: string,
    reportedAs: string = label
  ): MenuItemConstructorOptions => ({
    label,
    click: () => opts.onOpenExternalLink(reportedAs, url)
  });

  const appMenu: MenuItemConstructorOptions = {
    role: "appMenu",
    submenu: [
      aboutItem,
      checkForUpdatesItem,
      separator,
      settingsItem,
      separator,
      { role: "services" },
      separator,
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      separator,
      { role: "quit" }
    ]
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: isMac
      ? [{ role: "close", label: "Close Window" }]
      : [
          settingsItem,
          separator,
          { role: "close", label: "Close Window" },
          { role: "quit" }
        ]
  };

  // Reload Window stays visible without Developer Mode: it is the way back
  // when the renderer stops drawing its own controls. macOS omits
  // togglefullscreen because the system inserts its own full-screen item
  // (🌐F) and the stock one would show up twice.
  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      { role: "reload", label: "Reload Window" },
      ...(opts.developerMode
        ? ([
            { role: "forceReload" },
            { role: "toggleDevTools" }
          ] as MenuItemConstructorOptions[])
        : []),
      separator,
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      ...(isMac
        ? []
        : ([separator, { role: "togglefullscreen" }] as MenuItemConstructorOptions[]))
    ]
  };

  // Shortcuts go to the first nine profiles the menu SHOWS, so hiding a
  // profile hands its ⌘ number to the next one instead of leaving a gap.
  const menuProfiles = opts.profiles.filter((p) => p.showInMenu);
  const profilesMenu: MenuItemConstructorOptions = {
    label: "Profiles",
    submenu: [
      ...menuProfiles.map(
        (p, i): MenuItemConstructorOptions => ({
          label: labels.get(p.id) ?? p.name,
          type: "checkbox",
          checked: p.id === opts.currentProfileId,
          ...(i < 9 ? { accelerator: `CmdOrCtrl+${i + 1}` } : {}),
          click: () => opts.onOpenProfile(p.id)
        })
      ),
      ...(menuProfiles.length > 0 ? [separator] : []),
      { label: "New Profile…", click: () => opts.onNewProfile() },
      { label: "Manage Profiles…", click: () => opts.onManageProfiles() }
    ]
  };

  // macOS draws its own window list; elsewhere the stock Window menu offers
  // only Minimize and Close, so the open profile windows are listed here.
  const openWindowItems: MenuItemConstructorOptions[] = opts.openProfileIds
    .filter((id) => labels.has(id))
    .map((id) => ({
      label: labels.get(id) ?? id,
      type: "checkbox",
      checked: id === opts.currentProfileId,
      click: () => opts.onOpenProfile(id)
    }));
  const windowMenu: MenuItemConstructorOptions = isMac
    ? { role: "windowMenu" }
    : {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "close" },
          separator,
          ...(openWindowItems.length > 0
            ? openWindowItems
            : [{ label: "No Open Windows", enabled: false }])
        ]
      };

  const helpMenu: MenuItemConstructorOptions = {
    role: "help",
    submenu: [
      // Learn
      link("PwrGit Documentation", PWRGIT_LINKS.documentation),
      { label: "Changelog", click: () => opts.onOpenChangelog() },
      {
        label: "Replay Onboarding…",
        click: () => opts.onReplayOnboarding()
      },
      separator,
      // Get help. Logs is the escape hatch when something fails without
      // visible feedback; it has no shortcut, because ⇧⌘L is taken elsewhere
      // in the suite and Logs is not a daily action.
      link("Report an Issue…", PWRGIT_LINKS.issues, "Issue Reporting"),
      link(
        "Report a Security Vulnerability…",
        PWRGIT_LINKS.security,
        "Private Security Reporting"
      ),
      {
        label: "Copy Diagnostics Info",
        click: () => opts.onCopyDiagnostics()
      },
      { label: "Logs", click: () => opts.onOpenLogs() },
      separator,
      // Project
      link("PwrGit Website", PWRGIT_LINKS.website),
      link("View Source", PWRGIT_LINKS.source, "PwrGit Source"),
      separator,
      // Legal
      { label: "View License", click: () => opts.onOpenLicense() },
      {
        label: "Third-Party Notices",
        click: () => opts.onOpenThirdPartyNotices()
      },
      ...(isMac ? [] : [separator, checkForUpdatesItem, aboutItem])
    ]
  };

  return [
    ...(isMac ? [appMenu] : []),
    fileMenu,
    { role: "editMenu" },
    viewMenu,
    profilesMenu,
    windowMenu,
    helpMenu
  ];
}
