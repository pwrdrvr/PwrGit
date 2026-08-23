import { join } from "node:path";
import { BrowserWindow, shell } from "electron";
import { serializeAppearanceArg, type AppAppearance } from "@pwrgit/shared";
import {
  auxiliaryWindowChromeOptions,
  hideAuxiliaryWindowMenuBar
} from "./auxiliary-window-chrome";
import { windowChrome } from "./window-chrome";

/**
 * Singleton Settings window (same aux-window pattern as the Logs window /
 * PwrAgnt's window-open-settings): the renderer boots on the `#settings` hash
 * and renders the SettingsWindow feature instead of the app shell. Not
 * profile-bound — app settings are global; the Profiles section manages every
 * profile from one place.
 */
let settingsWindow: BrowserWindow | undefined;

export function openSettingsWindow(appearance: AppAppearance): void {
  if (settingsWindow !== undefined && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: "PwrGit Settings",
    ...auxiliaryWindowChromeOptions(appearance.resolvedTheme),
    backgroundColor: windowChrome(appearance.resolvedTheme).background,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [serializeAppearanceArg(appearance)]
    }
  });

  hideAuxiliaryWindowMenuBar(window);

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl !== undefined) {
    void window.loadURL(`${rendererUrl}#settings`);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"), {
      hash: "settings"
    });
  }

  window.on("closed", () => {
    if (settingsWindow === window) settingsWindow = undefined;
  });
  settingsWindow = window;
}
