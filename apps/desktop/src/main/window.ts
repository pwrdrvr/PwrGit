import { join } from "node:path";
import { BrowserWindow, shell } from "electron";
import {
  TITLE_BAR_OVERLAY_BACKGROUND,
  TITLE_BAR_OVERLAY_HEIGHT,
  TITLE_BAR_OVERLAY_SYMBOL,
  WINDOW_BACKGROUND
} from "./window-chrome";

/**
 * Create a profile-bound window (one window per profile). Frameless-inset
 * titlebar on macOS, custom title-bar overlay on Windows; the renderer paints
 * its own titlebar row. The bound profile travels via additionalArguments so
 * the preload can expose it before the renderer boots.
 */
export function createMainWindow(profileId: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: WINDOW_BACKGROUND,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 12, y: 10 },
    ...(process.platform === "win32"
      ? {
          titleBarOverlay: {
            color: TITLE_BAR_OVERLAY_BACKGROUND,
            symbolColor: TITLE_BAR_OVERLAY_SYMBOL,
            height: TITLE_BAR_OVERLAY_HEIGHT
          }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--pwrgit-profile=${profileId}`]
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
