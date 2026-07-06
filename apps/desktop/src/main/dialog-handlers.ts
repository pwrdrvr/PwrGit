import { BrowserWindow, dialog } from "electron";
import { ok } from "@pwrgit/shared";
import type { CommandBus } from "./command-bus";

export function registerDialogHandlers(bus: CommandBus): void {
  bus.register("dialog:pickDirectory", async () => {
    const win =
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows()[0] ??
      null;
    const result =
      win !== null
        ? await dialog.showOpenDialog(win, { properties: ["openDirectory"] })
        : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return ok(null);
    return ok(result.filePaths[0] ?? null);
  });
}
