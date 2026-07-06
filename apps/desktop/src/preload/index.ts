import { contextBridge } from "electron";

// Minimal bridge for the walking skeleton. The typed command-bus surface
// (dispatch / on) is added in U3.
contextBridge.exposeInMainWorld("pwrgit", {
  ping: (): string => "pong"
});
