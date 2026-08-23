import { describe, expect, it, vi } from "vitest";
import {
  auxiliaryWindowChromeOptions,
  hideAuxiliaryWindowMenuBar
} from "./auxiliary-window-chrome";
import { titleBarOverlay } from "./window-chrome";

describe("auxiliary window chrome", () => {
  it.each(["dark", "light"] as const)(
    "uses the %s overlay and hides the native menu on Windows",
    (theme) => {
      expect(auxiliaryWindowChromeOptions(theme, "win32")).toEqual({
        titleBarStyle: "hidden",
        titleBarOverlay: titleBarOverlay(theme),
        autoHideMenuBar: true
      });

      const window = {
        setAutoHideMenuBar: vi.fn(),
        setMenuBarVisibility: vi.fn()
      };
      hideAuxiliaryWindowMenuBar(window, "win32");
      expect(window.setAutoHideMenuBar).toHaveBeenCalledWith(true);
      expect(window.setMenuBarVisibility).toHaveBeenCalledWith(false);
    }
  );

  it("reserves macOS traffic lights without disabling windowed zoom", () => {
    expect(auxiliaryWindowChromeOptions("dark", "darwin")).toEqual({
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
    expect(auxiliaryWindowChromeOptions("dark", "linux")).toEqual({
      autoHideMenuBar: true
    });
  });
});
