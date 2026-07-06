import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC_DISPATCH_CHANNEL, IPC_EVENT_CHANNEL } from "@pwrgit/shared";

// The minimal, typed-at-the-renderer surface. Renderer-side helpers in
// src/renderer/src/lib/pwrgit.ts add the command/event generics on top.
const api = {
  dispatch: (name: string, req: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_DISPATCH_CHANNEL, name, req),

  on: (channel: string, handler: (payload: unknown) => void): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      eventChannel: string,
      payload: unknown
    ): void => {
      if (eventChannel === channel) handler(payload);
    };
    ipcRenderer.on(IPC_EVENT_CHANNEL, listener);
    return () => ipcRenderer.off(IPC_EVENT_CHANNEL, listener);
  }
};

contextBridge.exposeInMainWorld("pwrgit", api);
