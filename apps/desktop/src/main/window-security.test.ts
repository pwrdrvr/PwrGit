import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  logMain: vi.fn()
}));

vi.mock("electron", () => ({
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: mocks.openExternal }
}));

vi.mock("./logs", () => ({ logMain: mocks.logMain }));

const { applyWindowSecurityHardening } = await import("./window-security");

const APP_ENTRY = "file:///Applications/PwrGit.app/out/renderer/index.html";
const DEV_URL = "http://localhost:5173";

type WindowOpenHandler = (details: { url: string }) => { action: string };
type NavigationHandler = (
  event: { preventDefault: () => void },
  url: string
) => void;

/**
 * A BrowserWindow stub that keeps the two handlers the helper registers, so a
 * test can fire them the way Electron would.
 */
function hardenedWindow(
  options?: Parameters<typeof applyWindowSecurityHardening>[1]
) {
  let windowOpen: WindowOpenHandler | undefined;
  let willNavigate: NavigationHandler | undefined;

  const window = {
    webContents: {
      setWindowOpenHandler: (handler: WindowOpenHandler) => {
        windowOpen = handler;
      },
      on: (event: string, handler: NavigationHandler) => {
        if (event === "will-navigate") willNavigate = handler;
      }
    }
  } as unknown as BrowserWindow;

  applyWindowSecurityHardening(window, options);

  return {
    openWindow: (url: string) => windowOpen?.({ url }),
    navigateTo: (url: string) => {
      const preventDefault = vi.fn();
      willNavigate?.({ preventDefault }, url);
      return { prevented: preventDefault.mock.calls.length > 0 };
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.openExternal.mockResolvedValue(undefined);
  delete process.env["ELECTRON_RENDERER_URL"];
});

afterEach(() => {
  delete process.env["ELECTRON_RENDERER_URL"];
});

describe("window-open hardening", () => {
  it("hands an ordinary https link to the OS browser", async () => {
    expect(hardenedWindow().openWindow("https://github.com/pwrdrvr/PwrGit")).toEqual({
      action: "deny"
    });

    await vi.waitFor(() => {
      expect(mocks.openExternal).toHaveBeenCalledWith(
        "https://github.com/pwrdrvr/PwrGit"
      );
    });
    expect(mocks.logMain).not.toHaveBeenCalled();
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:token@example.com/private"
  ])("denies %s without handing it to shell.openExternal", async (url) => {
    expect(hardenedWindow().openWindow(url)).toEqual({ action: "deny" });

    await vi.waitFor(() => {
      expect(mocks.logMain).toHaveBeenCalledWith(
        "warn",
        "window-guards",
        "refused a window-open link:",
        expect.stringContaining("HTTP or HTTPS"),
        url
      );
    });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("opens nothing at all for a window that denies outbound links", async () => {
    expect(
      hardenedWindow({ windowOpen: "deny" }).openWindow("https://example.com")
    ).toEqual({ action: "deny" });

    await Promise.resolve();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});

describe("will-navigate hardening", () => {
  it("prevents navigation to a remote origin and logs it", () => {
    expect(hardenedWindow().navigateTo("https://evil.example/phish")).toEqual({
      prevented: true
    });
    expect(mocks.logMain).toHaveBeenCalledWith(
      "warn",
      "window-guards",
      "blocked renderer navigation:",
      "https://evil.example/phish"
    );
  });

  it("allows the app's own file:// entry, hash routes included", () => {
    const window = hardenedWindow();

    expect(window.navigateTo(APP_ENTRY)).toEqual({ prevented: false });
    expect(window.navigateTo(`${APP_ENTRY}#settings`)).toEqual({
      prevented: false
    });
    expect(mocks.logMain).not.toHaveBeenCalled();
  });

  it("allows the dev-server origin, hash routes included", () => {
    process.env["ELECTRON_RENDERER_URL"] = DEV_URL;
    const window = hardenedWindow();

    expect(window.navigateTo(`${DEV_URL}/`)).toEqual({ prevented: false });
    expect(window.navigateTo(`${DEV_URL}/#logs`)).toEqual({ prevented: false });
    expect(mocks.logMain).not.toHaveBeenCalled();
  });

  it("prevents another localhost port even while the dev server runs", () => {
    process.env["ELECTRON_RENDERER_URL"] = DEV_URL;

    expect(hardenedWindow().navigateTo("http://localhost:9229/")).toEqual({
      prevented: true
    });
  });

  it("prevents the dev-server origin once the dev server is not configured", () => {
    expect(hardenedWindow().navigateTo(`${DEV_URL}/#logs`)).toEqual({
      prevented: true
    });
  });

  it("keeps a deny-navigation window on its own entry", () => {
    expect(
      hardenedWindow({ navigation: "deny" }).navigateTo(APP_ENTRY)
    ).toEqual({ prevented: true });
  });
});
