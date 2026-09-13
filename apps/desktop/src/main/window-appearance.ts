import type { AppAppearance } from "@pwrgit/shared";

/**
 * Which palette each window renders in.
 *
 * A profile window owns its palette: a profile can pin light while the app
 * default is dark. Auxiliary windows — Settings, Logs, the document viewers,
 * the agent-access prompt — have no profile of their own, so they *borrow* one
 * from the window that summoned them. Opening Settings from a light profile
 * window while the app default is dark is the case this exists for.
 *
 * What's borrowed is the source, not a resolved palette, so an auxiliary window
 * keeps tracking that profile for as long as it's open: a profile that inherits
 * the app default drags its Settings window along when the app theme changes,
 * and a later override edit reaches both. Generic over the window type so the
 * resolution is testable without an Electron BrowserWindow.
 */
export type WindowAppearances<W extends object> = {
  /** The profile whose palette a window renders in; null means the app default. */
  sourceFor: (window: W | null) => string | null;
  /** The palette a window renders in. */
  appearanceFor: (window: W | null) => AppAppearance;
  /** Lend `from`'s source to an auxiliary window. A null opener means the app default. */
  inherit: (window: W, from: W | null) => void;
  /** Whether `inherit` has already run for this window — i.e. a re-summoned singleton. */
  knows: (window: W) => boolean;
  /** Whether an auxiliary window borrowed this profile, for a targeted repaint. */
  borrows: (window: W, profileId: string) => boolean;
};

export function createWindowAppearances<W extends object>(options: {
  /** The profile bound to a window; null for every non-profile window. */
  profileFor: (window: W | null) => string | null;
  /** The app-wide palette, for windows that borrow from nothing. */
  appAppearance: () => AppAppearance;
  /** One profile's palette: its override, or the app default when it has none. */
  profileAppearance: (profileId: string) => AppAppearance;
}): WindowAppearances<W> {
  // Weak: an auxiliary window's entry dies with the window, and the consent
  // prompt opens a fresh one every time it asks.
  const borrowed = new WeakMap<W, string | null>();

  const sourceFor = (window: W | null): string | null => {
    if (window === null) return null;
    return options.profileFor(window) ?? borrowed.get(window) ?? null;
  };

  return {
    sourceFor,
    knows: (window) => borrowed.has(window),
    inherit: (window, from) => {
      borrowed.set(window, sourceFor(from));
    },
    borrows: (window, profileId) => borrowed.get(window) === profileId,
    appearanceFor: (window) => {
      const profileId = sourceFor(window);
      return profileId === null
        ? options.appAppearance()
        : options.profileAppearance(profileId);
    }
  };
}
