import { join } from "node:path";
import { BrowserWindow } from "electron";
import { serializeAppearanceArg, type AppAppearance } from "@pwrgit/shared";
import { windowChrome } from "../window-chrome";

export function createConsentWindow(appearance: AppAppearance): BrowserWindow {
  const window = new BrowserWindow({
    width: 620, height: 660, minWidth: 500, minHeight: 480,
    show: false, title: "PwrGit — Approve agent access",
    backgroundColor: windowChrome(appearance.resolvedTheme).background,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      additionalArguments: [serializeAppearanceArg(appearance)]
    }
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl) void window.loadURL(rendererUrl + "#agent-consent");
  else void window.loadFile(join(__dirname, "../renderer/index.html"), { hash: "agent-consent" });
  return window;
}
