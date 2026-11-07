/** Invoked in Electron's main process by Playwright. Keep this closure-free. */
export function clickSettingsMenu({ Menu }: Pick<typeof import("electron"), "Menu">): void {
  for (const top of Menu.getApplicationMenu()?.items ?? []) {
    for (const item of top.submenu?.items ?? []) {
      if (item.label === "Settings…") {
        item.click();
        return;
      }
    }
  }
  throw new Error("Settings… menu item not found");
}
