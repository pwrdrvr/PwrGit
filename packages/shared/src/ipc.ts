// IPC channel names shared by main (ipcMain.handle / webContents.send) and
// preload (ipcRenderer.invoke / on). The renderer never touches these
// directly — it goes through the preload-exposed `window.pwrgit` API.

/** Renderer → main command dispatch: `invoke(channel, name, req)`. */
export const IPC_DISPATCH_CHANNEL = "pwrgit:dispatch";

/** Main → renderer event push: `send(channel, eventChannel, payload)`. */
export const IPC_EVENT_CHANNEL = "pwrgit:event";
