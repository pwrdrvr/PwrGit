import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const MAIN = dirname(fileURLToPath(import.meta.url));
const APP_ENTRY = "file:///Applications/PwrGit.app/out/renderer/index.html";
const DEV_URL = "http://localhost:5173";

type WindowOpenHandler = (details: { url: string }) => { action: string };
type NavigationHandler = (
  event: { preventDefault: () => void },
  url: string
) => void;

/** Lets the handlers' `.then` callbacks run before an assertion reads them. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

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

// Saved rather than deleted: vitest reuses a worker process across test files
// and does not reset process.env between them, so clearing this outright would
// clobber it for whatever runs next when a developer has it exported.
const realRendererUrl = process.env["ELECTRON_RENDERER_URL"];

function setRendererUrl(value: string | undefined): void {
  if (value === undefined) delete process.env["ELECTRON_RENDERER_URL"];
  else process.env["ELECTRON_RENDERER_URL"] = value;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.openExternal.mockResolvedValue(undefined);
  setRendererUrl(undefined);
});

afterEach(() => {
  setRendererUrl(realRendererUrl);
});

describe("window-open hardening", () => {
  it("hands an ordinary https link to the OS browser", async () => {
    expect(hardenedWindow().openWindow("https://github.com/pwrdrvr/PwrGit")).toEqual({
      action: "deny"
    });

    await settle();
    expect(mocks.openExternal).toHaveBeenCalledWith(
      "https://github.com/pwrdrvr/PwrGit"
    );
    expect(mocks.logMain).not.toHaveBeenCalled();
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:token@example.com/private"
  ])("denies %s without handing it to shell.openExternal", async (url) => {
    expect(hardenedWindow().openWindow(url)).toEqual({ action: "deny" });

    await settle();
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.logMain).toHaveBeenCalledWith(
      "warn",
      "window-guards",
      "refused a window-open link:",
      expect.stringContaining("HTTP or HTTPS"),
      expect.any(String)
    );
  });

  it("opens nothing at all for a window that denies outbound links", async () => {
    expect(
      hardenedWindow({ windowOpen: "deny" }).openWindow("https://example.com")
    ).toEqual({ action: "deny" });

    await settle();
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.logMain).toHaveBeenCalledWith(
      "warn",
      "window-guards",
      "refused a window-open link: this window opens nothing",
      "https://example.com"
    );
  });
});

describe("refusal logging", () => {
  // main.log is a file on disk that Help → Logs also shows for copying into
  // bug reports, and every URL reaching these guards is renderer-supplied.
  it("keeps embedded credentials out of the refusal log", async () => {
    hardenedWindow().openWindow("https://user:ghp_secret@example.com/private");

    await settle();
    const logged = String(mocks.logMain.mock.calls.at(0)?.at(-1));
    expect(logged).toBe("https://example.com");
    expect(logged).not.toContain("ghp_secret");
    expect(logged).not.toContain("user:");
  });

  it("keeps query strings out of the blocked-navigation log", () => {
    hardenedWindow().navigateTo("https://evil.example/cb?code=oauth-secret");

    expect(mocks.logMain).toHaveBeenCalledWith(
      "warn",
      "window-guards",
      "blocked renderer navigation:",
      "https://evil.example"
    );
    expect(String(mocks.logMain.mock.calls.at(0))).not.toContain("oauth-secret");
  });

  it("names an unparseable URL without echoing it", async () => {
    hardenedWindow().openWindow("not a url");

    await settle();
    expect(mocks.logMain).toHaveBeenCalledWith(
      "warn",
      "window-guards",
      "refused a window-open link:",
      expect.any(String),
      "<unparseable URL>"
    );
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
      "https://evil.example"
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
    setRendererUrl(DEV_URL);
    const window = hardenedWindow();

    expect(window.navigateTo(`${DEV_URL}/`)).toEqual({ prevented: false });
    expect(window.navigateTo(`${DEV_URL}/#logs`)).toEqual({ prevented: false });
    expect(mocks.logMain).not.toHaveBeenCalled();
  });

  it("prevents another localhost port even while the dev server runs", () => {
    setRendererUrl(DEV_URL);

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

/**
 * The stub above proves the helper is right; it cannot prove anyone calls it.
 * Since the whole point of routing every window through one helper is that a
 * window added later cannot silently inherit weaker defaults, the scan below
 * is what actually holds that invariant — a sixth factory that forgets the
 * call fails here rather than shipping unguarded.
 */
describe("every window factory applies the hardening", () => {
  function sourceFiles(root: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...sourceFiles(path));
        continue;
      }
      if (extname(entry.name) !== ".ts") continue;
      if (/\.test\.ts$/.test(entry.name)) continue;
      files.push(path);
    }
    return files;
  }

  const factories = sourceFiles(MAIN)
    .filter((path) => readFileSync(path, "utf8").includes("new BrowserWindow("))
    .map((path) => relative(resolve(MAIN, "../../../.."), path));

  it("finds the known window factories", () => {
    // A scan that silently matches nothing would pass every case below.
    expect(factories.length).toBeGreaterThanOrEqual(5);
  });

  it.each(factories)("%s calls applyWindowSecurityHardening", (factory) => {
    const source = readFileSync(resolve(MAIN, "../../../..", factory), "utf8");
    expect(source).toContain("applyWindowSecurityHardening(");
  });
});
