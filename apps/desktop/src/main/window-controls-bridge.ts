import { BrowserWindow, ipcMain } from "electron";
import {
  WINDOW_CONTROL_CHANNEL,
  WINDOW_FRAME_STATE_CHANNEL,
  type WindowFrameState
} from "@pwrgit/shared";

/**
 * Back the caption buttons the renderer paints on Linux.
 *
 * macOS draws traffic lights into the inset strip and Windows fills the Window
 * Controls Overlay, so on those two the OS owns minimize / maximize / close.
 * Linux has neither in a frameless window: without this bridge the window has
 * no buttons at all. The renderer owns the pixels (`WindowControls.tsx`);
 * everything that touches the window itself stays here.
 */

/** The slice that can answer what the button should draw. */
export type ReadableWindow = Pick<BrowserWindow, "isDestroyed" | "isMaximized">;

/** The slice of BrowserWindow a control action needs. */
export type ControllableWindow = Pick<
  BrowserWindow,
  "isDestroyed" | "isMaximized" | "minimize" | "maximize" | "unmaximize" | "close"
>;

/** The slice that reports its own maximize changes. */
export type ObservableWindow = Pick<
  BrowserWindow,
  "on" | "isDestroyed" | "isMaximized" | "webContents"
>;

function frameState(window: ReadableWindow): WindowFrameState | null {
  return window.isDestroyed() ? null : { maximized: window.isMaximized() };
}

/**
 * Run one control action.
 *
 * It answers nothing: the button redraws from the window's own maximize and
 * unmaximize events (`trackWindowFrameState`), which is the only account that
 * stays honest when the window manager declines a `maximize()` or maximizes
 * from somewhere else entirely. An unknown action is ignored rather than
 * trusted — this arrives over IPC, and `close()` is not something to reach by
 * falling through a switch.
 */
export function applyWindowControl(
  window: ControllableWindow,
  action: unknown
): void {
  if (window.isDestroyed()) return;
  switch (action) {
    case "minimize":
      window.minimize();
      return;
    case "toggle-maximize":
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
      return;
    case "close":
      window.close();
      return;
    default:
      return;
  }
}

/**
 * Push maximize changes to the window's renderer.
 *
 * The window manager maximizes windows without going through our buttons — a
 * double-click on the drag region, Super+Up, a tiling keybind — so the glyph
 * has to follow the window, not the last click.
 */
export function trackWindowFrameState(window: ObservableWindow): void {
  const push = (): void => {
    if (window.isDestroyed()) return;
    window.webContents.send(WINDOW_FRAME_STATE_CHANNEL, {
      maximized: window.isMaximized()
    } satisfies WindowFrameState);
  };
  window.on("maximize", push);
  window.on("unmaximize", push);
}

let wired = false;

/** Register once; every window's renderer shares these two channels. */
export function wireWindowControlsBridge(): void {
  if (wired) return;
  wired = true;

  ipcMain.handle(WINDOW_CONTROL_CHANNEL, (event, action: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window !== null) applyWindowControl(window, action);
  });

  // The same channel the pushes above ride on: invoke it for the state a
  // window already has, listen to it for the changes that follow.
  ipcMain.handle(WINDOW_FRAME_STATE_CHANNEL, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) return null;
    return frameState(window);
  });
}
