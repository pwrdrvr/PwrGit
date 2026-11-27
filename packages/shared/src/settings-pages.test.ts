import { describe, expect, it } from "vitest";
import {
  isSettingsHash,
  isSettingsPage,
  isSettingsSub,
  parseSettingsRouteHash,
  sanitizeSettingsRoute,
  SETTINGS_PAGES,
  settingsRouteHash,
  type SettingsRoute
} from "./settings-pages";

describe("isSettingsPage", () => {
  it("accepts every page the nav lists", () => {
    for (const page of SETTINGS_PAGES) expect(isSettingsPage(page)).toBe(true);
  });

  it("rejects anything else, including a near miss and a non-string", () => {
    expect(isSettingsPage("ai")).toBe(false);
    expect(isSettingsPage("General")).toBe(false);
    expect(isSettingsPage("logs")).toBe(false);
    expect(isSettingsPage(undefined)).toBe(false);
    expect(isSettingsPage({ page: "general" })).toBe(false);
  });
});

describe("isSettingsSub", () => {
  it("accepts a sub only on the page that owns it", () => {
    expect(isSettingsSub("forges", "github")).toBe(true);
    expect(isSettingsSub("git", "runtime")).toBe(true);
    expect(isSettingsSub("profiles", "hidden")).toBe(true);
    // Real subs, wrong page.
    expect(isSettingsSub("git", "github")).toBe(false);
    expect(isSettingsSub("forges", "codex")).toBe(false);
  });

  it("gives a page without subs none at all", () => {
    expect(isSettingsSub("general", "codex")).toBe(false);
    expect(isSettingsSub("general", "")).toBe(false);
  });

  it("rejects anything that is not a string", () => {
    expect(isSettingsSub("git", undefined)).toBe(false);
    expect(isSettingsSub("git", ["runtime"])).toBe(false);
  });
});

describe("sanitizeSettingsRoute", () => {
  it("keeps a well-formed route whole", () => {
    expect(
      sanitizeSettingsRoute({ page: "git", sub: "runtime" })
    ).toStrictEqual({ page: "git", sub: "runtime" });
  });

  it("drops a sub the page does not own but still lands on the page", () => {
    // The page is still the right place to be; failing the whole route would
    // leave Settings on whatever it opened to last.
    expect(sanitizeSettingsRoute({ page: "forges", sub: "codex" })).toStrictEqual({
      page: "forges"
    });
    expect(sanitizeSettingsRoute({ page: "general", sub: "anything" })).toStrictEqual({
      page: "general"
    });
  });

  it("rejects a route with no known page", () => {
    expect(sanitizeSettingsRoute({ page: "nope", sub: "codex" })).toBeNull();
    expect(sanitizeSettingsRoute({ sub: "codex" })).toBeNull();
    expect(sanitizeSettingsRoute({ page: null })).toBeNull();
  });

  it("rejects anything that is not an object", () => {
    expect(sanitizeSettingsRoute(null)).toBeNull();
    expect(sanitizeSettingsRoute(undefined)).toBeNull();
    expect(sanitizeSettingsRoute("ai-providers")).toBeNull();
    expect(sanitizeSettingsRoute(42)).toBeNull();
  });

  it("carries nothing across that it did not check", () => {
    // It crosses IPC: an extra field must not ride through on the spread.
    expect(sanitizeSettingsRoute({ page: "about", extra: "x" })).toStrictEqual({
      page: "about"
    });
  });
});

describe("settingsRouteHash / parseSettingsRouteHash", () => {
  it("boots a bare #settings when there is nowhere in particular to go", () => {
    expect(settingsRouteHash()).toBe("#settings");
    expect(settingsRouteHash(null)).toBe("#settings");
    expect(parseSettingsRouteHash("#settings")).toBeNull();
  });

  it("round-trips a route through the hash", () => {
    const routes: SettingsRoute[] = [
      { page: "general" },
      { page: "forges", sub: "gitlab" },
      { page: "profiles", sub: "hidden" },
      { page: "agents" }
    ];
    for (const route of routes) {
      expect(parseSettingsRouteHash(settingsRouteHash(route))).toStrictEqual(route);
    }
  });

  it("sanitizes what it parses, as anything arriving in a URL must be", () => {
    expect(parseSettingsRouteHash("#settings?page=bogus")).toBeNull();
    expect(parseSettingsRouteHash("#settings?")).toBeNull();
    expect(parseSettingsRouteHash("#settings?page=forges&sub=bogus")).toStrictEqual({ page: "forges" });
    expect(parseSettingsRouteHash("#settings?page=ai-providers")).toBeNull();
    expect(parseSettingsRouteHash("#settings?page=ai-features")).toBeNull();
  });

  it("answers null for a hash that is not a Settings route", () => {
    expect(parseSettingsRouteHash("#logs?page=general")).toBeNull();
    expect(parseSettingsRouteHash("#settingsx?page=general")).toBeNull();
  });
});

describe("isSettingsHash", () => {
  it("boots Settings on a bare #settings and on one carrying a route", () => {
    expect(isSettingsHash("#settings")).toBe(true);
    expect(isSettingsHash("#settings?page=general")).toBe(true);
    expect(isSettingsHash(settingsRouteHash({ page: "profiles", sub: "list" }))).toBe(true);
  });

  it("does not claim a hash that merely starts with the same letters", () => {
    expect(isSettingsHash("#settingsx")).toBe(false);
    expect(isSettingsHash("#logs")).toBe(false);
    expect(isSettingsHash("settings")).toBe(false);
    expect(isSettingsHash("")).toBe(false);
  });
});
