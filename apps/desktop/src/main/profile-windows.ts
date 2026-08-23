import { BrowserWindow } from "electron";
import type { AppAppearance } from "@pwrgit/shared";
import { createMainWindow } from "./window";

/**
 * One window per profile. Opening a profile that already has a window focuses
 * it — there is no "switch this window to another profile"; a window's profile
 * is fixed for its lifetime (the renderer reads it from the preload argv).
 */
export type ProfileWindows = {
  /** Open the profile's window, or focus it if it's already up. Returns
   *  whether a new window was created. */
  open: (profileId: string) => { window: BrowserWindow; created: boolean };
  has: (profileId: string) => boolean;
  /** The profile bound to a window (null for unknown/none). */
  profileFor: (win: BrowserWindow | null) => string | null;
  focusedProfileId: () => string | null;
};

export function createProfileWindows(options: {
  appearance: () => AppAppearance;
}): ProfileWindows {
  const byProfile = new Map<string, BrowserWindow>();

  const alive = (profileId: string): BrowserWindow | null => {
    const win = byProfile.get(profileId);
    return win !== undefined && !win.isDestroyed() ? win : null;
  };

  const open = (
    profileId: string
  ): { window: BrowserWindow; created: boolean } => {
    const existing = alive(profileId);
    if (existing !== null) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return { window: existing, created: false };
    }
    const win = createMainWindow(profileId, options.appearance());
    byProfile.set(profileId, win);
    win.on("closed", () => {
      if (byProfile.get(profileId) === win) byProfile.delete(profileId);
    });
    return { window: win, created: true };
  };

  const profileFor = (win: BrowserWindow | null): string | null => {
    if (win === null) return null;
    for (const [profileId, w] of byProfile) {
      if (w === win) return profileId;
    }
    return null;
  };

  return {
    open,
    has: (profileId) => alive(profileId) !== null,
    profileFor,
    focusedProfileId: () => profileFor(BrowserWindow.getFocusedWindow())
  };
}
