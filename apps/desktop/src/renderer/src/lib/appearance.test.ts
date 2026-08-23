// @vitest-environment jsdom

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
});
