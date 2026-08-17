/**
 * Window chrome colors.
 *
 * These paint before the renderer exists — `backgroundColor` fills the frame
 * during the pre-paint flash, and Windows draws its title-bar overlay from the
 * main process — so they cannot read CSS custom properties. They are therefore
 * hand-mirrored from `renderer/src/styles/tokens.css` and must be updated
 * together with it; `theme-contract.test.ts` fails if they drift.
 *
 * The renderer currently boots in dark mode, but both palettes live here so
 * the upcoming appearance plumbing has one switch point for pre-paint frames,
 * Windows caption buttons, and Electron's native surfaces.
 */

export type WindowChromeTheme = "dark" | "light";

export const DEFAULT_WINDOW_CHROME_THEME: WindowChromeTheme = "dark";

export const WINDOW_CHROME_BY_THEME = {
  dark: {
    background: "#000000",
    titleBar: "#050505",
    symbol: "#b8b0a5"
  },
  light: {
    background: "#ffffff",
    titleBar: "#f7f4ef",
    symbol: "#524a40"
  }
} as const satisfies Record<
  WindowChromeTheme,
  { background: string; titleBar: string; symbol: string }
>;

/** Mirrors `--bg-app`. The frame color behind every window before first paint. */
export const WINDOW_BACKGROUND =
  WINDOW_CHROME_BY_THEME[DEFAULT_WINDOW_CHROME_THEME].background;

/** Mirrors `--bg-titlebar`. Windows title-bar overlay fill. */
export const TITLE_BAR_OVERLAY_BACKGROUND =
  WINDOW_CHROME_BY_THEME[DEFAULT_WINDOW_CHROME_THEME].titleBar;

/** Mirrors `--text-secondary`. Windows caption-button glyph color. */
export const TITLE_BAR_OVERLAY_SYMBOL =
  WINDOW_CHROME_BY_THEME[DEFAULT_WINDOW_CHROME_THEME].symbol;

/** One pixel shorter than the renderer's 32px `.titlebar`. The uncovered last
 * pixel is its bottom border, so the divider continues beneath the native
 * Windows caption buttons instead of disappearing under the overlay. */
export const TITLE_BAR_OVERLAY_HEIGHT = 31;

/** Keep native popup menus and dialogs aligned with the renderer theme. */
export function applyNativeWindowTheme(
  nativeTheme: { themeSource: "system" | WindowChromeTheme },
  theme: WindowChromeTheme = DEFAULT_WINDOW_CHROME_THEME
): void {
  nativeTheme.themeSource = theme;
}
