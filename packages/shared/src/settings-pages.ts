// The Settings window's pages and the places within them — the allowlist a
// `settings:open` deep link is checked against, ported from PwrSnap's
// `SETTINGS_PAGES` / `SETTINGS_PAGE_SUBS`.
//
// Lives here, not beside the nav in the renderer, so main can validate a deep
// link without importing renderer code. The nav reads the same table: a page
// grows a caret and a sub-list exactly when it owns subs below.

import { AI_PROVIDER_IDS } from "./ai-providers";
import { FORGE_KINDS, type ProfileId } from "./types";

/** Every Settings page, in nav order. `agents` is Local Agents — agents
 *  connecting TO PwrGit — and keeps its id so nothing that already names it
 *  moves. */
export const SETTINGS_PAGES = [
  "general",
  "updates",
  "profiles",
  "forges",
  "ai-providers",
  "ai-features",
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

/** AI Features' sections, in the order the page reads. Availability — the
 *  master switch — leads, because nothing below it runs while it is off. */
export const AI_FEATURE_SECTIONS = ["availability", "default-agents", "guidance"] as const;

/**
 * Places within a page, keyed by the page that owns them.
 *
 * Every sub names a card inside its page's pane — a nav child scrolls to it,
 * never opens a pane of its own (settings/AGENTS.md). Forges has one per
 * product, AI Providers one per provider, AI Features one per section.
 */
export const SETTINGS_PAGE_SUBS = {
  forges: FORGE_KINDS,
  "ai-providers": AI_PROVIDER_IDS,
  "ai-features": AI_FEATURE_SECTIONS
} as const satisfies Partial<Record<SettingsPage, readonly string[]>>;

export type AiProvidersSettingsSub = (typeof SETTINGS_PAGE_SUBS)["ai-providers"][number];
export type AiFeaturesSettingsSub = (typeof SETTINGS_PAGE_SUBS)["ai-features"][number];

/** The subs `page` owns, or none. */
export function settingsPageSubs(page: SettingsPage): readonly string[] {
  return (SETTINGS_PAGE_SUBS as Partial<Record<SettingsPage, readonly string[]>>)[page] ?? [];
}

/** Whether `sub` names a place `page` actually has. */
export function isSettingsSub(page: SettingsPage, sub: unknown): sub is string {
  return typeof sub === "string" && settingsPageSubs(page).includes(sub);
}

/**
 * Where to open Settings. `profileId` picks the profile the AI pages edit —
 * the Settings window is one window for every profile, and those pages are
 * per-profile.
 */
export type SettingsRoute = {
  page: SettingsPage;
  sub?: string;
  profileId?: ProfileId;
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
  const profileId = record["profileId"];
  return {
    page,
    ...(isSettingsSub(page, sub) ? { sub } : {}),
    ...(typeof profileId === "string" && profileId.length > 0 && profileId.length <= 200
      ? { profileId }
      : {})
  };
}

/** The hash a freshly opened Settings window boots on. A plain `#settings`
 *  when there is nowhere in particular to go. */
export function settingsRouteHash(route?: SettingsRoute | null): string {
  if (route === undefined || route === null) return "#settings";
  const params = new URLSearchParams({ page: route.page });
  if (route.sub !== undefined) params.set("sub", route.sub);
  if (route.profileId !== undefined) params.set("profile", route.profileId);
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
    sub: params.get("sub") ?? undefined,
    profileId: params.get("profile") ?? undefined
  });
}
