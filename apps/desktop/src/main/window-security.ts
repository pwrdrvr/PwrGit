import type { BrowserWindow } from "electron";
import { openExternalUrl } from "./external-links";
import { logMain } from "./logs";

/**
 * Defense-in-depth guards for every BrowserWindow PwrGit creates. Each window
 * factory calls this one helper rather than writing its own pair of handlers,
 * so a window added later can never silently inherit weaker defaults than the
 * ones already here.
 *
 * - `setWindowOpenHandler` always denies renderer-driven window creation. With
 *   the default `windowOpen: "open-in-browser"` the URL is handed to
 *   `openExternalUrl`, the same validated boundary the `shell:openExternal`
 *   bus verb uses, so a renderer cannot reach `shell.openExternal` with a
 *   scheme or a credential-bearing URL the bus would have rejected. Windows
 *   with no legitimate outbound links pass `windowOpen: "deny"` and open
 *   nothing at all.
 * - `will-navigate` keeps the window on its own renderer entry. Only `file://`
 *   and, in development, the dev-server origin are allowed; anything else is
 *   prevented, so the app frame cannot be navigated away from the bundle. The
 *   agent-access consent window, which must never leave the prompt it is
 *   asking about, passes `navigation: "deny"` and stays where it loaded.
 */
export function applyWindowSecurityHardening(
  window: BrowserWindow,
  { windowOpen = "open-in-browser", navigation = "renderer-entry" }: {
    windowOpen?: "open-in-browser" | "deny";
    navigation?: "renderer-entry" | "deny";
  } = {}
): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (windowOpen === "open-in-browser") {
      void openExternalUrl(url).then((result) => {
        if (result.ok) return;
        logMain(
          "warn",
          "window-guards",
          "refused a window-open link:",
          result.error.message,
          url
        );
      });
    }

    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (navigation === "renderer-entry" && isSafeRendererNavigation(targetUrl)) {
      return;
    }
    event.preventDefault();
    logMain("warn", "window-guards", "blocked renderer navigation:", targetUrl);
  });
}

/**
 * Renderer navigation is only allowed back to the entry the window was loaded
 * from: `file://` in production, the dev-server origin under `pnpm dev`.
 * Hash-only navigation (the `#settings` / `#logs` / `#document-*` routes the
 * auxiliary windows boot on) keeps the same protocol and origin, so it passes
 * — Electron does not even raise `will-navigate` for an in-page hash change,
 * but the predicate must not depend on that.
 */
export function isSafeRendererNavigation(targetUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }

  // file:// URLs have a null origin, so they cannot be compared by origin.
  if (parsed.protocol === "file:") return true;

  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  if (rendererUrl === undefined) return false;

  try {
    return parsed.origin === new URL(rendererUrl).origin;
  } catch {
    return false;
  }
}
