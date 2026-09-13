import { describe, expect, it } from "vitest";
import type { AppAppearance } from "@pwrgit/shared";
import { resolveProfileAppearance } from "@pwrgit/shared";
import { createWindowAppearances } from "./window-appearance";

type FakeWindow = { name: string };

/**
 * Two profile windows — one pinned light, one inheriting — plus the auxiliary
 * windows they summon. Mirrors index.ts's wiring: the same
 * `resolveProfileAppearance` the real profile registry resolves through.
 */
function harness(appTheme: "dark" | "light" = "dark") {
  const profileWindows = new Map<FakeWindow, string>();
  const overrides: Record<string, "dark" | "light" | undefined> = {
    pinned: "light",
    inheriting: undefined
  };
  let app: AppAppearance = { theme: appTheme, resolvedTheme: appTheme };

  const appearances = createWindowAppearances<FakeWindow>({
    profileFor: (window) =>
      window === null ? null : (profileWindows.get(window) ?? null),
    appAppearance: () => app,
    profileAppearance: (profileId) =>
      resolveProfileAppearance(overrides[profileId], app)
  });

  return {
    appearances,
    overrides,
    setAppTheme: (theme: "dark" | "light") => {
      app = { theme, resolvedTheme: theme };
    },
    /** A window bound to a profile, like `createProfileWindows` tracks. */
    profileWindow: (profileId: string): FakeWindow => {
      const window = { name: `${profileId}-window` };
      profileWindows.set(window, profileId);
      return window;
    },
    settings: { name: "settings" } as FakeWindow
  };
}

describe("window appearance sources", () => {
  it("gives a profile window its own palette", () => {
    const { appearances, profileWindow } = harness("dark");
    expect(appearances.appearanceFor(profileWindow("pinned"))).toEqual({
      theme: "light",
      resolvedTheme: "light"
    });
  });

  it("opens an auxiliary window in its opener's palette", () => {
    const { appearances, profileWindow, settings } = harness("dark");
    appearances.inherit(settings, profileWindow("pinned"));
    expect(appearances.appearanceFor(settings)).toEqual({
      theme: "light",
      resolvedTheme: "light"
    });
  });

  it("falls back to the app palette with no opener", () => {
    const { appearances, settings } = harness("dark");
    appearances.inherit(settings, null);
    expect(appearances.appearanceFor(settings)).toEqual({
      theme: "dark",
      resolvedTheme: "dark"
    });
    expect(appearances.sourceFor(settings)).toBeNull();
  });

  it("keeps a borrowed palette when the app default moves", () => {
    const { appearances, profileWindow, settings, setAppTheme } =
      harness("dark");
    appearances.inherit(settings, profileWindow("pinned"));
    setAppTheme("light");
    expect(appearances.appearanceFor(settings).resolvedTheme).toBe("light");
    setAppTheme("dark");
    expect(appearances.appearanceFor(settings).resolvedTheme).toBe("light");
  });

  it("follows the app default through a profile that has no override", () => {
    const { appearances, profileWindow, settings, setAppTheme } =
      harness("dark");
    appearances.inherit(settings, profileWindow("inheriting"));
    expect(appearances.appearanceFor(settings).resolvedTheme).toBe("dark");
    setAppTheme("light");
    expect(appearances.appearanceFor(settings).resolvedTheme).toBe("light");
  });

  it("tracks the source profile, not the palette it resolved to", () => {
    const { appearances, profileWindow, settings, overrides } = harness("dark");
    appearances.inherit(settings, profileWindow("pinned"));
    overrides["pinned"] = "dark";
    expect(appearances.appearanceFor(settings).resolvedTheme).toBe("dark");
  });

  it("re-themes a singleton summoned from a different window", () => {
    const { appearances, profileWindow, settings } = harness("dark");
    appearances.inherit(settings, profileWindow("pinned"));
    expect(appearances.knows(settings)).toBe(true);
    appearances.inherit(settings, profileWindow("inheriting"));
    expect(appearances.appearanceFor(settings).resolvedTheme).toBe("dark");
  });

  it("lends its own source on to a window it opens", () => {
    const { appearances, profileWindow, settings } = harness("dark");
    appearances.inherit(settings, profileWindow("pinned"));
    const licence: FakeWindow = { name: "licence" };
    appearances.inherit(licence, settings);
    expect(appearances.appearanceFor(licence).resolvedTheme).toBe("light");
  });

  it("reports which windows borrowed a profile, for a targeted repaint", () => {
    const { appearances, profileWindow, settings } = harness("dark");
    appearances.inherit(settings, profileWindow("pinned"));
    expect(appearances.borrows(settings, "pinned")).toBe(true);
    expect(appearances.borrows(settings, "inheriting")).toBe(false);
    const logs: FakeWindow = { name: "logs" };
    expect(appearances.knows(logs)).toBe(false);
    expect(appearances.borrows(logs, "pinned")).toBe(false);
  });

  it("resolves a window it has never seen to the app palette", () => {
    const { appearances } = harness("light");
    const stranger: FakeWindow = { name: "stranger" };
    expect(appearances.appearanceFor(stranger)).toEqual({
      theme: "light",
      resolvedTheme: "light"
    });
    expect(appearances.appearanceFor(null).resolvedTheme).toBe("light");
  });

  it("drops back to the app palette when the source profile is deleted", () => {
    const { appearances, profileWindow, settings, overrides } = harness("dark");
    appearances.inherit(settings, profileWindow("pinned"));
    delete overrides["pinned"]; // profile:delete removed the row
    expect(appearances.appearanceFor(settings).resolvedTheme).toBe("dark");
  });
});
