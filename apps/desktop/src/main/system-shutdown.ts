import { app, powerMonitor } from "electron";
import { logMain } from "./logs";
import { quitWithExitFailSafe } from "./quit-retry";

/**
 * How long after the OS asks before PwrGit exits regardless: below logind's
 * usual five-second inhibitor deadline.
 */
export const SYSTEM_SHUTDOWN_EXIT_MS = 3_000;

/**
 * How long a deferred quit may still flush during an OS shutdown. It leaves
 * the rest of SYSTEM_SHUTDOWN_EXIT_MS for the windows to close and Electron
 * to emit will-quit and quit, so cleanup runs before the exit fail-safe.
 */
export const SYSTEM_SHUTDOWN_FLUSH_MS = 2_000;

/**
 * Register after app-ready, before asynchronous startup work. `beforeQuit`
 * listeners added later run when the OS asks, before PwrGit starts quitting.
 */
export function watchSystemShutdown(platform: NodeJS.Platform = process.platform): {
  beforeQuit(listener: () => void): void;
} {
  const listeners: (() => void)[] = [];
  const handle = { beforeQuit: (listener: () => void) => void listeners.push(listener) };
  if (platform !== "linux" && platform !== "darwin") return handle;

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
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        logMain("warn", "app", "system shutdown: listener failed:", error);
      }
    }
    // Normal quit keeps the existing cleanup path, with the exit as a
    // backstop in case a listener stalls it.
    quitWithExitFailSafe(app, {
      afterMs: SYSTEM_SHUTDOWN_EXIT_MS,
      warn: (message) => logMain("warn", "app", "system shutdown:", message)
    });
  });
  return handle;
}
