import type { MenuItemConstructorOptions } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PWRGIT_LINKS, type Profile } from "@pwrgit/shared";

const electronMock = vi.hoisted(() => ({
  buildFromTemplate: vi.fn(),
  setApplicationMenu: vi.fn()
}));

vi.mock("electron", () => ({
  Menu: electronMock
}));

const { buildAppMenuTemplate, rebuildAppMenu } = await import("./menu");
type AppMenuOptions = Parameters<typeof buildAppMenuTemplate>[0];

const profile = (
  id: string,
  name: string,
  overrides: Partial<Profile> = {}
): Profile => ({
  id,
  name,
  email: `${id}@example.com`,
  mono: "",
  roots: [],
  onboardingCompleted: true,
  showInMenu: true,
  ...overrides
});

function options(overrides: Partial<AppMenuOptions> = {}): AppMenuOptions {
  return {
    profiles: [],
    currentProfileId: null,
    openProfileIds: [],
    onOpenProfile: vi.fn(),
    onNewProfile: vi.fn(),
    onManageProfiles: vi.fn(),
    onAbout: vi.fn(),
    onCheckForUpdates: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenLogs: vi.fn(),
    onOpenChangelog: vi.fn(),
    onOpenLicense: vi.fn(),
    onOpenThirdPartyNotices: vi.fn(),
    onCopyDiagnostics: vi.fn(),
    onOpenExternalLink: vi.fn(),
    onReplayOnboarding: vi.fn(),
    developerMode: false,
    ...overrides
  };
}

type Platform = "darwin" | "linux" | "win32";

/** A top-level menu's name, whether it is given by label or by role. */
const nameOf = (item: MenuItemConstructorOptions): string =>
  item.label ?? `role:${item.role ?? "?"}`;

function topLevel(platform: Platform, opts = options()): string[] {
  return buildAppMenuTemplate(opts, platform).map(nameOf);
}

function submenuOf(
  platform: Platform,
  name: string,
  opts = options()
): MenuItemConstructorOptions[] {
  const menu = buildAppMenuTemplate(opts, platform).find(
    (item) => nameOf(item) === name
  );
  expect(menu, `${name} menu on ${platform}`).toBeDefined();
  return menu?.submenu as MenuItemConstructorOptions[];
}

/** Labels, roles and separators in order — the shape the standard pins. */
const flatten = (items: MenuItemConstructorOptions[]): string[] =>
  items.map((item) =>
    item.type === "separator" ? "---" : (item.label ?? `role:${item.role}`)
  );

const click = (item: MenuItemConstructorOptions | undefined): void => {
  expect(item).toBeDefined();
  (item?.click as (() => void) | undefined)?.();
};

const find = (
  items: MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions | undefined =>
  items.find((item) => item.label === label);

beforeEach(() => {
  electronMock.buildFromTemplate.mockReset();
  electronMock.buildFromTemplate.mockImplementation((template) => template);
  electronMock.setApplicationMenu.mockReset();
});

describe("application menu — PwrSuite menu standard", () => {
  it("orders the menu bar File · Edit · View · Profiles · Window · Help", () => {
    expect(topLevel("darwin")).toEqual([
      "role:appMenu",
      "File",
      "role:editMenu",
      "View",
      "Profiles",
      "role:windowMenu",
      "role:help"
    ]);
    for (const platform of ["linux", "win32"] as const) {
      expect(topLevel(platform)).toEqual([
        "File",
        "role:editMenu",
        "View",
        "Profiles",
        "Window",
        "role:help"
      ]);
    }
  });

  it("keeps About, Check for Updates and Settings in the macOS app menu", () => {
    expect(flatten(submenuOf("darwin", "role:appMenu"))).toEqual([
      "About PwrGit",
      "Check for Updates…",
      "---",
      "Settings…",
      "---",
      "role:services",
      "---",
      "role:hide",
      "role:hideOthers",
      "role:unhide",
      "---",
      "role:quit"
    ]);
    expect(flatten(submenuOf("darwin", "File"))).toEqual(["Close Window"]);
  });

  it("puts Settings in File off macOS, above Close Window and Quit", () => {
    for (const platform of ["linux", "win32"] as const) {
      const file = submenuOf(platform, "File");
      expect(flatten(file)).toEqual([
        "Settings…",
        "---",
        "Close Window",
        "role:quit"
      ]);
      expect(find(file, "Settings…")?.accelerator).toBe("CmdOrCtrl+,");
    }
  });

  it("lays out Help learn → get help → project → legal, About last off macOS", () => {
    const shared = [
      "PwrGit Documentation",
      "Changelog",
      "Replay Onboarding…",
      "---",
      "Report an Issue…",
      "Report a Security Vulnerability…",
      "Copy Diagnostics Info",
      "Logs",
      "---",
      "PwrGit Website",
      "View Source",
      "---",
      "View License",
      "Third-Party Notices"
    ];
    expect(flatten(submenuOf("darwin", "role:help"))).toEqual(shared);
    for (const platform of ["linux", "win32"] as const) {
      expect(flatten(submenuOf(platform, "role:help"))).toEqual([
        ...shared,
        "---",
        "Check for Updates…",
        "About PwrGit"
      ]);
    }
  });

  it("routes About, updates, changelog, diagnostics and onboarding to their actions", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const opts = options();
      const help = submenuOf(platform, "role:help", opts);
      const about =
        platform === "darwin"
          ? submenuOf(platform, "role:appMenu", opts)
          : help;
      click(find(about, "About PwrGit"));
      click(find(about, "Check for Updates…"));
      click(find(help, "Changelog"));
      click(find(help, "Copy Diagnostics Info"));
      click(find(help, "Replay Onboarding…"));
      click(find(help, "Logs"));
      click(find(help, "View License"));
      click(find(help, "Third-Party Notices"));
      expect(opts.onAbout).toHaveBeenCalledOnce();
      expect(opts.onCheckForUpdates).toHaveBeenCalledOnce();
      expect(opts.onOpenChangelog).toHaveBeenCalledOnce();
      expect(opts.onCopyDiagnostics).toHaveBeenCalledOnce();
      expect(opts.onReplayOnboarding).toHaveBeenCalledOnce();
      expect(opts.onOpenLogs).toHaveBeenCalledOnce();
      expect(opts.onOpenLicense).toHaveBeenCalledOnce();
      expect(opts.onOpenThirdPartyNotices).toHaveBeenCalledOnce();
    }
  });

  it("opens canonical product and reporting links from Help", () => {
    const opts = options();
    const help = submenuOf("darwin", "role:help", opts);
    const expected = [
      ["PwrGit Documentation", "PwrGit Documentation", PWRGIT_LINKS.documentation],
      ["Report an Issue…", "Issue Reporting", PWRGIT_LINKS.issues],
      [
        "Report a Security Vulnerability…",
        "Private Security Reporting",
        PWRGIT_LINKS.security
      ],
      ["PwrGit Website", "PwrGit Website", PWRGIT_LINKS.website],
      ["View Source", "PwrGit Source", PWRGIT_LINKS.source]
    ] as const;
    for (const [menuLabel] of expected) click(find(help, menuLabel));
    expect(vi.mocked(opts.onOpenExternalLink).mock.calls).toEqual(
      expected.map(([, reportedAs, url]) => [reportedAs, url])
    );
  });

  it("binds no Logs shortcut — ⇧⌘L belongs to PwrSnap elsewhere in the suite", () => {
    const accelerators = buildAppMenuTemplate(options(), "darwin")
      .flatMap((menu) => (menu.submenu as MenuItemConstructorOptions[]) ?? [])
      .map((item) => item.accelerator)
      .filter((accelerator) => accelerator !== undefined);
    expect(accelerators).not.toContain("CmdOrCtrl+Shift+L");
  });

  it("always offers Reload Window, and the developer items only in Developer Mode", () => {
    expect(flatten(submenuOf("darwin", "View"))).toEqual([
      "Reload Window",
      "---",
      "role:resetZoom",
      "role:zoomIn",
      "role:zoomOut"
    ]);
    expect(
      flatten(submenuOf("linux", "View", options({ developerMode: true })))
    ).toEqual([
      "Reload Window",
      "role:forceReload",
      "role:toggleDevTools",
      "---",
      "role:resetZoom",
      "role:zoomIn",
      "role:zoomOut",
      "---",
      "role:togglefullscreen"
    ]);
  });
});

describe("Profiles menu", () => {
  const profiles = [
    profile("personal", "Personal"),
    profile("scratch-1", "Scratch 1", { showInMenu: false }),
    profile("work-a", "Work", { email: "a@example.com" }),
    profile("work-b", "Work", { email: "b@example.com" }),
    profile("scratch-2", "Scratch 2", { showInMenu: false })
  ];

  it("lists only shown profiles, numbering shortcuts over the ones it shows", () => {
    const opts = options({ profiles, currentProfileId: "work-a" });
    const menu = submenuOf("darwin", "Profiles", opts);
    expect(flatten(menu)).toEqual([
      "Personal",
      "Work (a@example.com)",
      "Work (b@example.com)",
      "---",
      "New Profile…",
      "Manage Profiles…"
    ]);
    expect(menu.slice(0, 3).map((item) => item.accelerator)).toEqual([
      "CmdOrCtrl+1",
      "CmdOrCtrl+2",
      "CmdOrCtrl+3"
    ]);
    expect(menu.slice(0, 3).map((item) => item.checked)).toEqual([
      false,
      true,
      false
    ]);
    click(find(menu, "Work (b@example.com)"));
    expect(opts.onOpenProfile).toHaveBeenCalledWith("work-b");
  });

  it("stops shortcuts after nine profiles", () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      profile(`p${i + 1}`, `Profile ${i + 1}`)
    );
    const menu = submenuOf("darwin", "Profiles", options({ profiles: many }));
    expect(menu.slice(0, 11).map((item) => item.accelerator)).toEqual([
      ...Array.from({ length: 9 }, (_, i) => `CmdOrCtrl+${i + 1}`),
      undefined,
      undefined
    ]);
  });

  it("keeps New and Manage when every profile is hidden", () => {
    const hidden = profiles.map((p) => ({ ...p, showInMenu: false }));
    const opts = options({ profiles: hidden });
    const menu = submenuOf("linux", "Profiles", opts);
    expect(flatten(menu)).toEqual(["New Profile…", "Manage Profiles…"]);
    click(find(menu, "New Profile…"));
    click(find(menu, "Manage Profiles…"));
    expect(opts.onNewProfile).toHaveBeenCalledOnce();
    expect(opts.onManageProfiles).toHaveBeenCalledOnce();
  });
});

describe("Window menu off macOS", () => {
  it("lists open profile windows, hidden profiles included, checking the focused one", () => {
    const opts = options({
      profiles: [
        profile("personal", "Personal"),
        profile("scratch", "Scratch", { showInMenu: false })
      ],
      currentProfileId: "scratch",
      openProfileIds: ["personal", "scratch", "deleted-meanwhile"]
    });
    const menu = submenuOf("linux", "Window", opts);
    expect(flatten(menu)).toEqual([
      "role:minimize",
      "---",
      "Personal",
      "Scratch"
    ]);
    expect(find(menu, "Scratch")?.checked).toBe(true);
    click(find(menu, "Personal"));
    expect(opts.onOpenProfile).toHaveBeenCalledWith("personal");
  });

  it("binds Ctrl+W once — to File → Close Window, not again in Window", () => {
    for (const platform of ["linux", "win32"] as const) {
      const closeItems = buildAppMenuTemplate(options(), platform)
        .flatMap((menu) => (menu.submenu as MenuItemConstructorOptions[]) ?? [])
        .filter((item) => item.role === "close");
      expect(closeItems.map((item) => item.label)).toEqual(["Close Window"]);
    }
  });

  it("says so when no profile window is open", () => {
    const menu = submenuOf("win32", "Window");
    expect(find(menu, "No Open Windows")?.enabled).toBe(false);
  });
});

describe("rebuildAppMenu", () => {
  it("installs the template for the running platform", () => {
    rebuildAppMenu(options());
    expect(electronMock.setApplicationMenu).toHaveBeenCalledOnce();
    const [template] = electronMock.buildFromTemplate.mock.calls[0] ?? [];
    expect((template as MenuItemConstructorOptions[]).map(nameOf)).toEqual(
      topLevel(process.platform as Platform)
    );
  });
});
