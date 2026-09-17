import { showWindowWhenReady } from "./show-window-when-ready";
import { join } from "node:path";
import { BrowserWindow } from "electron";
import { serializeAppearanceArg, type AppAppearance } from "@pwrgit/shared";
import {
  auxiliaryWindowChromeOptions,
  hideAuxiliaryWindowMenuBar
} from "./auxiliary-window-chrome";
import { windowChrome } from "./window-chrome";
import { applyWindowSecurityHardening } from "./window-security";

/**
 * Singleton Logs window (PwrAgnt's app-log-window pattern): the renderer
 * boots on the `#logs` hash and renders the LogsWindow feature instead of the
 * app shell. Not profile-bound — it shows the one main-process log.
 */
let logsWindow: BrowserWindow | undefined;

export function openLogsWindow(appearance: AppAppearance): BrowserWindow {
  if (logsWindow !== undefined && !logsWindow.isDestroyed()) {
    if (logsWindow.isMinimized()) logsWindow.restore();
    logsWindow.focus();
    return logsWindow;
  }

  const window = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 700,
    minHeight: 480,
    show: false,
    title: "PwrGit Logs",
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

  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl !== undefined) {
    void window.loadURL(`${rendererUrl}#logs`);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"), {
      hash: "logs"
    });
  }

  window.on("closed", () => {
    if (logsWindow === window) logsWindow = undefined;
  });
  logsWindow = window;
  return window;
}
