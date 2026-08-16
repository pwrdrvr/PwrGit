import type {
  BrowserWindow,
  BrowserWindowConstructorOptions
} from "electron";
import {
  TITLE_BAR_OVERLAY_BACKGROUND,
  TITLE_BAR_OVERLAY_HEIGHT,
  TITLE_BAR_OVERLAY_SYMBOL
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
      titleBarOverlay: {
        color: TITLE_BAR_OVERLAY_BACKGROUND,
        symbolColor: TITLE_BAR_OVERLAY_SYMBOL,
        height: TITLE_BAR_OVERLAY_HEIGHT
      },
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
