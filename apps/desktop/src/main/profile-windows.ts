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
  /** Close the window bound to a profile. Returns whether one was open. */
  close: (profileId: string) => boolean;
  /** The profile bound to a window (null for unknown/none). */
  profileFor: (win: BrowserWindow | null) => string | null;
  focusedProfileId: () => string | null;
  /** Every profile with a live window. Not the same as "the active profile":
   *  several windows can be up at once, and work that repaints a sidebar has
   *  to cover all of them or the unfocused ones silently stay stale. */
  openProfileIds: () => string[];
};

export function createProfileWindows(options: {
  appearance: (profileId: string) => AppAppearance;
}): ProfileWindows {
  const byProfile = new Map<string, BrowserWindow>();
  /** Windows that have fired `close` — see `alive` and the `close` listener. */
  const closing = new WeakSet<BrowserWindow>();

  /** The window bound to a profile, closing or not. Only `close` wants this;
   *  everything else wants `alive`. */
  const bound = (profileId: string): BrowserWindow | null => {
    const win = byProfile.get(profileId);
    return win !== undefined && !win.isDestroyed() ? win : null;
  };

  // `isDestroyed()` alone is too late. A window reports itself undestroyed
  // from the moment `close()` is called until the teardown completes, and in
  // that gap it is still a live entry here: a reveal arriving mid-close would
  // be emitted into a renderer that is going away, and `open` would "focus"
  // the corpse instead of building the window the caller asked for. The
  // reveal is then lost twice over — never delivered, never queued. `close`
  // is the earliest truthful signal, so a window that has fired it is gone as
  // far as callers are concerned.
  const alive = (profileId: string): BrowserWindow | null => {
    const win = bound(profileId);
    return win !== null && !closing.has(win) ? win : null;
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
    const win = createMainWindow(profileId, options.appearance(profileId));
    byProfile.set(profileId, win);
    // CONTRACT: nothing in this app calls `event.preventDefault()` on a
    // profile window's `close`, and this mark is never cleared, so adding one
    // without clearing the mark there too would leave a window that is still
    // on screen permanently invisible to `alive` — and the next `open` for
    // that profile would build a SECOND window for it, silently, which is the
    // one thing this module exists to prevent. Electron offers no "the close
    // was refused" event to recover from automatically; re-checking on a
    // timer would race real destruction and put the mid-close reveal bug back.
    win.on("close", () => closing.add(win));
    // Identity-checked: a reveal that raced this window's close has already
    // put its replacement in the map, and the loser must not evict it.
    win.on("closed", () => {
      if (byProfile.get(profileId) === win) byProfile.delete(profileId);
    });
    return { window: win, created: true };
  };

  // Answers from the same set `has` and `openProfileIds` answer from: a
  // window the module has already written off must not still name a profile
  // here, or `focusedProfileId` hands the menu a profile that `has` says has
  // no window and the caller's own fallback never runs.
  const profileFor = (win: BrowserWindow | null): string | null => {
    if (win === null || closing.has(win)) return null;
    for (const [profileId, w] of byProfile) {
      if (w === win) return profileId;
    }
    return null;
  };

  return {
    open,
    has: (profileId) => alive(profileId) !== null,
    // "Was one open", per the type above — which a window already on its way
    // out was. `profile-handlers`' delete path reads this as "did the user
    // just lose a window", and answers it by opening the active profile's;
    // saying false for a window closing concurrently would leave them with
    // none. Re-closing it, on the other hand, buys nothing.
    close: (profileId) => {
      const window = bound(profileId);
      if (window === null) return false;
      if (!closing.has(window)) window.close();
      return true;
    },
    profileFor,
    focusedProfileId: () => profileFor(BrowserWindow.getFocusedWindow()),
    openProfileIds: () =>
      [...byProfile.keys()].filter((profileId) => alive(profileId) !== null)
  };
}
