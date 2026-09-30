/**
 * Window chrome colors.
 *
 * These paint before the renderer exists — `backgroundColor` fills the frame
 * during the pre-paint flash, and Windows draws its title-bar overlay from the
 * main process — so they cannot read CSS custom properties. They are therefore
 * hand-mirrored from `renderer/src/styles/tokens.css` and must be updated
 * together with it; `theme-contract.test.ts` fails if they drift.
 *
 * Both palettes live here so BrowserWindow construction and live native-chrome
 * repainting share one source of truth.
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

/** The renderer's `.titlebar` fill: 40px, with its 1px divider below that,
 * so the overlay covers exactly the fill and the divider continues beneath
 * the native Windows caption buttons instead of disappearing under them. */
export const TITLE_BAR_OVERLAY_HEIGHT = 40;

/**
 * Where macOS draws the stoplights inside our `hiddenInset` windows. The main
 * window and every auxiliary window share it; their title strips are the
 * same `.titlebar`. Pwr-family values — PwrAgent's
 * `MACOS_TRAFFIC_LIGHT_POSITION` is the same point, and the strip spec lives
 * in `renderer/src/features/chrome/AGENTS.md`.
 *
 * - **x = 16** is the strip's `padding-left`, the family rail inset.
 * - **y = 13** centres the 14px button (measured on macOS 26; Electron's y is
 *   the top of the button) in the strip's 40px fill: (40 - 14) / 2 = 13, the
 *   y=20 centreline that the mark, the wordmark's capitals, the breadcrumb
 *   chevron and the branch and path chips all centre on. The fill has to be
 *   an even height for this to be a whole point — Electron takes no halves.
 *
 * The group ends at x=76; the strip's 80px macOS gutter puts the brand at 96.
 * This was `{ x: 12, y: 10 }` in the old 32px strip, which centred the
 * stoplights 1.5px below its chips and 2.75px below the wordmark's capitals.
 */
export const MACOS_TRAFFIC_LIGHT_POSITION = { x: 16, y: 13 } as const;

export function windowChrome(theme: WindowChromeTheme) {
  return WINDOW_CHROME_BY_THEME[theme];
}

export function titleBarOverlay(theme: WindowChromeTheme): {
  color: string;
  symbolColor: string;
  height: number;
} {
  const chrome = windowChrome(theme);
  return {
    color: chrome.titleBar,
    symbolColor: chrome.symbol,
    height: TITLE_BAR_OVERLAY_HEIGHT
  };
}

export type RepaintableWindowChrome = {
  isDestroyed: () => boolean;
  setBackgroundColor: (color: string) => void;
  setTitleBarOverlay: (options: ReturnType<typeof titleBarOverlay>) => void;
};

/** Repaint one already-open native frame to match its renderer palette. */
export function repaintWindowChrome(
  window: RepaintableWindowChrome,
  theme: WindowChromeTheme,
  platform: NodeJS.Platform = process.platform
): void {
  if (window.isDestroyed()) return;
  window.setBackgroundColor(windowChrome(theme).background);
  if (platform === "win32") window.setTitleBarOverlay(titleBarOverlay(theme));
}
