import type { Point, Rectangle } from "electron";

/** The parts of a BrowserWindow placement reads and moves. */
export type PlaceableWindow = {
  getBounds(): Rectangle;
  setBounds(bounds: Rectangle): void;
  getMinimumSize(): number[];
  isMinimized(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
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
 * work area. `workArea` is the opener's display's. It never shrinks below
 * `minimum` (Electron would grow it back); a window that still cannot fit
 * keeps its top-left corner, and so its title bar, on the display.
 */
export function auxiliaryWindowBounds(
  size: { width: number; height: number },
  workArea: Rectangle,
  opener: Rectangle | null,
  minimum: { width: number; height: number } = { width: 0, height: 0 }
): Rectangle {
  const width = Math.max(Math.min(size.width, workArea.width), minimum.width);
  const height = Math.max(Math.min(size.height, workArea.height), minimum.height);
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

/** `min` wins when the range is empty, so an oversized window hangs off the
 *  right and bottom edges, never the left or top. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(Math.min(value, max), min);
}

/**
 * Auxiliary windows (Settings, Logs, the document viewers) open on the display
 * of the window that summoned them, centered over it. Left to itself Electron
 * centers a new window on the primary display, which with several monitors is
 * often not the one the user is looking at.
 *
 * A window is placed the first time it is seen. A singleton summoned again is
 * moved only when it sits on another display than the opener: one the user
 * already put somewhere on this display stays put, and so does one that is
 * maximized or full screen: moving those with setBounds breaks their state.
 * With no opener (a menu item with nothing focused) the cursor's display
 * stands in for it.
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
    if (placed.has(window)) {
      // Re-summoned from itself or from nowhere, or sized by the user to the
      // whole display: leave it alone.
      if (from === null || window.isMaximized() || window.isFullScreen()) return;
    }
    const display =
      from === null
        ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
        : screen.getDisplayMatching(from);
    const current = window.getBounds();
    if (placed.has(window) && screen.getDisplayMatching(current).id === display.id) return;
    placed.add(window);
    const [minWidth = 0, minHeight = 0] = window.getMinimumSize();
    window.setBounds(
      auxiliaryWindowBounds(current, display.workArea, from, { width: minWidth, height: minHeight })
    );
  };
}
