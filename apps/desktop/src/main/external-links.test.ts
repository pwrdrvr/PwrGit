import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  showMessageBox: vi.fn(),
  logMain: vi.fn()
}));

vi.mock("electron", () => ({
  dialog: { showMessageBox: mocks.showMessageBox },
  shell: { openExternal: mocks.openExternal }
}));

vi.mock("./logs", () => ({ logMain: mocks.logMain }));

const { isSafeExternalUrl, openExternalUrl, openExternalUrlFromMenu } =
  await import("./external-links");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.openExternal.mockResolvedValue(undefined);
  mocks.showMessageBox.mockResolvedValue({ response: 0 });
});

describe("external links", () => {
  it.each([
    "https://docs.pwrgit.com",
    "http://localhost:4173/help?topic=git#start"
  ])("accepts a web URL: %s", (url) => {
    expect(isSafeExternalUrl(url)).toBe(true);
  });

  it.each([
    "file:///tmp/secret",
    "javascript:alert(1)",
    "https://user:token@example.com/private",
    "not a url"
  ])("rejects an unsafe URL: %s", (url) => {
    expect(isSafeExternalUrl(url)).toBe(false);
  });

  it("awaits the browser handoff before reporting success", async () => {
    let finish: (() => void) | undefined;
    const open = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );

    const pending = openExternalUrl("https://docs.pwrgit.com", open);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finish?.();
    await expect(pending).resolves.toEqual({ ok: true, value: null });
  });

  it("returns actionable recovery when the default browser cannot open", async () => {
    const result = await openExternalUrl(
      "https://docs.pwrgit.com",
      vi.fn().mockRejectedValue(new Error("offline"))
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "external_open_failed",
        message: expect.stringContaining("copy the address")
      }
    });
  });

  it("shows menu failures with the canonical URL for offline recovery", async () => {
    mocks.openExternal.mockRejectedValue(new Error("no browser"));

    await openExternalUrlFromMenu(
      "PwrGit Documentation",
      "https://docs.pwrgit.com"
    );

    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "Unable to open PwrGit Documentation",
        detail: expect.stringContaining("https://docs.pwrgit.com")
      })
    );
    expect(mocks.logMain).toHaveBeenCalledWith(
      "warn",
      "external-link",
      "failed to open PwrGit Documentation:",
      expect.stringContaining("default browser"),
      "https://docs.pwrgit.com"
    );
  });
});
