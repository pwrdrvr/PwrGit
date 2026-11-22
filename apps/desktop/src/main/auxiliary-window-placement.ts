import type { Point, Rectangle } from "electron";

/** The parts of a BrowserWindow placement reads and moves. */
export type PlaceableWindow = {
  getBounds(): Rectangle;
  setBounds(bounds: Rectangle): void;
  isMinimized(): boolean;
  isDestroyed(): boolean;
};

/** The parts of Electron's `screen` placement asks. */
export type PlacementScreen = {
  getDisplayMatching(rect: Rectangle): { id: number; workArea: Rectangle };
  getDisplayNearestPoint(point: Point): { id: number; workArea: Rectangle };
  getCursorScreenPoint(): Point;
};

/**
 * Where an auxiliary window of `size` goes: centered over `opener`, or over
 * `workArea` when nothing opened it, then shrunk and slid until it fits the
 * work area. `workArea` is the opener's display's.
 */
export function auxiliaryWindowBounds(
  size: { width: number; height: number },
  workArea: Rectangle,
  opener: Rectangle | null
): Rectangle {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  const around = opener ?? workArea;
  const centerX = around.x + around.width / 2;
  const centerY = around.y + around.height / 2;
  return {
    x: clamp(Math.round(centerX - width / 2), workArea.x, workArea.x + workArea.width - width),
    y: clamp(Math.round(centerY - height / 2), workArea.y, workArea.y + workArea.height - height),
    width,
    height
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Auxiliary windows (Settings, Logs, the document viewers) open on the display
 * of the window that summoned them, centered over it. Left to itself Electron
 * centers a new window on the primary display, which with several monitors is
 * often not the one the user is looking at.
 *
 * A window is placed the first time it is seen. A singleton summoned again is
 * moved only when it sits on another display than the opener: one the user
 * already put somewhere on this display stays put. With no opener (a menu
 * item with nothing focused) the cursor's display stands in for it.
 */
export function createAuxiliaryWindowPlacer(
  screen: PlacementScreen
): (window: PlaceableWindow, opener: PlaceableWindow | null) => void {
  const placed = new WeakSet<PlaceableWindow>();
  return (window, opener) => {
    if (window.isDestroyed()) return;
    const from =
      opener !== null && opener !== window && !opener.isDestroyed() && !opener.isMinimized()
        ? opener.getBounds()
        : null;
    // Re-summoned from itself, or from nowhere: leave a placed window alone.
    if (from === null && placed.has(window)) return;
    const display =
      from === null
        ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
        : screen.getDisplayMatching(from);
    const current = window.getBounds();
    if (placed.has(window) && screen.getDisplayMatching(current).id === display.id) return;
    placed.add(window);
    window.setBounds(auxiliaryWindowBounds(current, display.workArea, from));
  };
}
