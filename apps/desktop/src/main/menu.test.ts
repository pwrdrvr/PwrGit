import type { MenuItemConstructorOptions } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  buildFromTemplate: vi.fn(),
  setApplicationMenu: vi.fn()
}));

vi.mock("electron", () => ({
  Menu: electronMock
}));

const { rebuildAppMenu } = await import("./menu");

function rebuild(overrides: { onCheckForUpdates?: () => void } = {}): void {
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
});
