import { describe, expect, it, vi } from "vitest";
import {
  auxiliaryWindowChromeOptions,
  hideAuxiliaryWindowMenuBar
} from "./auxiliary-window-chrome";
import {
  applyNativeWindowTheme,
  TITLE_BAR_OVERLAY_BACKGROUND,
  TITLE_BAR_OVERLAY_HEIGHT,
  TITLE_BAR_OVERLAY_SYMBOL
} from "./window-chrome";

describe("auxiliary window chrome", () => {
  it("keeps Electron-owned surfaces on the active app theme", () => {
    const nativeTheme = { themeSource: "system" as const };
    applyNativeWindowTheme(nativeTheme);
    expect(nativeTheme.themeSource).toBe("dark");
  });

  it("uses the themed overlay and hides the native menu on Windows", () => {
    expect(auxiliaryWindowChromeOptions("win32")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: TITLE_BAR_OVERLAY_BACKGROUND,
        symbolColor: TITLE_BAR_OVERLAY_SYMBOL,
        height: TITLE_BAR_OVERLAY_HEIGHT
      },
      autoHideMenuBar: true
    });

    const window = {
      setAutoHideMenuBar: vi.fn(),
      setMenuBarVisibility: vi.fn()
    };
    hideAuxiliaryWindowMenuBar(window, "win32");
    expect(window.setAutoHideMenuBar).toHaveBeenCalledWith(true);
    expect(window.setMenuBarVisibility).toHaveBeenCalledWith(false);
  });

  it("reserves macOS traffic lights without disabling windowed zoom", () => {
    expect(auxiliaryWindowChromeOptions("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 10 },
      fullscreenable: false,
      maximizable: true
    });

    const window = {
      setAutoHideMenuBar: vi.fn(),
      setMenuBarVisibility: vi.fn()
    };
    hideAuxiliaryWindowMenuBar(window, "darwin");
    expect(window.setAutoHideMenuBar).not.toHaveBeenCalled();
    expect(window.setMenuBarVisibility).not.toHaveBeenCalled();
  });

  it("keeps the native Linux frame but hides its per-window menu", () => {
    expect(auxiliaryWindowChromeOptions("linux")).toEqual({
      autoHideMenuBar: true
    });
  });
});
