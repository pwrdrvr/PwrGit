import { describe, expect, it, vi } from "vitest";
import {
  createNativeThemeController,
  type NativeThemeLike
} from "./native-theme";

function harness(initialShouldUseDarkColors = true) {
  let systemShouldUseDarkColors = initialShouldUseDarkColors;
  let themeSource: NativeThemeLike["themeSource"] = "system";
  let updated: (() => void) | undefined;
  const nativeTheme: NativeThemeLike = {
    get themeSource() {
      return themeSource;
    },
    set themeSource(value) {
      themeSource = value;
    },
    get shouldUseDarkColors() {
      if (themeSource === "dark") return true;
      if (themeSource === "light") return false;
      return systemShouldUseDarkColors;
    },
    on: (_event, listener) => {
      updated = listener;
    },
    removeListener: (_event, listener) => {
      if (updated === listener) updated = undefined;
    }
  };
  const window = {
    isDestroyed: () => false,
    setBackgroundColor: vi.fn(),
    setTitleBarOverlay: vi.fn()
  };
  const changes: Array<{ theme: string; resolvedTheme: string }> = [];
  const controller = createNativeThemeController({
    nativeTheme,
    initialTheme: "dark",
    platform: "win32",
    windows: () => [window],
    onChanged: (appearance) => changes.push(appearance)
  });
  return {
    nativeTheme,
    window,
    changes,
    controller,
    updateSystem: (dark: boolean) => {
      systemShouldUseDarkColors = dark;
      updated?.();
    },
    hasListener: () => updated !== undefined
  };
}

describe("native theme controller", () => {
  it("applies a forced theme to Electron and all Windows chrome", () => {
    const h = harness(true);
    h.controller.setTheme("light");

    expect(h.nativeTheme.themeSource).toBe("light");
    expect(h.controller.appearance()).toEqual({
      theme: "light",
      resolvedTheme: "light"
    });
    expect(h.window.setBackgroundColor).toHaveBeenCalledWith("#ffffff");
    expect(h.window.setTitleBarOverlay).toHaveBeenCalledWith({
      color: "#f7f4ef",
      symbolColor: "#524a40",
      height: 31
    });
  });

  it("responds live to OS changes only while System is selected", () => {
    const h = harness(true);
    h.controller.setTheme("system");
    h.updateSystem(false);

    expect(h.controller.appearance()).toEqual({
      theme: "system",
      resolvedTheme: "light"
    });
    expect(h.window.setBackgroundColor).toHaveBeenLastCalledWith("#ffffff");
    expect(h.window.setTitleBarOverlay).toHaveBeenLastCalledWith({
      color: "#f7f4ef",
      symbolColor: "#524a40",
      height: 31
    });
    expect(h.changes.at(-1)).toEqual({
      theme: "system",
      resolvedTheme: "light"
    });

    h.controller.setTheme("dark");
    const changeCount = h.changes.length;
    h.updateSystem(true);
    expect(h.changes).toHaveLength(changeCount);
  });

  it("repaints macOS frame backgrounds without a Windows overlay", () => {
    const h = harness(false);
    const controller = createNativeThemeController({
      nativeTheme: h.nativeTheme,
      initialTheme: "system",
      platform: "darwin",
      windows: () => [h.window],
      onChanged: () => undefined
    });
    controller.setTheme("light");
    expect(h.window.setBackgroundColor).toHaveBeenCalledWith("#ffffff");
    expect(h.window.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it("removes its nativeTheme listener on dispose", () => {
    const h = harness();
    expect(h.hasListener()).toBe(true);
    h.controller.dispose();
    expect(h.hasListener()).toBe(false);
  });
});
