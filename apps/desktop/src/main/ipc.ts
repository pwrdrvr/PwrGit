import { BrowserWindow, ipcMain } from "electron";
import {
  IPC_DISPATCH_CHANNEL,
  IPC_EVENT_CHANNEL,
  type CommandName,
  type EventChannel,
  type EventPayload,
  type Req
} from "@pwrgit/shared";
import type { CommandBus } from "./command-bus";

/** Bridge the command bus onto ipcMain. Call once, after `app.whenReady`. */
export function registerIpc(
  bus: CommandBus,
  lifecycle: { onWebContentsDestroyed?: (webContentsId: number) => void } = {}
): void {
  const trackedWebContents = new Set<number>();
  ipcMain.handle(
    IPC_DISPATCH_CHANNEL,
    (event, name: CommandName, req: unknown) => {
      const webContentsId = event.sender.id;
      if (!trackedWebContents.has(webContentsId)) {
        trackedWebContents.add(webContentsId);
        event.sender.once("destroyed", () => {
          trackedWebContents.delete(webContentsId);
          lifecycle.onWebContentsDestroyed?.(webContentsId);
        });
      }
      return bus.dispatch(name, req as Req<CommandName>, { webContentsId });
    }
  );
}

/** Broadcast a server event to every renderer window. */
export function emitEvent<C extends EventChannel>(
  channel: C,
  payload: EventPayload<C>
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_EVENT_CHANNEL, channel, payload);
  }
}

/** Send a typed server event to one window without disturbing sibling themes. */
export function emitEventToWindow<C extends EventChannel>(
  window: BrowserWindow,
  channel: C,
  payload: EventPayload<C>
): void {
  if (window.isDestroyed()) return;
  window.webContents.send(IPC_EVENT_CHANNEL, channel, payload);
}
