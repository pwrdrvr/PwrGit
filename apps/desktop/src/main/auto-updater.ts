import { app } from "electron";
// electron-updater is CommonJS; import the default and destructure so the
// strict-ESM main bundle can load it (named ESM imports fail at runtime).
import electronUpdater from "electron-updater";

/**
 * Check for updates on startup in the packaged app only. electron-updater
 * downloads in the background and `checkForUpdatesAndNotify` surfaces a native
 * notification; the update installs on the next quit. No-ops (and swallows
 * errors) in dev or when no update feed is configured.
 */
export function initAutoUpdater(): void {
  if (!app.isPackaged) return;
  const { autoUpdater } = electronUpdater;
  autoUpdater.on("error", () => undefined);
  void autoUpdater.checkForUpdatesAndNotify().catch(() => undefined);
}
