/** Invoked in Electron's main process by Playwright. Keep this closure-free. */
export function clickSettingsMenu({ Menu }: Pick<typeof import("electron"), "Menu">): Promise<void> {
  // Playwright can evaluate while main is inside a SQLite call. Defer the
  // action until that call has returned before it reads the profile theme.
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        for (const top of Menu.getApplicationMenu()?.items ?? []) {
          for (const item of top.submenu?.items ?? []) {
            if (item.label === "Settings…") {
              item.click();
              resolve();
              return;
            }
          }
        }
        throw new Error("Settings… menu item not found");
      } catch (error) {
        reject(error);
      }
    });
  });
}
