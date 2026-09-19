import { showWindowWhenReady } from "./show-window-when-ready";
import { join } from "node:path";
import { BrowserWindow } from "electron";
import {
  serializeAppearanceArg,
  settingsRouteHash,
  type AppAppearance,
  type SettingsRoute
} from "@pwrgit/shared";
import {
  auxiliaryWindowChromeOptions,
  hideAuxiliaryWindowMenuBar
} from "./auxiliary-window-chrome";
import { windowChrome } from "./window-chrome";
import { emitEventToWindow } from "./ipc";
import { applyWindowSecurityHardening } from "./window-security";

/**
 * Singleton Settings window (same aux-window pattern as the Logs window /
 * PwrAgnt's window-open-settings): the renderer boots on the `#settings` hash
 * and renders the SettingsWindow feature instead of the app shell. Not
 * profile-bound — app settings are global; the Profiles section manages every
 * profile from one place. Its *palette* is borrowed from whichever window
 * opened it (see `window-appearance.ts`), so summoning Settings from a
 * light-pinned profile window doesn't hand back a dark one.
 *
 * `route` deep-links a page (and a card on it). A window that is already open
 * is told over `settings:navigate`; a new one boots on the route's hash, so
 * the page is right on the first paint instead of one push after it —
 * a push to a renderer still loading would land before anything subscribed.
 */
let settingsWindow: BrowserWindow | undefined;

export function openSettingsWindow(
  appearance: AppAppearance,
  route?: SettingsRoute
): BrowserWindow {
  if (settingsWindow !== undefined && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
    if (route !== undefined) emitEventToWindow("settings:navigate", route, settingsWindow);
    return settingsWindow;
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

  showWindowWhenReady(window);
  applyWindowSecurityHardening(window);

  const hash = settingsRouteHash(route);
  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl !== undefined) {
    void window.loadURL(`${rendererUrl}${hash}`);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"), {
      hash: hash.slice(1)
    });
  }

  window.on("closed", () => {
    if (settingsWindow === window) settingsWindow = undefined;
  });
  settingsWindow = window;
  return window;
}
