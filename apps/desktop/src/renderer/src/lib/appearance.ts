import type { SidebarDensity, SidebarTextSize } from "@pwrgit/shared";
import { GENERAL_DEFAULTS } from "@pwrgit/shared";
import { dispatch, subscribe } from "./pwrgit";

/**
 * Appearance axes are applied as `data-*` on <html>, where `tokens.css` and
 * `app.css` pick them up. Mirrors PwrAgnt's `applyAppearanceAttributes`.
 *
 * Defaults carry NO attribute — the bare `:root` block is the tuned default,
 * so a fresh install has nothing stamped and the notch blocks only exist for
 * deliberate choices. That also means removing the attribute is how you return
 * to the default, not writing `data-sidebar-text="md"`.
 */
export function applyAppearance(
  textSize: SidebarTextSize,
  density: SidebarDensity
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  if (textSize !== GENERAL_DEFAULTS.sidebarTextSize) {
    root.setAttribute("data-sidebar-text", textSize);
  } else {
    root.removeAttribute("data-sidebar-text");
  }

  if (density !== GENERAL_DEFAULTS.sidebarDensity) {
    root.setAttribute("data-density", density);
  } else {
    root.removeAttribute("data-density");
  }
}

/**
 * Apply the stored appearance once at boot, then track `settings:changed`.
 *
 * Called from `main.tsx` rather than a component, so EVERY window (app,
 * settings, logs, documents) picks the axes up — the settings window is the
 * one changing them, and it would look wrong reflecting nothing. Runs before
 * render, so there's no flash of default sizing.
 */
export function startAppearanceSync(): () => void {
  const off = subscribe("settings:changed", (snapshot) => {
    applyAppearance(
      snapshot.general.sidebarTextSize,
      snapshot.general.sidebarDensity
    );
  });
  void dispatch("settings:read", undefined).then((r) => {
    if (r.ok) {
      applyAppearance(
        r.value.general.sidebarTextSize,
        r.value.general.sidebarDensity
      );
    }
  });
  return off;
}
