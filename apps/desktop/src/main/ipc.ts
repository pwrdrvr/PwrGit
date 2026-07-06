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
export function registerIpc(bus: CommandBus): void {
  ipcMain.handle(
    IPC_DISPATCH_CHANNEL,
    (_event, name: CommandName, req: unknown) =>
      bus.dispatch(name, req as Req<CommandName>)
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
