import { BrowserWindow, dialog } from "electron";
import { ok } from "@pwrgit/shared";
import type { CommandBus } from "./command-bus";

export function registerDialogHandlers(bus: CommandBus): void {
  const open = async (
    properties: Array<"openDirectory" | "multiSelections">
  ): Promise<string[]> => {
    const win =
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows()[0] ??
      null;
    const result =
      win !== null
        ? await dialog.showOpenDialog(win, { properties })
        : await dialog.showOpenDialog({ properties });
    return result.canceled ? [] : result.filePaths;
  };

  // Multi-select folders in one native dialog (macOS/Linux allow ⌘/Ctrl-click).
  bus.register("dialog:pickDirectories", async () => {
    return ok(await open(["openDirectory", "multiSelections"]));
  });
}
