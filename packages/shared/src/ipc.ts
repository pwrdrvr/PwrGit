// IPC channel names shared by main (ipcMain.handle / webContents.send) and
// preload (ipcRenderer.invoke / on). The renderer never touches these
// directly — it goes through the preload-exposed `window.pwrgit` API.

/** Renderer → main command dispatch: `invoke(channel, name, req)`. */
export const IPC_DISPATCH_CHANNEL = "pwrgit:dispatch";

/** Main → renderer event push: `send(channel, eventChannel, payload)`. */
export const IPC_EVENT_CHANNEL = "pwrgit:event";

/** Windows custom title-bar menu: fetch visible top-level labels. */
export const APP_MENU_MODEL_CHANNEL = "pwrgit:app-menu:model";

/** Windows custom title-bar menu: open one native submenu at a renderer point. */
export const APP_MENU_POPUP_CHANNEL = "pwrgit:app-menu:popup";

export type AppMenuTopLevel = { index: number; label: string };

export type AppMenuPopupRequest = {
  index: number;
  x: number;
  y: number;
};

/** Linux painted caption buttons: run one window-control action. */
export const WINDOW_CONTROL_CHANNEL = "pwrgit:window-control:invoke";

/** Linux painted caption buttons: main → renderer frame-state push. */
export const WINDOW_FRAME_STATE_CHANNEL = "pwrgit:window-control:state";

/** What a painted caption button asks the main process to do. */
export type WindowControlAction = "minimize" | "toggle-maximize" | "close";

/**
 * What the maximize button has to draw. The window manager maximizes windows
 * behind our back — a double-click on the strip, Super+Up, a tiling keybind —
 * so the glyph follows main's own `maximize` / `unmaximize` events rather than
 * whatever the last button press asked for.
 */
export type WindowFrameState = { maximized: boolean };
