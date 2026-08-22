import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkForAppUpdatesNow: vi.fn(),
  logMain: vi.fn(),
  showMessageBox: vi.fn()
}));

vi.mock("electron", () => ({
  dialog: { showMessageBox: mocks.showMessageBox }
}));

vi.mock("./auto-updater", () => ({
  checkForAppUpdatesNow: mocks.checkForAppUpdatesNow
}));

vi.mock("./logs", () => ({
  logMain: mocks.logMain
}));

const { appUpdateCheckDialogOptions, checkForAppUpdatesFromMenu } =
  await import("./menu-update-check");

beforeEach(() => {
  mocks.checkForAppUpdatesNow.mockReset();
  mocks.logMain.mockReset();
  mocks.showMessageBox.mockReset();
  mocks.showMessageBox.mockResolvedValue({ response: 0 });
});

describe("menu update check", () => {
  it("shows an up-to-date result", async () => {
    mocks.checkForAppUpdatesNow.mockResolvedValue({
      status: "no-update",
      version: "1.2.3"
    });

    await checkForAppUpdatesFromMenu();

    expect(mocks.checkForAppUpdatesNow).toHaveBeenCalledWith("menu");
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "PwrGit is up to date",
        detail: "You’re running v1.2.3."
      })
    );
  });

  it("turns a rejected check into a visible error", async () => {
    mocks.checkForAppUpdatesNow.mockRejectedValue(
      new Error("GitHub releases request failed with 404")
    );

    await checkForAppUpdatesFromMenu();

    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "Unable to check for updates",
        detail: "GitHub releases request failed with 404"
      })
    );
    expect(mocks.logMain).toHaveBeenCalledWith(
      "warn",
      "updater",
      "menu update check failed",
      "GitHub releases request failed with 404"
    );
  });

  it.each([
    [
      { status: "skipped", reason: "Use the package manager." },
      "Updates are unavailable"
    ],
    [{ status: "checking" }, "Checking for updates…"],
    [{ status: "available", version: "2.0.0" }, "Update available"],
    [
      { status: "downloaded", version: "2.0.0" },
      "Update ready to install"
    ],
    [
      { status: "error", message: "network failed" },
      "Unable to check for updates"
    ]
  ] as const)("maps %j to a dialog", (result, message) => {
    expect(appUpdateCheckDialogOptions(result)).toEqual(
      expect.objectContaining({ message })
    );
  });
});
