import { join } from "node:path";
import { BrowserWindow, shell } from "electron";

/**
 * Create the single main window. Frameless-inset titlebar on macOS, custom
 * title-bar overlay on Windows; the renderer paints its own titlebar row.
 */
export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: "#0a0908",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 12, y: 10 },
    ...(process.platform === "win32"
      ? {
          titleBarOverlay: {
            color: "#050403",
            symbolColor: "#b8b0a4",
            height: 32
          }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.once("ready-to-show", () => window.show());

  // Open external links in the OS browser; never navigate the app frame away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl !== undefined) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}
