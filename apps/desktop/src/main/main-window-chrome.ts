import type { BrowserWindowConstructorOptions } from "electron";
import {
  DEFAULT_WINDOW_CHROME_THEME,
  titleBarOverlay,
  type WindowChromeTheme
} from "./window-chrome";

type MainChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
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
 *   uses. Nothing has to suppress the native Linux menu bar to make room for
 *   the painted one: `titleBarStyle: "hidden"` is what `frame: false` is, and
 *   Electron's `RootView::SetMenu` returns before building a menu bar for a
 *   window with no frame. It registers that menu's accelerators first, so
 *   Ctrl+, and Ctrl+Shift+L keep working with no bar to attach them to.
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

  return { titleBarStyle: "hidden" };
}

