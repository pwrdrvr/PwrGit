import { describe, expect, it, vi } from "vitest";
import {
  hideNativeMenuBar,
  mainWindowChromeOptions
} from "./main-window-chrome";
import { titleBarOverlay } from "./window-chrome";

describe("main window chrome", () => {
  it("insets the macOS traffic lights into the strip", () => {
    expect(mainWindowChromeOptions("dark", "darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 10 }
    });
  });

  it.each(["dark", "light"] as const)(
    "reserves the %s Windows controls overlay",
    (theme) => {
      expect(mainWindowChromeOptions(theme, "win32")).toEqual({
        titleBarStyle: "hidden",
        titleBarOverlay: titleBarOverlay(theme)
      });
    }
  );

  it("goes frameless on Linux without arming the Alt menu-bar reveal", () => {
    expect(mainWindowChromeOptions("dark", "linux")).toEqual({
      titleBarStyle: "hidden",
      autoHideMenuBar: false
    });
  });

  it("hides the Linux menu bar while leaving the menu attached", () => {
    const window = {
      setAutoHideMenuBar: vi.fn(),
      setMenuBarVisibility: vi.fn()
    };
    hideNativeMenuBar(window, "linux");
    expect(window.setAutoHideMenuBar).toHaveBeenCalledWith(false);
    expect(window.setMenuBarVisibility).toHaveBeenCalledWith(false);
  });

  it.each(["darwin", "win32"] as const)(
    "leaves the %s menu bar alone — there is none in the window",
    (platform) => {
      const window = {
        setAutoHideMenuBar: vi.fn(),
        setMenuBarVisibility: vi.fn()
      };
      hideNativeMenuBar(window, platform);
      expect(window.setAutoHideMenuBar).not.toHaveBeenCalled();
      expect(window.setMenuBarVisibility).not.toHaveBeenCalled();
    }
  );
});
