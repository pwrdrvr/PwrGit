import { describe, expect, it } from "vitest";
import { SETTINGS_PAGES, settingsPageSubs } from "@pwrgit/shared";
import { describeCodexStatus, type AiProviderStatus } from "./ai-provider-status";
import {
  aiFeatureNavChildren,
  aiProviderNavChild,
  paneScrollForRoute,
  SETTINGS_NAV_GROUPS,
  type PaneRoute
} from "./settings-nav";

describe("SETTINGS_NAV_GROUPS", () => {
  it("expands exactly the pages that own subs", () => {
    // The same table main checks `settings:open` against, so a row can only
    // offer a child a deep link could also reach.
    expect([...SETTINGS_NAV_GROUPS].sort()).toEqual(["ai-features", "ai-providers", "forges"]);
    for (const page of SETTINGS_PAGES) {
      expect(SETTINGS_NAV_GROUPS.has(page), page).toBe(settingsPageSubs(page).length > 0);
    }
  });
});

describe("aiProviderNavChild", () => {
  it("carries the card's tone, chip and sentence onto the row", () => {
    const status: AiProviderStatus = {
      sub: "kimi",
      label: "Kimi Code CLI",
      tone: "warn",
      chip: "error",
      badge: "Unavailable",
      meta: "not signed in",
      sentence: "Kimi Code CLI: Unavailable"
    };
    // One answer, two renderings: the row routes to the card by the same sub.
    expect(aiProviderNavChild(status)).toStrictEqual({
      label: "Kimi Code CLI",
      sectionId: "kimi",
      dot: "warn",
      chip: "error",
      stateLabel: "Kimi Code CLI: Unavailable"
    });
  });

  it("leaves out what the status does not know rather than setting it undefined", () => {
    // Before discovery answers there is no dot, word or state to announce.
    expect(aiProviderNavChild(describeCodexStatus(null, true))).toStrictEqual({
      label: "Codex",
      sectionId: "codex"
    });
  });

  it("gives a healthy provider a dot and a name but no word", () => {
    const child = aiProviderNavChild({
      sub: "codex",
      label: "Codex",
      tone: "ok",
      badge: "Ready",
      meta: "v0.40.0 · /opt/homebrew/bin/codex",
      sentence: "Codex: Ready"
    });
    expect(child).toStrictEqual({
      label: "Codex",
      sectionId: "codex",
      dot: "ok",
      stateLabel: "Codex: Ready"
    });
  });
});

describe("aiFeatureNavChildren", () => {
  it("lists one plain jump link per section, in the order the pane reads", () => {
    expect(aiFeatureNavChildren()).toStrictEqual([
      { label: "Availability", sectionId: "availability" },
      { label: "Default agents", sectionId: "default-agents" },
      { label: "Guidance", sectionId: "guidance" }
    ]);
  });
});

describe("paneScrollForRoute", () => {
  const route = (page: PaneRoute["page"], sub: string | null, request: number): PaneRoute => ({
    page,
    sub,
    request
  });

  it("starts a different page at the top", () => {
    expect(paneScrollForRoute(route("general", null, 1), route("ai-providers", null, 2))).toBe(
      "top"
    );
    // Even when a card was asked for: the old page's offset means nothing here.
    expect(paneScrollForRoute(route("general", null, 1), route("ai-providers", "grok", 2))).toBe(
      "top"
    );
  });

  it("leaves the scroll alone when a card was asked for on the same page", () => {
    // The card reveals itself from wherever the pane is; jumping to the top
    // first is what made every jump link leap up and scroll back down.
    expect(paneScrollForRoute(route("forges", null, 1), route("forges", "gitlab", 2))).toBe("none");
    expect(paneScrollForRoute(route("forges", "github", 1), route("forges", "gitlab", 2))).toBe(
      "none"
    );
    expect(paneScrollForRoute(route("forges", "github", 1), route("forges", "github", 2))).toBe(
      "none"
    );
  });

  it("travels back to the top when the page's own row follows a card", () => {
    expect(
      paneScrollForRoute(route("ai-providers", "grok", 1), route("ai-providers", null, 2))
    ).toBe("travel-top");
  });

  it("travels back to the top on a re-click of the row already shown", () => {
    expect(paneScrollForRoute(route("ai-features", null, 1), route("ai-features", null, 2))).toBe(
      "travel-top"
    );
  });

  it("does nothing when the route did not move", () => {
    expect(paneScrollForRoute(route("about", null, 3), route("about", null, 3))).toBe("none");
  });
});
