import type {
  BrowserWindow,
  BrowserWindowConstructorOptions
} from "electron";
import {
  DEFAULT_WINDOW_CHROME_THEME,
  titleBarOverlay,
  type WindowChromeTheme
} from "./window-chrome";

type AuxiliaryChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  | "autoHideMenuBar"
  | "fullscreenable"
  | "maximizable"
  | "titleBarOverlay"
  | "titleBarStyle"
  | "trafficLightPosition"
>;

/** Platform chrome shared by every supporting window. */
export function auxiliaryWindowChromeOptions(
  theme: WindowChromeTheme = DEFAULT_WINDOW_CHROME_THEME,
  platform: NodeJS.Platform = process.platform
): AuxiliaryChromeOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 10 },
      fullscreenable: false,
      maximizable: true
    };
  }

  if (platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: titleBarOverlay(theme),
      autoHideMenuBar: true
    };
  }

  return { autoHideMenuBar: true };
}

/** Auxiliary windows do not duplicate the main window's application menu. */
export function hideAuxiliaryWindowMenuBar(
  window: Pick<BrowserWindow, "setAutoHideMenuBar" | "setMenuBarVisibility">,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === "darwin") return;
  window.setAutoHideMenuBar(true);
  window.setMenuBarVisibility(false);
}
