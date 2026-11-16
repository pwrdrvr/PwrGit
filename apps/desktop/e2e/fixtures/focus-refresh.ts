export function emitFocusOnMainLoop({ app, BrowserWindow }: Pick<typeof import("electron"), "app" | "BrowserWindow">): Promise<void> {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        const win = BrowserWindow.getAllWindows()[0];
        if (win !== undefined) app.emit("browser-window-focus", {}, win);
        resolve();
      } catch (cause) {
        reject(cause);
      }
    });
  });
}
