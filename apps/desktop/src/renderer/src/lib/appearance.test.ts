// @vitest-environment jsdom

import { GENERAL_DEFAULTS, SIDEBAR_DENSITIES, SIDEBAR_TEXT_SIZES } from "@pwrgit/shared";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { applyAppearance, applyResolvedTheme } from "./appearance";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-sidebar-text");
  document.documentElement.removeAttribute("data-density");
  document.documentElement.style.colorScheme = "";
});

describe("renderer appearance", () => {
  it("uses the light attribute only for the resolved light palette", () => {
    applyResolvedTheme("light");
    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");

    applyResolvedTheme("dark");
    expect(document.documentElement.dataset["theme"]).toBeUndefined();
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("applies text size and density as independent axes", () => {
    applyAppearance("lg", "compact");
    expect(document.documentElement.dataset).toMatchObject({
      sidebarText: "lg",
      density: "compact"
    });

    applyAppearance("md", "comfortable");
    expect(document.documentElement.dataset["sidebarText"]).toBeUndefined();
    expect(document.documentElement.dataset["density"]).toBeUndefined();
  });

  it("mutates the DOM only for appearance axes whose effective values change", () => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {});
    observer.observe(root, { attributes: true });
    try {
      fc.assert(fc.property(
        fc.constantFrom(...SIDEBAR_TEXT_SIZES),
        fc.constantFrom(...SIDEBAR_DENSITIES),
        fc.array(fc.tuple(
          fc.constantFrom(...SIDEBAR_TEXT_SIZES), fc.constantFrom(...SIDEBAR_DENSITIES)
        )),
        (text, density, updates) => {
          applyAppearance(text, density);
          observer.takeRecords();
          let previousText = text;
          let previousDensity = density;
          // A save for another setting reapplies the current appearance first.
          for (const [nextText, nextDensity] of [[text, density] as const, ...updates]) {
            applyAppearance(nextText, nextDensity);
            expect(observer.takeRecords().map((record) => record.attributeName)).toEqual([
              ...(nextText === previousText ? [] : ["data-sidebar-text"]),
              ...(nextDensity === previousDensity ? [] : ["data-density"])
            ]);
            expect(root.getAttribute("data-sidebar-text"))
              .toBe(nextText === GENERAL_DEFAULTS.sidebarTextSize ? null : nextText);
            expect(root.getAttribute("data-density"))
              .toBe(nextDensity === GENERAL_DEFAULTS.sidebarDensity ? null : nextDensity);
            previousText = nextText;
            previousDensity = nextDensity;
          }
        }
      ));
    } finally {
      observer.disconnect();
    }
  });
});
