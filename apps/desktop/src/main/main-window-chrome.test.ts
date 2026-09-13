import { describe, expect, it } from "vitest";
import { mainWindowChromeOptions } from "./main-window-chrome";
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

  it("goes frameless on Linux, where nothing else is on offer", () => {
    // No overlay to reserve and no menu bar to suppress — Electron builds none
    // for a frameless window, which is what `hidden` makes this.
    expect(mainWindowChromeOptions("dark", "linux")).toEqual({
      titleBarStyle: "hidden"
    });
  });

});
