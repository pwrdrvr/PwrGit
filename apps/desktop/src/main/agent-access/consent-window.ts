import { showWindowWhenReady } from "../show-window-when-ready";
import { join } from "node:path";
import { BrowserWindow } from "electron";
import { serializeAppearanceArg, type AppAppearance } from "@pwrgit/shared";
import { windowChrome } from "../window-chrome";
import { applyWindowSecurityHardening } from "../window-security";

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
  // The approval prompt opens nothing and goes nowhere while it is up.
  applyWindowSecurityHardening(window, {
    windowOpen: "deny",
    navigation: "deny"
  });
  showWindowWhenReady(window);
  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl) void window.loadURL(rendererUrl + "#agent-consent");
  else void window.loadFile(join(__dirname, "../renderer/index.html"), { hash: "agent-consent" });
  return window;
}
