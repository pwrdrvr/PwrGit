import { dirname } from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import { ok } from "@pwrgit/shared";
import type { CommandBus } from "./command-bus";

export function registerDialogHandlers(bus: CommandBus): void {
  // Since Electron 43 a dialog without `defaultPath` opens in Downloads every
  // time, and the OS stops restoring the folder the user last browsed. Repos
  // rarely live in Downloads, so start from home and then reopen beside the
  // last pick.
  let lastParent: string | undefined;

  const open = async (
    properties: Array<"openDirectory" | "multiSelections">
  ): Promise<string[]> => {
    const win =
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows()[0] ??
      null;
    const options = {
      defaultPath: lastParent ?? app.getPath("home"),
      properties
    };
    const result =
      win !== null
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return [];
    lastParent = dirname(result.filePaths[0]);
    return result.filePaths;
  };

  // Multi-select folders in one native dialog (macOS/Linux allow ⌘/Ctrl-click).
  bus.register("dialog:pickDirectories", async () => {
    return ok(await open(["openDirectory", "multiSelections"]));
  });
}
