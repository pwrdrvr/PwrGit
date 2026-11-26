// The Settings window's pages and the places within them — the allowlist a
// `settings:open` deep link is checked against, ported from PwrSnap's
// `SETTINGS_PAGES` / `SETTINGS_PAGE_SUBS`.
//
// Lives here, not beside the nav in the renderer, so main can validate a deep
// link without importing renderer code. The nav reads the same table: a page
// grows a caret and a sub-list exactly when it owns subs below.

import { FORGE_KINDS } from "./types";

/** Every Settings page, in nav order. `agents` is Local Agents — agents
 *  connecting TO PwrGit — and keeps its id so nothing that already names it
 *  moves. */
export const SETTINGS_PAGES = [
  "general",
  "git",
  "updates",
  "profiles",
  "forges",
  "agents",
  "experimental",
  "diagnostics",
  "about"
] as const;

export type SettingsPage = (typeof SETTINGS_PAGES)[number];

export function isSettingsPage(value: unknown): value is SettingsPage {
  return (
    typeof value === "string" &&
    (SETTINGS_PAGES as readonly string[]).includes(value)
  );
}

/** Git's sections, in the order the pane reads: what runs, newer builds of
 *  PwrGit's own Git, then every Git that could run instead. */
export const GIT_SECTIONS = ["runtime", "managed", "installs"] as const;

/** Profiles' sections, in the order the pane reads. Git's own identity
 *  leads: it is what every profile's identity overrides, and where the launch
 *  notice sends people. */
export const PROFILES_SECTIONS = ["git-identity", "git-folders", "list", "hidden"] as const;

/**
 * Places within a page, keyed by the page that owns them.
 *
 * Every sub names a card inside its page's pane — a nav child scrolls to it,
 * never opens a pane of its own (settings/AGENTS.md). Profiles and Git have one
 * per section, and Forges has one per product.
 */
export const SETTINGS_PAGE_SUBS = {
  git: GIT_SECTIONS,
  profiles: PROFILES_SECTIONS,
  forges: FORGE_KINDS
} as const satisfies Partial<Record<SettingsPage, readonly string[]>>;


/** The subs `page` owns, or none. */
export function settingsPageSubs(page: SettingsPage): readonly string[] {
  return (SETTINGS_PAGE_SUBS as Partial<Record<SettingsPage, readonly string[]>>)[page] ?? [];
}

/** Whether `sub` names a place `page` actually has. */
export function isSettingsSub(page: SettingsPage, sub: unknown): sub is string {
  return typeof sub === "string" && settingsPageSubs(page).includes(sub);
}

export type SettingsRoute = {
  page: SettingsPage;
  sub?: string;
};

/**
 * Keep only a well-formed route — it crosses IPC and arrives in a URL hash.
 * A sub the page does not own is dropped rather than failing the route: the
 * page is still the right place to land.
 */
export function sanitizeSettingsRoute(value: unknown): SettingsRoute | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const page = record["page"];
  if (!isSettingsPage(page)) return null;
  const sub = record["sub"];
  return {
    page,
    ...(isSettingsSub(page, sub) ? { sub } : {})
  };
}

/** The hash a freshly opened Settings window boots on. A plain `#settings`
 *  when there is nowhere in particular to go. */
export function settingsRouteHash(route?: SettingsRoute | null): string {
  if (route === undefined || route === null) return "#settings";
  const params = new URLSearchParams({ page: route.page });
  if (route.sub !== undefined) params.set("sub", route.sub);
  return `#settings?${params.toString()}`;
}

/** Whether a hash boots the Settings window at all. */
export function isSettingsHash(hash: string): boolean {
  return hash === "#settings" || hash.startsWith("#settings?");
}

/** The route a Settings hash carries, or null for a bare `#settings`. */
export function parseSettingsRouteHash(hash: string): SettingsRoute | null {
  if (!hash.startsWith("#settings?")) return null;
  const params = new URLSearchParams(hash.slice("#settings?".length));
  return sanitizeSettingsRoute({
    page: params.get("page"),
    sub: params.get("sub") ?? undefined
  });
}
