import type {
  BrowserWindow,
  BrowserWindowConstructorOptions
} from "electron";
import {
  DEFAULT_WINDOW_CHROME_THEME,
  titleBarOverlay,
  type WindowChromeTheme
} from "./window-chrome";

type MainChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  | "autoHideMenuBar"
  | "titleBarOverlay"
  | "titleBarStyle"
  | "trafficLightPosition"
>;

/**
 * Platform chrome for a profile window. Every platform hides the system title
 * bar so the renderer can paint the strip; what differs is who draws the
 * window buttons and where the File/Edit menu lives.
 *
 * - **macOS** keeps its traffic lights, inset into our strip.
 * - **Windows** reserves the Window Controls Overlay at the right edge and the
 *   OS paints min/max/close into it. The menu bar lived in the title bar we
 *   hid, so the renderer paints the top-level labels and pops native submenus
 *   through the app-menu bridge.
 * - **Linux** has neither: `titleBarStyle: "hidden"` there is a plain
 *   frameless window with no overlay API, so the renderer paints the caption
 *   buttons itself (`WindowControls.tsx`) alongside the same menu bar Windows
 *   uses. `autoHideMenuBar` stays *false* on purpose — auto-hide is what lets
 *   a single Alt press pop the native bar back up over our painted one; with
 *   it off, `hideNativeMenuBar` below can take the bar away for good while the
 *   menu stays attached to the window, which is what keeps its accelerators
 *   (Ctrl+, Ctrl+Shift+L …) alive.
 */
export function mainWindowChromeOptions(
  theme: WindowChromeTheme = DEFAULT_WINDOW_CHROME_THEME,
  platform: NodeJS.Platform = process.platform
): MainChromeOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 10 }
    };
  }

  if (platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: titleBarOverlay(theme)
    };
  }

  return { titleBarStyle: "hidden", autoHideMenuBar: false };
}

/**
 * Take the native in-window menu bar off a frameless Linux window.
 *
 * Linux is the one platform that draws the application menu inside the window
 * rather than in the title bar or the system bar, so a frameless window can
 * still sprout a Chromium-drawn File/Edit row above our strip. Hiding it
 * without auto-hide leaves the menu attached — accelerators keep working, and
 * `Menu.getApplicationMenu()` still answers the app-menu bridge — while Alt no
 * longer reveals a second menu bar on top of the painted one.
 */
export function hideNativeMenuBar(
  window: Pick<BrowserWindow, "setAutoHideMenuBar" | "setMenuBarVisibility">,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== "linux") return;
  window.setAutoHideMenuBar(false);
  window.setMenuBarVisibility(false);
}
