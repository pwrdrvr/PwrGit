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
    if (windowOpen === "deny") {
      logMain(
        "warn",
        "window-guards",
        "refused a window-open link: this window opens nothing",
        describeUrlForLog(url)
      );
      return { action: "deny" };
    }

    void openExternalUrl(url).then((result) => {
      if (result.ok) return;
      logMain(
        "warn",
        "window-guards",
        "refused a window-open link:",
        result.error.message,
        describeUrlForLog(url)
      );
    });

    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (navigation === "renderer-entry" && isSafeRendererNavigation(targetUrl)) {
      return;
    }
    event.preventDefault();
    logMain(
      "warn",
      "window-guards",
      "blocked renderer navigation:",
      describeUrlForLog(targetUrl)
    );
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
function isSafeRendererNavigation(targetUrl: string): boolean {
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

/**
 * Scheme and host only, for the two refusal logs above. Both are handed a
 * renderer-supplied URL, and `main.log` is a file on disk that Help → Logs
 * also shows for copying into bug reports — so the whole string must not go
 * in. The credential case is the pointed one: a URL refused *because* it
 * embeds `user:token@` would otherwise have that token persisted by the very
 * guard that rejected it. Query strings carry OAuth codes and session tokens
 * for the same reason, so they are dropped as well; scheme and host are what
 * a reader needs to tell a blocked `file://` from a blocked remote host.
 */
function describeUrlForLog(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "<unparseable URL>";
  }

  return parsed.host === "" ? parsed.protocol : `${parsed.protocol}//${parsed.host}`;
}
