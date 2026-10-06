import { app, powerMonitor } from "electron";
import { logMain } from "./logs";
import { quitWithExitFailSafe } from "./quit-retry";

/** Register after app-ready, before asynchronous startup work. */
export function watchSystemShutdown(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "linux" && platform !== "darwin") return;

  let shuttingDown = false;
  // Electron's generated types omit the event described by its shutdown API.
  powerMonitor.on("shutdown", (event?: Electron.Event) => {
    // Retain Electron's shutdown delay inhibitor until we exit. Otherwise
    // logind can kill Chromium's helpers while the browser is still alive;
    // its GPU restart attempts then produce a fatal crash during power-off.
    event?.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    logMain("info", "app", "system shutdown requested; quitting");
    // Normal quit keeps the existing cleanup path. Bound even a deferred
    // diagnostics drain below logind's usual five-second inhibitor deadline.
    quitWithExitFailSafe(app, {
      afterMs: 3_000,
      warn: (message) => logMain("warn", "app", "system shutdown:", message)
    });
  });
}
