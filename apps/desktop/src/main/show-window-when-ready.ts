import type { BrowserWindow } from "electron";

/** Register before navigation so a hidden window cannot miss its first load. */
export function showWindowWhenReady(
  window: BrowserWindow,
  platform: NodeJS.Platform = process.platform
): void {
  let finished = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

  const clearFallback = (): void => {
    if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    fallbackTimer = undefined;
  };
  const showOnce = (): void => {
    if (finished) return;
    finished = true;
    clearFallback();
    if (!window.isDestroyed()) window.show();
  };

  window.once("ready-to-show", showOnce);
  // PwrAgnt uses the same post-load fallback: Linux can finish loading a
  // hidden renderer without emitting ready-to-show until the window is mapped.
  if (platform !== "darwin") {
    window.webContents.once("did-finish-load", () => {
      if (!finished) fallbackTimer = setTimeout(showOnce, 500);
    });
  }
  window.once("closed", () => {
    finished = true;
    clearFallback();
  });
}
