import { app } from "electron";
import { autoUpdater } from "electron-updater";

/**
 * Check for updates on startup in the packaged app only. electron-updater
 * downloads in the background and `checkForUpdatesAndNotify` surfaces a native
 * notification; the update installs on the next quit. No-ops (and swallows
 * errors) in dev or when no update feed is configured.
 */
export function initAutoUpdater(): void {
  if (!app.isPackaged) return;
  autoUpdater.on("error", () => undefined);
  void autoUpdater.checkForUpdatesAndNotify().catch(() => undefined);
}
