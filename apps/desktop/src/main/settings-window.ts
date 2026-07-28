import { join } from "node:path";
import { BrowserWindow, shell } from "electron";

/**
 * Singleton Settings window (same aux-window pattern as the Logs window /
 * PwrAgnt's window-open-settings): the renderer boots on the `#settings` hash
 * and renders the SettingsWindow feature instead of the app shell. Not
 * profile-bound — app settings are global; the Profiles section manages every
 * profile from one place.
 */
let settingsWindow: BrowserWindow | undefined;

export function openSettingsWindow(): void {
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
    backgroundColor: "#0a0908",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

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
