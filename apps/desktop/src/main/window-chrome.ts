/**
 * Window chrome colors.
 *
 * These paint before the renderer exists — `backgroundColor` fills the frame
 * during the pre-paint flash, and Windows draws its title-bar overlay from the
 * main process — so they cannot read CSS custom properties. They are therefore
 * hand-mirrored from `renderer/src/styles/tokens.css` and must be updated
 * together with it; `theme-contract.test.ts` fails if they drift.
 *
 * Dark-theme values only. Making these follow the active theme needs the
 * appearance plumbing (config read + `data-theme`), which lands separately.
 */

/** Mirrors `--bg-app`. The frame color behind every window before first paint. */
export const WINDOW_BACKGROUND = "#000000";

/** Mirrors `--bg-titlebar`. Windows title-bar overlay fill. */
export const TITLE_BAR_OVERLAY_BACKGROUND = "#050505";

/** Mirrors `--text-secondary`. Windows caption-button glyph color. */
export const TITLE_BAR_OVERLAY_SYMBOL = "#b8b0a5";

/** Must match the renderer's `.titlebar` height, or the painted strip and the
 *  OS caption buttons sit on different lines. */
export const TITLE_BAR_OVERLAY_HEIGHT = 32;
