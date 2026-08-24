import type { MenuItemConstructorOptions } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PWRGIT_LINKS } from "@pwrgit/shared";

const electronMock = vi.hoisted(() => ({
  buildFromTemplate: vi.fn(),
  setApplicationMenu: vi.fn()
}));

vi.mock("electron", () => ({
  Menu: electronMock
}));

const { rebuildAppMenu } = await import("./menu");

function rebuild(
  overrides: {
    onCheckForUpdates?: () => void;
    onOpenExternalLink?: (label: string, url: string) => void;
  } = {}
): void {
  rebuildAppMenu({
    profiles: [],
    currentProfileId: null,
    onOpenProfile: vi.fn(),
    onNewProfile: vi.fn(),
    onManageProfiles: vi.fn(),
    onCheckForUpdates: overrides.onCheckForUpdates ?? vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenLogs: vi.fn(),
    onOpenLicense: vi.fn(),
    onOpenThirdPartyNotices: vi.fn(),
    onOpenExternalLink: overrides.onOpenExternalLink ?? vi.fn(),
    developerMode: false
  });
}

function builtTemplate(): MenuItemConstructorOptions[] {
  const [template] = electronMock.buildFromTemplate.mock.calls[0] ?? [];
  return template as MenuItemConstructorOptions[];
}

beforeEach(() => {
  electronMock.buildFromTemplate.mockReset();
  electronMock.buildFromTemplate.mockImplementation((template) => template);
  electronMock.setApplicationMenu.mockReset();
});

describe("application menu", () => {
  it("checks for updates from the Help menu", () => {
    const onCheckForUpdates = vi.fn();
    rebuild({ onCheckForUpdates });

    const help = builtTemplate().find((item) => item.role === "help");
    const submenu = help?.submenu as MenuItemConstructorOptions[];
    const checkForUpdates = submenu.find(
      (item) => item.label === "Check for Updates"
    );

    expect(checkForUpdates).toBeDefined();
    (checkForUpdates?.click as (() => void) | undefined)?.();
    expect(onCheckForUpdates).toHaveBeenCalledOnce();
  });

  it("opens canonical product and reporting links from Help", () => {
    const onOpenExternalLink = vi.fn();
    rebuild({ onOpenExternalLink });

    const help = builtTemplate().find((item) => item.role === "help");
    const submenu = help?.submenu as MenuItemConstructorOptions[];
    const expected = [
      ["PwrGit Documentation", PWRGIT_LINKS.documentation],
      ["PwrGit Website", PWRGIT_LINKS.website],
      ["Release Notes", PWRGIT_LINKS.releases],
      ["View Source", PWRGIT_LINKS.source],
      ["Report an Issue…", PWRGIT_LINKS.issues],
      ["Security Reporting (Private)…", PWRGIT_LINKS.security]
    ] as const;

    for (const [menuLabel] of expected) {
      const item = submenu.find((candidate) => candidate.label === menuLabel);
      expect(item, `${menuLabel} should be in Help`).toBeDefined();
      (item?.click as (() => void) | undefined)?.();
    }

    expect(onOpenExternalLink.mock.calls).toEqual(
      expected.map(([menuLabel, url]) => [
        menuLabel === "View Source"
          ? "PwrGit Source"
          : menuLabel === "Report an Issue…"
            ? "Issue Reporting"
            : menuLabel === "Security Reporting (Private)…"
              ? "Private Security Reporting"
              : menuLabel,
        url
      ])
    );
  });
});
