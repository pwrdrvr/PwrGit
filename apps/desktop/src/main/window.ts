import { showWindowWhenReady } from "./show-window-when-ready";
import { join } from "node:path";
import { BrowserWindow, shell } from "electron";
import { serializeAppearanceArg, type AppAppearance } from "@pwrgit/shared";
import {
  hideNativeMenuBar,
  mainWindowChromeOptions
} from "./main-window-chrome";
import { windowChrome } from "./window-chrome";

/**
 * Create a profile-bound window (one window per profile). Frameless-inset
 * titlebar on macOS, custom title-bar overlay on Windows, plain frameless on
 * Linux; the renderer paints its own titlebar row, the top-level menu labels
 * everywhere but macOS, and the caption buttons on Linux. Native submenus and
 * the window itself stay in the main process — see main-window-chrome.ts and
 * window-controls-bridge.ts, which index.ts wires to every window. The bound profile travels via additionalArguments
 * so the preload can expose it before the renderer boots.
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
    ...mainWindowChromeOptions(appearance.resolvedTheme),
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

  hideNativeMenuBar(window);
  showWindowWhenReady(window);

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
