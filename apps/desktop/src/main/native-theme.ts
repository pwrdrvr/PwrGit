import {
  resolveAppearanceTheme,
  type AppAppearance,
  type AppearanceTheme
} from "@pwrgit/shared";
import { titleBarOverlay, windowChrome } from "./window-chrome";

export type NativeThemeLike = {
  themeSource: AppearanceTheme;
  readonly shouldUseDarkColors: boolean;
  on: (event: "updated", listener: () => void) => unknown;
  removeListener: (event: "updated", listener: () => void) => unknown;
};

export type ThemeableWindow = {
  isDestroyed: () => boolean;
  setBackgroundColor: (color: string) => void;
  setTitleBarOverlay: (options: {
    color?: string;
    symbolColor?: string;
    height?: number;
  }) => void;
};

export type NativeThemeController = {
  appearance: () => AppAppearance;
  setTheme: (theme: AppearanceTheme) => void;
  dispose: () => void;
};

/**
 * Own Electron's app-level theme and repaint every already-open native frame.
 * Renderer windows receive the same resolved value over `appearance:changed`.
 */
export function createNativeThemeController(options: {
  nativeTheme: NativeThemeLike;
  initialTheme: AppearanceTheme;
  windows: () => ThemeableWindow[];
  platform?: NodeJS.Platform;
  onChanged: (appearance: AppAppearance) => void;
}): NativeThemeController {
  const platform = options.platform ?? process.platform;
  let theme = options.initialTheme;
  let resolvedTheme = resolveAppearanceTheme(
    options.nativeTheme.shouldUseDarkColors
  );

  const repaint = (): void => {
    const chrome = windowChrome(resolvedTheme);
    for (const window of options.windows()) {
      if (window.isDestroyed()) continue;
      window.setBackgroundColor(chrome.background);
      if (platform === "win32") {
        window.setTitleBarOverlay(titleBarOverlay(resolvedTheme));
      }
    }
  };

  const publish = (): void => {
    repaint();
    options.onChanged({ theme, resolvedTheme });
  };

  const syncResolvedSystemTheme = (): void => {
    if (theme !== "system") return;
    const next = resolveAppearanceTheme(options.nativeTheme.shouldUseDarkColors);
    if (next === resolvedTheme) return;
    resolvedTheme = next;
    publish();
  };

  const setTheme = (next: AppearanceTheme): void => {
    const preferenceChanged = theme !== next;
    theme = next;
    options.nativeTheme.themeSource = next;
    const nextResolved = resolveAppearanceTheme(
      options.nativeTheme.shouldUseDarkColors
    );
    const resolutionChanged = resolvedTheme !== nextResolved;
    resolvedTheme = nextResolved;
    if (preferenceChanged || resolutionChanged) publish();
  };

  options.nativeTheme.on("updated", syncResolvedSystemTheme);
  // Set the source before resolving once more: forced light/dark changes
  // shouldUseDarkColors synchronously in Electron.
  options.nativeTheme.themeSource = theme;
  resolvedTheme = resolveAppearanceTheme(options.nativeTheme.shouldUseDarkColors);

  return {
    appearance: () => ({ theme, resolvedTheme }),
    setTheme,
    dispose: () => {
      options.nativeTheme.removeListener("updated", syncResolvedSystemTheme);
    }
  };
}
