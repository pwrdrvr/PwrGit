import type { AppHandle } from "./electron-app";

export async function triggerActiveRefresh(app: AppHandle): Promise<void> {
  await app.app.evaluate(async ({ app: electronApp, BrowserWindow }) => {
    // CDP evaluation can interrupt SQLite inside a native call. Focus
    // listeners query that connection, so let the interrupted call return.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const win = BrowserWindow.getAllWindows()[0];
    if (win !== undefined) {
      electronApp.emit("browser-window-focus", {}, win);
    }
  });
}
