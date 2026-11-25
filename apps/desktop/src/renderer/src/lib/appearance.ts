import type {
  ResolvedAppearanceTheme,
  SidebarDensity,
  SidebarTextSize
} from "@pwrgit/shared";
import { GENERAL_DEFAULTS } from "@pwrgit/shared";
import { dispatch, subscribe } from "./pwrgit";

function setAppearanceAttribute(root: HTMLElement, name: string, value: string | null): void {
  if (root.getAttribute(name) === value) return;
  if (value === null) root.removeAttribute(name);
  else root.setAttribute(name, value);
}

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

  setAppearanceAttribute(
    root, "data-sidebar-text", textSize === GENERAL_DEFAULTS.sidebarTextSize ? null : textSize
  );
  setAppearanceAttribute(
    root, "data-density", density === GENERAL_DEFAULTS.sidebarDensity ? null : density
  );
}

/** Dark owns the bare :root block; light is the only attributed override. */
export function applyResolvedTheme(theme: ResolvedAppearanceTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "light") {
    root.setAttribute("data-theme", "light");
    root.style.colorScheme = "light";
  } else {
    root.removeAttribute("data-theme");
    root.style.colorScheme = "dark";
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
  // The inline head bootstrap already applied this value; repeating it here
  // makes direct renderer/unit entry points deterministic too.
  applyResolvedTheme(window.pwrgit.appearance.resolvedTheme);

  const offAppearance = subscribe("appearance:changed", (appearance) => {
    applyResolvedTheme(appearance.resolvedTheme);
  });
  const offSettings = subscribe("settings:changed", (snapshot) => {
    applyAppearance(
      snapshot.general.sidebarTextSize,
      snapshot.general.sidebarDensity
    );
  });
  void dispatch("appearance:read", undefined).then((r) => {
    if (r.ok) applyResolvedTheme(r.value.resolvedTheme);
  });
  void dispatch("settings:read", undefined).then((r) => {
    if (r.ok) {
      applyAppearance(
        r.value.general.sidebarTextSize,
        r.value.general.sidebarDensity
      );
    }
  });
  return () => {
    offAppearance();
    offSettings();
  };
}
