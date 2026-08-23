import {
  isAppearanceTheme,
  type AppAppearance,
  type ResolvedAppearanceTheme
} from "./protocol";
import type { ProfileThemeOverride } from "./types";

/** Main → preload bootstrap token used before the renderer can make IPC calls. */
export const APPEARANCE_ARG_PREFIX = "--pwrgit-appearance=";

export function resolveAppearanceTheme(
  shouldUseDarkColors: boolean
): ResolvedAppearanceTheme {
  return shouldUseDarkColors ? "dark" : "light";
}

/** Resolve one profile window without changing the app-wide preference. */
export function resolveProfileAppearance(
  override: ProfileThemeOverride | undefined,
  appAppearance: AppAppearance
): AppAppearance {
  return override === undefined
    ? appAppearance
    : { theme: override, resolvedTheme: override };
}

export function serializeAppearanceArg(appearance: AppAppearance): string {
  return `${APPEARANCE_ARG_PREFIX}${JSON.stringify(appearance)}`;
}

/** Parse a bootstrap token defensively; preload startup must never throw. */
export function parseAppearanceArg(
  argv: readonly string[]
): AppAppearance | null {
  const arg = argv.find((candidate) =>
    candidate.startsWith(APPEARANCE_ARG_PREFIX)
  );
  if (arg === undefined) return null;

  try {
    const parsed = JSON.parse(
      arg.slice(APPEARANCE_ARG_PREFIX.length)
    ) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { theme, resolvedTheme } = parsed as Record<string, unknown>;
    if (!isAppearanceTheme(theme)) return null;
    if (resolvedTheme !== "dark" && resolvedTheme !== "light") return null;
    return { theme, resolvedTheme };
  } catch {
    return null;
  }
}
