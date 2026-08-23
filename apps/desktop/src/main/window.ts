import { join } from "node:path";
import { BrowserWindow, shell } from "electron";
import { serializeAppearanceArg, type AppAppearance } from "@pwrgit/shared";
import { titleBarOverlay, windowChrome } from "./window-chrome";

/**
 * Create a profile-bound window (one window per profile). Frameless-inset
 * titlebar on macOS, custom title-bar overlay on Windows; the renderer paints
 * its own titlebar row and Windows top-level menu labels. Native submenus stay
 * in the main process. The bound profile travels via additionalArguments so
 * the preload can expose it before the renderer boots.
 */
export function createMainWindow(
  profileId: string,
  appearance: AppAppearance
): BrowserWindow {
  const chrome = windowChrome(appearance.resolvedTheme);
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: chrome.background,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 12, y: 10 },
    ...(process.platform === "win32"
      ? {
          titleBarOverlay: titleBarOverlay(appearance.resolvedTheme)
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--pwrgit-profile=${profileId}`,
        serializeAppearanceArg(appearance)
      ]
    }
  });

  window.once("ready-to-show", () => window.show());

  // Open external links in the OS browser; never navigate the app frame away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl !== undefined) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}
