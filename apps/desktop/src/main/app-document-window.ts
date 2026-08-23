import { join } from "node:path";
import { BrowserWindow } from "electron";
import {
  serializeAppearanceArg,
  type AppAppearance,
  type AppDocumentKind
} from "@pwrgit/shared";
import {
  auxiliaryWindowChromeOptions,
  hideAuxiliaryWindowMenuBar
} from "./auxiliary-window-chrome";
import { windowChrome } from "./window-chrome";

const documentWindows = new Map<AppDocumentKind, BrowserWindow>();

function titleFor(kind: AppDocumentKind): string {
  return kind === "license" ? "PwrGit License" : "PwrGit Third-Party Notices";
}

/**
 * Opens one focused viewer per bundled document. The renderer gets only the
 * document kind; main reads the matching fixed resource through the command
 * bus, so a compromised renderer cannot request arbitrary local files.
 */
export function openAppDocumentWindow(
  kind: AppDocumentKind,
  appearance: AppAppearance
): void {
  const existing = documentWindows.get(kind);
  if (existing !== undefined && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: titleFor(kind),
    ...auxiliaryWindowChromeOptions(appearance.resolvedTheme),
    backgroundColor: windowChrome(appearance.resolvedTheme).background,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [serializeAppearanceArg(appearance)]
    }
  });

  hideAuxiliaryWindowMenuBar(window);

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  const hash = `document-${kind}`;
  if (rendererUrl !== undefined) {
    void window.loadURL(`${rendererUrl}#${hash}`);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"), { hash });
  }

  window.on("closed", () => {
    if (documentWindows.get(kind) === window) documentWindows.delete(kind);
  });
  documentWindows.set(kind, window);
}
