import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkForAppUpdatesNow: vi.fn(),
  emitEvent: vi.fn(),
  logMain: vi.fn()
}));

vi.mock("./auto-updater", () => ({
  checkForAppUpdatesNow: mocks.checkForAppUpdatesNow
}));

vi.mock("./ipc", () => ({
  emitEvent: mocks.emitEvent
}));

vi.mock("./logs", () => ({
  logMain: mocks.logMain
}));

const { checkForAppUpdatesFromMenu } = await import("./menu-update-check");

beforeEach(() => {
  mocks.checkForAppUpdatesNow.mockReset();
  mocks.emitEvent.mockReset();
  mocks.logMain.mockReset();
});

describe("menu update check", () => {
  it("answers with events, never a modal", async () => {
    mocks.checkForAppUpdatesNow.mockResolvedValue({
      status: "no-update",
      version: "1.2.3"
    });

    await checkForAppUpdatesFromMenu();

    expect(mocks.checkForAppUpdatesNow).toHaveBeenCalledWith("menu");
    expect(mocks.emitEvent.mock.calls).toEqual([
      ["app:updateCheckResult", { status: "checking" }],
      ["app:updateCheckResult", { status: "no-update", version: "1.2.3" }]
    ]);
  });

  it("acknowledges the click before the check finishes", async () => {
    let settle: (result: unknown) => void = () => undefined;
    mocks.checkForAppUpdatesNow.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      })
    );

    const pending = checkForAppUpdatesFromMenu();
    await Promise.resolve();

    expect(mocks.emitEvent).toHaveBeenCalledExactlyOnceWith(
      "app:updateCheckResult",
      { status: "checking" }
    );

    settle({ status: "downloaded", version: "2.0.0" });
    await pending;

    expect(mocks.emitEvent).toHaveBeenLastCalledWith("app:updateCheckResult", {
      status: "downloaded",
      version: "2.0.0"
    });
  });

  it("turns a rejected check into a visible error", async () => {
    mocks.checkForAppUpdatesNow.mockRejectedValue(
      new Error("GitHub releases request failed with 404")
    );

    await checkForAppUpdatesFromMenu();

    expect(mocks.emitEvent).toHaveBeenLastCalledWith("app:updateCheckResult", {
      status: "error",
      message: "GitHub releases request failed with 404"
    });
    expect(mocks.logMain).toHaveBeenCalledWith(
      "warn",
      "updater",
      "menu update check failed",
      "GitHub releases request failed with 404"
    );
  });
});
